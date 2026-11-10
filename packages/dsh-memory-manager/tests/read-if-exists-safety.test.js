import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, lstat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readIfExists } from '../src/util.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'read-if-exists-safety-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await mkdir(root, { recursive: true });
  await mkdir(skills, { recursive: true });
  const index = path.join(root, 'MEMORY.md');
  const indexBytes = Buffer.from('# Existing index\n\nUnrelated historical evidence.\n');
  await writeFile(index, indexBytes);
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
  t.after(async () => {
    if (typeof dispose === 'function') dispose();
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^read-if-exists-safety-/);
    await rm(home, { recursive: true, force: true });
  });
  return { home, root, skills, index, indexBytes, registered };
}

async function inject(method, target, error, fn) {
  const original = fs.promises[method];
  let hits = 0;
  fs.promises[method] = async (file, ...args) => {
    if (path.resolve(String(file)) === path.resolve(target)) { hits++; throw error; }
    return original.call(fs.promises, file, ...args);
  };
  syncBuiltinESMExports();
  try { await fn(() => hits); }
  finally { fs.promises[method] = original; syncBuiltinESMExports(); }
}

async function missing(p) {
  await assert.rejects(lstat(p), (err) => err.code === 'ENOENT');
}

const skillArgs = (name) => ({ action: 'crystallize', name, summary: 'new summary', when: 'when needed', procedure: ['first action', 'second action'], verification: 'verify', sources: ['example'] });
const capabilityArgs = (name) => ({ action: 'record', name, invocation: 'example --run', summary: 'example capability' });

for (const [kind, code] of [['skill', 'EIO'], ['capability', 'EIO'], ['skill', 'EACCES'], ['capability', 'EACCES']]) {
  test(`真实 ${kind} 遇到正文读取 ${code} 时保留正文、索引和账本`, async (t) => {
    const f = await fixture(t);
    const name = `existing-${kind}`;
    const target = kind === 'skill' ? path.join(f.skills, name, 'SKILL.md') : path.join(f.root, 'capabilities', `${name}.md`);
    const original = Buffer.from(kind === 'skill'
      ? `---\nname: ${name}\nstatus: active\nagent_created: true\n---\n\nExisting skill content.\n`
      : '# Original capability\n\nExisting capability content.\n');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, original);
    const tool = f.registered.get(kind === 'skill' ? 'memory_skill' : 'memory_capability');
    assert.equal(typeof tool?.execute, 'function');
    const fault = Object.assign(new Error(`injected ${code} on existing target`), { code });
    await inject('readFile', target, fault, async (hits) => {
      await assert.rejects(tool.execute(kind === 'skill' ? skillArgs(name) : capabilityArgs(name), {}), (err) => err === fault);
      assert.equal(hits(), 1, 'must reach the actual failing read');
    });
    assert.deepEqual(await readFile(target), original);
    assert.deepEqual(await readFile(f.index), f.indexBytes);
    await missing(path.join(f.root, '.write-ledger.jsonl'));
    await missing(path.join(f.root, '.usage.jsonl'));
    if (kind === 'skill') await missing(path.join(f.skills, '.history'));
  });
}

test('真实缺失路径：两个工具都能正常新建', async (t) => {
  const f = await fixture(t);
  const skill = f.registered.get('memory_skill');
  const capability = f.registered.get('memory_capability');
  const skillResult = await skill.execute(skillArgs('new-safe-skill'), {});
  const capResult = await capability.execute(capabilityArgs('new-safe-capability'), {});
  assert.equal(skillResult.created, true);
  assert.equal(capResult.created, true);
  assert.match(await readFile(path.join(f.skills, 'new-safe-skill', 'SKILL.md'), 'utf8'), /new summary/);
  assert.match(await readFile(path.join(f.root, 'capabilities', 'new-safe-capability.md'), 'utf8'), /example --run/);
  const index = await readFile(f.index, 'utf8');
  assert.match(index, /new-safe-skill/);
  assert.match(index, /new-safe-capability/);
});

test('readIfExists 保留真实内容，真正缺失可新建，非目录父项和读取错误不伪装缺失', async (t) => {
  const f = await fixture(t);
  assert.equal(await readIfExists(f.index), f.indexBytes.toString());
  assert.equal(await readIfExists(path.join(f.root, 'missing', 'child.md')), undefined);
  await assert.rejects(readIfExists(path.join(f.index, 'child.md')), { code: 'MEMORY_READ_STATE_UNKNOWN' });
  await assert.rejects(readIfExists(f.root), { code: 'EISDIR' });
  const fault = Object.assign(new Error('synthetic EIO'), { code: 'EIO' });
  await inject('readFile', f.index, fault, async (hits) => {
    await assert.rejects(readIfExists(f.index), (err) => err === fault);
    assert.equal(hits(), 1);
  });
});

test('缺失读取后 lstat 不可访问：抛出稳定未知状态', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, 'missing.md');
  const fault = Object.assign(new Error('synthetic lstat EACCES'), { code: 'EACCES' });
  await inject('lstat', target, fault, async (hits) => {
    await assert.rejects(readIfExists(target), (err) => err.code === 'MEMORY_READ_STATE_UNKNOWN' && err.cause === fault && err.readError?.code === 'ENOENT');
    assert.equal(hits(), 1);
  });
});

test('读取报缺失但 lstat 确认目录项仍存在时拒绝视为新文件', async (t) => {
  const f = await fixture(t);
  const fault = Object.assign(new Error('synthetic ENOENT after read'), { code: 'ENOENT' });
  await inject('readFile', f.index, fault, async (hits) => {
    await assert.rejects(readIfExists(f.index), (err) => err.code === 'MEMORY_READ_STATE_UNKNOWN' && err.readError === fault);
    assert.equal(hits(), 1);
  });
  assert.deepEqual(await readFile(f.index), f.indexBytes);
});

test('祖先目录存在但 realpath 返回 ENOENT 时拒绝视为新文件', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, 'missing', 'child.md');
  const fault = Object.assign(new Error('synthetic unresolved ancestor'), { code: 'ENOENT' });
  await inject('realpath', f.root, fault, async (hits) => {
    await assert.rejects(readIfExists(target), (err) => err.code === 'MEMORY_READ_STATE_UNKNOWN' && err.cause === fault);
    assert.equal(hits(), 1);
  });
});

test('目录 junction 目标消失时，后代读取不得视为新文件', async (t) => {
  const f = await fixture(t);
  const actual = path.join(f.home, 'junction-target');
  const junction = path.join(f.home, 'junction-parent');
  await mkdir(actual);
  try { await symlink(actual, junction, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (err) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(err.code)) { t.skip(`junction unavailable: ${err.code}`); return; }
    throw err;
  }
  await rm(actual, { recursive: true });
  await assert.rejects(readIfExists(path.join(junction, 'child.md')), { code: 'MEMORY_READ_STATE_UNKNOWN' });
});

test('符号链接：可读目标照常读取，坏最终链接与坏祖先均报告未知', async (t) => {
  const f = await fixture(t);
  const link = path.join(f.home, 'file-link');
  const dangling = path.join(f.home, 'dangling-link');
  const ancestor = path.join(f.home, 'dangling-parent');
  try {
    await symlink(f.index, link, 'file');
    await symlink(path.join(f.home, 'never-created.md'), dangling, 'file');
    await symlink(path.join(f.home, 'never-created-dir'), ancestor, 'dir');
  } catch (err) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(err.code)) { t.skip(`symlink unavailable: ${err.code}`); return; }
    throw err;
  }
  assert.equal(await readIfExists(link), f.indexBytes.toString());
  await assert.rejects(readIfExists(dangling), { code: 'MEMORY_READ_STATE_UNKNOWN' });
  await assert.rejects(readIfExists(path.join(ancestor, 'child.md')), { code: 'MEMORY_READ_STATE_UNKNOWN' });
});
