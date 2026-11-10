// Exercise the registered panel route with a synthetic authenticated connection.
// All files, including the DSH home, live below an isolated temporary directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeText } from '../src/util.js';

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'dao-archive-safety-'));
  const root = path.join(base, 'memory');
  const skillRoot = path.join(base, 'skills');
  await mkdir(path.join(root, 'dao'), { recursive: true });
  await mkdir(skillRoot, { recursive: true });
  const originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = base;
  const mod = await import('../server.js');
  const noop = () => {};
  let handler;
  const ctx = {
    tools: { register: () => noop },
    on: () => noop,
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    inject(_names, fn) {
      fn({
        webServer: { register(route) { if (route.path === '/api/memory-org') handler = route.handler; return noop; } },
        connection: { requestRejection: () => undefined },
        effect: (fn) => fn(),
      });
    },
  };
  const dispose = mod.apply(ctx, { memoryRoot: root, skillRoot });
  assert.equal(typeof handler, 'function', 'the actual panel route must be registered');
  t.after(async () => {
    dispose?.();
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    assert.equal(path.dirname(path.resolve(base)), path.resolve(tmpdir()));
    assert.ok(path.basename(base).startsWith('dao-archive-safety-'));
    await rm(base, { recursive: true, force: true });
  });
  async function removeDao(name) {
    const bytes = Buffer.from(JSON.stringify({ action: 'delete', name }), 'utf8');
    const req = { method: 'POST', url: '/api/memory-org/dao-action', async *[Symbol.asyncIterator]() { yield bytes; } };
    let status;
    let body;
    const res = { writeHead(code) { status = code; }, end(value) { body = value; } };
    await handler(req, res);
    return { status, body: JSON.parse(body) };
  }
  const name = '归档安全测试';
  const active = path.join(root, 'dao', `${name}.md`);
  const archive = path.join(root, 'dao', '_deleted', `${name}.md`);
  async function createActive(text) { await writeText(active, text, { memoryRoot: root }); }
  return { root, name, active, archive, createActive, removeDao };
}

async function contentsOrMissing(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

test('首次删除正式道成功并保留归档原文', async (t) => {
  const f = await fixture(t);
  const original = '# 道 · 归档安全测试\n\n第一版原文\n';
  await f.createActive(original);
  const result = await f.removeDao(f.name);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(await contentsOrMissing(f.active), null);
  const archived = await readFile(f.archive, 'utf8');
  assert.ok(archived.startsWith(original.trimEnd() + '\n'), 'archive retains the original text');
  assert.match(archived, /## 删除/);
});

test('同名归档已存在时拒绝再次删除，原归档与当前正式道均逐字节保留', async (t) => {
  const f = await fixture(t);
  await f.createActive('# 道 · 归档安全测试\n\n第一版原文\n');
  const first = await f.removeDao(f.name);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const oldArchive = await readFile(f.archive);
  const secondText = '# 道 · 归档安全测试\n\n第二版原文，不得丢失\n';
  await f.createActive(secondText);
  const activeBefore = await readFile(f.active);
  const second = await f.removeDao(f.name);
  const activeAfter = await readFile(f.active).catch((err) => { if (err.code === 'ENOENT') return null; throw err; });
  const archiveAfter = await readFile(f.archive);
  assert.deepEqual(
    { status: second.status, activePreserved: activeAfter?.equals(activeBefore) === true, archivePreserved: archiveAfter.equals(oldArchive) },
    { status: 409, activePreserved: true, archivePreserved: true },
    'conflicting deletion must fail without overwriting the earlier archive or removing the active entry',
  );
});
