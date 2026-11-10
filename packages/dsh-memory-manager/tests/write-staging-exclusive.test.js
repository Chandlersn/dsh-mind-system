import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile, link, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeText } from '../src/util.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'memory-stage-exclusive-'));
  const dir = path.join(root, 'functions');
  const file = path.join(dir, 'subject.md');
  await mkdir(dir, { recursive: true });
  await writeFile(file, '原目标');
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('memory-stage-exclusive-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, dir, file };
}

async function interceptWriteFile(replacement, run) {
  const original = fs.promises.writeFile;
  fs.promises.writeFile = replacement(original);
  syncBuiltinESMExports();
  try { return await run(); }
  finally { fs.promises.writeFile = original; syncBuiltinESMExports(); }
}

// Reproduce the old name exactly: both sources of its suffix are predictable.
test('可预测旧暂存名已有文件时，不能覆盖或删除该文件', async (t) => {
  const { root, file } = await fixture(t);
  const oldNow = Date.now, oldRandom = Math.random;
  const now = 1700000000000, random = 0.5;
  const collision = `${file}.tmp-${process.pid.toString(36)}-${now.toString(36)}-${random.toString(36).slice(2, 8)}`;
  await writeFile(collision, '已有暂存资料');
  Date.now = () => now;
  Math.random = () => random;
  try { await writeText(file, '新目标', { memoryRoot: root }); }
  finally { Date.now = oldNow; Math.random = oldRandom; }
  assert.equal(await readFile(collision, 'utf8'), '已有暂存资料');
  assert.equal(await readFile(file, 'utf8'), '新目标');
});

test('当前暂存名发生碰撞时独占创建拒绝，不覆盖也不删除已有文件', async (t) => {
  const { root, file } = await fixture(t);
  let existing;
  await interceptWriteFile((original) => async (target, ...args) => {
    if (!existing && String(target).startsWith(`${file}.tmp-`)) {
      existing = String(target);
      await original(existing, '其他写入者的暂存资料', 'utf8');
    }
    return original(target, ...args);
  }, async () => {
    await assert.rejects(writeText(file, '不应提交', { memoryRoot: root }), (err) => {
      assert.equal(err.code, 'MEMORY_STAGE_OUTCOME_UNKNOWN');
      assert.match(err.message, /暂存/);
      assert.match(err.message, /核对/);
      return true;
    });
  });
  assert.ok(existing, '必须真实触发碰撞');
  assert.equal(await readFile(existing, 'utf8'), '其他写入者的暂存资料');
  assert.equal(await readFile(file, 'utf8'), '原目标');
});

test('暂存文件部分写入后回执丢失：目标未替换，暂存归属未知且不删除', async (t) => {
  const { root, file } = await fixture(t);
  let staged;
  await interceptWriteFile((original) => async (target, data, ...args) => {
    if (!staged && String(target).startsWith(`${file}.tmp-`)) {
      staged = String(target);
      await original(staged, String(data).slice(0, 3), ...args);
      const err = new Error('模拟部分写入后异常'); err.code = 'EIO'; throw err;
    }
    return original(target, data, ...args);
  }, async () => {
    await assert.rejects(writeText(file, '新正文需要保留', { memoryRoot: root }), (err) => {
      assert.equal(err.code, 'MEMORY_STAGE_OUTCOME_UNKNOWN');
      assert.equal(err.fileWritten, false);
      assert.equal(err.stagingPath, staged);
      assert.match(err.message, /核对/);
      return true;
    });
  });
  assert.ok(staged, '必须真实创建并部分写入暂存文件');
  assert.equal(await readFile(staged, 'utf8'), '新正文');
  assert.equal(await readFile(file, 'utf8'), '原目标');
});

test('已有硬链接暂存名不能覆盖其指向文件或删除链接', async (t) => {
  const { root, file } = await fixture(t);
  const other = path.join(root, '硬链接目标.md');
  await writeFile(other, '不可更改');
  let staged;
  await interceptWriteFile((original) => async (target, ...args) => {
    if (!staged && String(target).startsWith(`${file}.tmp-`)) {
      staged = String(target);
      await link(other, staged);
    }
    return original(target, ...args);
  }, async () => {
    await assert.rejects(writeText(file, '不应写入', { memoryRoot: root }), { code: 'MEMORY_STAGE_OUTCOME_UNKNOWN' });
  });
  assert.equal(await readFile(other, 'utf8'), '不可更改');
  assert.equal(await readFile(staged, 'utf8'), '不可更改');
  assert.equal((await lstat(staged)).nlink >= 2, true);
  assert.equal(await readFile(file, 'utf8'), '原目标');
});

test('已有符号链接暂存名不能被跟随或删除', async (t) => {
  const { root, dir, file } = await fixture(t);
  const outside = path.join(dir, '其他文件.md');
  await writeFile(outside, '不可更改');
  try { await symlink(outside, path.join(dir, '权限探针.link'), 'file'); }
  catch (err) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(err.code)) return t.skip('本机没有创建文件符号链接的权限');
    throw err;
  }
  let staged;
  await interceptWriteFile((original) => async (target, ...args) => {
    if (!staged && String(target).startsWith(`${file}.tmp-`)) {
      staged = String(target);
      await symlink(outside, staged, 'file');
    }
    return original(target, ...args);
  }, async () => {
    await assert.rejects(writeText(file, '不应写向其他文件', { memoryRoot: root }), { code: 'MEMORY_STAGE_OUTCOME_UNKNOWN' });
  });
  assert.equal(await readFile(outside, 'utf8'), '不可更改');
  assert.equal(await readFile(file, 'utf8'), '原目标');
  assert.equal((await lstat(staged)).isSymbolicLink(), true);
});
