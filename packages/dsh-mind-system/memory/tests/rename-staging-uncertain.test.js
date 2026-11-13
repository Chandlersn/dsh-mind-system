import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeRenameTarget } from '../server.js';
import { LEDGER_REL } from '../src/write-ledger.js';

// 2026-11-13：暂存入口是 stage.js 的 open(path, 'wx') + FileHandle 写入，
// 路径在 <root>/.stage/<key 文件名>.stage-<uuid>.tmp。故障注入改为拦截
// fs.promises.open 的 'wx' 独占创建（唯一的暂存创建入口），语义不变：
// 部分写入 / 真实 EEXIST 后，源与目标原样、暂存现场保留、结果明确。
async function fixture(t, fault) {
  const io = fs.promises;
  const originalOpen = io.open;
  const originalWrite = io.writeFile;
  const root = await io.mkdtemp(path.join(tmpdir(), 'dsh-rename-stage-'));
  const dir = path.join(root, 'functions');
  const stageDir = path.join(root, '.stage');
  const source = path.join(dir, '源.md');
  const target = path.join(dir, '目标.md');
  const ledger = path.join(root, LEDGER_REL);
  await io.mkdir(dir, { recursive: true });
  await originalWrite.call(io, source, '源文件原文', 'utf8');
  await originalWrite.call(io, target, '目标文件原文', 'utf8');
  await originalWrite.call(io, ledger, '', 'utf8');
  t.after(async () => {
    io.open = originalOpen;
    io.writeFile = originalWrite;
    syncBuiltinESMExports();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-rename-stage-'));
    await io.rm(root, { recursive: true, force: true });
  });

  let stage;
  let attempts = 0;
  io.open = async (target_, ...args) => {
    if (typeof target_ === 'string' && args[0] === 'wx' && path.dirname(target_).toLowerCase() === stageDir.toLowerCase() && path.basename(target_).includes('.stage-')) {
      attempts++;
      stage = path.resolve(target_);
      if (fault === 'partial') {
        const handle = await originalOpen.call(io, target_, ...args);
        const realWrite = handle.writeFile.bind(handle);
        handle.writeFile = async (data, ...rest) => {
          await realWrite(String(data).slice(0, 4), ...rest);
          const error = new Error('隔离故障：写入部分暂存内容后 EIO');
          error.code = 'EIO';
          throw error;
        };
        return handle;
      }
      // Create the sentinel immediately before the real exclusive open, proving
      // the real EEXIST path instead of throwing a synthetic collision.
      await originalWrite.call(io, target_, '已有暂存哨兵，必须保留', { encoding: 'utf8', flag: 'wx' });
      const error = new Error(`EEXIST: file already exists, open '${target_}'`);
      error.code = 'EEXIST';
      error.path = target_;
      throw error;
    }
    return originalOpen.call(io, target_, ...args);
  };
  syncBuiltinESMExports();

  let failure;
  try {
    await writeRenameTarget(root, target, '目标文件原文', '目标合并后的完整正文');
  } catch (error) {
    failure = error;
  } finally {
    io.open = originalOpen;
    io.writeFile = originalWrite;
    syncBuiltinESMExports();
  }

  assert.equal(attempts, 1, '必须命中真实暂存写入一次');
  assert.ok(stage, '测试必须观测真实暂存路径');
  assert.equal(path.dirname(stage).toLowerCase(), stageDir.toLowerCase(), '暂存文件必须位于隔离 .stage/ 目录');
  assert.equal(await io.readFile(source, 'utf8'), '源文件原文', '源文件必须保留');
  assert.equal(await io.readFile(target, 'utf8'), '目标文件原文', '目标文件必须保持原字节');
  assert.equal(await io.readFile(ledger, 'utf8'), '', '提交前不得追加账本');
  const stageText = await io.readFile(stage, 'utf8');
  // 部分写入残片（前 4 字节）按 2026-11-13 契约保留在暂存路径；独占碰撞时
  // 哨兵文件必须原样保留。两者都证明：归属未核验前绝不删除/改写暂存现场。
  assert.equal(stageText, fault === 'partial' ? '目标合并' : '已有暂存哨兵，必须保留', '部分残片或哨兵内容必须保留，不能误删');
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
