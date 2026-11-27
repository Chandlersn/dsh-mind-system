import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../server.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'usage-report-scan-'));
  const root = path.join(home, 'memory'), skills = path.join(home, 'skills');
  await mkdir(path.join(root, '.usage'), { recursive: true }); await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# index\n');
  const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const tools = new Map(), noop = () => {};
  const ctx = { tools: { register(tool) { tools.set(tool.name, tool); return noop; } }, systemPrompt: { getSectionOrder: () => 2900, section: () => noop }, on: () => noop, get: () => undefined, set() {}, emit() {}, inject(_n, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); } };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR || 'D:/dsh' });
  t.after(async () => { dispose?.(); if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; assert.equal(path.dirname(home), path.resolve(tmpdir())); await rm(home, { recursive: true, force: true }); });
  const tool = tools.get('memory_usage'); assert.ok(tool);
  const file = path.join(root, '.usage', `${new Date().toISOString().slice(0, 7)}.jsonl`);
  const run = async () => {
    const args = { action: 'report', days: 30 }, value = await tool.execute(args);
    const rendered = tool.output.render(args, value).map((x) => x.text).join('\n');
    for (const key of Object.keys(value)) assert.ok(key in tool.output.schema.properties, `schema includes ${key}`);
    assert.equal(tool.output.schema.additionalProperties, false);
    return { value, rendered };
  };
  return { root, file, run };
}
const row = (kind) => JSON.stringify({ t: new Date().toISOString(), href: 'functions/example.md', kind }) + '\n';

test('report refuses partial recommendations and does not expose bad row bytes', async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, `${row('read')}{private_invalid_line\n${row('positive')}`);
  const { value, rendered } = await f.run();
  assert.equal(value.scanStatus, 'incomplete'); assert.equal(value.invalidRows, 1); assert.deepEqual(value.items, []);
  assert.match(rendered, /扫描不完整/); assert.match(rendered, /坏行至少 1 条/); assert.match(rendered, /invalid_row/);
  assert.doesNotMatch(rendered, /private_invalid_line/); assert.doesNotMatch(JSON.stringify(value), /private_invalid_line/);
  assert.doesNotMatch(rendered, /纠正率\s*\d/);
});

test('complete empty and nonempty scans disclose unknown snapshot semantics', async (t) => {
  const f = await fixture(t);
  let result = await f.run();
  assert.equal(result.value.scanStatus, 'complete'); assert.deepEqual(result.value.items, []);
  assert.match(result.rendered, /snapshot=unknown/); assert.match(result.rendered, /logicalCompleteness=unknown/);
  await writeFile(f.file, `${row('read')}${row('positive')}`);
  result = await f.run();
  assert.equal(result.value.scanStatus, 'complete'); assert.equal(result.value.items.length, 1);
  assert.equal(result.value.snapshot, 'unknown'); assert.equal(result.value.logicalCompleteness, 'unknown');
  assert.match(result.rendered, /不构成一致快照/); assert.match(result.rendered, /functions\/example\.md/);
});

test('conflicting shard and archive sources are reported without suggestions', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, '.usage', 'archive'));
  await writeFile(f.file, row('read'));
  await writeFile(path.join(f.root, '.usage', 'archive', path.basename(f.file)), row('positive'));
  const { value, rendered } = await f.run();
  assert.equal(value.scanStatus, 'incomplete'); assert.deepEqual(value.items, []);
  assert.ok(value.scanReasons.includes('conflicting_sources'));
  assert.match(rendered, /conflicting_sources/);
});

test('scan size limit fails closed without returning partial suggestions', async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, Buffer.alloc(8 * 1024 * 1024 + 1, 65));
  const { value, rendered } = await f.run();
  assert.equal(value.scanStatus, 'unknown'); assert.equal(value.invalidRowsLowerBound, true); assert.deepEqual(value.items, []);
  assert.match(rendered, /扫描不完整/); assert.match(rendered, /坏行至少 0 条/); assert.match(rendered, /byte_limit/);
});

test('directory read EACCES reports unknown without partial suggestions', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, '.usage.jsonl'), row('positive'));
  const original = fs.promises.opendir; let hits = 0;
  fs.promises.opendir = async function (dir, ...args) {
    if (typeof dir === 'string' && path.resolve(dir) === path.join(f.root, '.usage')) { hits++; throw Object.assign(new Error('private synthetic failure'), { code: 'EACCES' }); }
    return original.call(this, dir, ...args);
  };
  syncBuiltinESMExports();
  let result;
  try { result = await f.run(); } finally { fs.promises.opendir = original; syncBuiltinESMExports(); }
  assert.ok(hits > 0); assert.equal(result.value.scanStatus, 'unknown'); assert.deepEqual(result.value.items, []);
  assert.match(result.rendered, /扫描不完整/); assert.match(result.rendered, /directory_unavailable/); assert.doesNotMatch(result.rendered, /private synthetic failure/);
});
