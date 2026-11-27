import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, symlink, rename, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { readCorrelation, createCorrelationPeerGate } from '../src/correlation-read.js';
import { apply, TOOL_NAMES } from '../index.js';

const id = '12345678-1234-4234-8234-123456789abc';
const row = { objectKey: 'functions/test.md', kind: 'positive', note: 'private note', noteStatus: 'available' };
const peerResult = (rows = [row]) => ({ status: rows.length ? 'observed' : 'not_observed', scope: 'selected_sources_complete', snapshot: 'unknown', sourceState: 'present', rows, duplicate: rows.length === 2, overflow: false });
const service = value => ({ readUsageCorrelation: async () => value });
const entry = (adoption = row) => ({ correlationId: id, gate: 'adoption_nomination', origin: 'adoption', adoption });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'valve-correlation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'mind-valves.jsonl') };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('one scope keeps a hung peer slot through timeout and service changes', async t => {
  const f = await fixture(t);
  await writeFile(f.path, JSON.stringify(entry()) + '\n');
  const before = await Promise.all([readFile(f.path, 'utf8'), readdir(f.dir)]);
  let timeout, calls = 0;
  const gate = createCorrelationPeerGate({ schedule: fn => { timeout = fn; return 1; }, cancel: () => {} });
  const pending = deferred(), started = deferred();
  let current = { readUsageCorrelation: () => { calls++; started.resolve(); return pending.promise; } };
  const run = key => readCorrelation(f.dir, () => current, key, gate);
  const first = run(id);
  await started.promise;
  const otherId = '22345678-1234-4234-8234-123456789abc';
  assert.equal((await run(otherId)).status, 'incomplete');
  current = service(peerResult());
  assert.equal((await run(id)).status, 'incomplete');
  timeout();
  const timedOut = await first;
  assert.equal(timedOut.status, 'incomplete');
  assert.equal(timedOut.peerProvenance, 'unverified');
  assert.equal((await run(id)).status, 'incomplete');
  assert.equal(calls, 1);
  pending.resolve(peerResult());
  await pending.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await run(id)).status, 'compared');
  assert.deepEqual(await Promise.all([readFile(f.path, 'utf8'), readdir(f.dir)]), before);
  for (const secret of [id, otherId, row.objectKey, row.note]) assert.ok(!JSON.stringify(timedOut).includes(secret));
});

test('late rejection and disposal are contained and release only on settlement', async t => {
  const f = await fixture(t);
  let timeout, calls = 0;
  const gate = createCorrelationPeerGate({ schedule: fn => { timeout = fn; return 1; }, cancel: () => {} });
  const pending = deferred(), started = deferred();
  const get = () => ({ readUsageCorrelation: () => { calls++; started.resolve(); return pending.promise; } });
  const first = readCorrelation(f.dir, get, id, gate);
  await started.promise;
  timeout();
  assert.equal((await first).status, 'incomplete');
  assert.equal((await readCorrelation(f.dir, get, id, gate)).status, 'incomplete');
  pending.reject(Error('secret peer rejection'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await readCorrelation(f.dir, () => service(peerResult()), id, gate)).memory.status, 'observed');
  assert.equal(calls, 1);
  const next = deferred(), nextStarted = deferred();
  const waiting = readCorrelation(f.dir, () => ({ readUsageCorrelation: () => { nextStarted.resolve(); return next.promise; } }), id, gate);
  await nextStarted.promise;
  gate.dispose();
  assert.equal((await waiting).status, 'incomplete');
  assert.equal((await readCorrelation(f.dir, get, id, gate)).status, 'incomplete');
  next.reject(Error('secret after disposal'));
  await new Promise(resolve => setImmediate(resolve));
});

test('hostile peer data is copied without invoking getters or iterators', async t => {
  const f = await fixture(t);
  await writeFile(f.path, JSON.stringify(entry()) + '\n');
  const secret = 'private proxy exception';
  let reads = 0;
  const proxy = new Proxy(peerResult(), { get(target, key, receiver) { if (++reads > 0) throw Error(secret); return Reflect.get(target, key, receiver); } });
  const copied = await readCorrelation(f.dir, () => service(proxy), id);
  assert.equal(copied.status, 'incomplete');
  assert.ok(!JSON.stringify(copied).includes(secret));
  const stable = new Proxy(peerResult(), { get(target, key, receiver) { if (key === 'duplicate') throw Error(secret); return Reflect.get(target, key, receiver); } });
  assert.equal((await readCorrelation(f.dir, () => service(stable), id)).status, 'compared');
  const broken = new Proxy(peerResult(), { getOwnPropertyDescriptor(target, key) { if (key === 'duplicate') throw Error(secret); return Reflect.getOwnPropertyDescriptor(target, key); } });
  const array = [row];
  Object.defineProperty(array, Symbol.iterator, { value() { throw Error(secret); } });
  const throwing = () => { throw Error(secret); };
  for (const peer of [broken, { ...peerResult(), rows: array }, { ...peerResult(), rows: [new Proxy(row, { ownKeys: throwing })] }]) {
    const result = await readCorrelation(f.dir, () => service(peer), id);
    assert.equal(result.status, 'incomplete');
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  assert.equal((await readCorrelation(f.dir, () => ({ readUsageCorrelation: throwing }), id)).status, 'incomplete');
  assert.equal((await readCorrelation(f.dir, () => undefined, id)).status, 'incomplete');
});

test('bounded comparisons redact contents and reject false matches', async t => {
  const f = await fixture(t);
  await writeFile(f.path, JSON.stringify(entry()) + '\n');
  const original = await readFile(f.path, 'utf8');
  const before = await readdir(f.dir);
  const get = result => readCorrelation(f.dir, () => service(result), id);
  const result = await get(peerResult());
  assert.equal(result.status, 'compared');
  assert.equal(result.peerProvenance, 'unverified');
  assert.deepEqual(result.comparison, { objectKey: 'match', kind: 'match', note: 'match' });
  for (const secret of [id, row.objectKey, row.note, 'candidate_id']) assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual((await get(peerResult([{ ...row, objectKey: 'functions/other.md', kind: 'correction', note: 'different' }]))).comparison, { objectKey: 'mismatch', kind: 'mismatch', note: 'mismatch' });
  assert.equal((await get(peerResult([{ ...row, note: '', noteStatus: 'missing_normalized_empty' }]))).comparison.note, 'unknown');
  assert.equal((await get(peerResult([row, row]))).status, 'duplicate');
  assert.equal((await get(peerResult([]))).status, 'not_observed');
  for (const bad of [null, {}, { ...peerResult(), duplicate: true }, { ...peerResult(), overflow: true }, { ...peerResult(), snapshot: 'atomic' }, { ...peerResult(), rows: [{ ...row, note: null }] }, { ...peerResult(), rows: [{ ...row, noteStatus: 'missing_normalized_empty' }] }, { ...peerResult(), rows: [{ ...row, objectKey: '../bad' }] }]) assert.equal((await get(bad)).status, 'incomplete');
  assert.equal((await readCorrelation(f.dir, () => { throw Error('secret'); }, id)).status, 'incomplete');
  assert.equal((await readCorrelation(f.dir, () => service(peerResult()), 'invalid')).reason, 'invalid_id');
  assert.deepEqual(await readdir(f.dir), before);
  assert.equal(await readFile(f.path, 'utf8'), original);
});

test('receiver detects missing, invalid, duplicate, corrupt and truncated scans', async t => {
  const f = await fixture(t);
  const run = () => readCorrelation(f.dir, () => service(peerResult()), id);
  assert.equal((await run()).receiver.sourceState, 'absent');
  assert.deepEqual(await readdir(f.dir), []);
  await writeFile(f.path, JSON.stringify(entry({ ...row, note: null })) + '\n');
  assert.equal((await run()).status, 'incomplete');
  await writeFile(f.path, JSON.stringify(entry()) + '\n' + JSON.stringify(entry()) + '\n');
  assert.equal((await run()).status, 'duplicate');
  await writeFile(f.path, JSON.stringify(entry()));
  assert.equal((await run()).status, 'incomplete');
  await writeFile(f.path, JSON.stringify(entry()) + '\n{bad\n');
  assert.equal((await run()).status, 'incomplete');
  await writeFile(f.path, ' '.repeat(4 * 1024 * 1024 + 1));
  assert.equal((await run()).status, 'incomplete');
});

test('missing directory and symlink sources are incomplete', async t => {
  const f = await fixture(t);
  const run = dir => readCorrelation(dir, () => service(peerResult()), id);
  assert.equal((await run(join(f.dir, 'missing'))).status, 'incomplete');
  const target = join(f.dir, 'target');
  await writeFile(target, JSON.stringify(entry()) + '\n');
  try { await symlink(target, f.path, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Symlink creation unavailable'); throw error; }
  assert.equal((await run(f.dir)).status, 'incomplete');
  const linkedDir = join(f.dir, 'linked-dir');
  const realDir = join(f.dir, 'real-dir');
  await mkdir(realDir);
  try { await symlink(realDir, linkedDir, 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Directory symlink creation unavailable'); throw error; }
  assert.equal((await run(linkedDir)).status, 'incomplete');
});

test('path replacement during reading is incomplete', async t => {
  const f = await fixture(t);
  await writeFile(f.path, JSON.stringify(entry()) + '\n');
  const alternate = join(f.dir, 'replacement');
  await writeFile(alternate, JSON.stringify(entry()) + '\n');
  const probe = await open(f.path, 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.read;
  let attempted = false, unsupported = false;
  t.mock.method(prototype, 'read', async function (...args) {
    if (!attempted) {
      attempted = true;
      try {
        await rename(f.path, join(f.dir, 'previous'));
        await rename(alternate, f.path);
      } catch (error) {
        if (['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) unsupported = true;
        else throw error;
      }
    }
    return original.apply(this, args);
  });
  const result = await readCorrelation(f.dir, () => service(peerResult()), id);
  assert.equal(attempted, true);
  if (unsupported) return t.skip('Open file replacement unavailable');
  assert.equal(result.status, 'incomplete');
});

test('real memory scanner compares with the receiver without writes', async t => {
  const f = await fixture(t);
  const combined = new URL('../../memory/src/usage-correlation-reader.js', import.meta.url);
  const standalone = new URL('../../dsh-memory-manager/src/usage-correlation-reader.js', import.meta.url);
  const { readUsageCorrelation } = await import((existsSync(combined) ? combined : standalone).href);
  await writeFile(f.path, JSON.stringify(entry()) + '\n');
  const source = join(f.dir, '.usage.jsonl');
  await writeFile(source, JSON.stringify({ correlationId: id, href: row.objectKey, kind: row.kind, note: row.note, t: new Date().toISOString() }) + '\n');
  const before = await Promise.all([readFile(f.path, 'utf8'), readFile(source, 'utf8'), readdir(f.dir)]);
  const result = await readCorrelation(f.dir, () => ({ readUsageCorrelation: key => readUsageCorrelation(f.dir, key) }), id);
  assert.equal(result.status, 'compared');
  assert.equal(result.peerProvenance, 'unverified');
  assert.deepEqual(result.comparison, { objectKey: 'match', kind: 'match', note: 'match' });
  assert.deepEqual(await Promise.all([readFile(f.path, 'utf8'), readFile(source, 'utf8'), readdir(f.dir)]), before);
});

test('registered tool disposal ends an active wait and blocks further peer calls', async t => {
  const f = await fixture(t);
  const pending = deferred(), started = deferred();
  const tools = new Map();
  let release, calls = 0;
  const peer = { readUsageCorrelation() { calls++; started.resolve(); return pending.promise; } };
  const ctx = { tools: { register: tool => tools.set(tool.name, tool) }, get: name => name === 'memoryUsageCorrelation' ? peer : undefined, set() {}, effect: fn => { release = fn(); }, inject() {}, logger: () => ({}) };
  apply(ctx, { storageDir: f.dir, patrol: { enabled: false } }, { correlationPeerGateOptions: { schedule: () => 1, cancel: () => {} } });
  const tool = tools.get(TOOL_NAMES.correlation);
  const first = tool.execute({ correlationId: id });
  await started.promise;
  release();
  const result = await first;
  assert.equal(result.status, 'incomplete');
  const host = join(process.env.DSH_INSTALL_DIR, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
  const { validateJsonSchemaValue } = createRequire(host)(host);
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result, 'value'), []);
  assert.equal((await tool.execute({ correlationId: id })).status, 'incomplete');
  assert.equal(calls, 1);
  pending.reject(Error('private late rejection'));
  await new Promise(resolve => setImmediate(resolve));
});

test('registered tool uses live peer lookup and host output schema', async t => {
  const f = await fixture(t);
  await writeFile(f.path, JSON.stringify(entry()) + '\n');
  let current;
  const tools = new Map();
  const noop = () => {};
  const ctx = { tools: { register: tool => tools.set(tool.name, tool) }, get: name => name === 'memoryUsageCorrelation' ? current : undefined, set: noop, on: noop, inject: noop, logger: () => ({}) };
  apply(ctx, { storageDir: f.dir, patrol: { enabled: false } });
  const tool = tools.get(TOOL_NAMES.correlation);
  assert.ok(tool);
  assert.equal((await tool.execute({ correlationId: id })).status, 'incomplete');
  current = service(peerResult());
  const result = await tool.execute({ correlationId: id });
  assert.equal(result.status, 'compared');
  const host = join(process.env.DSH_INSTALL_DIR, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
  const { validateJsonSchemaValue } = createRequire(host)(host);
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result, 'value'), []);
  assert.ok(validateJsonSchemaValue(tool.output.schema, { ...result, peerProvenance: 'verified' }, 'value').length > 0);
  const { peerProvenance: omitted, ...withoutProvenance } = result;
  assert.equal(omitted, 'unverified');
  assert.ok(validateJsonSchemaValue(tool.output.schema, withoutProvenance, 'value').length > 0);
  current = undefined;
  assert.equal((await tool.execute({ correlationId: id })).status, 'incomplete');
});
