import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeText } from '../src/util.js';
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
      assert.equal(await readFile(stage, 'utf8'), sentinel, '暂存路径已被他人占用，绝不能删除');
      const ledger = await readLedger(root);
      if (lostAck) {
        assert.equal(error?.code, 'MEMORY_WRITE_COMMIT_UNKNOWN');
        assert.equal(error?.fileWritten, null);
        assert.equal(error?.ledgerStatus, 'not_attempted');
        assert.equal(error?.cleanupStatus, 'unknown');
        assert.equal(error?.stagePath, stage);
        assert.equal(ledger.has('functions/destination.md'), false);
        assert.match(error.message, /未自动清理/);
      } else {
        assert.equal(error?.code, 'MEMORY_STAGE_PATH_UNKNOWN', '目标已提交但旧暂存路径被占用时必须报告');
        assert.equal(error?.fileWritten, true);
        assert.equal(error?.cleanupStatus, 'unknown');
        assert.equal(error?.stagePath, stage);
        assert.equal(error?.ledgerStatus, mode === 'writeText' ? 'unknown' : 'recorded');
        assert.equal(ledger.get('functions/destination.md')?.hash, contentHash('已提交内容'));
      }
    });
  }
}

for (const lostAck of [false, true]) {
  test(`panel 独占 link 后路径被替换${lostAck ? '且回执丢失' : ''}：保留哨兵并报告部分结果`, async (t) => {
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
    assert.equal(await readFile(stage, 'utf8'), sentinel, '不允许删除被替换的路径');
    assert.equal(error?.cleanupStatus, 'unknown');
    assert.equal(error?.stagePath, stage);
    const ledger = await readLedger(root);
    if (lostAck) {
      assert.equal(error?.code, 'MEMORY_WRITE_COMMIT_UNKNOWN');
      assert.equal(error?.fileWritten, null);
      assert.equal(ledger.has('functions/new.md'), false);
    } else {
      assert.equal(error?.code, 'MEMORY_PANEL_CLEANUP_UNKNOWN');
      assert.equal(error?.fileWritten, true);
      assert.equal(error?.ledgerStatus, 'recorded');
      assert.equal(ledger.get('functions/new.md')?.hash, contentHash('完整归档内容'));
    }
  });
}

test('panel 正常独占 link：不能安全确认路径归属时保留暂存并报告，目标实际完整且已记账', async (t) => {
  const { root, file } = await fixture(t);
  const target = path.join(path.dirname(file), 'normal.md');
  let error;
  try { await writeTrackedPanelFile(root, target, '正常归档', { exclusive: true, tool: 'test:exclusive' }); }
  catch (e) { error = e; }
  assert.equal(error?.code, 'MEMORY_PANEL_CLEANUP_UNKNOWN');
  assert.equal(error?.fileWritten, true);
  assert.equal(error?.ledgerStatus, 'recorded');
  assert.equal(error?.cleanupStatus, 'unknown');
  assert.equal(await readFile(error.stagePath, 'utf8'), '正常归档');
  assert.equal(await readFile(target, 'utf8'), '正常归档');
  assert.equal((await stat(target)).ino, (await stat(error.stagePath)).ino);
  assert.equal((await readLedger(root)).get('functions/normal.md')?.hash, contentHash('正常归档'));
});
