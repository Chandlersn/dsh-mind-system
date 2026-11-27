import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../server.js';
import { readUsageLedgerText } from './usage-ledger-helper.mjs';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'recall-usage-scan-'));
  const root = path.join(home, 'memory'), skills = path.join(home, 'skills');
  await mkdir(path.join(root, 'functions'), { recursive: true });
  await mkdir(path.join(root, '.usage'), { recursive: true }); await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# index\n\n## 功能模块索引（functions/）\n\n| 功能域 | 摘要 |\n|---|---|\n| [Repair](functions/repair.md) | isolated repair example |\n');
  await writeFile(path.join(root, 'functions', 'repair.md'), '# repair\n');
  const old = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const hooks = new Map(), noop = () => {};
  const valves = { upward() {}, negativeRules() { return [{ id: 'deny-risk', statement: 'Do not proceed', keywords: ['risk-token'] }]; } };
  const ctx = { tools: { register: () => noop }, systemPrompt: { getSectionOrder: () => 2900, section: () => noop }, on(name, fn) { hooks.set(name, fn); return noop; }, get(name) { return name === 'valves' ? valves : undefined; }, set() {}, emit() {}, inject(_n, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); } };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, recallTimeoutMs: 500, dshRoot: process.env.DSH_INSTALL_DIR || 'D:/dsh' });
  t.after(async () => { dispose?.(); if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; assert.equal(path.dirname(home), path.resolve(tmpdir())); await rm(home, { recursive: true, force: true }); });
  let turn = 0;
  async function invoke() {
    let count = 0;
    const result = await hooks.get('agent/pre-step')({ agent: { id: 'scan-agent' }, turn: ++turn, messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'risk-token unrelated input' }] }] }, async () => { count++; return { kind: 'enter', messages: [] }; });
    assert.equal(count, 1); return result.messages.map((m) => m.content[0].text).join('\n');
  }
  return { root, invoke, hooks };
}
const row = () => JSON.stringify({ t: new Date().toISOString(), href: 'functions/repair.md', kind: 'correction' }) + '\n';
async function waitExposure(root) {
  for (let i = 0; i < 500; i++) {
    if ((await readUsageLedgerText(root)).includes('"kind":"recall"')) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('expected actual recall exposure');
}

test('new corruption invalidates prior heat and recovery restores it', async (t) => {
  const f = await fixture(t), legacy = path.join(f.root, '.usage.jsonl');
  const valid = row() + row();
  await writeFile(legacy, valid);
  let result = await f.invoke();
  assert.match(result, /functions\/repair\.md/); assert.match(result, /deny-risk/);
  await waitExposure(f.root);
  await writeFile(legacy, valid + '{private_secret_bad_line\n');
  result = await f.invoke();
  assert.match(result, /使用热度与纠偏状态未知/); assert.match(result, /deny-risk/);
  assert.doesNotMatch(result, /functions\/repair\.md|private_secret_bad_line/);
  await writeFile(legacy, valid);
  result = await f.invoke();
  assert.doesNotMatch(result, /使用热度与纠偏状态未知/);
  assert.match(result, /functions\/repair\.md/); assert.match(result, /deny-risk/);
  await waitExposure(f.root);
});

test('late scan cannot populate cache or emit usage after the deadline', async (t) => {
  const f = await fixture(t), legacy = path.join(f.root, '.usage.jsonl');
  await writeFile(legacy, row() + row());
  const original = fs.promises.open;
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const reached = new Promise((resolve) => { entered = resolve; });
  let blocked = false;
  fs.promises.open = async function (name, ...args) {
    if (!blocked && typeof name === 'string' && path.resolve(name) === legacy) { blocked = true; entered(); await gate; }
    return original.call(this, name, ...args);
  };
  syncBuiltinESMExports();
  try {
    const pending = f.invoke(); await reached;
    const text = await pending;
    assert.match(text, /deny-risk/); assert.doesNotMatch(text, /functions\/repair\.md/);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.doesNotMatch(await readUsageLedgerText(f.root), /"kind":"recall"/);
  } finally { release(); fs.promises.open = original; syncBuiltinESMExports(); }
  await writeFile(legacy, '{private_bad_line\n');
  const result = await f.invoke();
  assert.match(result, /使用热度与纠偏状态未知/); assert.match(result, /deny-risk/);
  assert.doesNotMatch(result, /functions\/repair\.md|private_bad_line/);
});

test('conflicting archive and shard prevent correction-based recall', async (t) => {
  const f = await fixture(t), dir = path.join(f.root, '.usage'), month = new Date().toISOString().slice(0, 7);
  await mkdir(path.join(dir, 'archive'));
  await writeFile(path.join(dir, `${month}.jsonl`), row() + row());
  await writeFile(path.join(dir, 'archive', `${month}.jsonl`), row());
  const result = await f.invoke();
  assert.match(result, /使用热度与纠偏状态未知/); assert.match(result, /deny-risk/);
  assert.doesNotMatch(result, /functions\/repair\.md/);
});
