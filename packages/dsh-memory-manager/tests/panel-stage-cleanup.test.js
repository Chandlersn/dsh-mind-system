import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Exercise the real registered handler through an isolated local HTTP server.
test('已提交归档后暂存硬链接清理失败，必须报告部分完成而非成功', async (t) => {
  const io = fs.promises;
  const home = await io.mkdtemp(path.join(tmpdir(), 'panel-stage-cleanup-'));
  const root = path.join(home, 'memory');
  const skillRoot = path.join(home, 'skills');
  const candidate = path.join(root, 'dao', '_candidates', '测试候选.md');
  const target = path.join(root, 'dao', '_candidates', '_rejected', '测试候选.md');
  const ledger = path.join(root, '.write-ledger.jsonl');
  const oldHome = process.env.DSH_HOME;
  const originalUnlink = io.unlink;
  let route, server, dispose;
  let capturedStage;
  let injections = 0;
  const text = '# 测试候选\n\n## 命题\n\n世界随着关系变化。\n';
  t.after(async () => {
    io.unlink = originalUnlink;
    syncBuiltinESMExports();
    if (typeof dispose === 'function') dispose();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith('panel-stage-cleanup-'));
    await io.rm(home, { recursive: true, force: true });
  });
  await io.mkdir(path.dirname(candidate), { recursive: true });
  await io.mkdir(skillRoot, { recursive: true });
  await io.writeFile(path.join(root, 'MEMORY.md'), '# 测试索引\n', 'utf8');
  await io.writeFile(candidate, text, 'utf8');
  process.env.DSH_HOME = home;
  io.unlink = async (file, ...args) => {
    // 2026-11-13：暂存移入 .stage/；故障注入在真实暂存 unlink 上（EACCES → deferred）。
    if (typeof file === 'string' && path.dirname(file).toLowerCase() === path.join(root, '.stage').toLowerCase() && path.basename(file).endsWith('.tmp')) {
      capturedStage = path.resolve(file);
      injections++;
      const error = new Error('隔离故障：暂存硬链接清理失败');
      error.code = 'EACCES';
      throw error;
    }
    return originalUnlink.call(io, file, ...args);
  };
  syncBuiltinESMExports();
  const noop = () => {};
  let authCalls = 0;
  const ctx = {
    tools: { register: () => noop }, on: () => noop,
    inject(_names, callback) {
      callback({ webServer: { register(r) { if (r.path === '/api/memory-org') route = r.handler; return noop; } },
        connection: { requestRejection() { authCalls++; return undefined; } }, effect: (f) => f() });
    },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  const modulePath = path.resolve(import.meta.dirname, '..', 'server.js');
  const { apply } = await import(pathToFileURL(modulePath).href);
  dispose = apply(ctx, { memoryRoot: root, skillRoot, dshRoot: process.env.DSH_INSTALL_DIR });
  assert.equal(typeof route, 'function');
  server = createServer((req, res) => { void route(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/memory-org/axiom-action`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'reject', name: '测试候选', reason: '隔离反例' }),
  });
  const body = await response.json();
  assert.equal(authCalls, 1);
  assert.equal(injections, 1, '故障必须命中真实提交后的暂存文件清理');
  assert.ok(capturedStage);
  const [targetBytes, stageBytes, targetStat, stageStat] = await Promise.all([
    io.readFile(target, 'utf8'),
    io.readFile(capturedStage, 'utf8').catch((e) => (e.code === 'ENOENT' ? '' : Promise.reject(e))),
    io.stat(target),
    io.stat(capturedStage).catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e))),
  ]);
  assert.ok(targetBytes.startsWith(text));
  // unlink 注入 EACCES：removeVerifiedStage 报 deferred（未删除），暂存保留。
  assert.equal(stageBytes, targetBytes, '暂存文件和目标内容相同（未删除）');
  assert.ok(stageStat, '暂存路径保留');
  assert.ok(targetStat.nlink >= 2 && stageStat.nlink >= 2, '目标与暂存文件须保留至少两个硬链接');
  if (targetStat.ino && stageStat.ino) {
    assert.equal(targetStat.dev, stageStat.dev);
    assert.equal(targetStat.ino, stageStat.ino, '暂存文件和目标是同一个文件对象');
  }
  const records = await io.readFile(ledger, 'utf8').then((s) => s.trim().split('\n').filter(Boolean).map(JSON.parse), (error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const archived = records.filter((r) => r.key === 'dao/_candidates/_rejected/测试候选.md');
  const sourceStillExists = await io.access(candidate).then(() => true, (e) => e.code === 'ENOENT' ? false : Promise.reject(e));
  t.diagnostic(`实际 HTTP=${response.status}，回执=${JSON.stringify(body)}；目标/暂存硬链接数=${targetStat.nlink}；归档账本条数=${archived.length}；候选仍在=${sourceStillExists}`);
  assert.ok(!response.ok, '提交后暂存清理失败不得报告成功');
  assert.equal(sourceStillExists, true, '暂存清理未确认时必须保留源文件');
  assert.equal(archived.length, 1, '目标已提交时必须尝试并确认目标记账');
  assert.equal(body.fileWritten, true);
  assert.equal(body.ledgerStatus, 'recorded');
  assert.equal(body.cleanupStatus, 'deferred');
  const receipt = JSON.stringify(body);
  assert.match(receipt, /目标.{0,30}已(提交|写入)|已(提交|写入).{0,30}目标/, '必须说明目标已提交');
  assert.match(receipt, /暂存|临时/, '必须说明暂存清理');
  assert.match(receipt, /deferred|未知|不确定|未确认/, '必须说明清理状态');
  assert.match(receipt, /核对|核查/, '必须提示核对实际状态');
});
