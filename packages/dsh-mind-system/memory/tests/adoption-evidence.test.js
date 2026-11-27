import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readAdoptionEvidence } from '../src/adoption-evidence.js';

async function root(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adoption-evidence-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const line = (o) => `${JSON.stringify(o)}\n`;
async function snap(r) {
  const out = {};
  for (const f of ['.usage.jsonl', '.usage/2026-11.jsonl', '.write-ledger.jsonl', 'MEMORY.md']) {
    try { const s = await fs.stat(path.join(r, f)); out[f] = `${s.size}:${s.mtimeMs}`; } catch { out[f] = 'none'; }
  }
  return out;
}

test('only explicit verdicts for the exact objectKey are returned, with safety fields', async (t) => {
  const r = await root(t);
  const key = 'functions/心智编排层.md';
  await fs.mkdir(path.join(r, '.usage'));
  await fs.writeFile(path.join(r, '.usage.jsonl'),
    line({ t: '2026-11-20T01:00:00.000Z', href: key, kind: 'recall' }) +
    line({ t: '2026-11-20T01:00:01.000Z', href: key, kind: 'read' }) +
    line({ t: '2026-11-20T01:00:02.000Z', href: key, kind: 'positive', note: '就是这个' }) +
    line({ t: '2026-11-20T01:00:03.000Z', href: 'insights/other.md', kind: 'correction', note: '别的' }));
  const before = await snap(r);
  const res = await readAdoptionEvidence({ root: r, objectKey: key });
  assert.equal(res.status, 'ok');
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].kind, 'positive');
  assert.equal(res.rows[0].note, '就是这个');
  assert.equal(res.provenance, 'caller/user-action');
  assert.equal(res.goalProof, 'not_evaluated');
  assert.equal(res.governanceEligible, false);
  assert.equal(res.attestation, 'adoption_signal');
  assert.deepEqual(await snap(r), before, 'query must not append usage or change bytes/mtime');
});

test('a discovered shard that disappears during read fails without partial results', async (t) => {
  const r = await root(t);
  const key = 'functions/demo.md';
  const shard = path.join(r, '.usage', '2026-11.jsonl');
  await fs.mkdir(path.dirname(shard));
  await fs.writeFile(path.join(r, '.usage.jsonl'),
    line({ t: '2026-10-01T00:00:00.000Z', href: key, kind: 'positive', note: 'already read' }));
  await fs.writeFile(shard, line({ t: '2026-11-01T00:00:00.000Z', href: key, kind: 'correction' }));

  const originalLstat = fs.lstat;
  let shardStats = 0;
  let injected = false;
  fs.lstat = async (file, ...args) => {
    if (file === shard && ++shardStats === 2) {
      injected = true;
      await fs.unlink(shard);
    }
    return originalLstat(file, ...args);
  };
  try {
    const result = await readAdoptionEvidence({ root: r, objectKey: key });
    assert.equal(injected, true, 'the enumerated shard must reach the read operation');
    assert.equal(result.status, 'incomplete');
    assert.equal(result.reason, 'read_failed');
    assert.deepEqual(result.rows, []);
  } finally {
    fs.lstat = originalLstat;
  }
});

test('an undiscovered optional legacy file is an empty source', async (t) => {
  const r = await root(t);
  const result = await readAdoptionEvidence({ root: r, objectKey: 'functions/demo.md' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.rows, []);
  assert.equal(result.nextCursor, null);
});

test('unambiguous monthly archives are read as evidence, not refused', async (t) => {
  const r = await root(t);
  const key = 'functions/demo.md';
  const archive = path.join(r, '.usage', 'archive');
  await fs.mkdir(archive, { recursive: true });
  await fs.writeFile(path.join(r, '.usage.jsonl'), line({ t: '2026-11-01T00:00:00.000Z', href: key, kind: 'positive', note: 'live' }));
  await fs.writeFile(path.join(archive, '2026-10.jsonl'), line({ t: '2026-10-01T00:00:00.000Z', href: key, kind: 'correction', note: 'archived' }));
  const result = await readAdoptionEvidence({ root: r, objectKey: key });
  assert.equal(result.status, 'ok');
  assert.equal(result.rows.length, 2, 'live and archived verdicts are both returned');
  assert.deepEqual(result.rows.map((row) => row.note), ['archived', 'live']);
});

test('empty archive and unrelated files leave evidence available', async (t) => {
  const r = await root(t);
  const archive = path.join(r, '.usage', 'archive');
  await fs.mkdir(archive, { recursive: true });
  for (const unrelated of [false, true]) {
    if (unrelated) await fs.writeFile(path.join(archive, 'notes.txt'), 'not a ledger');
    const result = await readAdoptionEvidence({ root: r, objectKey: 'functions/demo.md' });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.rows, []);
  }
});

test('archive permission errors return incomplete without partial results', async (t) => {
  const r = await root(t);
  const key = 'functions/demo.md';
  const archive = path.join(r, '.usage', 'archive');
  await fs.mkdir(archive, { recursive: true });
  await fs.writeFile(path.join(r, '.usage.jsonl'), line({ t: '2026-11-01T00:00:00.000Z', href: key, kind: 'positive' }));
  const originalReaddir = fs.readdir;
  let injected = false;
  fs.readdir = async (dir, ...args) => {
    if (dir === archive) {
      injected = true;
      throw Object.assign(new Error('injected access denial'), { code: 'EACCES' });
    }
    return originalReaddir(dir, ...args);
  };
  try {
    const result = await readAdoptionEvidence({ root: r, objectKey: key });
    assert.equal(injected, true);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.reason, 'read_failed');
    assert.deepEqual(result.rows, []);
  } finally {
    fs.readdir = originalReaddir;
  }
});

test('an archive junction is rejected before its external directory is enumerated', async (t) => {
  const r = await root(t);
  const external = await root(t);
  const archive = path.join(r, '.usage', 'archive');
  await fs.mkdir(path.dirname(archive));
  await fs.symlink(external, archive, process.platform === 'win32' ? 'junction' : 'dir');
  const originalReaddir = fs.readdir;
  let enumerated = false;
  fs.readdir = async (dir, ...args) => {
    if (dir === archive) enumerated = true;
    return originalReaddir(dir, ...args);
  };
  try {
    const result = await readAdoptionEvidence({ root: r, objectKey: 'functions/demo.md' });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.reason, 'unsafe_source', 'a link is refused with a stable reason code');
    assert.deepEqual(result.rows, []);
    assert.equal(enumerated, false, 'the external directory must not be enumerated');
  } finally {
    fs.readdir = originalReaddir;
  }
});

test('a non-directory archive path is not treated as missing', async (t) => {
  const r = await root(t);
  await fs.mkdir(path.join(r, '.usage'));
  await fs.writeFile(path.join(r, '.usage', 'archive'), 'not a directory');
  const result = await readAdoptionEvidence({ root: r, objectKey: 'functions/demo.md' });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.reason, 'read_failed');
  assert.deepEqual(result.rows, []);
});

test('pagination walks all verdicts without duplicates, including monthly shards', async (t) => {
  const r = await root(t);
  const key = 'functions/memory-manager.md';
  await fs.mkdir(path.join(r, '.usage'));
  await fs.writeFile(path.join(r, '.usage.jsonl'),
    line({ t: '2026-10-01T00:00:00.000Z', href: key, kind: 'correction', note: 'c1' }));
  await fs.writeFile(path.join(r, '.usage', '2026-11.jsonl'),
    line({ t: '2026-11-01T00:00:00.000Z', href: key, kind: 'positive', note: 'p1' }) +
    line({ t: '2026-11-02T00:00:00.000Z', href: key, kind: 'correction', note: 'c2' }));
  const all = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const page = await readAdoptionEvidence({ root: r, objectKey: key, limit: 2, cursor });
    assert.equal(page.status, 'ok');
    all.push(...page.rows.map((x) => x.note));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(all.sort(), ['c1', 'c2', 'p1']);
  assert.equal(new Set(all).size, 3, 'no duplicates across pages');
});

test('forged keys, bad cursors and BOM-prefixed shards are handled honestly', async (t) => {
  const r = await root(t);
  const key = 'functions/demo.md';
  await fs.mkdir(path.join(r, '.usage'));
  await fs.writeFile(path.join(r, '.usage', '2026-11.jsonl'),
    `\ufeff${line({ t: '2026-11-20T01:00:02.000Z', href: key, kind: 'positive', note: 'ok' })}`);
  for (const bad of ['../functions/demo.md', 'other/demo.md', 'functions/demo']) {
    const res = await readAdoptionEvidence({ root: r, objectKey: bad });
    assert.equal(res.status, 'error');
  }
  const res = await readAdoptionEvidence({ root: r, objectKey: key, cursor: 'garbage' });
  assert.equal(res.status, 'error');
  assert.equal(res.reason, 'invalid_cursor');
  const good = await readAdoptionEvidence({ root: r, objectKey: key });
  assert.equal(good.status, 'ok');
  assert.equal(good.rows.length, 1);
});

test('correlation ids project without asserting uniqueness or changing legacy cursor order', async (t) => {
  const r = await root(t);
  const key = 'functions/demo.md';
  const file = path.join(r, '.usage.jsonl');
  const id1 = '11111111-1111-4111-8111-111111111111';
  const id2 = '22222222-2222-4222-8222-222222222222';
  const base = { t: '2026-11-20T01:00:02.000Z', href: key, kind: 'positive', note: 'same' };
  await fs.writeFile(file, line(base) + line({ ...base, correlationId: id1 })
    + line({ ...base, correlationId: id2 }) + line({ ...base, correlationId: id2 })
    + line({ ...base, kind: 'recall', correlationId: 'private' }));
  const pages = [];
  let cursor;
  do {
    const page = await readAdoptionEvidence({ root: r, objectKey: key, limit: 1, cursor });
    assert.equal(page.status, 'ok');
    pages.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(pages.length, 4);
  assert.equal(Object.hasOwn(pages[0], 'correlationId'), false);
  assert.deepEqual(pages.slice(1).map(row => row.correlationId), [id1, id2, id2]);
  assert.equal(pages[1].evidenceRef, pages[2].evidenceRef);
  assert.equal(pages[1].provenance, 'caller/user-action');
  const oldCursor = `v1:${Buffer.from(JSON.stringify({ t: base.t, k: base.kind, n: base.note, i: 1 })).toString('base64url')}`;
  const oldPage = await readAdoptionEvidence({ root: r, objectKey: key, limit: 1, cursor: oldCursor });
  assert.equal(oldPage.status, 'incomplete');
  assert.equal(oldPage.reason, 'legacy_cursor');
  assert.equal(oldPage.restartRequired, true);
  assert.deepEqual(oldPage.rows, []);
  const first = await readAdoptionEvidence({ root: r, objectKey: key, limit: 2 });
  await fs.writeFile(file, line(base) + line({ ...base, correlationId: id2 }) + line({ ...base, correlationId: id1 }));
  const changed = await readAdoptionEvidence({ root: r, objectKey: key, cursor: first.nextCursor });
  assert.equal(changed.status, 'incomplete');
  assert.equal(changed.reason, 'cursor_not_found');
  assert.deepEqual(changed.rows, []);
});

test('cross-source identical insertion invalidates the previous page', async (t) => {
  const r = await root(t);
  const key = 'functions/demo.md';
  const shard = path.join(r, '.usage', '2026-11.jsonl');
  const legacy = path.join(r, '.usage.jsonl');
  const base = { t: '2026-11-20T01:00:02.000Z', href: key, kind: 'positive', note: 'private-note' };
  const id = '11111111-1111-4111-8111-111111111111';
  await fs.mkdir(path.dirname(shard));
  await fs.writeFile(legacy, '');
  await fs.writeFile(shard, line(base) + line({ ...base, t: '2026-11-21T00:00:00Z' }));
  const first = await readAdoptionEvidence({ root: r, objectKey: key, limit: 1 });
  assert.equal(first.status, 'ok');
  assert.ok(first.nextCursor.startsWith('v2:'));
  const payload = Buffer.from(first.nextCursor.slice(3), 'base64url').toString('utf8');
  assert.equal(payload.includes(base.note), false);
  assert.equal(payload.includes(key), false);
  await fs.writeFile(legacy, line({ ...base, correlationId: id }));
  const next = await readAdoptionEvidence({ root: r, objectKey: key, cursor: first.nextCursor });
  assert.equal(next.status, 'incomplete');
  assert.equal(next.reason, 'cursor_not_found');
  assert.equal(next.restartRequired, true);
  assert.deepEqual(next.rows, []);
  const restart = await readAdoptionEvidence({ root: r, objectKey: key });
  assert.equal(restart.status, 'ok');
  assert.equal(restart.rows.length, 3);
  assert.equal(restart.rows.filter(row => row.correlationId === id).length, 1);
});

test('cursor binds object and rejects additions, deletion, edits and malformed payloads', async (t) => {
  const r = await root(t);
  const key = 'functions/demo.md';
  const other = 'functions/other.md';
  const file = path.join(r, '.usage.jsonl');
  const row = { t: '2026-11-20T01:00:02Z', href: key, kind: 'positive', note: 'same' };
  const original = line(row) + line(row);
  await fs.writeFile(file, original);
  const first = await readAdoptionEvidence({ root: r, objectKey: key, limit: 1 });
  assert.equal(first.status, 'ok');
  const second = await readAdoptionEvidence({ root: r, objectKey: key, limit: 1, cursor: first.nextCursor });
  assert.equal(second.status, 'ok');
  assert.equal(second.rows.length, 1);
  assert.equal(second.hasMore, false);
  assert.equal((await readAdoptionEvidence({ root: r, objectKey: other, cursor: first.nextCursor })).status, 'incomplete');
  const otherRoot = await root(t);
  await fs.writeFile(path.join(otherRoot, '.usage.jsonl'), original);
  assert.equal((await readAdoptionEvidence({ root: otherRoot, objectKey: key, cursor: first.nextCursor })).status, 'incomplete');
  for (const replacement of [original + line(row), line(row), original.replace('same', 'edit')]) {
    await fs.writeFile(file, replacement);
    const changed = await readAdoptionEvidence({ root: r, objectKey: key, cursor: first.nextCursor });
    assert.equal(changed.status, 'incomplete');
    assert.equal(changed.restartRequired, true);
    assert.deepEqual(changed.rows, []);
  }
  await fs.writeFile(file, original);
  await fs.mkdir(path.join(r, '.usage'));
  await fs.writeFile(path.join(r, '.usage', '2026-11.jsonl'), '');
  assert.equal((await readAdoptionEvidence({ root: r, objectKey: key, cursor: first.nextCursor })).status, 'incomplete');
  for (const payload of [{ d: 'a'.repeat(64), r: 'b'.repeat(64), i: 256 }, { d: 'a'.repeat(64), r: 'b'.repeat(64), i: 0, note: 'x' }, { d: 'x', r: 'b'.repeat(64), i: 0 }]) {
    const bad = `v2:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    assert.equal((await readAdoptionEvidence({ root: r, objectKey: key, cursor: bad })).reason, 'invalid_cursor');
  }
});

test('a source changed after reading is rejected instead of returning a page', async (t) => {
  const r = await root(t);
  const file = path.join(r, '.usage.jsonl');
  const key = 'functions/demo.md';
  const row = { t: '2026-11-20T01:00:02Z', href: key, kind: 'positive' };
  await fs.writeFile(file, line(row));
  const originalLstat = fs.lstat;
  let count = 0;
  let injected = false;
  fs.lstat = async (name, ...args) => {
    if (name === file && ++count === 3) {
      injected = true;
      await fs.appendFile(file, line(row));
    }
    return originalLstat(name, ...args);
  };
  try {
    const result = await readAdoptionEvidence({ root: r, objectKey: key });
    assert.equal(injected, true);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.reason, 'source_changed');
    assert.deepEqual(result.rows, []);
  } finally { fs.lstat = originalLstat; }
});

test('oversized, damaged and overfull sources never produce a partial page', async (t) => {
  const r = await root(t);
  const file = path.join(r, '.usage.jsonl');
  const key = 'functions/demo.md';
  const row = { t: '2026-11-20T01:00:02Z', href: key, kind: 'positive' };
  await fs.writeFile(file, 'x'.repeat(8 * 1024 * 1024 + 1));
  assert.equal((await readAdoptionEvidence({ root: r, objectKey: key })).reason, 'file_too_large');
  await fs.writeFile(file, line(row).repeat(257));
  assert.equal((await readAdoptionEvidence({ root: r, objectKey: key })).reason, 'too_many_matches');
  await fs.writeFile(file, line(row) + '{bad');
  const damaged = await readAdoptionEvidence({ root: r, objectKey: key });
  assert.equal(damaged.reason, 'bad_row');
  assert.deepEqual(damaged.rows, []);
});

test('physical empty lines count toward the scan budget without phantom trailing lines', async (t) => {
  const r = await root(t);
  const file = path.join(r, '.usage.jsonl');
  const key = 'functions/demo.md';
  const row = { t: '2026-11-20T01:00:02Z', href: key, kind: 'positive' };
  await fs.writeFile(file, '\n'.repeat(9999) + line(row));
  const exact = await readAdoptionEvidence({ root: r, objectKey: key });
  assert.equal(exact.status, 'ok');
  assert.equal(exact.scanned, 10000);
  assert.equal(exact.rows.length, 1);
  await fs.writeFile(file, '\n'.repeat(8 * 1024 * 1024));
  const over = await readAdoptionEvidence({ root: r, objectKey: key });
  assert.equal(over.status, 'incomplete');
  assert.equal(over.reason, 'too_many_rows');
  assert.deepEqual(over.rows, []);
  await fs.writeFile(file, line(row).slice(0, -1));
  const unterminated = await readAdoptionEvidence({ root: r, objectKey: key });
  assert.equal(unterminated.status, 'ok');
  assert.equal(unterminated.scanned, 1);
});

test('matching verdicts with missing or invalid timestamps are incomplete', async (t) => {
  const r = await root(t);
  const file = path.join(r, '.usage.jsonl');
  const key = 'functions/demo.md';
  for (const invalid of [undefined, null, '', 'not-a-date', 42]) {
    const row = { href: key, kind: 'positive', ...(invalid === undefined ? {} : { t: invalid }) };
    await fs.writeFile(file, line({ t: '2026-11-20T00:00:00Z', href: key, kind: 'correction' }) + line(row));
    const result = await readAdoptionEvidence({ root: r, objectKey: key });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.reason, 'bad_row');
    assert.deepEqual(result.rows, []);
  }
  await fs.writeFile(file, line({ kind: 'positive', href: 'functions/other.md' }));
  assert.equal((await readAdoptionEvidence({ root: r, objectKey: key })).status, 'ok');
});

test('malformed matching correlation ids fail closed without exposing other records', async (t) => {
  const r = await root(t);
  const key = 'functions/demo.md';
  const file = path.join(r, '.usage.jsonl');
  const base = { t: '2026-11-20T01:00:02.000Z', href: key, kind: 'correction' };
  for (const invalid of [null, 42, '', '11111111-1111-1111-8111-111111111111', '11111111-1111-4111-7111-111111111111']) {
    await fs.writeFile(file, line(base) + line({ ...base, correlationId: invalid }));
    const result = await readAdoptionEvidence({ root: r, objectKey: key });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.reason, 'bad_row');
    assert.deepEqual(result.rows, []);
  }
  await fs.writeFile(file, line({ ...base, href: 'functions/other.md', correlationId: null })
    + line({ ...base, kind: 'read', correlationId: null }) + line(base));
  const result = await readAdoptionEvidence({ root: r, objectKey: key });
  assert.equal(result.status, 'ok');
  assert.equal(result.rows.length, 1);
  assert.equal(Object.hasOwn(result.rows[0], 'correlationId'), false);
  await fs.writeFile(file, line(base) + '{broken\n');
  assert.equal((await readAdoptionEvidence({ root: r, objectKey: key })).reason, 'bad_row');
});

test('unavailable notes are identified without exposing their content', async (t) => {
  const r = await root(t);
  const key = 'functions/demo.md';
  const base = { t: '2026-11-20T01:00:02.000Z', href: key, kind: 'positive' };
  const longNote = 'private-long-'.repeat(200);
  const controlNote = 'private\ncontrol';
  await fs.writeFile(path.join(r, '.usage.jsonl'),
    line({ ...base, note: longNote }) + line({ ...base, note: controlNote })
    + line({ ...base, note: '' }) + line(base) + line({ ...base, note: 'visible' }));
  const result = await readAdoptionEvidence({ root: r, objectKey: key });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.rows.map(row => row.noteStatus),
    ['unavailable', 'unavailable', 'available', 'missing', 'available']);
  assert.deepEqual(result.rows.map(row => row.note), ['', '', '', '', 'visible']);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('response limit includes projected correlation ids', async (t) => {
  const r = await root(t);
  const key = 'functions/demo.md';
  const row = { t: '2026-11-20T01:00:02.000Z', href: key, kind: 'positive',
    note: 'x'.repeat(1000), correlationId: '11111111-1111-4111-8111-111111111111' };
  await fs.writeFile(path.join(r, '.usage.jsonl'), line(row).repeat(100));
  const result = await readAdoptionEvidence({ root: r, objectKey: key, limit: 100 });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.reason, 'response_too_large');
  assert.deepEqual(result.rows, []);
});
