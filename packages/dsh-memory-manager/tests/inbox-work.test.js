import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryInbox } from '../health-inbox.js';
import { selectInboxWork } from '../src/inbox-work.js';

const DAY = 86_400_000;
const finding = { from: 'test', code: 'R5', message: 'fixture finding' };

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'inbox-work-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('inbox-work-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, file: path.join(root, 'storages', 'memory-inbox.json'), inbox: new MemoryInbox(() => root) };
}

test('selects a new issue, skips recent handling, and leaves the store untouched', async t => {
  const { inbox, file } = await fixture(t);
  assert.equal(selectInboxWork(await inbox.list()), null);
  const { item } = await inbox.post(finding);
  const rows = await inbox.list();
  const before = await readFile(file);
  assert.equal(selectInboxWork(rows), rows[0]);
  assert.deepEqual(await readFile(file), before);
  const ack = await inbox.update(item.fingerprint, 'acknowledged', 'under review');
  const handled = Date.parse(ack.lastHandledAt);
  assert.equal(selectInboxWork([ack], handled + DAY - 1), null);
  assert.equal(selectInboxWork([ack], handled + DAY), ack);
  const resolved = await inbox.update(item.fingerprint, 'resolved', 'verified');
  assert.equal(selectInboxWork([resolved], handled + 2 * DAY), null);
  const reopened = (await inbox.post(finding)).item;
  assert.equal(selectInboxWork([reopened]), reopened);
});

test('duplicate reports survive reload without advancing the disposition clock, including legacy rows', async t => {
  const { root, inbox, file } = await fixture(t);
  const { item } = await inbox.post(finding);
  await inbox.update(item.fingerprint, 'acknowledged', 'reviewed');
  const store = JSON.parse(await readFile(file, 'utf8'));
  const row = store.items[item.fingerprint];
  const old = '2026-01-01T00:00:00.000Z';
  row.lastHandledAt = old;
  row.receivedAt = old;
  await writeFile(file, JSON.stringify(store));
  const updated = (await new MemoryInbox(() => root).post(finding)).item;
  assert.equal(updated.lastHandledAt, old);
  assert.notEqual(updated.lastSeenAt, old);
  assert.equal(selectInboxWork([updated], Date.parse(old) + DAY), updated);
  delete row.lastHandledAt;
  row.lastSeenAt = '2026-02-01T12:00:00.000Z';
  await writeFile(file, JSON.stringify(store));
  const legacy = (await new MemoryInbox(() => root).post(finding)).item;
  assert.equal(Object.hasOwn(legacy, 'lastHandledAt'), false);
  assert.equal(selectInboxWork([legacy], Date.parse(old) + DAY), legacy);
});

test('a daily job sees every eligible row even at the same minute each day', () => {
  const start = Date.parse('2026-01-03T04:00:00Z');
  const rows = Object.freeze(['a', 'b', 'c', 'd'].map((fingerprint, i) => Object.freeze({
    fingerprint, receivedAt: new Date(start - (i + 1) * DAY).toISOString(), status: i % 2 ? 'open' : 'acknowledged',
  })));
  const seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const now = start + i * DAY;
    const selected = selectInboxWork(rows, now);
    assert.equal(selected, selectInboxWork([...rows].reverse(), now));
    seen.add(selected);
  }
  assert.deepEqual(seen, new Set(rows));
});
