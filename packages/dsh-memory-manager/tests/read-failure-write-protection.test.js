import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { contentHash, readLedger } from '../src/write-ledger.js';

// Exercise the real tools registered by apply; all state is inside a unique
// temporary DSH_HOME. The fault is limited to one exact, existing file.
async function fixture(t, { index = true, area = true } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'memory-read-failure-'));
  const root = path.join(home, 'memory');
  const functionsDir = path.join(root, 'functions');
  const skills = path.join(home, 'skills');
  const indexPath = path.join(root, 'MEMORY.md');
  const areaPath = path.join(functionsDir, 'area.md');
  const indexBytes = Buffer.from('# 原始索引\n\n## 功能模块索引\n\n| 功能域 | 一句话状态 / 待验证 |\n|---|---|\n| [old](functions/old.md) | 原有索引条目 |\n');
  const areaBytes = Buffer.from('# 原有功能域\n\n已有内容必须逐字节保留。\n');
  await mkdir(functionsDir, { recursive: true });
  await mkdir(skills, { recursive: true });
  if (index) await writeFile(indexPath, indexBytes);
  if (area) await writeFile(areaPath, areaBytes);
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const registered = [];
  const noop = () => {};
  const ctx = {
    tools: { register: (definition) => (registered.push(definition), noop) },
    on: () => noop,
    inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  const mod = await import('../server.js');
  const dispose = mod.apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR });
  t.after(async () => {
    if (typeof dispose === 'function') dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    assert.equal(path.dirname(path.resolve(home)), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith('memory-read-failure-'));
    await rm(home, { recursive: true, force: true });
  });
  const tool = (name) => {
    const entry = registered.find((item) => item?.name === name && typeof item.execute === 'function');
    assert.ok(entry, `real apply must register ${name}`);
    return entry;
  };
  return { root, indexPath, areaPath, indexBytes, areaBytes, tool };
}

async function withReadFailure(target, code, run) {
  const original = fs.promises.readFile;
  let hits = 0;
  fs.promises.readFile = async (file, ...args) => {
    if (typeof file === 'string' && path.resolve(file) === path.resolve(target)) {
      hits++;
      const error = new Error(`injected ${code} for existing protected file`);
      error.code = code;
      throw error;
    }
    return original.call(fs.promises, file, ...args);
  };
  syncBuiltinESMExports();
  try {
    await run();
    assert.ok(hits > 0, 'the actual tool must reach the injected read failure');
  } finally {
    fs.promises.readFile = original;
    syncBuiltinESMExports();
  }
}

async function expectExplicitFailure(run, code) {
  try {
    const result = await run();
    const text = JSON.stringify(result);
    assert.ok(result && (result.ok === false || result.success === false || result.fileWritten === false || result.status === 'error'), `must reject or return an explicit failure/partial result, got ${text}`);
    assert.match(text, /失败|错误|未知|未写|未完成|EIO|EACCES|error|fail/i);
  } catch (error) {
    // Do not accidentally accept an assertion failure from the explicit-result
    // branch as a successful rejection by the tool.
    if (error?.code === 'ERR_ASSERTION') throw error;
    assert.ok(error && (error.code === code || String(error.message).includes(code) || error.cause?.code === code), `failure should preserve ${code}: ${error}`);
  }
}

async function assertNoLedger(root) {
  await assert.rejects(stat(path.join(root, '.write-ledger.jsonl')), (error) => error.code === 'ENOENT', 'failed pre-write reads must not invent ledger records');
}

const writeArgs = { feature: 'area', title: '追加隔离测试', summary: '验证读取失败不会覆盖已有记录', date: '2026-11-10', result: 'done' };
const indexArgs = { zone: 'functions', name: 'area', summary: '验证已有索引受到保护' };

test('memory_write: existing feature read EIO rejects without replacing its bytes or inventing ledger', async (t) => {
  const f = await fixture(t);
  await withReadFailure(f.areaPath, 'EIO', async () => {
    await expectExplicitFailure(() => f.tool('memory_write').execute(writeArgs, {}), 'EIO');
  });
  assert.deepEqual(await readFile(f.areaPath), f.areaBytes, 'existing function bytes must survive');
  assert.deepEqual(await readFile(f.indexPath), f.indexBytes, 'unrelated index must survive');
  await assertNoLedger(f.root);
});

test('memory_index: existing index read EACCES rejects without replacing its bytes or inventing ledger', async (t) => {
  const f = await fixture(t);
  await withReadFailure(f.indexPath, 'EACCES', async () => {
    await expectExplicitFailure(() => f.tool('memory_index').execute(indexArgs, {}), 'EACCES');
  });
  assert.deepEqual(await readFile(f.indexPath), f.indexBytes, 'existing index bytes must survive');
  assert.deepEqual(await readFile(f.areaPath), f.areaBytes, 'unrelated feature must survive');
  await assertNoLedger(f.root);
});

test('genuinely missing feature can be created and recorded by memory_write', async (t) => {
  const f = await fixture(t, { area: false });
  const result = await f.tool('memory_write').execute(writeArgs, {});
  assert.equal(result.createdFunctionFile, true);
  const created = await readFile(f.areaPath, 'utf8');
  assert.match(created, /追加隔离测试/);
  const ledger = await readLedger(f.root);
  assert.equal(ledger.get('functions/area.md')?.hash, contentHash(created));
  assert.deepEqual(await readFile(f.indexPath), f.indexBytes);
});

test('genuinely missing index can be created by memory_index without forging an area ledger', async (t) => {
  const f = await fixture(t, { index: false });
  const result = await f.tool('memory_index').execute(indexArgs, {});
  assert.equal(result.created, true);
  const created = await readFile(f.indexPath, 'utf8');
  assert.match(created, /\[area\]\(functions\/area\.md\)/);
  assert.deepEqual(await readFile(f.areaPath), f.areaBytes);
  await assertNoLedger(f.root);
});
