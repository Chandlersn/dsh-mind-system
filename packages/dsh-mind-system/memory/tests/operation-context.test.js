import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withOperationContext, currentOperationId } from '../src/operation-context.js';
import { recordWrite, recordDeleteEvent, readLedger } from '../src/write-ledger.js';
import { withMemoryRootTransaction } from '../src/root-transaction.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'operation-context-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^operation-context-/);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
const rows = async root => (await readFile(path.join(root, '.write-ledger.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('shared module copies inherit after await, isolate nested scopes and close on failure', async () => {
  const copy = await import('../src/operation-context.js?independent-copy');
  assert.equal(currentOperationId(), undefined);
  const failure = new Error('original failure');
  let parentId;
  let late;
  const release = deferred();
  await assert.rejects(withOperationContext(async () => {
    parentId = currentOperationId();
    await Promise.resolve();
    assert.equal(copy.currentOperationId(), parentId);
    await copy.withOperationContext(async () => {
      assert.notEqual(currentOperationId(), parentId);
    });
    assert.equal(currentOperationId(), parentId);
    late = release.promise.then(() => copy.currentOperationId());
    throw failure;
  }), error => error === failure);
  release.resolve();
  assert.equal(await late, undefined);
  assert.equal(currentOperationId(), undefined);
});

test('parallel roots and queued root aliases retain each invocation identity', async t => {
  const root = await fixture(t);
  const other = await fixture(t);
  const alias = path.join(other, 'alias');
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const entered = deferred();
  const release = deferred();
  const ids = [];
  const first = withOperationContext(async () => {
    const id = currentOperationId(); ids.push(id);
    await withMemoryRootTransaction(root, async () => {
      entered.resolve(); await release.promise;
      assert.equal(currentOperationId(), id);
      await recordWrite(root, { key: 'functions/first.md', hash: 'first' });
    });
  });
  await entered.promise;
  const second = withOperationContext(async () => {
    const id = currentOperationId(); ids.push(id);
    await withMemoryRootTransaction(alias, async () => {
      assert.equal(currentOperationId(), id);
      await recordWrite(root, { key: 'functions/second.md', hash: 'second' });
    });
  });
  await withOperationContext(async () => {
    const id = currentOperationId(); ids.push(id);
    await withMemoryRootTransaction(other, async () => {
      await recordWrite(other, { key: 'functions/other.md', hash: 'other' });
    });
  });
  release.resolve(); await Promise.all([first, second]);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual((await rows(root)).map(row => row.request_id), ids.slice(0, 2));
  assert.equal((await rows(other))[0].request_id, ids[2]);
});

test('ledger captures identity before await, rejects caller override and preserves delete pair ids', async t => {
  const root = await fixture(t);
  let id;
  let pending;
  let detached;
  const release = deferred();
  await withOperationContext(() => {
    id = currentOperationId();
    pending = Promise.all([
      recordWrite(root, { key: 'functions/a.md', hash: 'hash', request_id: 'spoof' }),
      recordDeleteEvent(root, { key: 'functions/b.md', op: 'delete_intent', id: 'delete-id', request_id: 'spoof' }),
    ]);
    detached = release.promise.then(() => recordWrite(root, { key: 'functions/late.md', hash: 'late', request_id: id }));
  });
  await pending;
  await withOperationContext(async () => {
    await recordDeleteEvent(root, { key: 'functions/b.md', op: 'delete', id: 'delete-id', request_id: 'spoof' });
  });
  release.resolve(); await detached;
  await recordWrite(root, { key: 'functions/legacy.md', hash: 'old', request_id: 'spoof' });
  const actual = await rows(root);
  assert.ok(actual.slice(0, 2).every(row => row.request_id === id));
  assert.equal(actual[2].id, 'delete-id');
  assert.notEqual(actual[2].request_id, id);
  assert.ok(actual.slice(3).every(row => !Object.hasOwn(row, 'request_id')));
  assert.equal((await readLedger(root)).get('functions/b.md').op, 'delete');
  await writeFile(path.join(root, '.write-ledger.jsonl'), '{"key":"functions/old.md","hash":"old","tool":"legacy"}\n');
  assert.equal((await readLedger(root)).get('functions/old.md').hash, 'old');
});
