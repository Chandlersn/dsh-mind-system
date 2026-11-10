import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeText, withWriteCommitLock } from '../src/util.js';
import { readLedger, recordDeleteEvent, contentHash, LEDGER_REL } from '../src/write-ledger.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-write-intent-'));
  await mkdir(path.join(root, 'functions'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^dsh-write-intent-/);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function intent(root, key) {
  assert.equal(await recordDeleteEvent(root, { key, op: 'delete_intent', id: 'intent-1', tool: 'fixture' }), true);
}

function refused(err) {
  assert.equal(err.code, 'MEMORY_DELETE_INTENT_PENDING');
  assert.equal(err.fileWritten, false);
  assert.match(err.message, /未完成删除意图/);
  return true;
}

test('已有目标的未完成删除意图阻止覆盖，账本原样且仍可读取', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'functions', 'x.md');
  await writeFile(file, '原文');
  await intent(root, 'functions/x.md');
  const ledgerFile = path.join(root, LEDGER_REL);
  const before = await readFile(ledgerFile, 'utf8');
  await assert.rejects(writeText(file, '新文', { memoryRoot: root }), refused);
  assert.equal(await readFile(file, 'utf8'), '原文');
  assert.equal(await readFile(ledgerFile, 'utf8'), before);
  assert.equal((await readLedger(root)).get('functions/x.md').op, 'delete_intent');
  assert.deepEqual(await readdir(path.dirname(file)), ['x.md']);
});

test('目标尚不存在但已有意图时不创建新文件', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'functions', 'new.md');
  await intent(root, 'functions/new.md');
  const before = await readFile(path.join(root, LEDGER_REL), 'utf8');
  await assert.rejects(writeText(file, '不可创建', { memoryRoot: root }), refused);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, LEDGER_REL), 'utf8'), before);
});

test('损坏或无法读取的账本在替换之前拒绝且不覆写', async (t) => {
  for (const mode of ['invalid-json', 'directory']) {
    const root = await fixture(t);
    const file = path.join(root, 'functions', 'x.md');
    const ledger = path.join(root, LEDGER_REL);
    await writeFile(file, '原文');
    if (mode === 'invalid-json') await writeFile(ledger, '{corrupt\n');
    else await mkdir(ledger);
    await assert.rejects(writeText(file, '新文', { memoryRoot: root }), (err) => {
      assert.equal(err.code, 'MEMORY_LEDGER_UNREADABLE');
      assert.equal(err.fileWritten, false);
      return true;
    });
    assert.equal(await readFile(file, 'utf8'), '原文');
    if (mode === 'invalid-json') assert.equal(await readFile(ledger, 'utf8'), '{corrupt\n');
    else assert.deepEqual(await readdir(ledger), []);
  }
});

test('已经错序的意图及写入使整个账本未知，目标不被替换', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'functions', 'x.md');
  await writeFile(file, '原文');
  await intent(root, 'functions/other.md');
  const ledgerPath = path.join(root, LEDGER_REL);
  const initial = await readFile(ledgerPath, 'utf8');
  const broken = initial + JSON.stringify({ key: 'functions/other.md', hash: 'a', tool: 'fixture' }) + '\n';
  await writeFile(ledgerPath, broken);
  assert.equal(await readLedger(root), undefined);
  await assert.rejects(writeText(file, '不可覆盖', { memoryRoot: root }), { code: 'MEMORY_LEDGER_UNREADABLE', fileWritten: false });
  assert.equal(await readFile(file, 'utf8'), '原文');
  assert.equal(await readFile(ledgerPath, 'utf8'), broken);
});

test('已完成删除允许重建并记录新的写入', async (t) => {
  const root = await fixture(t);
  await intent(root, 'functions/x.md');
  assert.equal(await recordDeleteEvent(root, { key: 'functions/x.md', op: 'delete', id: 'intent-1', tool: 'fixture' }), true);
  const file = path.join(root, 'functions', 'x.md');
  await writeText(file, '新正文', { memoryRoot: root });
  assert.equal((await readLedger(root)).get('functions/x.md').hash, contentHash('新正文'));
});

test('不同文件的意图不阻止正常目标写入', async (t) => {
  const root = await fixture(t);
  await intent(root, 'functions/other.md');
  const file = path.join(root, 'functions', 'x.md');
  await writeText(file, '正常写入', { memoryRoot: root });
  const ledger = await readLedger(root);
  assert.equal(ledger.get('functions/other.md').op, 'delete_intent');
  assert.equal(ledger.get('functions/x.md').hash, contentHash('正常写入'));
});

test('同一提交锁内读取意图，等待期间新发生的删除不会漏过', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'functions', 'x.md');
  await writeFile(file, '原文');
  let release;
  let entered;
  const barrier = new Promise((resolve) => { release = resolve; });
  const acquired = new Promise((resolve) => { entered = resolve; });
  const deletion = withWriteCommitLock(file, async () => { entered(); await barrier; await intent(root, 'functions/x.md'); });
  await acquired;
  const writing = writeText(file, '不可覆盖', { memoryRoot: root });
  release();
  await deletion;
  await assert.rejects(writing, refused);
  assert.equal(await readFile(file, 'utf8'), '原文');
  assert.equal((await readLedger(root)).get('functions/x.md').op, 'delete_intent');
});

test('目录链接指向受管根时按物理根与物理键阻止覆盖', async (t) => {
  const root = await fixture(t);
  const alias = path.join(root, 'alias');
  try { await symlink(path.join(root, 'functions'), alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (err) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(err.code)) return t.skip('目录链接不可用'); throw err; }
  const file = path.join(root, 'functions', 'x.md');
  await writeFile(file, '原文');
  await intent(root, 'functions/x.md');
  const before = await readFile(path.join(root, LEDGER_REL), 'utf8');
  await assert.rejects(writeText(path.join(alias, 'x.md'), '不可覆盖', { memoryRoot: root }), refused);
  assert.equal(await readFile(file, 'utf8'), '原文');
  assert.equal(await readFile(path.join(root, LEDGER_REL), 'utf8'), before);
});

test('根目录的链接别名仍核查同一物理账本', async (t) => {
  const root = await fixture(t);
  const alias = path.join(root, 'root-alias');
  try { await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (err) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(err.code)) return t.skip('目录链接不可用'); throw err; }
  const file = path.join(root, 'functions', 'x.md');
  await writeFile(file, '原文');
  await intent(root, 'functions/x.md');
  await assert.rejects(writeText(file, '不可覆盖', { memoryRoot: alias }), refused);
  assert.equal(await readFile(file, 'utf8'), '原文');
  assert.equal((await readLedger(root)).get('functions/x.md').op, 'delete_intent');
});

test('Windows 同一文件名大小写变体不能绕过删除意图', async (t) => {
  if (process.platform !== 'win32') return t.skip('仅适用不区分大小写的 Windows 默认文件系统');
  const root = await fixture(t);
  const file = path.join(root, 'functions', 'Name.md');
  await writeFile(file, '原文');
  await intent(root, 'functions/Name.md');
  await assert.rejects(writeText(path.join(root, 'functions', 'name.md'), '不可覆盖', { memoryRoot: root }), refused);
  assert.equal(await readFile(file, 'utf8'), '原文');
});

test('目标叶子链接按被替换的目录项核查，目标内容不被误认', async (t) => {
  const root = await fixture(t);
  const actual = path.join(root, 'functions', 'actual.md');
  const link = path.join(root, 'functions', 'link.md');
  await writeFile(actual, '外链目标');
  try { await symlink(actual, link, 'file'); }
  catch (err) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(err.code)) return t.skip('文件链接不可用'); throw err; }
  await intent(root, 'functions/link.md');
  await assert.rejects(writeText(link, '不可覆盖', { memoryRoot: root }), refused);
  assert.equal(await readFile(link, 'utf8'), '外链目标');
  assert.equal(await readFile(actual, 'utf8'), '外链目标');
  assert.equal((await readLedger(root)).get('functions/link.md').op, 'delete_intent');
});

test('账本文件是悬空链接时不把 ENOENT 当空账本', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'functions', 'x.md');
  await writeFile(file, '原文');
  const ledger = path.join(root, LEDGER_REL);
  try { await symlink(path.join(root, 'missing-ledger'), ledger, 'file'); }
  catch (err) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(err.code)) return t.skip('文件链接不可用'); throw err; }
  await assert.rejects(writeText(file, '不可覆盖', { memoryRoot: root }), { code: 'MEMORY_LEDGER_UNREADABLE', fileWritten: false });
  assert.equal(await readFile(file, 'utf8'), '原文');
  await assert.rejects(readFile(ledger), { code: 'ENOENT' });
});

test('账本可读但实际追加失败时仍报告已写入、账本状态未知', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'functions', 'x.md');
  const ledgerPath = path.join(root, LEDGER_REL);
  await writeFile(file, '原文');
  await writeFile(ledgerPath, '');
  const original = fs.promises.appendFile;
  fs.promises.appendFile = async (target, ...args) => {
    if (path.resolve(target) === ledgerPath) throw Object.assign(new Error('injected append failure'), { code: 'EACCES' });
    return original.call(fs.promises, target, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(writeText(file, '已落盘', { memoryRoot: root }), (err) => {
      assert.equal(err.code, 'MEMORY_LEDGER_APPEND_FAILED');
      assert.equal(err.fileWritten, true);
      assert.equal(err.ledgerStatus, 'unknown');
      assert.match(err.message, /不要盲目重试/);
      return true;
    });
    assert.equal(await readFile(file, 'utf8'), '已落盘');
    assert.equal(await readFile(ledgerPath, 'utf8'), '');
  } finally {
    fs.promises.appendFile = original;
    syncBuiltinESMExports();
  }
});
