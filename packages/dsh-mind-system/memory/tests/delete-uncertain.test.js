import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deleteTrackedFile } from '../server.js';
import { LEDGER_REL, readLedger } from '../src/write-ledger.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-delete-uncertain-'));
  await mkdir(path.join(root, 'functions'));
  const file = path.join(root, 'functions', 'x.md');
  await writeFile(file, '原文', 'utf8');
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^dsh-delete-uncertain-/);
    await rm(root, { recursive: true, force: true });
  });
  return { root, file, key: 'functions/x.md', ledger: path.join(root, LEDGER_REL) };
}

function injectedError() {
  return Object.assign(new Error('模拟操作成功但确认丢失'), { code: 'EIO' });
}

function assertCheckBeforeRetry(message) {
  assert.match(message, /核对|核查/, '回执应要求先核对实际状态');
  assert.match(message, /不要盲目重试|勿盲目重试/, '回执应明确禁止盲目重试');
}

test('unlink 已删除后抛错时，保留意图并明确删除结果未知', async (t) => {
  const { root, file, key } = await fixture(t);
  const original = fs.promises.unlink;
  let injected = 0;
  fs.promises.unlink = async (target, ...args) => {
    if (path.resolve(String(target)) === file && injected === 0) {
      injected++;
      await original.call(fs.promises, target, ...args);
      throw injectedError();
    }
    return original.call(fs.promises, target, ...args);
  };
  syncBuiltinESMExports();
  let failure;
  try {
    await deleteTrackedFile(root, file, '原文', { tool: 'test' });
  } catch (error) {
    failure = error;
  } finally {
    fs.promises.unlink = original;
    syncBuiltinESMExports();
  }
  assert.equal(injected, 1, '故障必须在真实 unlink 完成后发生');
  await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' }, '文件实际已经删除');
  assert.equal((await readLedger(root)).get(key)?.op, 'delete_intent', '账本保留未完成意图');
  assert.ok(failure, '删除回执必须报告异常');
  assert.match(failure.message, /未知|不确定/, '必须明确删除结果未知');
  assert.match(failure.message, /可能.{0,8}删|已删除/, '必须提示文件可能已删除');
  assert.match(failure.message, /意图/, '必须提示保留的删除意图');
  assertCheckBeforeRetry(failure.message);
});

test('删除意图真实追加后抛错时，文件保留且明确记账结果未知', async (t) => {
  const { root, file, key, ledger } = await fixture(t);
  const original = fs.promises.appendFile;
  let injected = 0;
  fs.promises.appendFile = async (target, data, ...args) => {
    if (path.resolve(String(target)) === ledger && String(data).includes('"op":"delete_intent"') && injected === 0) {
      injected++;
      await original.call(fs.promises, target, data, ...args);
      throw injectedError();
    }
    return original.call(fs.promises, target, data, ...args);
  };
  syncBuiltinESMExports();
  let failure;
  try {
    await deleteTrackedFile(root, file, '原文', { tool: 'test' });
  } catch (error) {
    failure = error;
  } finally {
    fs.promises.appendFile = original;
    syncBuiltinESMExports();
  }
  assert.equal(injected, 1, '故障必须在真实追加删除意图之后发生');
  assert.equal(await readFile(file, 'utf8'), '原文', '意图确认失败时原文件必须保留');
  assert.equal((await readLedger(root)).get(key)?.op, 'delete_intent', '意图实际已经追加到账本');
  assert.ok(failure, '删除回执必须报告异常');
  assert.match(failure.message, /意图/, '回执应明确指向删除意图');
  assert.match(failure.message, /记账|记录|账本/, '回执应明确指向记账结果');
  assert.match(failure.message, /未知|不确定/, '必须明确意图记账结果未知');
  assertCheckBeforeRetry(failure.message);
});
