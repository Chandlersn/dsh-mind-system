/**
 * Archive-tolerant whole-ledger readers (reader-side blocker removal).
 *
 * Before this fix, ANY `.usage/archive/YYYY-MM.jsonl` file made object-trace and
 * adoption-evidence return `incomplete` for every query, and usageFiles() never
 * enumerated archives at all — so a moved compacted month silently disappeared
 * from every whole-file consumer. These tests pin the new contract with isolated
 * mkdtemp roots only; no real `~/.dsh` data is read or written.
 *
 * Assertions are concrete: hop statuses, row counts, marker notes and stable
 * reason codes — never just "no error".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { usageFiles, readUsage, usagePath, usageShardDir, usageArchivePath } from '../src/usage.js';
import { traceObject } from '../src/object-trace.js';
import { readAdoptionEvidence } from '../src/adoption-evidence.js';

async function root(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-archive-readers-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const line = (o) => `${JSON.stringify(o)}\n`;
const verdict = (t, href, kind, note) => line({ t, href, kind, note });
async function write(dir, rel, text) {
  const file = path.join(dir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
  return file;
}

// --- 1. Baseline: legacy + live shard, no archive ----------------------------
test('baseline legacy + live shard: concrete hop statuses and adoption rows are unchanged', async (t) => {
  const r = await root(t);
  const key = 'functions/archive-test.md';
  await write(r, '.usage.jsonl',
    line({ t: '2026-10-01T00:00:00Z', href: key, kind: 'recall' }) +
    verdict('2026-10-02T00:00:00Z', key, 'positive', 'legacy-verdict'));
  await write(r, '.usage/2026-11.jsonl',
    line({ t: '2026-11-01T00:00:00Z', href: key, kind: 'read' }) +
    verdict('2026-11-02T00:00:00Z', key, 'correction', 'live-verdict'));

  const files = await usageFiles(r);
  assert.deepEqual(files.map((f) => f.source), ['legacy', 'live']);
  assert.deepEqual(files.map((f) => f.month), ['', '2026-11']);

  const trace = await traceObject({ root: r, objectKey: key });
  assert.equal(trace.status, 'ok');
  assert.equal(trace.hops.recall.status, 'present');
  assert.equal(trace.hops.read.status, 'present');
  assert.equal(trace.hops.adoption.status, 'present');
  assert.equal(trace.hops.adoption.evidence.length, 2);
  assert.equal(trace.hops.adoption.attestation, 'usage_signal_record');
  assert.equal(trace.hops.adoption.governanceEligible, false);

  const evidence = await readAdoptionEvidence({ root: r, objectKey: key });
  assert.equal(evidence.status, 'ok');
  assert.equal(evidence.rows.length, 2, 'both verdicts are paged');
  assert.deepEqual(evidence.rows.map((x) => x.note), ['legacy-verdict', 'live-verdict']);
});

// --- 2. Archive present, NO duplicate month ----------------------------------
test('archive-only marker is included in both trace hops and adoption evidence', async (t) => {
  const r = await root(t);
  const key = 'functions/archive-only.md';
  await write(r, '.usage.jsonl', line({ t: '2026-10-01T00:00:00Z', href: key, kind: 'recall' }));
  await write(r, '.usage/archive/2026-09.jsonl',
    line({ t: '2026-09-01T00:00:00Z', href: key, kind: 'read' }) +
    verdict('2026-09-02T00:00:00Z', key, 'positive', 'ARCHIVE-ONLY-MARKER'));

  const files = await usageFiles(r);
  assert.deepEqual(files.map((f) => f.source), ['legacy', 'archive']);
  assert.deepEqual(files.map((f) => f.month), ['', '2026-09']);

  const trace = await traceObject({ root: r, objectKey: key });
  assert.equal(trace.status, 'ok');
  assert.equal(trace.hops.read.status, 'present', 'archive-only read hop appears');
  assert.equal(trace.hops.read.evidence[0].t, '2026-09-01T00:00:00Z');
  assert.equal(trace.hops.adoption.status, 'present');
  assert.equal(trace.hops.adoption.evidence[0].note, 'ARCHIVE-ONLY-MARKER');

  const evidence = await readAdoptionEvidence({ root: r, objectKey: key });
  assert.equal(evidence.status, 'ok');
  assert.equal(evidence.rows.length, 1);
  assert.equal(evidence.rows[0].note, 'ARCHIVE-ONLY-MARKER');
});

// --- 3. Same month in BOTH locations -----------------------------------------
test('same-month live+archive duplicate fails closed with a stable reason code', async (t) => {
  const r = await root(t);
  const key = 'functions/ambiguous.md';
  const row = verdict('2026-11-01T00:00:00Z', key, 'positive', 'dup');
  await write(r, '.usage/2026-11.jsonl', row);
  await write(r, '.usage/archive/2026-11.jsonl', row);

  await assert.rejects(usageFiles(r), { code: 'USAGE_AMBIGUOUS_MONTH' });

  const trace = await traceObject({ root: r, objectKey: key });
  assert.equal(trace.status, 'incomplete');
  assert.equal(trace.reason, 'scan_incomplete');
  assert.deepEqual(trace.hops, {}, 'no partial hops leak');

  const evidence = await readAdoptionEvidence({ root: r, objectKey: key });
  assert.equal(evidence.status, 'incomplete');
  assert.equal(evidence.reason, 'ambiguous_sources', 'stable reason code');
  assert.deepEqual(evidence.rows, [], 'no double counting or silent pick');
});

// --- 4. Symlink / junction in archive ----------------------------------------
test('a junction inside .usage/archive is refused without following its target', async (t) => {
  const r = await root(t);
  const outside = await root(t);
  const key = 'functions/link.md';
  await write(outside, '2026-11.jsonl', verdict('2026-11-01T00:00:00Z', key, 'positive', 'OUTSIDE'));
  const archive = path.join(r, '.usage', 'archive');
  await fs.mkdir(path.dirname(archive), { recursive: true });
  try {
    await fs.symlink(outside, archive, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`link unavailable: ${error.code}`);
    throw error;
  }
  assert.equal((await fs.lstat(archive)).isSymbolicLink(), true);

  await assert.rejects(usageFiles(r), { code: 'USAGE_LINK_NOT_ALLOWED' });
  const trace = await traceObject({ root: r, objectKey: key });
  assert.equal(trace.status, 'incomplete');
  assert.deepEqual(trace.hops, {});
  const evidence = await readAdoptionEvidence({ root: r, objectKey: key });
  assert.equal(evidence.status, 'incomplete');
  assert.equal(evidence.reason, 'unsafe_source');
  assert.deepEqual(evidence.rows, []);
  assert.ok(!JSON.stringify(trace).includes('OUTSIDE'), 'external target bytes never leak');
});

// --- 5. Malformed / truncated UTF-8 in archive -------------------------------
test('malformed row and truncated bytes in archive fail closed without leaking', async (t) => {
  const r = await root(t);
  const key = 'functions/bad-archive.md';
  await write(r, '.usage.jsonl', verdict('2026-10-01T00:00:00Z', key, 'positive', 'good'));
  const archive = usageArchivePath(r, '2026-09');
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.writeFile(archive, verdict('2026-09-01T00:00:00Z', key, 'positive', 'BADBYTES-LEAK') + '{not json}\n');

  const trace = await traceObject({ root: r, objectKey: key });
  assert.equal(trace.status, 'incomplete');
  assert.deepEqual(trace.hops, {});

  const evidence = await readAdoptionEvidence({ root: r, objectKey: key });
  assert.equal(evidence.status, 'incomplete');
  assert.equal(evidence.reason, 'bad_row');
  assert.deepEqual(evidence.rows, []);
  assert.ok(!JSON.stringify(evidence).includes('BADBYTES-LEAK'), 'bad row bytes never leak');

  // Truncated/invalid UTF-8 tail (replacement char) must also fail closed.
  await fs.writeFile(archive, Buffer.concat([
    Buffer.from(verdict('2026-09-01T00:00:00Z', key, 'positive', 'ok')),
    Buffer.from([0xff, 0xfe, 0xfd]),
  ]));
  const truncated = await readAdoptionEvidence({ root: r, objectKey: key });
  assert.equal(truncated.status, 'incomplete');
  assert.deepEqual(truncated.rows, []);
  assert.ok(!JSON.stringify(truncated).includes('\ufffd'), 'no replacement characters leak');
});

// --- 6. Cursor across archive migration --------------------------------------
test('cursor across archive migration never returns a DIFFERENT verified row', async (t) => {
  const r = await root(t);
  const key = 'functions/cursor.md';
  const t1 = '2026-10-01T00:00:00Z';
  const t2 = '2026-10-02T00:00:00Z';
  await write(r, '.usage/2026-10.jsonl', verdict(t1, key, 'positive', 'p1') + verdict(t2, key, 'correction', 'c2'));

  const first = await readAdoptionEvidence({ root: r, objectKey: key, limit: 1 });
  assert.equal(first.status, 'ok');
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].note, 'p1');
  const cursor = first.nextCursor;
  assert.ok(cursor, 'a cursor was issued');

  // Migration: move the SAME month into archive and add an earlier archived row.
  await fs.mkdir(path.join(r, '.usage', 'archive'), { recursive: true });
  await fs.rename(path.join(r, '.usage', '2026-10.jsonl'), path.join(r, '.usage', 'archive', '2026-10.jsonl'));
  await fs.appendFile(path.join(r, '.usage', 'archive', '2026-10.jsonl'), verdict('2026-09-15T00:00:00Z', key, 'positive', 'migrated'));

  const after = await readAdoptionEvidence({ root: r, objectKey: key, limit: 1, cursor });
  // INVARIANT: a cursor is accepted ONLY when its t/k/n identity still matches
  // at the same absolute index. Otherwise incomplete/cursor_not_found. It must
  // never silently return a different row (e.g. 'migrated' or 'c2').
  if (after.status === 'ok') {
    assert.equal(after.rows.length, 1);
    assert.notEqual(after.rows[0].note, 'migrated', 'never silently returns a newly inserted row');
    assert.ok(['p1', 'c2'].includes(after.rows[0].note));
    assert.ok(after.rows[0].t >= t1, 'returned row is at or after the cursor row');
  } else {
    assert.equal(after.status, 'incomplete');
    assert.equal(after.reason, 'cursor_not_found');
    assert.deepEqual(after.rows, []);
  }
  // Restarting from page 1 is always safe and sees all migrated evidence.
  const restart = await readAdoptionEvidence({ root: r, objectKey: key, limit: 10 });
  assert.equal(restart.status, 'ok');
  assert.equal(restart.rows.length, 3, 'full archive-aware ledger is visible after restart');
});

// --- 7. Exact-once counting after compaction ---------------------------------
test('a compacted archive row is counted EXACTLY ONCE by readUsage', async (t) => {
  const r = await root(t);
  const key = 'functions/compacted.md';
  const t0 = new Date().toISOString();
  const archive = usageArchivePath(r, t0.slice(0, 7));
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.writeFile(archive, verdict(t0, key, 'read', 'count-once'));

  const files = await usageFiles(r);
  assert.equal(files.filter((f) => f.source === 'archive').length, 1);
  const rows = await readUsage(r, 30);
  assert.equal(rows.length, 1, 'one archived row yields exactly one entry, not two');
  assert.equal(rows[0].href, key);
});

// --- 8. Bounding -------------------------------------------------------------
test('enumeration and row caps return incomplete rather than partial results', async (t) => {
  const r = await root(t);
  const key = 'functions/bounded.md';
  // usageFiles hard bound: 65 sources (legacy + 64 shards) must throw.
  await write(r, '.usage.jsonl', verdict('2026-10-01T00:00:00Z', key, 'positive', 'legacy'));
  for (let i = 0; i < 64; i++) {
    const month = `${2000 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
    await write(r, `.usage/${month}.jsonl`, verdict(`${month}-01T00:00:00Z`, key, 'read', 'x'));
  }
  await assert.rejects(usageFiles(r), { code: 'USAGE_FILE_LIMIT' });
  const trace = await traceObject({ root: r, objectKey: key });
  assert.equal(trace.status, 'incomplete');
  assert.deepEqual(trace.hops, {});
  const evidence = await readAdoptionEvidence({ root: r, objectKey: key });
  assert.equal(evidence.status, 'incomplete');
  assert.equal(evidence.reason, 'source_limit');
  assert.deepEqual(evidence.rows, []);
});
