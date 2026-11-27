import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { traceObject } from '../src/object-trace.js';

async function root(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'object-trace-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const line = (o) => `${JSON.stringify(o)}\n`;
const snap = async (r) => {
  const out = {};
  for (const f of ['.write-ledger.jsonl', '.usage.jsonl', 'MEMORY.md', '.usage/2026-11.jsonl']) {
    try { const s = await fs.stat(path.join(r, f)); out[f] = `${s.size}:${s.mtimeMs}`; } catch { out[f] = 'none'; }
  }
  return out;
};

test('trace reports write, index, recall, read and explicit adoption per hop', async (t) => {
  const r = await root(t);
  const key = 'functions/demo.md';
  await fs.writeFile(path.join(r, '.write-ledger.jsonl'),
    line({ t: '2026-11-23T01:00:00.000Z', key, hash: 'h1', tool: 'memory_write', request_id: '11111111-1111-4111-8111-111111111111', objectKey: key }));
  await fs.writeFile(path.join(r, 'MEMORY.md'), `# Memory\n\n| [demo](functions/demo.md) | row |\n`);
  await fs.mkdir(path.join(r, '.usage'));
  await fs.writeFile(path.join(r, '.usage.jsonl'), line({ t: '2026-11-23T02:00:00.000Z', href: key, kind: 'recall' }));
  await fs.writeFile(path.join(r, '.usage', '2026-11.jsonl'),
    line({ t: '2026-11-23T03:00:00.000Z', href: key, kind: 'read' }) +
    line({ t: '2026-11-23T04:00:00.000Z', href: key, kind: 'positive', note: '就是这个' }));

  const before = await snap(r);
  const result = await traceObject({ root: r, objectKey: key });
  assert.equal(result.status, 'ok');
  assert.equal(result.objectKey, key);
  assert.equal(result.hops.write.status, 'present');
  assert.equal(result.hops.write.evidence[0].request_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(result.hops.index.status, 'present');
  assert.equal(result.hops.recall.status, 'present');
  assert.equal(result.hops.read.status, 'present');
  assert.equal(result.hops.adoption.status, 'present');
  assert.equal(result.hops.adoption.evidence[0].note, '就是这个');
  assert.equal(result.execution, 'not_observed');
  assert.deepEqual(await snap(r), before, 'trace must not write any ledger or index');
});

test('missing adoption is not_observed, never "no"; cross-zone keys do not leak', async (t) => {
  const r = await root(t);
  await fs.mkdir(path.join(r, '.usage'));
  await fs.writeFile(path.join(r, '.usage.jsonl'),
    line({ t: '2026-11-23T02:00:00.000Z', href: 'insights/demo.md', kind: 'positive', note: 'other zone' }));
  const a = await traceObject({ root: r, objectKey: 'functions/demo.md' });
  assert.equal(a.hops.adoption.status, 'not_observed');
  assert.equal(a.absenceMeansNoAdoption, false);
  assert.equal(a.hops.adoption.userIdentity, 'unverified');
  assert.equal(a.hops.adoption.governanceEligible, false);
  assert.equal(a.hops.write.status, 'missing');
  const b = await traceObject({ root: r, objectKey: 'insights/demo.md' });
  assert.equal(b.hops.adoption.status, 'present');
});

test('invalid or forged object keys are rejected before any scan', async (t) => {
  const r = await root(t);
  for (const key of ['../functions/demo.md', 'other/demo.md', 'functions/demo', 'FUNCTI/functions/demo.md', '']) {
    const res = await traceObject({ root: r, objectKey: key });
    assert.equal(res.status, 'error', String(key));
    assert.equal(res.reason, 'invalid_object_key');
  }
  const forged = await traceObject({ root: r, objectKey: 'functions/demo.md', request_id: 'x', name: 'y' });
  assert.equal(forged.status, 'ok', 'extra fields are ignored, not honored as filters');
});

test('a UTF-8 BOM on the first shard line is tolerated, not treated as corruption', async (t) => {
  const r = await root(t);
  const key = 'functions/demo.md';
  await fs.mkdir(path.join(r, '.usage'));
  await fs.writeFile(path.join(r, '.usage', '2026-11.jsonl'),
    `\ufeff${line({ t: '2026-11-23T02:00:00.000Z', href: key, kind: 'read' })}`);
  const res = await traceObject({ root: r, objectKey: key });
  assert.equal(res.status, 'ok');
  assert.equal(res.hops.read.status, 'present');
});

test('corrupt ledger row yields incomplete with no leaked matches', async (t) => {
  const r = await root(t);
  const key = 'functions/demo.md';
  await fs.writeFile(path.join(r, '.write-ledger.jsonl'),
    line({ t: '2026-11-23T01:00:00.000Z', key, hash: 'h1', objectKey: key }) + '{bad json}\n');
  const res = await traceObject({ root: r, objectKey: key });
  assert.equal(res.status, 'incomplete');
  assert.deepEqual(res.hops, {});
});

test('more than 48 usage shards yields incomplete instead of partial evidence', async (t) => {
  const r = await root(t);
  const key = 'functions/demo.md';
  const dir = path.join(r, '.usage');
  await fs.mkdir(dir);
  const name = (i) => `${2020 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}.jsonl`;
  for (let i = 0; i < 48; i++) {
    await fs.writeFile(path.join(dir, name(i)), line({ href: key, kind: 'read', t: '2020-01-01T00:00:00Z' }));
  }
  const within = await traceObject({ root: r, objectKey: key });
  assert.equal(within.status, 'ok');
  assert.equal(within.hops.read.evidence.length, 48);
  await fs.writeFile(path.join(dir, name(48)), line({ href: key, kind: 'positive', t: '2024-01-01T00:00:00Z' }));
  const exceeded = await traceObject({ root: r, objectKey: key });
  assert.equal(exceeded.status, 'incomplete');
  assert.deepEqual(exceeded.hops, {});
});

test('a shard removed after enumeration is incomplete while an absent legacy file is optional', async (t) => {
  const r = await root(t);
  const key = 'functions/demo.md';
  const dir = path.join(r, '.usage');
  const shard = path.join(dir, '2026-11.jsonl');
  await fs.mkdir(dir);
  await fs.writeFile(shard, line({ href: key, kind: 'positive', t: '2026-11-23T00:00:00Z' }));
  const before = await traceObject({ root: r, objectKey: key });
  assert.equal(before.status, 'ok');
  assert.equal(before.hops.adoption.status, 'present');
  const open = fs.open.bind(fs);
  let removed = false;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (file === shard && !removed) { removed = true; await fs.unlink(shard); }
    return open(file, ...args);
  });
  const after = await traceObject({ root: r, objectKey: key });
  assert.equal(removed, true);
  assert.equal(after.status, 'incomplete');
  assert.deepEqual(after.hops, {});
});

test('an unambiguous archive JSONL is scanned as evidence; unrelated files are ignored', async (t) => {
  const r = await root(t), key = 'functions/demo.md';
  const archive = path.join(r, '.usage', 'archive');
  const inspect = () => traceObject({ root: r, objectKey: key });
  assert.equal((await inspect()).status, 'ok');
  await fs.mkdir(archive, { recursive: true });
  assert.equal((await inspect()).status, 'ok');
  await fs.writeFile(path.join(archive, 'notes.txt'), 'unrelated');
  await fs.writeFile(path.join(archive, '2026-01.jsonl.gz'), 'unrelated');
  assert.equal((await inspect()).status, 'ok');
  await fs.writeFile(path.join(archive, '2026-01.jsonl'),
    line({ t: '2026-01-01T00:00:00Z', href: key, kind: 'read' }) +
    line({ t: '2026-01-02T00:00:00Z', href: key, kind: 'positive', note: 'archived' }));
  const result = await inspect();
  assert.equal(result.status, 'ok');
  assert.equal(result.hops.read.status, 'present', 'archive-only read hop is included');
  assert.equal(result.hops.adoption.status, 'present');
  assert.equal(result.hops.adoption.evidence[0].note, 'archived');
});

test('an inaccessible archive or non-directory archive is incomplete', async (t) => {
  const r = await root(t), key = 'functions/demo.md';
  const archive = path.join(r, '.usage', 'archive');
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.writeFile(archive, 'not a directory');
  const notDirectory = await traceObject({ root: r, objectKey: key });
  assert.equal(notDirectory.status, 'incomplete');
  assert.deepEqual(notDirectory.hops, {});
  await fs.unlink(archive);
  await fs.mkdir(archive);
  const readdir = fs.readdir.bind(fs);
  t.mock.method(fs, 'readdir', async (dir, ...args) => {
    if (dir === archive) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return readdir(dir, ...args);
  });
  const denied = await traceObject({ root: r, objectKey: key });
  assert.equal(denied.status, 'incomplete');
  assert.deepEqual(denied.hops, {});
});

test('archive junction is rejected without enumerating its external target', async (t) => {
  const r = await root(t), external = await root(t), key = 'functions/demo.md';
  const archive = path.join(r, '.usage', 'archive');
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.writeFile(path.join(external, '2026-01.jsonl'), line({ href: key, kind: 'positive' }));
  await fs.symlink(external, archive, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await fs.lstat(archive)).isSymbolicLink(), true);
  const readdir = fs.readdir.bind(fs);
  let archiveReads = 0;
  t.mock.method(fs, 'readdir', async (dir, ...args) => {
    if (dir === archive || dir === external) archiveReads++;
    return readdir(dir, ...args);
  });
  const result = await traceObject({ root: r, objectKey: key });
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.hops, {});
  assert.equal(archiveReads, 0);
});

test('untrusted verdict rows cannot promote identity, attribution, or governance', async (t) => {
  const r = await root(t), key = 'functions/demo.md';
  await fs.writeFile(path.join(r, '.usage.jsonl'),
    line({ href: key, kind: 'positive', note: 'yes', provenance: 'verified', userIdentity: 'authenticated', governanceEligible: true, goalProof: 'achieved' }) +
    line({ href: key, kind: 'correction', note: 'no', principleAttribution: 'verified' }) +
    line({ href: key, kind: 'read' }));
  const result = await traceObject({ root: r, objectKey: key });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.hops.adoption, {
    status: 'present',
    total: 2,
    evidence: [{ kind: 'positive', href: key, note: 'yes' }, { kind: 'correction', href: key, note: 'no' }],
    evidenceTruncated: false,
    attestation: 'usage_signal_record',
    provenance: 'unverified_legacy_or_caller_declaration',
    userIdentity: 'unverified',
    goalProof: 'not_evaluated',
    principleAttribution: 'not_evaluated',
    governanceEligible: false,
  });
  await fs.appendFile(path.join(r, '.usage.jsonl'), '{bad json}\n');
  const incomplete = await traceObject({ root: r, objectKey: key });
  assert.equal(incomplete.status, 'incomplete');
  assert.deepEqual(incomplete.hops, {});
});

test('large response retains exact totals and trims evidence within the byte budget', async (t) => {
  const r = await root(t), key = 'functions/demo.md';
  const row = line({ href: key, kind: 'positive', note: 'x'.repeat(500) });
  await fs.writeFile(path.join(r, '.usage.jsonl'), row.repeat(300));
  const result = await traceObject({ root: r, objectKey: key });
  assert.equal(result.status, 'ok');
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 65536);
  assert.equal(result.hops.adoption.total, 300);
  assert.ok(result.hops.adoption.evidence.length < 256);
  assert.equal(result.hops.adoption.evidenceTruncated, true);
  assert.equal(result.hops.adoption.governanceEligible, false);
});

test('row limit applies to all rows rather than only matches', async (t) => {
  const r = await root(t), key = 'functions/demo.md';
  const file = path.join(r, '.usage.jsonl');
  const row = line({ href: key, kind: 'recall' });
  await fs.writeFile(file, row.repeat(10000));
  const full = await traceObject({ root: r, objectKey: key });
  assert.equal(full.status, 'ok');
  assert.equal(full.hops.recall.total, 10000);
  assert.equal(full.hops.recall.evidenceTruncated, true);
  await fs.appendFile(file, line({ href: 'functions/other.md', kind: 'read' }));
  const exceeded = await traceObject({ root: r, objectKey: key });
  assert.equal(exceeded.status, 'incomplete');
  assert.deepEqual(exceeded.hops, {});
});

test('counts every matching row across shards and detects corruption after the sample cap', async (t) => {
  const r = await root(t), key = 'functions/demo.md';
  const shard = path.join(r, '.usage', '2026-11.jsonl');
  await fs.mkdir(path.dirname(shard));
  await fs.writeFile(path.join(r, '.write-ledger.jsonl'), line({ key }).repeat(300));
  await fs.writeFile(path.join(r, '.usage.jsonl'), line({ href: key, kind: 'read' }).repeat(300));
  await fs.writeFile(shard, line({ href: key, kind: 'read' }).repeat(270) +
    line({ href: key, kind: 'positive' }) + line({ href: 'functions/other.md', kind: 'read' }));
  const result = await traceObject({ root: r, objectKey: key });
  assert.equal(result.status, 'ok');
  assert.equal(result.hops.write.total, 300);
  assert.equal(result.hops.read.total, 570);
  assert.equal(result.hops.read.evidence.length, 256);
  assert.equal(result.hops.read.evidenceTruncated, true);
  assert.equal(result.hops.adoption.total, 1);
  assert.equal(result.hops.adoption.evidenceTruncated, false);
  await fs.appendFile(shard, '{corrupt');
  const corrupt = await traceObject({ root: r, objectKey: key });
  assert.equal(corrupt.status, 'incomplete');
  assert.deepEqual(corrupt.hops, {});
});
