import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, lstat, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beginCaptureIntent, finishCaptureIntent } from '../src/capture-intent.js';

const day = '2026-11-10';
// Binary bytes, including non-UTF-8, ensure the assertion cannot pass on a
// lossy text comparison or on a recreated file with merely similar text.
const foreignBytes = Buffer.from([0x00, 0xff, 0x41, 0x0a, 0xc3, 0xa9, 0x7f]);

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'capture-intent-replacement-'));
  const pending = path.join(root, '.daily-capture.pending');
  const saved = path.join(root, 'saved-original-intent');
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('capture-intent-replacement-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, pending, saved };
}

// Another real Node process moves the original witness and installs its own
// file at the same path. It never receives the real memory root. The child has
// no piped stdio; its exit status confirms both filesystem actions completed.
async function replaceInOtherProcess(f) {
  const script = `const {rename,writeFile} = require('node:fs/promises');
    (async () => {
      await rename(process.env.CAPTURE_TEST_PENDING, process.env.CAPTURE_TEST_SAVED);
      await writeFile(process.env.CAPTURE_TEST_PENDING, Buffer.from(process.env.CAPTURE_TEST_FOREIGN, 'base64'), {flag:'wx'});
    })().catch(() => { process.exitCode = 1; });`;
  const child = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, CAPTURE_TEST_PENDING: f.pending, CAPTURE_TEST_SAVED: f.saved,
      CAPTURE_TEST_FOREIGN: foreignBytes.toString('base64') },
    stdio: 'ignore', windowsHide: true,
  });
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(signal, null, '替换进程须正常退出');
  assert.equal(code, 0, '替换进程必须完成真实 rename 和独占哨兵写入');
}

async function observedBytes(file) {
  try { return await readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function runFinish(intent) {
  try { await finishCaptureIntent(intent); return null; }
  catch (error) { return error; }
}

async function verifyReplacementPreserved(f, originalBytes, error) {
  assert.deepEqual(await readFile(f.saved), originalBytes, '另一个进程保存的原意图字节必须完整');
  const actual = await observedBytes(f.pending);
  assert.deepEqual(actual, foreignBytes, '外来哨兵在原路径必须原样保留；null 表示被 finish 误删');
  assert.ok(error, '意图已被替换时不能报告正常完成');
}

test('正常正控：真实创建的未替换意图可完成且被移除', async (t) => {
  const f = await fixture(t);
  const intent = await beginCaptureIntent(f.root, day);
  assert.equal(intent.file, f.pending);
  const bytes = await readFile(f.pending);
  const record = JSON.parse(bytes.toString('utf8'));
  assert.equal(record.id, intent.id);
  assert.equal(record.day, day);
  await finishCaptureIntent(intent);
  await assert.rejects(lstat(f.pending), { code: 'ENOENT' });
  assert.equal(await observedBytes(f.saved), null, '正控没有运行替换进程');
});

test('finish 调用前被另一进程替换时，不能删除外来哨兵', async (t) => {
  const f = await fixture(t);
  const intent = await beginCaptureIntent(f.root, day);
  const originalBytes = await readFile(f.pending);
  await replaceInOtherProcess(f);
  assert.deepEqual(await readFile(f.saved), originalBytes, '替换实际保留原意图');
  assert.deepEqual(await readFile(f.pending), foreignBytes, '调用前确认外来哨兵确实存在');
  const error = await runFinish(intent);
  await verifyReplacementPreserved(f, originalBytes, error);
});

test('finish 发起原子改名的瞬间被另一进程替换时，不能删除外来哨兵', async (t) => {
  const f = await fixture(t);
  const intent = await beginCaptureIntent(f.root, day);
  const originalBytes = await readFile(f.pending);
  // Race the real detach step. The implementation renames the pathname into a
  // quarantine name before verifying the inode; another process replacing the
  // file at that instant is the case a check-then-delete order could never
  // survive. Patching rename (not unlink) keeps the race on the step that
  // actually decides which file we are about to destroy.
  const originalRename = fs.promises.rename;
  let calls = 0;
  fs.promises.rename = async (from, to, ...args) => {
    if (path.resolve(String(from)) !== path.resolve(f.pending)) return originalRename(from, to, ...args);
    calls++;
    assert.equal(calls, 1, 'detach must happen exactly once');
    await replaceInOtherProcess(f);
    assert.deepEqual(await readFile(f.saved), originalBytes, 'the real original intent is preserved before the race');
    assert.deepEqual(await readFile(f.pending), foreignBytes, 'the foreign witness really is in place at detach time');
    return originalRename(from, to, ...args);
  };
  syncBuiltinESMExports();
  let error;
  try { error = await runFinish(intent); }
  finally { fs.promises.rename = originalRename; syncBuiltinESMExports(); }
  assert.equal(calls, 1, 'the race must happen on the real detach step');
  await verifyReplacementPreserved(f, originalBytes, error);
});
