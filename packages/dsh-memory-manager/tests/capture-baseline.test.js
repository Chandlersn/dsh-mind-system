import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyCaptureBaseline, isCaptureKey } from '../src/capture-baseline.js';
import { contentHash, isTracked, LEDGER_REL } from '../src/write-ledger.js';

// Fixtures are deliberately limited to a freshly created temporary root;
// none of these tests calls capture or accesses the user's actual memory.
const KEY = '2026-11-10.md';
const OTHER_KEY = '2026-11-09.md';
const TEXT = '独立每日原文：🙂\n';
const line = (entry) => `${JSON.stringify(entry)}\n`;
const writeRecord = (key, text) => line({ key, hash: contentHash(text), tool: 'fixture' });
const deletePair = (key) => [
  { key, op: 'delete_intent', id: 'fixture-id', tool: 'fixture' },
  { key, op: 'delete', id: 'fixture-id', tool: 'fixture' },
].map(line).join('');
const intent = (key) => line({ key, op: 'delete_intent', id: 'fixture-id', tool: 'fixture' });

async function makeFixture(t, { text = TEXT, ledger } = {}) {
  const tempRoot = await realpath(tmpdir());
  const root = await mkdtemp(path.join(tempRoot, 'capture-baseline-test-'));
  assert.equal(path.dirname(root), tempRoot);
  assert.ok(path.basename(root).startsWith('capture-baseline-test-'));
  // Register cleanup immediately, before any fixture writes can fail.
  t.after(async () => {
    const info = await lstat(root);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.equal(await realpath(root), root);
    assert.equal(path.dirname(root), tempRoot);
    assert.ok(path.basename(root).startsWith('capture-baseline-test-'));
    await rm(root, { recursive: true });
  });
  if (text !== null) await writeFile(path.join(root, KEY), text, 'utf8');
  if (ledger !== undefined) await writeFile(path.join(root, LEDGER_REL), ledger, 'utf8');
  return root;
}

async function snapshot(root) {
  const names = (await readdir(root)).sort();
  return Promise.all(names.map(async (name) => {
    const file = path.join(root, name);
    const st = await lstat(file);
    assert.ok(st.isFile() && !st.isSymbolicLink(), `unexpected fixture entry: ${name}`);
    return { name, bytes: await readFile(file) };
  }));
}

async function verifyUnchanged(root, operation) {
  const before = await snapshot(root);
  try {
    await operation();
  } finally {
    assert.deepEqual(await snapshot(root), before, 'baseline check must not modify the daily file or ledger');
  }
}

const deniedCases = [
  { name: 'existing file and missing ledger', fixture: {}, reason: 'never_recorded' },
  { name: 'existing file and empty ledger', fixture: { ledger: '' }, reason: 'never_recorded' },
  { name: 'corrupt ledger', fixture: { ledger: '{"key":' }, reason: 'ledger_unreadable' },
  { name: 'file absent with corrupt ledger', fixture: { text: null, ledger: '{"key":' }, reason: 'ledger_unreadable' },
  { name: 'ledger contains unrelated history but no daily record', fixture: { ledger: writeRecord(OTHER_KEY, '其他日记') }, reason: 'never_recorded' },
  { name: 'file differs from recorded hash', fixture: { ledger: writeRecord(KEY, '旧内容') }, reason: 'hash_mismatch' },
  { name: 'recorded deletion followed by file reappearance', fixture: { ledger: deletePair(KEY) }, reason: 'deleted_present' },
  { name: 'delete intent without completion and file still present', fixture: { ledger: intent(KEY) }, reason: 'delete_incomplete' },
  { name: 'file absent but ledger records a live file', fixture: { text: null, ledger: writeRecord(KEY, TEXT) }, reason: 'recorded_file_absent' },
  { name: 'file absent but ledger has an incomplete deletion', fixture: { text: null, ledger: intent(KEY) }, reason: 'recorded_file_absent' },
];

for (const scenario of deniedCases) {
  test(`capture baseline fails closed: ${scenario.name}`, async (t) => {
    const root = await makeFixture(t, scenario.fixture);
    const existingText = scenario.fixture.text === null ? undefined : await readFile(path.join(root, KEY), 'utf8');
    await verifyUnchanged(root, async () => {
      await assert.rejects(verifyCaptureBaseline(root, KEY, existingText), (error) => {
        assert.equal(error.code, 'CAPTURE_BASELINE_UNVERIFIED');
        assert.equal(error.reason, scenario.reason);
        return true;
      });
    });
  });
}

test('matching recorded content establishes consistency, not provenance', async (t) => {
  const root = await makeFixture(t, { ledger: writeRecord(KEY, TEXT) });
  await verifyUnchanged(root, async () => {
    const result = await verifyCaptureBaseline(root, KEY, await readFile(path.join(root, KEY), 'utf8'));
    assert.deepEqual(result, { currentFile: 'consistent', provenance: 'unknown' });
  });
});

for (const [name, ledger] of [['missing ledger', undefined], ['empty ledger', ''], ['completed deletion', deletePair(KEY)]]) {
  test(`missing daily file and ${name} returns absent with unknown provenance`, async (t) => {
    const root = await makeFixture(t, { text: null, ledger });
    await verifyUnchanged(root, async () => {
      const result = await verifyCaptureBaseline(root, KEY, undefined);
      // ENOENT/empty ledger is not evidence that historical events never existed.
      assert.deepEqual(result, { currentFile: 'absent', provenance: 'unknown' });
    });
  });
}

test('采集键口径与 isTracked 对齐：接受 daily/YYYY-MM.md，其他带斜杠路径仍拒', () => {
  // 月/周折叠方案（2026-11）：归档键与 isTracked 的 daily/ 前缀口径一致。
  for (const key of ['daily/2026-10.md', 'daily/1999-12.md']) {
    assert.equal(isCaptureKey(key), true, key);
    assert.equal(isTracked(key), true, `${key} 必须同时是 tracked 键`);
  }
  // 严格月校验：13 月、缺位、日形名、嵌套、其他 zone 前缀一律拒绝。
  for (const key of ['daily/2026-13.md', 'daily/2026-00.md', 'daily/2026-1.md', 'daily/2026-10-05.md', 'daily/notes.md', 'daily/sub/2026-10.md', 'daily/2026-10.txt', 'functions/x.md', 'insights/x.md', 'daily/../2026-10-05.md', 'daily//2026-10.md', 'daily/2026-10.md/']) {
    assert.equal(isCaptureKey(key), false, key);
  }
  // 根层日线程口径不变。
  assert.equal(isCaptureKey('2026-11-10.md'), true);
  assert.equal(isCaptureKey('2026-11-10.md\n'), false);
  assert.equal(isCaptureKey(undefined), false);
  assert.equal(isCaptureKey(42), false);
});
