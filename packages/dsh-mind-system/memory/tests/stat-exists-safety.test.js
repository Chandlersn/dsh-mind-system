import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { localDateStr, statExists } from '../src/util.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'stat-exists-safety-'));
  const prior = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (prior === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prior;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^stat-exists-safety-/);
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

async function withStatFault(target, code, fn) {
  const original = fs.promises.stat;
  let hits = 0;
  fs.promises.stat = async (file, ...args) => {
    if (path.resolve(String(file)) === path.resolve(target)) {
      hits++;
      throw Object.assign(new Error(`injected ${code} for snapshot`), { code });
    }
    return original.call(fs.promises, file, ...args);
  };
  syncBuiltinESMExports();
  try { await fn(() => hits); }
  finally { fs.promises.stat = original; syncBuiltinESMExports(); }
}

test('statExists 只将真实 ENOENT 和 ENOTDIR 判为不存在', async (t) => {
  const home = await fixture(t);
  const existing = path.join(home, 'existing');
  await writeFile(existing, 'existing', 'utf8');
  assert.equal(await statExists(existing), true);
  assert.equal(await statExists(path.join(home, 'missing')), false);
  assert.equal(await statExists(path.join(existing, 'child')), false);
});

test('statExists 传播 EIO 和 EACCES 原始异常', async (t) => {
  const home = await fixture(t);
  const existing = path.join(home, 'existing');
  await writeFile(existing, 'existing', 'utf8');
  for (const code of ['EIO', 'EACCES']) {
    await withStatFault(existing, code, async (hits) => {
      await assert.rejects(statExists(existing), (err) => err.code === code && err.message.includes(`injected ${code}`));
      assert.equal(hits(), 1);
    });
  }
});

test('真实 memory_skill 已有快照时使用独占创建，不走快照 stat 且不覆盖', async (t) => {
  const home = await fixture(t);
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  const name = 'snapshot-safety';
  const skillFile = path.join(skills, name, 'SKILL.md');
  const history = path.join(skills, '.history', `${name}-${localDateStr()}.md`);
  const oldSkill = Buffer.from('---\nname: snapshot-safety\nstatus: active\nagent_created: true\n---\n\noriginal skill content\n');
  const oldSnapshot = Buffer.from('original first snapshot; must remain untouched\n');
  await mkdir(path.dirname(skillFile), { recursive: true });
  await mkdir(path.dirname(history), { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(skillFile, oldSkill);
  await writeFile(history, oldSnapshot);
  const registered = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register: (definition) => { registered.set(definition.name, definition); return noop; } },
    on: () => noop,
    inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  const { apply } = await import('../server.js');
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR });
  if (typeof dispose === 'function') t.after(() => dispose());
  const tool = registered.get('memory_skill');
  assert.ok(tool && typeof tool.execute === 'function', '真实工具必须注册');
  let failure;
  await withStatFault(history, 'EIO', async (hits) => {
    try {
      await tool.execute({
        action: 'crystallize', name, summary: 'test summary', when: 'test trigger',
        procedure: ['first step', 'second step'], verification: 'verify', sources: ['example'],
      }, {});
    } catch (err) { failure = err; }
    assert.equal(hits(), 0, '生产快照路径已改为独占创建，不再调用 stat');
  });
  assert.deepEqual(await readFile(history), oldSnapshot, '历史快照不得覆盖');
  assert.deepEqual(await readFile(skillFile), oldSkill, '技能正文不得覆盖');
  assert.equal(failure?.code, 'MEMORY_SKILL_HISTORY_EXISTS', '已存在快照必须停止并说明路径占用');
  assert.equal(failure?.cause?.code, 'EEXIST');

  const originalWrite = fs.promises.writeFile;
  let writeHits = 0;
  fs.promises.writeFile = async (file, ...args) => {
    if (path.resolve(String(file)) === history) {
      writeHits++;
      throw Object.assign(new Error('injected EIO during exclusive snapshot creation'), { code: 'EIO' });
    }
    return originalWrite.call(fs.promises, file, ...args);
  };
  syncBuiltinESMExports();
  let writeFailure;
  try {
    await tool.execute({
      action: 'crystallize', name, summary: 'test summary', when: 'test trigger',
      procedure: ['first step', 'second step'], verification: 'verify', sources: ['example'],
    }, {});
  } catch (err) { writeFailure = err; }
  finally { fs.promises.writeFile = originalWrite; syncBuiltinESMExports(); }
  assert.equal(writeHits, 1, '必须命中真实快照独占写入');
  assert.equal(writeFailure?.code, 'MEMORY_SKILL_HISTORY_UNKNOWN');
  assert.equal(writeFailure?.cause?.code, 'EIO');
  assert.match(writeFailure.message, /EIO/);
  assert.deepEqual(await readFile(history), oldSnapshot, '写入 EIO 后历史快照不得覆盖');
  assert.deepEqual(await readFile(skillFile), oldSkill, '写入 EIO 后技能正文不得覆盖');
});
