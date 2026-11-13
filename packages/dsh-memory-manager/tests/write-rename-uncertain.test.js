import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeText } from '../src/util.js';
import { contentHash, LEDGER_REL, readLedger } from '../src/write-ledger.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-rename-uncertain-'));
  const file = path.join(root, 'functions', 'subject.md');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '旧内容', 'utf8');
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-rename-uncertain-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, file };
}

async function withFsFault(replacements, fn) {
  const originals = new Map();
  for (const [name, replacement] of Object.entries(replacements)) {
    originals.set(name, fs.promises[name]);
    fs.promises[name] = replacement(fs.promises[name]);
  }
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    for (const [name, original] of originals) fs.promises[name] = original;
    syncBuiltinESMExports();
  }
}

test('真实替换后回执丢失：报告提交未知，不自动重复 rename', async (t) => {
  const { root, file } = await fixture(t);
  let attempts = 0;
  let contentsAtFailure;
  let error;
  await withFsFault({ rename: (original) => async (source, destination) => {
    if (path.resolve(String(destination)) !== file) return original(source, destination);
    attempts++;
    if (attempts === 1) {
      await original(source, destination);
      contentsAtFailure = await readFile(file, 'utf8');
      const failure = new Error('模拟文件已替换、rename 确认丢失');
      failure.code = 'EIO';
      throw failure;
    }
    return original(source, destination);
  } }, async () => {
    try { await writeText(file, '已替换的新内容', { memoryRoot: root }); }
    catch (caught) { error = caught; }
  });

  // These observations establish the ambiguous commit independently of the receipt.
  assert.equal(contentsAtFailure, '已替换的新内容', '故障须在真实替换完成后发生');
  assert.equal(await readFile(file, 'utf8'), '已替换的新内容');
  assert.equal((await readLedger(root)).has('functions/subject.md'), false, '替换已发生但尚无账本回执');
  assert.ok(error, '调用必须抛错，不能伪报成功');
  assert.deepEqual({ code: error.code, fileWritten: error.fileWritten, attempts }, {
    code: 'MEMORY_WRITE_COMMIT_UNKNOWN', fileWritten: null, attempts: 1,
  }, '提交状态未知时必须停止重试并明确报告');
  assert.match(error.message, /先.*(核对|检查)/);
  assert.match(error.message, /不要盲目重试/);
});

test('临时文件写入在 rename 前确定失败：目标和账本不变', async (t) => {
  const { root, file } = await fixture(t);
  let renameAttempts = 0;
  let intercepted = 0;
  let error;
  await withFsFault({
    rename: (original) => async (...args) => { renameAttempts++; return original(...args); },
    // 2026-11-13：暂存写入走 createVerifiedStage（open 'wx' + handle.writeFile）；
    // 拦截 open 命中 .stage- 命名后抛 EACCES，等价于旧 writeFile 注入。
    open: (original) => async (target, ...args) => {
      if (args[0] === 'wx' && String(target).includes('.stage-') && String(target).endsWith('.tmp')) {
        intercepted++;
        const failure = new Error('模拟暂存创建失败');
        failure.code = 'EACCES';
        throw failure;
      }
      return original(target, ...args);
    },
  }, async () => {
    try { await writeText(file, '不可写入的新内容', { memoryRoot: root }); }
    catch (caught) { error = caught; }
  });
  assert.equal(intercepted, 1);
  assert.equal(renameAttempts, 0);
  assert.ok(error);
  assert.notEqual(error.code, 'MEMORY_WRITE_COMMIT_UNKNOWN');
  assert.notEqual(error.fileWritten, true);
  assert.equal(await readFile(file, 'utf8'), '旧内容');
  assert.equal((await readLedger(root)).has('functions/subject.md'), false);
});

test('正常替换一次并在账本记录实际内容哈希', async (t) => {
  const { root, file } = await fixture(t);
  let attempts = 0;
  const result = await withFsFault({ rename: (original) => async (source, destination) => {
    if (path.resolve(String(destination)) === file) attempts++;
    return original(source, destination);
  } }, () => writeText(file, '正常新内容', { memoryRoot: root }));
  assert.equal(attempts, 1);
  assert.ok(Array.isArray(result.hits));
  assert.equal(await readFile(file, 'utf8'), '正常新内容');
  const ledger = await readLedger(root);
  assert.equal(ledger.get('functions/subject.md')?.hash, contentHash('正常新内容'));
  assert.ok((await readFile(path.join(root, LEDGER_REL), 'utf8')).length > 0);
});
