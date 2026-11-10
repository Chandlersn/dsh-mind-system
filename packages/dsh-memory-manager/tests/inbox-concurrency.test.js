import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryInbox, inboxFingerprint } from '../health-inbox.js';

const sample = (code) => ({ from: 'test', code, message: `issue ${code}` });
const item = (input, status = 'open') => ({
  ...input, fingerprint: inboxFingerprint(input.from, input.code, input.message),
  severity: 'warn', receivedAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:00.000Z', times: 1, status,
});
const diskPath = (root) => join(root, 'storages', 'memory-inbox.json');
async function sandbox(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-inbox-race-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function seed(root, items) {
  await mkdir(join(root, 'storages'), { recursive: true });
  await writeFile(diskPath(root), JSON.stringify({ version: 1, items: Object.fromEntries(items.map((x) => [x.fingerprint, x])) }), 'utf8');
}

test('concurrent first post and update wait for complete seeded state', async () => sandbox(async (root) => {
  const existing = item(sample('existing'), 'resolved');
  const changed = item(sample('changed'));
  await seed(root, [existing, changed]);
  const inbox = new MemoryInbox(() => root);
  const [posted, updated] = await Promise.all([
    inbox.post(sample('existing')),
    inbox.update(changed.fingerprint, 'acknowledged', 'reviewed'),
    inbox.post(sample('new')),
  ]);
  assert.equal(posted.isNew, false);
  assert.equal(posted.times, 2);
  assert.equal(updated?.status, 'acknowledged');
  const saved = JSON.parse(await readFile(diskPath(root), 'utf8')).items;
  assert.equal(Object.keys(saved).length, 3);
  assert.equal(saved[existing.fingerprint].times, 2);
  assert.equal(saved[existing.fingerprint].status, 'open');
  assert.equal(saved[changed.fingerprint].note, 'reviewed');
}));

test('many concurrent posts persist all unique items and duplicate counts', async () => sandbox(async (root) => {
  const inbox = new MemoryInbox(() => root);
  const results = await Promise.all([...Array.from({ length: 60 }, (_, i) => inbox.post(sample(`unique-${i}`))),
    ...Array.from({ length: 30 }, () => inbox.post(sample('duplicate')))]);
  assert.deepEqual(results.slice(60).map((result) => result.times), Array.from({ length: 30 }, (_, i) => i + 1));
  assert.deepEqual(results.slice(60).map((result) => result.item.times), Array.from({ length: 30 }, (_, i) => i + 1));
  const saved = JSON.parse(await readFile(diskPath(root), 'utf8')).items;
  assert.equal(Object.keys(saved).length, 61);
  assert.equal(saved[inboxFingerprint('test', 'duplicate', 'issue duplicate')].times, 30);
}));

test('corrupted JSON rejects parallel reads and mutations without altering bytes; retry after repair', async () => sandbox(async (root) => {
  await mkdir(join(root, 'storages'), { recursive: true });
  const raw = '{"version":1,"items":{"old":';
  await writeFile(diskPath(root), raw, 'utf8');
  const inbox = new MemoryInbox(() => root);
  const results = await Promise.allSettled([inbox.list(), inbox.post(sample('new')), inbox.update('old', 'resolved')]);
  assert.ok(results.every((r) => r.status === 'rejected'), 'no caller sees a fabricated empty inbox');
  assert.match(String(results[0].reason), /收件箱/);
  assert.equal(await readFile(diskPath(root), 'utf8'), raw);
  const old = item(sample('old'));
  await seed(root, [old]);
  await inbox.post(sample('new'));
  const saved = JSON.parse(await readFile(diskPath(root), 'utf8')).items;
  assert.equal(Object.keys(saved).length, 2);
  assert.ok(saved[old.fingerprint]);
}));

test('unsupported versions and invalid items reject rather than overwrite', async () => sandbox(async (root) => {
  await mkdir(join(root, 'storages'), { recursive: true });
  for (const raw of ['{"version":2,"items":{}}', '{"version":1,"items":[]}', '{"version":1,"items":{"bad":null}}']) {
    await writeFile(diskPath(root), raw, 'utf8');
    const inbox = new MemoryInbox(() => root);
    await assert.rejects(inbox.post(sample('new')), /收件箱/);
    assert.equal(await readFile(diskPath(root), 'utf8'), raw);
  }
}));

test('returned records cannot mutate internal state outside the write queue', async () => sandbox(async (root) => {
  const inbox = new MemoryInbox(() => root);
  const posted = await inbox.post(sample('snapshot'));
  posted.item.times = 1000;
  const listed = await inbox.list();
  listed[0].status = 'resolved';
  const again = await inbox.post(sample('snapshot'));
  assert.equal(again.times, 2);
  assert.equal(again.item.status, 'open');
}));

test('inaccessible storage is an error rather than an empty inbox', async () => sandbox(async (root) => {
  await writeFile(join(root, 'storages'), 'not a directory');
  const inbox = new MemoryInbox(() => root);
  await assert.rejects(inbox.list(), /收件箱读取失败/);
  await assert.rejects(inbox.post(sample('new')), /收件箱读取失败/);
  assert.equal(await readFile(join(root, 'storages'), 'utf8'), 'not a directory');
}));

test('storage errors surface instead of claiming a persisted post', async () => sandbox(async (root) => {
  const inbox = new MemoryInbox(() => root);
  await inbox.list(); // Empty because no file exists yet.
  await writeFile(join(root, 'storages'), 'not a directory');
  await assert.rejects(inbox.post(sample('failure')), /收件箱|EEXIST|ENOTDIR/);
  await assert.rejects(inbox.list(), /收件箱读取失败/, 'damaged storage must not be presented as an empty cached inbox');
  await rm(join(root, 'storages'));
  await inbox.post(sample('recovered'));
  const saved = JSON.parse(await readFile(diskPath(root), 'utf8')).items;
  assert.equal(Object.keys(saved).length, 1, 'a later successful write cannot resurrect the failed post');
}));
