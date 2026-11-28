import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply, runHealthCheck, DEFAULTS } from '../server.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'usage-status-render-'));
  const root = path.join(home, 'memory'), skills = path.join(home, 'skills');
  await mkdir(path.join(root, '.usage'), { recursive: true }); await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# index\n');
  const old = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const tools = new Map(), noop = () => {};
  const ctx = { tools: { register(tool) { tools.set(tool.name, tool); return noop; } }, systemPrompt: { getSectionOrder: () => 2900, section: () => noop }, on: () => noop, get: () => undefined, set() {}, emit() {}, inject(_n, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); } };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR || 'D:/dsh' });
  t.after(async () => { dispose?.(); if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; assert.equal(path.dirname(home), path.resolve(tmpdir())); await rm(home, { recursive: true, force: true }); });
  return { root, skills, tool: tools.get('memory_read') };
}

test('registered adoption evidence renders empty and incomplete results verbatim', async (t) => {
  const f = await fixture(t);
  const args = { kind: 'adoption_evidence', objectKey: 'functions/example.md' };
  const show = async () => { const result = await f.tool.execute(args); return JSON.parse(f.tool.output.render(args, result)[0].text); };
  const empty = await show();
  assert.equal(empty.status, 'ok'); assert.deepEqual(empty.rows, []);
  const original = fs.promises.readdir;
  let hits = 0;
  fs.promises.readdir = async function (name, ...args) { if (typeof name === 'string' && path.resolve(name) === path.join(f.root, '.usage')) { hits++; throw Object.assign(new Error('injected'), { code: 'EACCES' }); } return original.call(this, name, ...args); };
  syncBuiltinESMExports();
  let result;
  try { result = await show(); } finally { fs.promises.readdir = original; syncBuiltinESMExports(); }
  assert.ok(hits > 0); assert.equal(result.status, 'incomplete'); assert.equal(result.reason, 'read_failed'); assert.deepEqual(result.rows, []);
});

test('R22 marks an enumerated shard disappearing as unknown', async (t) => {
  const f = await fixture(t);
  const month = new Date().toISOString().slice(0, 7), shard = path.join(f.root, '.usage', `${month}.jsonl`);
  await writeFile(shard, JSON.stringify({ t: new Date().toISOString(), href: 'insights/example.md', kind: 'positive' }) + '\n');
  const original = fs.promises.readFile;
  let hits = 0;
  fs.promises.readFile = async function (name, ...args) {
    if (typeof name === 'string' && path.resolve(name) === shard) {
      hits++; throw Object.assign(new Error('injected'), { code: 'ENOENT' });
    }
    return original.call(this, name, ...args);
  };
  syncBuiltinESMExports();
  let report;
  try { report = await runHealthCheck(f.root, { ...DEFAULTS, skillRoot: f.skills }); }
  finally { fs.promises.readFile = original; syncBuiltinESMExports(); }
  assert.ok(hits > 0);
  assert.ok(report.results.some((r) => r.rule === 'R22' && /不完整.*未知.*ENOENT/.test(r.message)));
  assert.ok(report.results.some((r) => r.rule === 'R26'));
});
