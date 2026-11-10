import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditBatch, contentHash, isTracked, ledgerKey, readLedger, reconcile, recordDeleteEvent } from '../src/write-ledger.js';
import { writeText } from '../src/util.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'daily-ledger-key-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('daily-ledger-key-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('根层每日文件名以 YYYY-MM-DD.md 严格形状受管，拒绝路径变体', () => {
  for (const key of ['2026-11-10.md', '0000-00-00.md', '9999-99-99.md']) {
    assert.equal(isTracked(key), true, key);
  }
  for (const key of ['2026-1-10.md', '26-11-10.md', '2026-11-1.md', '2026-11-10.MD', '2026-11-10.md\n', ' 2026-11-10.md', '2026-11-10.md ', 'README.md', '.write-ledger.jsonl', '../2026-11-10.md', './2026-11-10.md', '/2026-11-10.md', 'nested/2026-11-10.md', 'daily/../2026-11-10.md', 'daily\\..\\2026-11-10.md']) {
    assert.equal(isTracked(key), false, key);
  }
  for (const key of ['functions/x.md', 'insights/x.md', 'dao/_candidates/x.md', 'capabilities/x.md', 'daily/x.md']) assert.equal(isTracked(key), true, key);
});

test('writeText 登记根层每日键，修改后对账指出 hash_mismatch', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, '2026-11-10.md');
  await writeText(file, '用户原始记录\n', { memoryRoot: root });
  const key = ledgerKey(root, file);
  assert.equal(key, '2026-11-10.md');
  let ledger = await readLedger(root);
  assert.ok(ledger instanceof Map);
  assert.equal(ledger.get(key)?.hash, contentHash(await readFile(file, 'utf8')));
  assert.equal(reconcile({ key, text: await readFile(file, 'utf8'), ledger }).verdict, 'ok');
  await writeFile(file, '隔离测试模拟外部修改\n');
  ledger = await readLedger(root);
  const check = reconcile({ key, text: await readFile(file, 'utf8'), ledger });
  assert.equal(check.verdict, 'unverified');
  assert.equal(check.reason, 'hash_mismatch');
  assert.deepEqual(auditBatch({ files: [{ key, text: await readFile(file, 'utf8') }], ledger }).map((x) => [x.key, x.reason]), [[key, 'hash_mismatch']]);
});

test('根层每日键的删除意图及完成事件与既有对账语义一致', async (t) => {
  const root = await fixture(t);
  const key = '2026-11-10.md';
  await writeText(path.join(root, key), '原文', { memoryRoot: root });
  assert.equal(await recordDeleteEvent(root, { key, op: 'delete_intent', id: 'daily-tx', tool: 'isolated-test' }), true);
  let ledger = await readLedger(root);
  assert.equal(reconcile({ key, text: '原文', ledger }).reason, 'delete_incomplete');
  assert.equal(await recordDeleteEvent(root, { key, op: 'delete', id: 'daily-tx', tool: 'isolated-test' }), true);
  ledger = await readLedger(root);
  assert.equal(reconcile({ key, text: '原文', ledger }).reason, 'deleted_present');
});
