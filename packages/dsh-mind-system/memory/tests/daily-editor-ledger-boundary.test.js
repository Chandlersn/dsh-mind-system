import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWriteGuard, WRITE_DENIED } from '../src/write-guard.js';
import { writeText } from '../src/util.js';
import { auditBatch, contentHash, LEDGER_REL, readLedger, reconcile } from '../src/write-ledger.js';
import { verifyCaptureBaseline } from '../src/capture-baseline.js';

// Every fixture path, including the simulated host's skill root, is disposable.
async function fixture(t) {
  const temp = await realpath(tmpdir());
  const home = await mkdtemp(path.join(temp, 'daily-editor-boundary-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  t.after(async () => {
    assert.equal(path.dirname(home), temp);
    assert.match(path.basename(home), /^daily-editor-boundary-/);
    assert.equal(await realpath(home), home);
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(root);
  await mkdir(skills);
  const ctx = { fs: { resolve: async (requested) => {
    const absolute = path.resolve(requested);
    assert.ok(absolute === home || absolute.startsWith(home + path.sep), 'resolver must stay inside the isolated fixture');
    return { displayPath: absolute, targetKey: absolute };
  } } };
  const guard = createWriteGuard(() => root, ctx, () => skills);
  async function editor(name, file, operation) {
    let called = false;
    const result = await guard({ name, arguments: { file_path: file } }, async () => {
      called = true;
      return operation();
    });
    assert.equal(called, true);
    return result;
  }
  return { root, skills, guard, editor };
}

test('允许编辑日记后 R26 对账报 hash_mismatch，采集基线拒绝且不补账', async (t) => {
  const { root, skills, guard, editor } = await fixture(t);
  const key = '2026-11-10.md';
  const daily = path.join(root, key);
  const old = path.join(root, '2026-11-09.md');
  const original = '已登记的原始日记\n';
  await writeText(old, '旧日记保持原样\n', { memoryRoot: root });
  await writeText(daily, original, { memoryRoot: root });
  const ledgerPath = path.join(root, LEDGER_REL);
  const baselineLedger = await readFile(ledgerPath);
  const oldBytes = await readFile(old);
  let ledger = await readLedger(root);
  assert.equal(ledger.get(key)?.hash, contentHash(original));
  assert.equal(reconcile({ key, text: original, ledger }).verdict, 'ok');
  assert.deepEqual(await verifyCaptureBaseline(root, key, original), { currentFile: 'consistent', provenance: 'unknown' });

  const edited = `${original}通过普通编辑工具追加\n`;
  await editor('edit', daily, async () => {
    const before = await readFile(daily, 'utf8');
    assert.equal(before, original);
    await writeFile(daily, edited, 'utf8');
  });
  ledger = await readLedger(root);
  const text = await readFile(daily, 'utf8');
  assert.equal(text, edited);
  assert.equal(reconcile({ key, text, ledger }).reason, 'hash_mismatch');
  assert.deepEqual(auditBatch({ files: [{ key, text }], ledger }).map(({ key, reason }) => [key, reason]), [[key, 'hash_mismatch']]);
  await assert.rejects(verifyCaptureBaseline(root, key, text), { code: 'CAPTURE_BASELINE_UNVERIFIED', reason: 'hash_mismatch' });
  assert.deepEqual(await readFile(ledgerPath), baselineLedger, '编辑和基线检查均不得补记账本');
  assert.deepEqual(await readFile(old), oldBytes, '旧日记不得改变');
  assert.equal(await readFile(daily, 'utf8'), edited, '拒绝采集后保留编辑结果');

  // The same wrapper continues to deny protected locations without running the tool.
  for (const file of [path.join(root, 'MEMORY.md'), path.join(root, 'functions', 'x.md'), ledgerPath, path.join(root, '.daily-capture.pending'), path.join(skills, 'x.md')]) {
    let called = false;
    await assert.rejects(guard({ name: 'write', arguments: { file_path: file } }, () => { called = true; }), { code: WRITE_DENIED });
    assert.equal(called, false, file);
  }
});

test('经守卫新增未登记日记报 never_recorded 且基线拒绝采集', async (t) => {
  const { root, editor } = await fixture(t);
  const key = '2026-11-11.md';
  const daily = path.join(root, key);
  const old = path.join(root, '2026-11-09.md');
  await writeText(old, '已登记的旧日记\n', { memoryRoot: root });
  const ledgerPath = path.join(root, LEDGER_REL);
  const beforeLedger = await readFile(ledgerPath);
  const beforeOld = await readFile(old);
  const text = '编辑工具创建的新日记\n';
  await editor('write', daily, () => writeFile(daily, text, 'utf8'));
  const actual = await readFile(daily, 'utf8');
  const ledger = await readLedger(root);
  assert.equal(reconcile({ key, text: actual, ledger }).reason, 'never_recorded');
  assert.deepEqual(auditBatch({ files: [{ key, text: actual }], ledger }).map(({ key, reason }) => [key, reason]), [[key, 'never_recorded']]);
  await assert.rejects(verifyCaptureBaseline(root, key, actual), { code: 'CAPTURE_BASELINE_UNVERIFIED', reason: 'never_recorded' });
  assert.deepEqual(await readFile(ledgerPath), beforeLedger);
  assert.deepEqual(await readFile(old), beforeOld);
  assert.equal(await readFile(daily, 'utf8'), text);
});
