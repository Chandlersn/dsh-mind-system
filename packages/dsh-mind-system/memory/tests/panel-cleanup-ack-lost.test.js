import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The production route is exercised through loopback HTTP and an isolated home.
async function fixture(t, { loseLedgerAck = false } = {}) {
  const io = fs.promises;
  const home = await io.mkdtemp(path.join(tmpdir(), 'panel-cleanup-ack-lost-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  const candidate = path.join(root, 'dao', '_candidates', '隔离候选.md');
  const target = path.join(root, 'dao', '_candidates', '_rejected', '隔离候选.md');
  const ledger = path.join(root, '.write-ledger.jsonl');
  const oldHome = process.env.DSH_HOME;
  const originalUnlink = io.unlink;
  const originalAppend = io.appendFile;
  const sourceText = '# 隔离候选\n\n## 命题\n\n关系在变化中生成。\n';
  let stage;
  let unlinkHits = 0;
  let ledgerHits = 0;
  let server, dispose;
  t.after(async () => {
    io.unlink = originalUnlink;
    io.appendFile = originalAppend;
    syncBuiltinESMExports();
    if (typeof dispose === 'function') dispose();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith('panel-cleanup-ack-lost-'));
    await io.rm(home, { recursive: true, force: true });
  });
  await io.mkdir(path.dirname(candidate), { recursive: true });
  await io.mkdir(skills, { recursive: true });
  await io.writeFile(path.join(root, 'MEMORY.md'), '# 测试索引\n', 'utf8');
  await io.writeFile(candidate, sourceText, 'utf8');
  process.env.DSH_HOME = home;
  const same = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
  io.unlink = async (file, ...args) => {
    if (typeof file === 'string' && same(path.dirname(file), path.dirname(target)) && path.basename(file).startsWith(`${path.basename(target)}.stage-`) && unlinkHits === 0) {
      stage = path.resolve(file);
      unlinkHits++;
      await originalUnlink.call(io, file, ...args);
      const error = new Error('隔离故障：暂存清理实际完成后回执丢失'); error.code = 'EIO'; throw error;
    }
    return originalUnlink.call(io, file, ...args);
  };
  io.appendFile = async (file, data, ...args) => {
    if (loseLedgerAck && same(file, ledger) && String(data).includes('axiom-action:reject') && ledgerHits === 0) {
      ledgerHits++;
      await originalAppend.call(io, file, data, ...args);
      const error = new Error('隔离故障：账本追加实际完成后回执丢失'); error.code = 'EIO'; throw error;
    }
    return originalAppend.call(io, file, data, ...args);
  };
  syncBuiltinESMExports();
  let route, authCalls = 0;
  const noop = () => {};
  const ctx = {
    tools: { register: () => noop }, on: () => noop,
    inject(_names, callback) {
      callback({ webServer: { register(r) { if (r.path === '/api/memory-org') route = r.handler; return noop; } },
        connection: { requestRejection() { authCalls++; return undefined; } }, effect: (f) => f() });
    },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  const { apply } = await import(pathToFileURL(path.resolve(import.meta.dirname, '..', 'server.js')).href);
  dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR });
  assert.equal(typeof route, 'function');
  server = createServer((req, res) => { void route(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/memory-org/axiom-action`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'reject', name: '隔离候选', reason: '隔离故障测试' }),
  });
  const body = await response.json();
  assert.equal(authCalls, 1);
  assert.equal(unlinkHits, 1, 'fault must occur after the actual stage unlink');
  assert.ok(stage);
  assert.equal(ledgerHits, loseLedgerAck ? 1 : 0, 'ledger fault must match the requested scenario');
  const targetText = await io.readFile(target, 'utf8');
  assert.ok(targetText.startsWith(sourceText), 'destination was fully committed');
  assert.match(targetText, /隔离故障测试/);
  assert.equal(await io.readFile(candidate, 'utf8'), sourceText, 'source remains untouched');
  await assert.rejects(io.readFile(stage, 'utf8'), { code: 'ENOENT' }, 'the temporary file really was removed');
  const entries = (await io.readFile(ledger, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(entries.filter((e) => e.key === 'dao/_candidates/_rejected/隔离候选.md' && e.tool === 'axiom-action:reject').length, 1, 'the destination entry really exists in the ledger');
  assert.ok(!response.ok, 'lost acknowledgement cannot be reported as a full success');
  assert.equal(body.fileWritten, true);
  assert.equal(body.cleanupStatus, 'unknown', 'receipt cannot infer that the temporary path remains');
  assert.match(body.error, /暂存|临时/);
  assert.match(body.error, /清理结果未知|清理状态未知/);
  assert.match(body.error, /核对|核查/);
  assert.match(body.error, /不要盲目重试/);
  return { body, status: response.status };
}

test('暂存删除实际成功后确认丢失：目标已记账，清理结果仍未知', async (t) => {
  const { body } = await fixture(t);
  assert.equal(body.code, 'MEMORY_PANEL_CLEANUP_UNKNOWN');
  assert.equal(body.ledgerStatus, 'recorded');
  assert.match(body.error, /目标已提交并记账/);
});

test('账本实际追加和暂存实际删除后均丢失回执：两种状态都必须未知', async (t) => {
  const { body } = await fixture(t, { loseLedgerAck: true });
  assert.equal(body.code, 'MEMORY_LEDGER_APPEND_FAILED');
  assert.equal(body.ledgerStatus, 'unknown');
  assert.match(body.error, /账本.*(未知|未能确认)/);
  assert.match(body.error, /暂存.*清理结果未知/);
});
