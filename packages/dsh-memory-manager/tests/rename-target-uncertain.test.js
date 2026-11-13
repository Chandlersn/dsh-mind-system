import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeRenameTarget } from '../server.js';
import { LEDGER_REL } from '../src/write-ledger.js';

test('目标已替换但 rename 确认丢失：状态未知且不重试、不删除源文件', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-rename-target-uncertain-'));
  const originalRename = fs.promises.rename;
  t.after(async () => {
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-rename-target-uncertain-'));
    await rm(root, { recursive: true, force: true });
  });

  const dir = path.join(root, 'functions');
  const source = path.join(dir, '旧功能.md');
  const target = path.join(dir, '新功能.md');
  const ledger = path.join(root, LEDGER_REL);
  await mkdir(dir, { recursive: true });
  await writeFile(source, '源文件必须保留', 'utf8');
  await writeFile(target, '目标原始正文', 'utf8');
  await writeFile(ledger, '', 'utf8');

  let attempts = 0;
  let actualReplacement = false;
  fs.promises.rename = async (from, to) => {
    // 2026-11-13：writeRenameTarget 暂存移入 <root>/.stage/（`.stage-<uuid>.tmp`）。
    if (path.resolve(String(to)) === target && String(from).includes('.stage-')) {
      attempts++;
      if (attempts === 1) {
        await originalRename(from, to);
        actualReplacement = (await readFile(target, 'utf8')) === '目标合并后正文';
        const error = new Error('模拟替换已完成但确认丢失');
        error.code = 'EIO';
        throw error;
      }
    }
    return originalRename(from, to);
  };
  syncBuiltinESMExports();

  let failure;
  try {
    await writeRenameTarget(root, target, '目标原始正文', '目标合并后正文');
  } catch (error) {
    failure = error;
  } finally {
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
  }

  // Observe disk independently: an EIO from the caller does not imply no commit.
  assert.equal(actualReplacement, true, '故障必须发生在真实目标替换之后');
  assert.equal(await readFile(target, 'utf8'), '目标合并后正文');
  assert.equal(await readFile(source, 'utf8'), '源文件必须保留');
  assert.equal(await readFile(ledger, 'utf8'), '', '此故障发生在目标记账之前');
  assert.ok(failure, '提交回执丢失必须作为异常报告');
  t.diagnostic(`实际回执：code=${String(failure.code)}，fileWritten=${String(failure.fileWritten)}，message=${String(failure.message)}`);
  assert.equal(attempts, 1, '目标替换可能已发生，不能重复执行 rename');
  assert.equal(failure.code, 'MEMORY_WRITE_COMMIT_UNKNOWN');
  assert.equal(failure.fileWritten, null, '不得声称已确定写入或未写入');
  assert.match(failure.message, /核[查对]/);
  assert.match(failure.message, /目标/);
  assert.match(failure.message, /账本/);
  assert.match(failure.message, /不要盲目重试/);
});
