import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readdir } from 'node:fs/promises';
const combined = new URL('../../memory/server.js', import.meta.url);
const standalone = new URL('../../dsh-memory-manager/server.js', import.meta.url);
const { existsSync } = await import('node:fs');
const memoryServer = existsSync(combined) ? combined : standalone;
const { apply } = await import(memoryServer.href);
const { resolveDshRoot } = await import(new URL('./src/host.js', memoryServer).href);
const { usageShardPath, resetUsageWriteHealth } = await import(new URL('./src/usage.js', memoryServer).href);
import { createRuntime, apply as applyValves } from '../index.js';
import { readDecisions } from '../src/store.js';

const hostEntry = path.join(resolveDshRoot(process.env.DSH_INSTALL_DIR), 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
const { validateJsonSchemaValue } = createRequire(hostEntry)(hostEntry);
const key = 'functions/sample.md';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function fixture(t, mode = 'normal') {
  const home = await mkdtemp(path.join(tmpdir(), 'adoption-integration-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  const storage = path.join(home, 'valves');
  await mkdir(path.join(root, 'functions'), { recursive: true });
  await mkdir(skills);
  await writeFile(path.join(root, key), 'Synthetic fixture');
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const runtime = createRuntime({ storageDir: storage });
  let calls = 0;
  const service = { ...runtime, negativeRules: runtime.negativeRules, upward: runtime.upward };
  if (mode === 'legacy') delete service.recordCorrelatedAdoptionSignal;
  if (mode === 'throw') service.recordCorrelatedAdoptionSignal = async signal => {
    calls++;
    assert.equal(await runtime.recordCorrelatedAdoptionSignal(signal), 'appended');
    throw new Error('synthetic lost acknowledgement');
  };
  const tools = new Map();
  const noop = () => {};
  const ctx = { tools: { register(tool) { tools.set(tool.name, tool); return noop; } },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop }, on: () => noop,
    set() {}, get: name => name === 'valves' ? service : undefined,
    inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }) };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR,
    dailyArchiveFirstDelayMs: 0, dailyArchiveIntervalMs: 0 });
  t.after(async () => {
    dispose?.();
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    resetUsageWriteHealth();
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^adoption-integration-/);
    await rm(home, { recursive: true, force: true });
  });
  return { root, storage, tools, runtime, get calls() { return calls; } };
}

async function usageRows(root) {
  try { return (await readFile(usageShardPath(root), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function schema(tool, result) {
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result, 'value'), []);
}

test('registered memory tools correlate real independent ledgers and expose evidence', async t => {
  const f = await fixture(t);
  const usage = f.tools.get('memory_usage');
  const args = { action: 'record', kind: 'positive', href: key, note: 'synthetic declaration' };
  const result = await usage.execute(args);
  schema(usage, result);
  assert.equal(result.bridgeStatus, 'appended');
  assert.match(result.correlationId, uuid);
  const [source] = await usageRows(f.root);
  const [decision] = await readDecisions(f.storage);
  assert.equal(source.correlationId, result.correlationId);
  assert.equal(source.href, decision.adoption.objectKey);
  assert.equal(source.kind, decision.adoption.kind);
  assert.equal(source.note, decision.adoption.note);
  assert.equal(decision.correlationId, result.correlationId);
  assert.equal(decision.adoption.objectKey, key);
  assert.equal(decision.adoption.kind, args.kind);
  assert.equal(decision.adoption.note, args.note);
  assert.equal(decision.adoption.provenance, 'caller/user-action');
  assert.equal(decision.adoption.governanceEligible, false);
  assert.equal(decision.adoption.principleAttribution, 'not_evaluated');
  const reader = f.tools.get('memory_read');
  const evidence = await reader.execute({ kind: 'adoption_evidence', objectKey: key });
  schema(reader, evidence);
  const page = JSON.parse(evidence.content);
  assert.equal(page.status, 'ok');
  assert.equal(page.governanceEligible, false);
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0].correlationId, result.correlationId);
  assert.equal(page.rows[0].provenance, 'caller/user-action');
});

test('legacy service writes without claiming correlation', async t => {
  const f = await fixture(t, 'legacy');
  const tool = f.tools.get('memory_usage');
  const result = await tool.execute({ action: 'record', kind: 'correction', href: key });
  schema(tool, result);
  assert.equal(result.bridgeStatus, 'legacy_unlinked');
  assert.equal((await usageRows(f.root))[0].correlationId, result.correlationId);
  const rows = await readDecisions(f.storage);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].correlationId, undefined);
});

test('invalid key is refused before either ledger receives a write', async t => {
  const f = await fixture(t);
  for (const href of ['functions/../bad.md', `functions/sk-${'x'.repeat(30)}.md`]) {
    await assert.rejects(f.tools.get('memory_usage').execute({ action: 'record', kind: 'positive', href }));
    assert.deepEqual(await usageRows(f.root), []);
    assert.deepEqual(await readDecisions(f.storage), []);
  }
});

test('lost acknowledgement after real commit is unconfirmed and is not retried', async t => {
  const f = await fixture(t, 'throw');
  const tool = f.tools.get('memory_usage');
  const result = await tool.execute({ action: 'record', kind: 'correction', href: key });
  schema(tool, result);
  assert.equal(result.bridgeStatus, 'unconfirmed');
  assert.equal(f.calls, 1);
  const rows = await readDecisions(f.storage);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].correlationId, result.correlationId);
  assert.equal((await usageRows(f.root))[0].correlationId, result.correlationId);
});

test('Cordis plugins compare real source and receiver records without writes or disclosure', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'correlation-cordis-'));
  const memory = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  const storage = path.join(home, 'valves');
  await Promise.all([mkdir(memory), mkdir(skills), mkdir(storage)]);
  const oldHome = process.env.DSH_HOME, oldSag = process.env.SAG_BIN;
  process.env.DSH_HOME = home;
  process.env.SAG_BIN = path.join(home, 'missing-sag');
  const install = resolveDshRoot(process.env.DSH_INSTALL_DIR);
  const { Context } = await import(pathToFileURL(path.join(install, 'node_modules/@deepseek-ai/cordis/lib/index.js')).href);
  const ctx = new Context();
  const tools = new Map();
  const noop = () => {};
  t.after(async () => {
    await ctx.fiber.dispose();
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldSag === undefined) delete process.env.SAG_BIN; else process.env.SAG_BIN = oldSag;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^correlation-cordis-/);
    await rm(home, { recursive: true, force: true });
  });
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return noop; } });
  ctx.provide('loader', {});
  ctx.provide('systemPrompt', { getSectionOrder: () => 2900, section: () => noop });
  await ctx.plugin({ name: 'correlation-test-valves', inject: ['tools'], apply: c => applyValves(c, { storageDir: storage, patrol: { enabled: false } }) });
  const query = tools.get('valve_usage_correlation');
  assert.ok(query);
  const correlationId = '12345678-1234-4123-8123-123456789abc';
  const sourceFile = path.join(memory, '.usage.jsonl');
  const receiverFile = path.join(storage, 'mind-valves.jsonl');
  const secretKey = 'functions/synthetic-private.md';
  const secretNote = 'synthetic-private-note';
  const source = { t: '2026-11-27T00:00:00.000Z', href: secretKey, kind: 'positive', note: secretNote, correlationId };
  const receiver = { correlationId, gate: 'adoption_nomination', origin: 'adoption', adoption: { objectKey: secretKey, kind: 'positive', note: secretNote } };
  await writeFile(sourceFile, JSON.stringify(source) + '\n');
  await writeFile(receiverFile, JSON.stringify(receiver) + '\n');
  const before = await Promise.all([readFile(sourceFile), readFile(receiverFile), readdir(memory), readdir(storage)]);
  const call = async () => { const result = await query.execute({ correlationId }); schema(query, result); return result; };
  assert.equal((await call()).status, 'incomplete');
  const fiber = ctx.plugin({ name: 'correlation-test-memory', inject: ['tools', 'loader', 'systemPrompt'], apply: c => apply(c, { memoryRoot: memory, skillRoot: skills, dshRoot: install, dailyArchiveFirstDelayMs: 0, dailyArchiveIntervalMs: 0 }) });
  await fiber;
  assert.equal(typeof ctx.get('memoryUsageCorrelation')?.readUsageCorrelation, 'function');
  const result = await call();
  assert.equal(result.status, 'compared');
  assert.deepEqual(result.comparison, { objectKey: 'match', kind: 'match', note: 'match' });
  assert.equal(result.snapshot, 'unknown');
  assert.equal(result.peerProvenance, 'unverified');
  assert.equal(result.goalProof, 'not_evaluated');
  assert.equal(result.principleAttribution, 'not_evaluated');
  assert.equal(result.governanceEligible, false);
  for (const sensitive of [correlationId, secretKey, secretNote]) assert.equal(JSON.stringify(result).includes(sensitive), false);
  assert.deepEqual(await Promise.all([readFile(sourceFile), readFile(receiverFile), readdir(memory), readdir(storage)]), before);
  await writeFile(sourceFile, (JSON.stringify(source) + '\n').repeat(2));
  const duplicateBefore = await Promise.all([readFile(sourceFile), readFile(receiverFile), readdir(memory), readdir(storage)]);
  const duplicate = await call();
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.memory.status, 'duplicate');
  assert.deepEqual(await Promise.all([readFile(sourceFile), readFile(receiverFile), readdir(memory), readdir(storage)]), duplicateBefore);
  await fiber.dispose();
  assert.equal(ctx.get('memoryUsageCorrelation'), undefined);
  assert.equal((await call()).status, 'incomplete');
  assert.deepEqual(await Promise.all([readFile(sourceFile), readFile(receiverFile), readdir(memory), readdir(storage)]), duplicateBefore);
});

test('duplicate correlation IDs do not imply deduplication', async t => {
  const f = await fixture(t);
  const result = await f.tools.get('memory_usage').execute({ action: 'record', kind: 'positive', href: key });
  assert.equal(await f.runtime.recordCorrelatedAdoptionSignal({ schemaVersion: 1, eventId: result.correlationId, objectKey: key, kind: 'positive' }), 'appended');
  const matches = (await readDecisions(f.storage)).filter(row => row.correlationId === result.correlationId);
  assert.equal(matches.length, 2);
  assert.notEqual(matches[0].candidate_id, matches[1].candidate_id);
});
