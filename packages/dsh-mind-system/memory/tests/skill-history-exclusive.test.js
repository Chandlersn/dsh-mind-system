import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm, link, symlink, lstat, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { localDateStr } from '../src/util.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'skill-history-exclusive-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  const name = 'exclusive-history';
  const skillFile = path.join(skills, name, 'SKILL.md');
  const history = path.join(skills, '.history', `${name}-${localDateStr()}.md`);
  const oldSkill = Buffer.from('---\nname: exclusive-history\nstatus: active\nagent_created: true\n---\n\nOriginal skill content.\n');
  await mkdir(root, { recursive: true });
  await mkdir(path.dirname(skillFile), { recursive: true });
  await mkdir(path.dirname(history), { recursive: true });
  await writeFile(skillFile, oldSkill);
  const registered = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register(def) { registered.set(def.name, def); return noop; } },
    on: () => noop,
    inject: (_services, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  const { apply } = await import('../server.js');
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR });
  const tool = registered.get('memory_skill');
  assert.equal(typeof tool?.execute, 'function', 'real apply must register memory_skill');
  t.after(async () => {
    if (typeof dispose === 'function') dispose();
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith('skill-history-exclusive-'));
    await rm(home, { recursive: true, force: true });
  });
  const run = () => tool.execute({
    action: 'crystallize', name, summary: 'new summary', when: 'new trigger',
    procedure: ['first action', 'second action'], verification: 'verify result', sources: ['example'],
  }, {});
  return { home, root, skills, name, skillFile, history, oldSkill, run };
}

function checkUnknown(err) {
  assert.equal(err.code, 'MEMORY_SKILL_HISTORY_UNKNOWN');
  assert.equal(err.skillWritten, false);
  assert.equal(err.snapshotWritten, null);
  assert.match(err.message, /结果不明/);
  assert.match(err.message, /不可盲目重试/);
  return true;
}

function checkOccupied(err) {
  assert.equal(err.code, 'MEMORY_SKILL_HISTORY_EXISTS');
  assert.equal(err.skillWritten, false);
  assert.equal(err.snapshotWritten, null);
  assert.match(err.message, /无法确认/);
  assert.match(err.message, /不可盲目重试/);
  return true;
}

async function withHistoryFault(history, phase, code, fn) {
  const original = fs.promises.writeFile;
  let calls = 0;
  fs.promises.writeFile = async (file, content, options) => {
    if (path.resolve(String(file)) === path.resolve(history)) {
      calls++;
      assert.equal(options?.flag, 'wx', 'actual snapshot creation must be exclusive');
      if (phase === 'after') await original.call(fs.promises, file, content, options);
      throw Object.assign(new Error(`injected ${code} ${phase}`), { code });
    }
    return original.call(fs.promises, file, content, options);
  };
  syncBuiltinESMExports();
  try { await fn(() => calls); }
  finally { fs.promises.writeFile = original; syncBuiltinESMExports(); }
}

test('快照全新创建成功后才重结晶，保存原 SKILL.md 原文', async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.action, 'crystallize');
  assert.deepEqual(await readFile(f.history), f.oldSkill);
  const updated = await readFile(f.skillFile, 'utf8');
  assert.notEqual(updated, f.oldSkill.toString());
  assert.match(updated, /new summary/);
  assert.match(updated, /status: active/);
});

test('已有同日快照不可信时拒绝覆盖，保留首份及原技能', async (t) => {
  const f = await fixture(t);
  const oldHistory = Buffer.from('existing historical snapshot; preserve exactly\n');
  await writeFile(f.history, oldHistory);
  await assert.rejects(f.run(), checkOccupied);
  assert.deepEqual(await readFile(f.history), oldHistory);
  assert.deepEqual(await readFile(f.skillFile), f.oldSkill);
});

for (const code of ['EIO', 'EACCES']) {
  test(`快照写入前 ${code}：结果未知，不修改技能文件`, async (t) => {
    const f = await fixture(t);
    await withHistoryFault(f.history, 'before', code, async (calls) => {
      await assert.rejects(f.run(), checkUnknown);
      assert.equal(calls(), 1);
    });
    await assert.rejects(lstat(f.history), { code: 'ENOENT' });
    assert.deepEqual(await readFile(f.skillFile), f.oldSkill);
  });
}

test('历史目录创建 EIO 也在修改技能前报告未知', async (t) => {
  const f = await fixture(t);
  const original = fs.promises.mkdir;
  let hits = 0;
  fs.promises.mkdir = async (dir, ...args) => {
    if (path.resolve(String(dir)) === path.dirname(f.history)) {
      hits++;
      throw Object.assign(new Error('injected mkdir EIO'), { code: 'EIO' });
    }
    return original.call(fs.promises, dir, ...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(f.run(), checkUnknown); }
  finally { fs.promises.mkdir = original; syncBuiltinESMExports(); }
  assert.equal(hits, 1);
  await assert.rejects(lstat(f.history), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.skillFile), f.oldSkill);
});

test('快照写入后回执 EIO：保留真实快照，禁止继续覆盖技能', async (t) => {
  const f = await fixture(t);
  await withHistoryFault(f.history, 'after', 'EIO', async (calls) => {
    await assert.rejects(f.run(), checkUnknown);
    assert.equal(calls(), 1);
  });
  assert.deepEqual(await readFile(f.history), f.oldSkill);
  assert.deepEqual(await readFile(f.skillFile), f.oldSkill);
  await assert.rejects(f.run(), checkOccupied);
  assert.deepEqual(await readFile(f.history), f.oldSkill);
  assert.deepEqual(await readFile(f.skillFile), f.oldSkill);
});

test('已有硬链接快照不得截断其他文件', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.home, 'hardlink-target.md');
  const sentinel = Buffer.from('external hardlink target must not change\n');
  await writeFile(outside, sentinel);
  await link(outside, f.history);
  await assert.rejects(f.run(), checkOccupied);
  assert.deepEqual(await readFile(outside), sentinel);
  assert.deepEqual(await readFile(f.history), sentinel);
  assert.deepEqual(await readFile(f.skillFile), f.oldSkill);
});

test('坏符号链接占据快照路径时不能沿链接创建外部目标', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.home, 'outside-target.md');
  try { await symlink(outside, f.history, 'file'); }
  catch (err) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(err?.code)) { t.skip(`symbolic link unavailable: ${err.code}`); return; }
    throw err;
  }
  assert.equal((await lstat(f.history)).isSymbolicLink(), true);
  await assert.rejects(f.run(), checkOccupied);
  assert.equal((await lstat(f.history)).isSymbolicLink(), true);
  assert.equal(await readlink(f.history), outside);
  await assert.rejects(lstat(outside), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.skillFile), f.oldSkill);
});
