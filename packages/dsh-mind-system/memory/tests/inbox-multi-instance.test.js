import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { MemoryInbox } from '../health-inbox.js';

const finding = (code) => ({ from: 'test', code, message: `issue ${code}`, severity: 'warn' });
const stable = (message) => ({ from: 'test', code: 'stable', message, severity: 'warn', identity: { scope: 'root', subtype: 'size', subject: 'aggregate' } });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-multi-inbox-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-multi-inbox-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, file: path.join(root, 'storages', 'memory-inbox.json') };
}

test('two cached instances refresh reads and preserve interleaved updates and deletion', async (t) => {
  const { root } = await fixture(t);
  const a = new MemoryInbox(() => root), b = new MemoryInbox(() => root);
  await Promise.all([a.list(), b.list()]);
  const first = await a.post(finding('one'));
  assert.equal((await b.list()).length, 1);
  await b.post(finding('two'));
  await a.update(first.item.fingerprint, 'acknowledged', 'reviewed');
  assert.equal((await b.list()).find((it) => it.code === 'one').note, 'reviewed');
  await b.remove(first.item.fingerprint);
  await a.post(finding('three'));
  assert.deepEqual((await b.list()).map((it) => it.code).sort(), ['three', 'two']);
});

test('concurrent same and distinct findings from separate instances preserve all counts and identity', async (t) => {
  const { root, file } = await fixture(t);
  const a = new MemoryInbox(() => root), b = new MemoryInbox(() => root);
  await Promise.all([a.list(), b.list()]);
  await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? a : b).post(finding(`unique-${i}`))));
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).post(stable(`observation ${i}`))));
  const records = await a.list();
  assert.equal(records.length, 25);
  assert.equal(records.find((it) => it.code === 'stable').times, 20);
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(Object.keys(parsed.items).length, 25);
  assert.equal(Object.keys(parsed.identities).length, 1);
});

test('independently loaded module copies serialize the same physical file and aliases', async (t) => {
  const { root } = await fixture(t);
  const alias = path.join(root, 'alias');
  const actual = path.join(root, 'actual');
  await mkdir(actual);
  await symlink(actual, alias, 'junction');
  const { MemoryInbox: ReloadedInbox } = await import(`../health-inbox.js?reload=${Date.now()}-${Math.random()}`);
  const a = new MemoryInbox(() => actual), b = new ReloadedInbox(() => alias);
  await Promise.all([a.list(), b.list()]);
  await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? a : b).post(finding(`reload-${i}`))));
  assert.equal((await a.list()).length, 16);
  assert.equal((await b.list()).length, 16);
});

test('failed write releases shared queue, does not resurrect failure, and later updates remain visible', async (t) => {
  const { root } = await fixture(t);
  const a = new MemoryInbox(() => root), b = new MemoryInbox(() => root);
  await a.post(finding('original'));
  const originalRename = fs.promises.rename;
  let injected = false, releaseFailure, reachedFailure;
  const entered = new Promise((resolve) => { reachedFailure = resolve; });
  const hold = new Promise((resolve) => { releaseFailure = resolve; });
  fs.promises.rename = async (source, target) => {
    if (!injected && String(target) === path.join(root, 'storages', 'memory-inbox.json')) {
      injected = true;
      reachedFailure();
      await hold;
      throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
    }
    return originalRename(source, target);
  };
  syncBuiltinESMExports();
  let failed, succeeded;
  try {
    const first = a.post(finding('failed'));
    await entered;
    const second = b.post(finding('survives'));
    releaseFailure();
    [failed, succeeded] = await Promise.allSettled([first, second]);
  } finally {
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  assert.equal(failed.status, 'rejected');
  assert.equal(succeeded.status, 'fulfilled');
  assert.deepEqual((await fs.promises.readdir(path.join(root, 'storages'))).filter((name) => name.endsWith('.tmp')), []);
  assert.deepEqual((await a.list()).map((it) => it.code).sort(), ['original', 'survives']);
  await a.post(finding('after'));
  assert.deepEqual((await b.list()).map((it) => it.code).sort(), ['after', 'original', 'survives']);
});

test('a successful rename with lost acknowledgement reports unknown and can be checked before retry', async (t) => {
  const { root, file } = await fixture(t);
  const inbox = new MemoryInbox(() => root);
  const originalRename = fs.promises.rename;
  fs.promises.rename = async (source, target) => {
    await originalRename(source, target);
    if (String(target) === file) throw Object.assign(new Error('acknowledgement lost'), { code: 'EIO' });
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(inbox.post(finding('maybe-committed')), (error) => {
      assert.equal(error.code, 'INBOX_COMMIT_UNKNOWN');
      assert.equal(error.committed, 'unknown');
      assert.match(error.message, /先重新读取磁盘核对，不要盲目重试/);
      return true;
    });
  } finally {
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
  }
  const actual = await inbox.list();
  assert.equal(actual.find((entry) => entry.code === 'maybe-committed')?.times, 1);
  assert.equal(Object.keys(JSON.parse(await readFile(file, 'utf8')).items).length, 1);
});

test('a symbolic-link inbox file is rejected rather than replaced as an alias', async (t) => {
  const { root, file } = await fixture(t);
  const target = path.join(root, 'target.json');
  const original = '{"version":1,"items":{}}';
  await mkdir(path.dirname(file));
  await writeFile(target, original, 'utf8');
  try { await symlink(target, file, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) return t.skip('file symlink unavailable');
    throw error;
  }
  const inbox = new MemoryInbox(() => root);
  await assert.rejects(inbox.list(), /符号链接/);
  await assert.rejects(inbox.post(finding('unsafe')), /符号链接/);
  assert.equal(await readFile(target, 'utf8'), original);
});

test('a multiply hardlinked inbox is rejected rather than split by atomic replacement', async (t) => {
  const { root, file } = await fixture(t);
  const other = path.join(root, 'other.json');
  const original = '{"version":1,"items":{}}';
  await mkdir(path.dirname(file));
  await writeFile(file, original, 'utf8');
  try { await link(file, other); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error?.code)) return t.skip('hardlink unavailable');
    throw error;
  }
  const inbox = new MemoryInbox(() => root);
  await assert.rejects(inbox.post(finding('unsafe')), /硬链接/);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal(await readFile(other, 'utf8'), original);
});

test('external corruption after an earlier read is detected rather than masked by stale cache', async (t) => {
  const { root, file } = await fixture(t);
  const inbox = new MemoryInbox(() => root);
  await inbox.post(finding('original'));
  const bad = '{"version":1,"items":';
  await writeFile(file, bad, 'utf8');
  await assert.rejects(inbox.list(), /收件箱/);
  await assert.rejects(inbox.post(finding('must-not-write')), /收件箱/);
  assert.equal(await readFile(file, 'utf8'), bad);
});
