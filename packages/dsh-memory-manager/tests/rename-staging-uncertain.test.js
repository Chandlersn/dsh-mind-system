import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeRenameTarget } from '../server.js';
import { LEDGER_REL } from '../src/write-ledger.js';

async function fixture(t, fault) {
  const io = fs.promises;
  const originalWrite = io.writeFile;
  const root = await io.mkdtemp(path.join(tmpdir(), 'dsh-rename-stage-'));
  const dir = path.join(root, 'functions');
  const source = path.join(dir, '源.md');
  const target = path.join(dir, '目标.md');
  const ledger = path.join(root, LEDGER_REL);
  await io.mkdir(dir, { recursive: true });
  await originalWrite.call(io, source, '源文件原文', 'utf8');
  await originalWrite.call(io, target, '目标文件原文', 'utf8');
  await originalWrite.call(io, ledger, '', 'utf8');
  t.after(async () => {
    io.writeFile = originalWrite;
    syncBuiltinESMExports();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-rename-stage-'));
    await io.rm(root, { recursive: true, force: true });
  });

  let stage;
  let attempts = 0;
  io.writeFile = async (file, data, options) => {
    if (typeof file === 'string' && file.startsWith(`${target}.rename-`) && file.endsWith('.tmp')) {
      attempts++;
      stage = file;
      assert.equal(options?.flag, 'wx', '暂存文件必须独占创建');
      if (fault === 'partial') {
        await originalWrite.call(io, file, String(data).slice(0, 4), options);
        const error = new Error('隔离故障：写入部分暂存内容后 EIO');
        error.code = 'EIO';
        throw error;
      }
      // Create the sentinel immediately before the real exclusive open, proving
      // the real EEXIST path instead of throwing a synthetic collision.
      await originalWrite.call(io, file, '已有暂存哨兵，必须保留', { encoding: 'utf8', flag: 'wx' });
      return originalWrite.call(io, file, data, options);
    }
    return originalWrite.call(io, file, data, options);
  };
  syncBuiltinESMExports();

  let failure;
  try {
    await writeRenameTarget(root, target, '目标文件原文', '目标合并后的完整正文');
  } catch (error) {
    failure = error;
  } finally {
    io.writeFile = originalWrite;
    syncBuiltinESMExports();
  }

  assert.equal(attempts, 1, '必须命中真实暂存写入一次');
  assert.ok(stage, '测试必须观测真实暂存路径');
  assert.equal(path.dirname(stage), dir, '暂存文件必须位于隔离目录');
  assert.equal(await io.readFile(source, 'utf8'), '源文件原文', '源文件必须保留');
  assert.equal(await io.readFile(target, 'utf8'), '目标文件原文', '目标文件必须保持原字节');
  assert.equal(await io.readFile(ledger, 'utf8'), '', '提交前不得追加账本');
  const stageText = await io.readFile(stage, 'utf8');
  assert.equal(stageText, fault === 'partial' ? '目标合并' : '已有暂存哨兵，必须保留', '原有或部分暂存内容必须保留，不能误删');
  assert.ok(failure, '暂存失败不得报告成功');
  t.diagnostic(`实际回执：code=${String(failure.code)}，fileWritten=${String(failure.fileWritten)}，message=${String(failure.message)}`);
  assert.equal(failure.code, 'MEMORY_STAGE_OUTCOME_UNKNOWN');
  assert.equal(failure.fileWritten, false, '目标替换尚未开始，应明确目标未写入');
  assert.match(failure.message, /暂存|临时/, '需指出遗留暂存文件');
  assert.match(failure.message, /核对|核查/, '需提示先核对');
  assert.match(failure.message, /不要盲目.{0,8}重试/, '不得引导用户盲目重试');
}

test('暂存部分写入后 EIO：源、目标原样且残片保留，结果需明确', async (t) => fixture(t, 'partial'));
test('暂存独占创建发生真实 EEXIST：源、目标原样且哨兵不得误删', async (t) => fixture(t, 'collision'));
