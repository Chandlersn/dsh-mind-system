import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat, lstat, utimes, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeText } from '../src/util.js';
import { createVerifiedStage, removeVerifiedStage, sweepStaleStages, stageDir } from '../src/stage.js';
import { contentHash, readLedger } from '../src/write-ledger.js';

// Export only for this isolated test; the functions and all fs operations are
// the production code, and no packaged source or real memory is modified.
const entry = pathToFileURL(path.resolve(import.meta.dirname, '..', 'server.js')).href;
const hook = registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (url.startsWith(entry) && loaded.format === 'module') {
      return { ...loaded, source: `${Buffer.from(loaded.source).toString('utf8')}\nexport { writeTrackedPanelFile };\n` };
    }
    return loaded;
  },
});
const { writeRenameTarget, writeTrackedPanelFile } = await import(`${entry}?staging-ownership-test`);
hook.deregister();

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'staging-owner-after-commit-'));
  const file = path.join(root, 'functions', 'destination.md');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '旧内容', 'utf8');
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('staging-owner-after-commit-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, file };
}

async function faulted(name, replacement, run) {
  const original = fs.promises[name];
  fs.promises[name] = replacement(original);
  syncBuiltinESMExports();
  try { return await run(); }
  finally { fs.promises[name] = original; syncBuiltinESMExports(); }
}

for (const mode of ['writeText', 'writeRenameTarget', 'panel-rename']) {
  for (const lostAck of [false, true]) {
    test(`${mode} 替换目标后新文件占用暂存路径${lostAck ? '且回执丢失' : ''}：不删除他人文件`, async (t) => {
      const { root, file } = await fixture(t);
      const sentinel = `其他进程的哨兵-${mode}-${lostAck}`;
      let stage, attempts = 0, error;
      await faulted('rename', (original) => async (from, to) => {
        if (path.resolve(String(to)) !== file) return original(from, to);
        attempts++;
        stage = path.resolve(String(from));
        await original(from, to);
        await writeFile(stage, sentinel, { encoding: 'utf8', flag: 'wx' });
        if (lostAck) { const e = new Error('rename 已完成且原路径被占用后 EIO'); e.code = 'EIO'; throw e; }
      }, async () => {
        try {
          if (mode === 'writeText') await writeText(file, '已提交内容', { memoryRoot: root });
          else if (mode === 'writeRenameTarget') await writeRenameTarget(root, file, '旧内容', '已提交内容');
          else await writeTrackedPanelFile(root, file, '已提交内容', { tool: 'test:panel' });
        } catch (e) { error = e; }
      });
      assert.equal(attempts, 1);
      assert.equal(await readFile(file, 'utf8'), '已提交内容', '故障在真实提交后');
      // Preserve the replacement and its bytes when ownership cannot be verified.
      assert.equal(await readFile(stage, 'utf8'), sentinel);
      assert.equal(await stat(stage).then((s) => s.isFile(), () => false), true, '路径保留待核对');
      const ledger = await readLedger(root);
      if (lostAck) {
        assert.equal(error?.code, 'MEMORY_WRITE_COMMIT_UNKNOWN');
        assert.equal(error?.fileWritten, null);
        assert.equal(error?.ledgerStatus, 'not_attempted');
        assert.equal(error?.cleanupStatus, 'deferred');
        assert.equal(error?.stagePath, stage);
        assert.equal(ledger.has('functions/destination.md'), false);
      } else {
        assert.equal(error?.code, 'MEMORY_STAGE_CLEANUP_DEFERRED', '目标已提交但暂存被占用时报告 deferred');
        assert.equal(error?.fileWritten, true);
        assert.equal(error?.cleanupStatus, 'deferred');
        assert.equal(error?.stagePath, stage);
        assert.equal(error?.ledgerStatus, mode === 'writeText' ? 'recorded' : 'recorded');
        assert.equal(ledger.get('functions/destination.md')?.hash, contentHash('已提交内容'));
      }
    });
  }
}

for (const lostAck of [false, true]) {
  test(`panel 独占 link 后暂存路径被替换${lostAck ? '且回执丢失' : ''}：不删外来文件，保留现场内容`, async (t) => {
    const { root, file } = await fixture(t);
    const target = path.join(path.dirname(file), 'new.md');
    const sentinel = `其他进程的硬链接暂存哨兵-${lostAck}`;
    const originalUnlink = fs.promises.unlink;
    let stage, error, calls = 0;
    await faulted('link', (original) => async (from, to) => {
      if (path.resolve(String(to)) !== target) return original(from, to);
      calls++;
      stage = path.resolve(String(from));
      await original(from, to);
      await originalUnlink(from);
      await writeFile(stage, sentinel, { encoding: 'utf8', flag: 'wx' });
      if (lostAck) { const e = new Error('link 实际完成后 EIO'); e.code = 'EIO'; throw e; }
    }, async () => {
      try { await writeTrackedPanelFile(root, target, '完整归档内容', { exclusive: true, tool: 'test:exclusive' }); }
      catch (e) { error = e; }
    });
    assert.equal(calls, 1);
    assert.equal(await readFile(target, 'utf8'), '完整归档内容');
    // Preserve the replacement and its bytes after the target is committed.
    assert.equal(await readFile(stage, 'utf8'), sentinel);
    assert.equal(await stat(stage).then((s) => s.isFile(), () => false), true, '路径保留待核对');
    assert.equal(error?.cleanupStatus, 'deferred');
    assert.equal(error?.stagePath, stage);
    const ledger = await readLedger(root);
    if (lostAck) {
      assert.equal(error?.code, 'MEMORY_WRITE_COMMIT_UNKNOWN');
      assert.equal(error?.fileWritten, null);
      assert.equal(ledger.has('functions/new.md'), false);
    } else {
      assert.equal(error?.code, 'MEMORY_STAGE_CLEANUP_DEFERRED');
      assert.equal(error?.fileWritten, true);
      assert.equal(error?.ledgerStatus, 'recorded');
      assert.equal(ledger.get('functions/new.md')?.hash, contentHash('完整归档内容'));
    }
  });
}

test('panel 正常独占 link：inode 核验一致即删除暂存，目标完整且已记账', async (t) => {
  const { root, file } = await fixture(t);
  const target = path.join(path.dirname(file), 'normal.md');
  const result = await writeTrackedPanelFile(root, target, '正常归档', { exclusive: true, tool: 'test:exclusive' });
  assert.equal(result, undefined);
  assert.equal(await readFile(target, 'utf8'), '正常归档');
  const stageDirectory = path.join(root, '.stage');
  const left = await readdir(stageDirectory).catch(() => []);
  assert.deepEqual(left, [], '.stage/ 暂存已通过 inode 核验删除');
  assert.equal((await readLedger(root)).get('functions/normal.md')?.hash, contentHash('正常归档'));
});

test('正常提交 200 成功且 .stage/ 暂存消失（回归：旧恒 500/CLEANUP_UNKNOWN 已解除）', async (t) => {
  const { root, file } = await fixture(t);
  const target = path.join(path.dirname(file), 'ack.md');
  await assert.doesNotReject(() => writeTrackedPanelFile(root, target, '提交正文', { exclusive: true, tool: 'test:exclusive' }));
  assert.equal(await readFile(target, 'utf8'), '提交正文');
  const left = await readdir(stageDir(root)).catch(() => []);
  assert.deepEqual(left, [], '正常 exclusive 提交后 .stage/ 必须为空');
});

test('removeVerifiedStage：ino=0n preserves the unverified file', async (t) => {
  const { root } = await fixture(t);
  const dir = stageDir(root);
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'zero-ino.stage-00000000-0000-4000-8000-000000000000.tmp');
  await writeFile(p, '不可核验内容', 'utf8');
  const entry = { path: p, dev: 0n, ino: 0n };
  const outcome = await removeVerifiedStage(entry);
  assert.equal(outcome.removed, false, 'ino=0n 无法核验归属，不得报告已删除');
  assert.equal(outcome.deferred, true);
  assert.equal(await stat(p).then((s) => s.isFile(), () => false), true, '路径保留待核对');
  assert.equal(await readFile(p, 'utf8'), '不可核验内容');
});

for (const kind of ['file', 'hardlink', 'symlink']) {
  test(`removeVerifiedStage：暂存路径被 ${kind} 替换——绝不 unlink，路径保留待核对`, async (t) => {
    const { root } = await fixture(t);
    const dir = stageDir(root);
    await mkdir(dir, { recursive: true });
    const p = path.join(dir, 'replaced.stage-11111111-1111-4111-8111-111111111111.tmp');
    const entry = await createVerifiedStage(root, 'functions/replaced.md', '我们自己的暂存正文');
    // 让 entry 指向 p 所在的替换现场：创建真实暂存后把其路径语义嫁接到 p。
    entry.path = p;
    // 先造成路径存在（后面替换），再让 lstat 对比 inode 必然不匹配。
    const victim = path.join(root, 'victim.md');
    await writeFile(victim, '外来文件的宝贵字节', 'utf8');
    if (kind === 'file') {
      await writeFile(p, '外来文件的宝贵字节', 'utf8');
    } else if (kind === 'hardlink') {
      await link(victim, p);
    } else {
      try { await symlink(victim, p); }
      catch (err) { if (['EPERM', 'EACCES'].includes(err.code)) return t.skip('symlink unavailable'); throw err; }
    }
    const outcome = await removeVerifiedStage(entry);
    assert.equal(outcome.removed, false, `${kind} 替换后不得报告删除成功`);
    assert.equal(outcome.deferred, true);
    // Verify the replacement and the target both retain their bytes.
    if (kind === 'symlink') {
      assert.equal(await lstat(p).then((s) => s.isSymbolicLink(), () => false), true, '符号链接路径保留');
    } else {
      assert.equal(await stat(p).then((s) => s.isFile(), () => false), true, `${kind} 路径保留待核对`);
    }
    assert.equal(await readFile(p, 'utf8'), '外来文件的宝贵字节');
    assert.equal(await readFile(victim, 'utf8'), '外来文件的宝贵字节');
  });
}

test('Disabled sweep preserves old, fresh and unrelated files', async (t) => {
  const { root } = await fixture(t);
  const dir = stageDir(root);
  await mkdir(dir, { recursive: true });
  const old = path.join(dir, 'orphan.stage-22222222-2222-4222-8222-222222222222.tmp');
  const fresh = path.join(dir, 'fresh.stage-33333333-3333-4333-8333-333333333333.tmp');
  const other = path.join(dir, 'notes.md');
  await writeFile(old, '陈旧孤儿', 'utf8');
  await writeFile(fresh, '新鲜暂存', 'utf8');
  await writeFile(other, '外来文件', 'utf8');
  const distant = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(old, distant, distant);
  const result = await sweepStaleStages(root, { now: Date.now() });
  assert.deepEqual(result, { swept: 0, scanned: 2, disabled: true, reason: 'ownership-unverified' });
  assert.equal(await readFile(old, 'utf8'), '陈旧孤儿');
  assert.equal(await readFile(fresh, 'utf8'), '新鲜暂存', '未超龄暂存保留');
  assert.equal(await readFile(other, 'utf8'), '外来文件', '非 .tmp 外来文件保留');
});

test('simulated symlink detection leaves replacement and target untouched', async (t) => {
  const { root } = await fixture(t);
  const entry = await createVerifiedStage(root, 'functions/link.md', 'original bytes');
  const target = path.join(root, 'link-target.md');
  await writeFile(target, 'target bytes');
  let injected = 0;
  const result = await faulted('lstat', (original) => async (file, ...args) => {
    if (path.resolve(String(file)) === entry.path) {
      injected++;
      return { isSymbolicLink: () => true };
    }
    return original(file, ...args);
  }, () => removeVerifiedStage(entry));
  assert.equal(injected, 1);
  assert.deepEqual(result, { removed: false, deferred: true, reason: 'replaced-by-symlink' });
  assert.equal(await readFile(entry.path, 'utf8'), 'original bytes');
  assert.equal(await readFile(target, 'utf8'), 'target bytes');
});

test('lstat failure preserves a stage hard link and its target', async (t) => {
  const { root } = await fixture(t);
  const entry = await createVerifiedStage(root, 'functions/linked.md', 'protected bytes');
  const target = path.join(root, 'linked-target.md');
  await link(entry.path, target);
  let injected = 0;
  const result = await faulted('lstat', (original) => async (file, ...args) => {
    if (path.resolve(String(file)) === entry.path) {
      injected++;
      const error = new Error('injected lstat failure');
      error.code = 'EACCES';
      throw error;
    }
    return original(file, ...args);
  }, () => removeVerifiedStage(entry));
  assert.equal(injected, 1);
  assert.deepEqual(result, { removed: false, deferred: true, reason: 'EACCES' });
  assert.equal(await readFile(entry.path, 'utf8'), 'protected bytes');
  assert.equal(await readFile(target, 'utf8'), 'protected bytes');
});

test('verified stage hard link is removed without modifying its target', async (t) => {
  const { root } = await fixture(t);
  const entry = await createVerifiedStage(root, 'functions/normal.md', 'protected bytes');
  const target = path.join(root, 'normal-target.md');
  await link(entry.path, target);
  assert.deepEqual(await removeVerifiedStage(entry), { removed: true });
  await assert.rejects(lstat(entry.path), { code: 'ENOENT' });
  assert.equal(await readFile(target, 'utf8'), 'protected bytes');
});

test('孤儿清扫：.stage/ 不存在时静默跳过（正反例）', async (t) => {
  const { root } = await fixture(t);
  const result = await sweepStaleStages(root);
  assert.deepEqual(result, { swept: 0, scanned: 0, disabled: true, reason: 'ownership-unverified' });
  await assert.rejects(stat(stageDir(root)), { code: 'ENOENT' }, '清扫不得凭空创建 .stage/');
});
