import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../server.js';
import { readUsageLedgerText } from './usage-ledger-helper.mjs';

async function fixture(t, rules) {
  const home = await mkdtemp(path.join(tmpdir(), 'recall-rule-isolation-'));
  const root = path.join(home, 'memory'), skills = path.join(home, 'skills');
  await mkdir(root, { recursive: true }); await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# index\n');
  const old = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const hooks = new Map(), services = new Map(), noop = () => {};
  const ctx = { tools: { register: () => noop }, systemPrompt: { getSectionOrder: () => 2900, section: () => noop }, on(name, fn) { hooks.set(name, fn); return noop; }, get(name) { return name === 'valves' ? rules : services.get(name); }, set(name, v) { services.set(name, v); }, inject(_n, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); } };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, recallTimeoutMs: 80, recallOptionalBudgetBytes: 0, dshRoot: process.env.DSH_INSTALL_DIR || 'D:/dsh' });
  t.after(async () => { dispose?.(); if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; assert.equal(path.dirname(home), path.resolve(tmpdir())); await rm(home, { recursive: true, force: true }); });
  const payload = { agent: { id: 'rule-isolation-agent' }, turn: 1, messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'risky-key' }] }] };
  return { root, hook: hooks.get('agent/pre-step'), payload, probe: services.get('memory.healthProbe') };
}
const rule = { upward() {}, async negativeRules() { return [{ id: 'prevent-risk', statement: 'Do not perform this action', keywords: ['risky-key'] }]; } };
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function text(result) { return result.messages?.map((m) => m.content?.[0]?.text ?? '').join('\n') ?? ''; }

for (const mode of ['EACCES', 'slow']) test(`index ${mode} cannot suppress an available rule`, async (t) => {
  const f = await fixture(t, rule), original = fs.promises.readFile, gate = deferred(), reached = deferred();
  let reads = 0;
  fs.promises.readFile = async function (file, ...args) {
    if (typeof file === 'string' && path.resolve(file) === path.join(f.root, 'MEMORY.md') && reads === 0) {
      reads++; reached.resolve();
      if (mode === 'EACCES') throw Object.assign(new Error('injected'), { code: 'EACCES' });
      await gate.promise;
    }
    return original.call(this, file, ...args);
  };
  syncBuiltinESMExports();
  let nextCount = 0;
  try {
    const pending = f.hook(f.payload, async () => { nextCount++; return { kind: 'enter', messages: [] }; });
    await reached.promise;
    const result = await pending;
    assert.equal(nextCount, 1); assert.match(text(result), /prevent-risk/);
    assert.doesNotMatch(text(result), /记忆召回（memory-manager/);
    assert.equal((await readUsageLedgerText(f.root)).trim(), '');
    const before = await f.probe.probe();
    gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    const after = await f.probe.probe();
    const get = (p) => p.findings.find((x) => x.code === 'memory.recall-dual-side')?.message;
    assert.equal(get(after), get(before), 'late optional completion must not mutate the exposure ledger');
    assert.ok(reads > 0);
  } finally { gate.resolve(); fs.promises.readFile = original; syncBuiltinESMExports(); }
});

test('rules timeout is visible, rejected steps do not consume, and late rules do not enter', async (t) => {
  const gate = deferred();
  const f = await fixture(t, { upward() {}, negativeRules: () => gate.promise });
  let calls = 0;
  const rejected = { kind: 'reject' };
  assert.strictEqual(await f.hook(f.payload, async () => { calls++; return rejected; }), rejected);
  const result = await f.hook(f.payload, async () => { calls++; return { kind: 'enter', messages: [] }; });
  assert.equal(calls, 2); assert.match(text(result), /负向规则状态未知.*超时/);
  assert.doesNotMatch(text(result), /prevent-risk/);
  gate.resolve([{ id: 'prevent-risk', statement: 'late', keywords: ['risky-key'] }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await readUsageLedgerText(f.root)).trim(), '');
  assert.equal((await f.probe.probe()).findings.some((x) => x.code === 'memory.recall-dual-side'), false);
});

test('next exception propagates exactly once', async (t) => {
  const f = await fixture(t, rule); let count = 0;
  await assert.rejects(f.hook(f.payload, async () => { count++; throw new Error('downstream-failure'); }), /downstream-failure/);
  assert.equal(count, 1);
});
