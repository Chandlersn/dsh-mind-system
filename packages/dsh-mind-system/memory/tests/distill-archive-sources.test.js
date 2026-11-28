import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../server.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'distill-archive-sources-'));
  const root = path.join(home, 'memory'), skills = path.join(home, 'skills');
  await mkdir(path.join(root, 'functions'), { recursive: true });
  await mkdir(path.join(root, 'daily'), { recursive: true }); await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# index\n');
  const old = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const tools = new Map(), noop = () => {};
  const ctx = { tools: { register(tool) { tools.set(tool.name, tool); return noop; } }, systemPrompt: { getSectionOrder: () => 2900, section: () => noop }, on: () => noop, get: () => undefined, set() {}, emit() {}, inject(_n, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); } };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR || 'D:/dsh' });
  t.after(async () => { dispose?.(); if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; assert.equal(path.dirname(home), path.resolve(tmpdir())); await rm(home, { recursive: true, force: true }); });
  return { root, tool: tools.get('memory_write'), archive: path.join(root, 'daily', '2026-11.md') };
}
const args = { sourceReason: 'These dates cover archived observations and their top-level follow-up.', feature: 'test-archive', title: 'Source verification', summary: 'A bounded test', date: '2026-11-20' };
const archive = '# November\n\n## [2026-W47]\n\n### [2026-11-17]\n\nDay content.\n\n### [2026-11-18]\n\nOther content.\n';
async function absent(file) { await assert.rejects(() => readFile(file), { code: 'ENOENT' }); }

test('archived and top-level sources can be declared without rewriting either source', async (t) => {
  const f = await fixture(t), top = path.join(f.root, '2026-11-19.md');
  await writeFile(f.archive, archive); await writeFile(top, 'Top content\n');
  const result = await f.tool.execute({ ...args, sources: ['2026-11-17', '2026-11-18', '2026-11-19'] });
  assert.deepEqual(result.sourceDays, ['2026-11-17', '2026-11-18', '2026-11-19']);
  const body = await readFile(path.join(f.root, 'functions', 'test-archive.md'), 'utf8');
  assert.match(body, /未核验相关性、真实性或是否读过/);
  assert.match(f.tool.output.render(args, result)[0].text, /调用方声明/);
  assert.equal(await readFile(f.archive, 'utf8'), archive); assert.equal(await readFile(top, 'utf8'), 'Top content\n');
  await absent(path.join(f.root, '2026-11-17.md'));
});

test('top-level empty source is rejected even with a valid archive', async (t) => {
  const f = await fixture(t); await writeFile(f.archive, archive);
  await writeFile(path.join(f.root, '2026-11-17.md'), '  \n');
  await assert.rejects(f.tool.execute({ ...args, sources: ['2026-11-17'] }), /2026-11-17: empty/);
  await absent(path.join(f.root, 'functions', 'test-archive.md'));
  assert.equal(await readFile(f.archive, 'utf8'), archive);
});

for (const [body, status] of [
  ['# month\n', 'missing'],
  ['### [2026-11-17]\n\n', 'empty'],
  ['### [2026-11-17]\nfirst\n### [2026-11-17]\nsecond\n', 'ambiguous'],
]) test(`archive ${status} rejects the entire declared set`, async (t) => {
  const f = await fixture(t); await writeFile(f.archive, body);
  await writeFile(path.join(f.root, '2026-11-19.md'), 'Valid source\n');
  await assert.rejects(f.tool.execute({ ...args, sources: ['2026-11-19', '2026-11-17'] }), new RegExp(`2026-11-17: ${status}`));
  await absent(path.join(f.root, 'functions', 'test-archive.md'));
  assert.equal(await readFile(f.archive, 'utf8'), body);
});

test('archive read EACCES is unavailable and does not write a feature', async (t) => {
  const f = await fixture(t); await writeFile(f.archive, archive);
  const original = fs.promises.readFile; let hits = 0;
  fs.promises.readFile = async function (name, ...rest) {
    if (typeof name === 'string' && path.resolve(name) === f.archive) { hits++; throw Object.assign(new Error('injected'), { code: 'EACCES' }); }
    return original.call(this, name, ...rest);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(f.tool.execute({ ...args, sources: ['2026-11-17'] }), /2026-11-17: unavailable/); }
  finally { fs.promises.readFile = original; syncBuiltinESMExports(); }
  assert.ok(hits > 0); await absent(path.join(f.root, 'functions', 'test-archive.md'));
  assert.equal(await readFile(f.archive, 'utf8'), archive);
});
