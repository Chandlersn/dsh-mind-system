import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defer = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('authenticated dao-action waits for the complete memory_write root transaction', { timeout: 15000 }, async () => {
  const io = fs.promises;
  const home = await io.mkdtemp(path.join(tmpdir(), 'memory-panel-concurrency-'));
  const root = path.join(home, 'memory');
  const skillRoot = path.join(home, 'skills');
  const fn = path.join(root, 'functions', '并发功能.md');
  const dao = path.join(root, 'dao', '并发道.md');
  const archive = path.join(root, 'dao', '_deleted', '并发道.md');
  const originalHome = process.env.DSH_HOME;
  const original = Object.fromEntries(['readFile', 'stat', 'mkdir', 'writeFile', 'appendFile', 'rename', 'unlink'].map((name) => [name, io[name]]));
  const featureRead = defer();
  const releaseFeature = defer();
  const panelRootStat = defer();
  const panelDaoRead = defer();
  const writesBeforeRelease = [];
  let watchingPanel = false;
  let featureBlocked = false;
  let panelFinished = false;
  let toolPromise;
  let panelPromise;
  let dispose;
  try {
    await io.mkdir(path.dirname(fn), { recursive: true });
    await io.mkdir(path.dirname(dao), { recursive: true });
    await io.mkdir(skillRoot, { recursive: true });
    const sourceDao = '# 并发道\n\n正式道原文，必须在工具完成之后才归档。\n';
    await io.writeFile(path.join(root, 'MEMORY.md'), '# 隔离索引\n', 'utf8');
    await io.writeFile(fn, '# 并发功能\n\n## 当前状态摘要（截至 2026-11-09）\n\n- 现有状态。\n', 'utf8');
    await io.writeFile(dao, sourceDao, 'utf8');
    process.env.DSH_HOME = home;

    let serverFile = path.join(packageRoot, 'server.js');
    if (process.env.PANEL_CONCURRENCY_MUTATE === '1') {
      // Mutate only a disposable copy. The unchanged assertion below must fail
      // when the panel bypasses the outer root transaction.
      const copy = path.join(home, 'mutated-package');
      await io.mkdir(copy);
      await io.cp(path.join(packageRoot, 'src'), path.join(copy, 'src'), { recursive: true });
      for (const name of ['server.js', 'health-inbox.js', 'package.json']) await io.copyFile(path.join(packageRoot, name), path.join(copy, name));
      const copiedServer = path.join(copy, 'server.js');
      const text = await io.readFile(copiedServer, 'utf8');
      const before = 'return await withMemoryRootTransaction(root, handle);';
      assert.equal(text.split(before).length, 2, 'mutation must affect exactly the panel transaction');
      await io.writeFile(copiedServer, text.replace(before, 'return await handle();'), 'utf8');
      serverFile = copiedServer;
    }

    // Intercept the actual builtin imports used by util.js and server.js.
    io.readFile = async (file, ...args) => {
      const target = typeof file === 'string' ? path.resolve(file) : '';
      if (!featureBlocked && target === path.resolve(fn)) {
        featureBlocked = true;
        featureRead.resolve();
        await releaseFeature.promise;
      }
      if (watchingPanel && target === path.resolve(dao)) panelDaoRead.resolve('panel-read');
      return original.readFile.call(io, file, ...args);
    };
    io.stat = async (file, ...args) => {
      const result = await original.stat.call(io, file, ...args);
      if (watchingPanel && typeof file === 'string' && path.resolve(file).toLowerCase() === path.resolve(root).toLowerCase()) panelRootStat.resolve('root-lock');
      return result;
    };
    for (const method of ['mkdir', 'writeFile', 'appendFile', 'rename', 'unlink']) {
      io[method] = async (...args) => {
        if (watchingPanel) writesBeforeRelease.push({ method, target: String(args[0]) });
        return original[method].apply(io, args);
      };
    }
    syncBuiltinESMExports();

    const mod = await import(pathToFileURL(serverFile).href);
    const tools = new Map();
    let handler;
    let authCalls = 0;
    const noop = () => {};
    const ctx = {
      tools: { register: (tool) => { tools.set(tool.name, tool); return noop; } },
      on: () => noop,
      inject(_names, run) {
        run({
          webServer: { register(route) { if (route.path === '/api/memory-org') handler = route.handler; return noop; } },
          connection: { requestRejection() { authCalls++; return undefined; } },
          effect: (f) => f(),
        });
      },
      systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    };
    dispose = mod.apply(ctx, { memoryRoot: root, skillRoot, dshRoot: process.env.DSH_INSTALL_DIR });
    const writer = tools.get('memory_write');
    assert.ok(writer?.execute && handler, 'real apply must register both tool and panel');
    toolPromise = writer.execute({ feature: '并发功能', title: '并发写入', summary: '测试事务顺序', result: 'done' }, {});
    await featureRead.promise; // The real tool owns its root lock but has not read the feature yet.

    const payload = Buffer.from(JSON.stringify({ action: 'delete', name: '并发道' }));
    const req = { method: 'POST', url: '/api/memory-org/dao-action', async *[Symbol.asyncIterator]() { yield payload; } };
    let response;
    const res = { writeHead(status) { response = { status }; }, end(body) { response.body = body; } };
    watchingPanel = true;
    panelPromise = handler(req, res).then(() => { panelFinished = true; return response; });

    // No arbitrary sleep: either root identity is resolved, or the unguarded
    // mutant enters the dao handler and begins reading the protected source.
    const first = await Promise.race([panelRootStat.promise, panelDaoRead.promise]);
    await new Promise((resolve) => setImmediate(resolve)); // drain the lock enqueue microtasks
    assert.equal(authCalls, 1, 'the actual panel authentication gate must run');
    assert.equal(first, 'root-lock', 'panel entered its file handler instead of joining the root transaction');
    assert.equal(panelFinished, false, 'panel completed before the tool released its transaction');
    assert.deepEqual(writesBeforeRelease, [], 'panel must not attempt any mutation while the tool holds the root');
    assert.equal(await original.readFile.call(io, dao, 'utf8'), sourceDao, 'formal dao remains byte-for-byte unchanged');
    await assert.rejects(original.stat.call(io, archive), { code: 'ENOENT' }, 'archive must not exist yet');

    watchingPanel = false;
    releaseFeature.resolve();
    const [written, deleted] = await Promise.all([toolPromise, panelPromise]);
    assert.match(written.appendedHeading, /并发写入/);
    assert.equal(deleted.status, 200, `panel should succeed: ${deleted.body}`);
    assert.match(await original.readFile.call(io, fn, 'utf8'), /并发写入/);
    assert.match(await original.readFile.call(io, archive, 'utf8'), /正式道原文/);
    await assert.rejects(original.stat.call(io, dao), { code: 'ENOENT' });
  } finally {
    watchingPanel = false;
    releaseFeature.resolve();
    if (toolPromise || panelPromise) await Promise.allSettled([toolPromise, panelPromise].filter(Boolean));
    for (const [name, fnOriginal] of Object.entries(original)) io[name] = fnOriginal;
    syncBuiltinESMExports();
    if (typeof dispose === 'function') dispose();
    if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith('memory-panel-concurrency-'));
    await io.rm(home, { recursive: true, force: true });
  }
});
