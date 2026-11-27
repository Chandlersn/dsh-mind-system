import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { readLedger } from '../src/write-ledger.js';
import { tmpdir } from 'node:os';
import { apply } from '../server.js';
import { resolveDshRoot } from '../src/host.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'memory-delete-tool-'));
  const root = path.join(home, 'memory'), skills = path.join(home, 'skills');
  await mkdir(root); await mkdir(skills);
  await writeFile(path.join(root, 'MEMORY.md'), '# Index\n\n## 功能模块索引\n\n| 功能域 | 一句话状态 / 待验证 |\n|---|---|\n| [foo](functions/foo.md) | row |\n');
  await mkdir(path.join(root, 'functions'));
  await mkdir(path.join(root, 'insights'));
  await mkdir(path.join(root, 'dao'));
  await writeFile(path.join(root, 'functions', 'foo.md'), '# Foo\n\nbody\n');
  await writeFile(path.join(root, 'insights', 'bar.md'), '# Bar\n\nlaw\n');
  await writeFile(path.join(root, 'dao', 'baz.md'), '# Dao\n\naxiom\n');
  const previous = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const tools = new Map(), noop = () => {};
  const ctx = { tools: { register: tool => { tools.set(tool.name, tool); return noop; } },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop }, on: () => noop, set() {},
    get: name => name === 'valves' ? undefined : undefined,
    inject: () => {} };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: resolveDshRoot(process.env.DSH_INSTALL_DIR),
    dailyArchiveFirstDelayMs: 0, dailyArchiveIntervalMs: 0 });
  t.after(async () => {
    dispose?.(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  return { root, tools };
}

test('L2 self-delete archives the file, deletes source, and removes index row', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const { root, tools } = await fixture(t);
  const tool = tools.get('memory_delete');
  assert.ok(tool);
  const r = await tool.execute({ zone: 'functions', name: 'foo' });
  assert.equal(r.deleted, true);
  assert.equal(r.layer, 'L2');
  assert.equal(await readFile(path.join(root, 'functions', '_deleted', 'foo.md'), 'utf8').then(x => x.includes('# Foo')), true);
  await assert.rejects(() => readFile(path.join(root, 'functions', 'foo.md')));
  assert.doesNotMatch(await readFile(path.join(root, 'MEMORY.md'), 'utf8'), /functions\/foo\.md/);
  assert.deepEqual(r.warnings, []);
});

test('L1 self-delete works; L0 dao is refused with human_gate_required and source intact', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const { root, tools } = await fixture(t);
  const tool = tools.get('memory_delete');
  const l1 = await tool.execute({ zone: 'insights', name: 'bar' });
  assert.equal(l1.layer, 'L1');
  assert.equal(await readFile(path.join(root, 'insights', '_deleted', 'bar.md'), 'utf8').then(x => x.includes('# Bar')), true);
  await assert.rejects(() => tool.execute({ zone: 'dao', name: 'baz' }),
    (err) => err.code === 'human_gate_required');
  assert.match(await readFile(path.join(root, 'dao', 'baz.md'), 'utf8'), /# Dao/);
});

test('archive collision aborts before deleting the source', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const { root, tools } = await fixture(t);
  await mkdir(path.join(root, 'functions', '_deleted'), { recursive: true });
  await writeFile(path.join(root, 'functions', '_deleted', 'foo.md'), 'previous historical archive\n');
  await assert.rejects(() => tools.get('memory_delete').execute({ zone: 'functions', name: 'foo' }),
    (err) => err.code === 'archive_exists');
  assert.match(await readFile(path.join(root, 'functions', 'foo.md'), 'utf8'), /# Foo/);
  assert.match(await readFile(path.join(root, 'functions', '_deleted', 'foo.md'), 'utf8'), /previous historical archive/);
});

test('all supported zones remove only their own rows', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const { root, tools } = await fixture(t);
  await mkdir(path.join(root, 'capabilities'));
  for (const zone of ['insights', 'capabilities']) await writeFile(path.join(root, zone, 'foo.md'), 'body');
  const original = [
    '# Index', '## 功能模块索引', '| 功能域 | 一句话状态 / 待验证 |', '|---|---|',
    '| [foo](functions/foo.md) | target |', '| [foo](functions/other.md) | preserve |', '| [other](functions/foo2.md) | preserve |',
    '### 索引·group', '| 功能域 | 一句话状态 / 待验证 |', '|---|---|', '| foo | legacy |',
    '## 创新优化思想索引', '| 思想主题 | 一句话内涵 |', '|---|---|', '| [foo](insights/foo.md) | target |',
    '## 能力台账（可用工具 / MCP / CLI）', '| 能力 | 一句话用途 |', '|---|---|', '| [foo](capabilities/foo.md) | target |',
    '## Other', '| foo | preserve |', ''
  ].join('\n');
  await writeFile(path.join(root, 'MEMORY.md'), original);
  const tool = tools.get('memory_delete');
  for (const zone of ['functions', 'insights', 'capabilities']) {
    await tool.execute({ zone, name: 'foo' });
    assert.equal((await readLedger(root)).get(`${zone}/foo.md`)?.op, 'delete');
    assert.match(await readFile(path.join(root, zone, '_deleted', 'foo.md'), 'utf8'), /body|Foo/);
  }
  const index = await readFile(path.join(root, 'MEMORY.md'), 'utf8');
  assert.doesNotMatch(index, /\]\((?:functions|insights|capabilities)\/foo\.md\)/);
  assert.match(index, /\[foo\]\(functions\/other\.md\)/);
  assert.match(index, /\[other\]\(functions\/foo2\.md\)/);
  assert.match(index, /## Other\n\| foo \| preserve \|/);
  assert.match(index, /\| foo \| legacy \|/);
});

test('index write failure reports the already committed deletion', { skip: 'superseded: index cleanup failure now returns deleted:true with a manual-cleanup warning; covered in memory-delete-rename-first.test.js' }, async (t) => {
  const { root, tools } = await fixture(t);
  const original = fs.promises.rename;
  let injected = 0;
  fs.promises.rename = async (from, to, ...args) => {
    if (path.resolve(String(to)) === path.join(root, 'MEMORY.md')) {
      injected++;
      throw Object.assign(new Error('injected index failure'), { code: 'EIO' });
    }
    return original.call(fs.promises, from, to, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => tools.get('memory_delete').execute({ zone: 'functions', name: 'foo' }),
      (err) => err.code === 'MEMORY_DELETE_INDEX_PARTIAL' && err.deleteStatus === 'deleted' && err.indexStatus === 'unknown' && /已删除/.test(err.message));
  } finally { fs.promises.rename = original; syncBuiltinESMExports(); }
  assert.equal(injected, 1);
  await assert.rejects(() => readFile(path.join(root, 'functions', 'foo.md')), { code: 'ENOENT' });
  assert.match(await readFile(path.join(root, 'functions', '_deleted', 'foo.md'), 'utf8'), /Foo/);
  assert.equal((await readLedger(root)).get('functions/foo.md')?.op, 'delete');
  assert.match(await readFile(path.join(root, 'MEMORY.md'), 'utf8'), /functions\/foo\.md/);
});

test('lost index commit acknowledgement reports an unknown outcome', { skip: 'superseded: index cleanup uncertainty now returns deleted:true with a manual-cleanup warning; covered in memory-delete-rename-first.test.js' }, async (t) => {
  const { root, tools } = await fixture(t);
  const original = fs.promises.rename;
  let injected = 0;
  fs.promises.rename = async (from, to, ...args) => {
    const result = await original.call(fs.promises, from, to, ...args);
    if (path.resolve(String(to)) === path.join(root, 'MEMORY.md')) {
      injected++;
      throw Object.assign(new Error('lost acknowledgement'), { code: 'EIO' });
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => tools.get('memory_delete').execute({ zone: 'functions', name: 'foo' }),
      (err) => err.code === 'MEMORY_DELETE_INDEX_PARTIAL' && err.indexStatus === 'unknown');
  } finally { fs.promises.rename = original; syncBuiltinESMExports(); }
  assert.equal(injected, 1);
  assert.doesNotMatch(await readFile(path.join(root, 'MEMORY.md'), 'utf8'), /functions\/foo\.md/);
  assert.equal((await readLedger(root)).get('functions/foo.md')?.op, 'delete');
});

test('missing index is not recreated', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const { root, tools } = await fixture(t);
  await rm(path.join(root, 'MEMORY.md'));
  await tools.get('memory_delete').execute({ zone: 'functions', name: 'foo' });
  await assert.rejects(() => readFile(path.join(root, 'MEMORY.md')), { code: 'ENOENT' });
});

test('registered tool removes unambiguous Markdown variants recognized by recall', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const { root, tools } = await fixture(t);
  const rows = [
    '| [foo](./functions/foo.md) | dot |',
    '| [foo](functions/%66oo.md) | encoded |',
    '| [foo](<functions/foo.md>) | angle |',
    '| [foo](functions/foo.md "title") | title |',
    '| [foo][ref] | reference |',
    '| foo | legacy | [file](functions/foo.md) | body |',
  ];
  const index = ['## 功能模块索引', '| 功能域摘要 | 一句话状态 | 过程链接 | 摘要 |', '|---|---|---|---|', ...rows, '', '[ref]: functions/foo.md', ''].join('\r\n');
  await writeFile(path.join(root, 'MEMORY.md'), index);
  const result = await tools.get('memory_delete').execute({ zone: 'functions', name: 'foo' });
  const after = await readFile(path.join(root, 'MEMORY.md'), 'utf8');
  for (const row of rows) assert.doesNotMatch(after, new RegExp(row.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(after, /(?<!\r)\n/);
  assert.equal(result.deleted, true);
});

test('registered tool preserves ambiguous and unrelated rows and reports uncertainty', { skip: 'Deletion is paused pending a proven cross-process safe protocol' }, async (t) => {
  const { root, tools } = await fixture(t);
  const rows = [
    '| foo | bare unknown |',
    '| foo | unrelated | [file](functions/other.md) |',
    '| [foo](functions/foo.md) | [other](functions/other.md) |',
    '| [foo](functions/%ZZfoo.md) | malformed |',
    '| ` [foo](functions/foo.md) ` | code |',
    '| \\[foo](functions/foo.md) | escaped |',
  ];
  const index = ['## 功能模块索引', '| 功能域 | 一句话状态 |', '|---|---|', ...rows, ''].join('\n');
  await writeFile(path.join(root, 'MEMORY.md'), index);
  const result = await tools.get('memory_delete').execute({ zone: 'functions', name: 'foo' });
  const after = await readFile(path.join(root, 'MEMORY.md'), 'utf8');
  for (const row of rows) assert.ok(after.includes(row), row);
  assert.ok(result.warnings.length > 0, 'ambiguous rows must be reported');
});

test('unknown name and unsupported zone fail without any effect', async (t) => {
  const { root, tools } = await fixture(t);
  const tool = tools.get('memory_delete');
  await assert.rejects(() => tool.execute({ zone: 'functions', name: 'missing' }), (err) => err.code === 'safe_delete_unavailable');
  await assert.rejects(() => tool.execute({ zone: 'daily', name: '2026-11-23' }), (err) => err.code === 'unsupported_zone');
  assert.match(await readFile(path.join(root, 'MEMORY.md'), 'utf8'), /functions\/foo\.md/);
});
