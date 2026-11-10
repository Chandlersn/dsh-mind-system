import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Exercise the real registered route and OS filesystem using an isolated root.
async function fixture(t) {
  const io = fs.promises;
  const home = await io.mkdtemp(path.join(tmpdir(), 'panel-staging-collision-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  const candidate = path.join(root, 'dao', '_candidates', '测试候选.md');
  const target = path.join(root, 'dao', '_candidates', '_rejected', '测试候选.md');
  const seed = path.join(home, 'sentinel-source.txt');
  const text = '# 测试候选\n\n## 命题\n\n世界随着关系变化。\n';
  const sentinel = '绝不能清理的既有暂存路径 sentinel';
  const savedHome = process.env.DSH_HOME;
  const originalWrite = io.writeFile;
  const originalUnlink = io.unlink;
  let server;
  let dispose;
  t.after(async () => {
    io.writeFile = originalWrite;
    io.unlink = originalUnlink;
    syncBuiltinESMExports();
    if (typeof dispose === 'function') dispose();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith('panel-staging-collision-'));
    await io.rm(home, { recursive: true, force: true });
  });
  await io.mkdir(path.dirname(candidate), { recursive: true });
  await io.mkdir(skills, { recursive: true });
  await originalWrite.call(io, path.join(root, 'MEMORY.md'), '# 隔离索引\n', 'utf8');
  await originalWrite.call(io, candidate, text, 'utf8');
  await originalWrite.call(io, seed, sentinel, 'utf8');
  process.env.DSH_HOME = home;
  let route;
  let authCalls = 0;
  const noop = () => {};
  const ctx = {
    tools: { register: () => noop }, on: () => noop,
    inject(_names, callback) {
      callback({
        webServer: { register(r) { if (r.path === '/api/memory-org') route = r.handler; return noop; } },
        connection: { requestRejection() { authCalls++; return undefined; } },
        effect: (f) => f(),
      });
    },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  const { apply } = await import(pathToFileURL(path.resolve(import.meta.dirname, '..', 'server.js')).href);
  dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR });
  assert.equal(typeof route, 'function');
  server = createServer((req, res) => { void route(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  async function rejectCandidate() {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/memory-org/axiom-action`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reject', name: '测试候选', reason: '隔离反例' }),
    });
    const body = await response.json();
    assert.equal(authCalls, 1, 'must call the registered route authentication gate');
    return { status: response.status, body };
  }
  return { io, home, root, candidate, target, seed, text, sentinel, originalWrite, originalUnlink, rejectCandidate };
}

function sameDirectory(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
function isStage(file, target, options) {
  return typeof file === 'string' && sameDirectory(path.dirname(file), path.dirname(target)) &&
    path.basename(file).startsWith(`${path.basename(target)}.stage-`) && options?.flag === 'wx';
}
function fault(code) { const error = new Error(`隔离注入 ${code}`); error.code = code; return error; }
async function assertOutcome(f, result, stage, before, expected) {
  assert.ok(result.status >= 400, `不得报告成功：${JSON.stringify(result.body)}`);
  assert.equal(result.body.fileWritten, false, '目标文件未执行提交');
  assert.equal(result.body.cleanupStatus, 'unknown', '暂存路径归属/清理状态未确认');
  assert.equal(await f.io.readFile(f.candidate, 'utf8'), f.text, '原候选必须逐字节保留');
  await assert.rejects(f.io.readFile(f.target, 'utf8'), { code: 'ENOENT' }, '正式归档不得出现');
  assert.equal(await f.io.readFile(stage, 'utf8'), expected, '不能删除或改写未确认归属的暂存文件');
  const after = await f.io.stat(stage);
  if (before.ino && after.ino) {
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino, '必须保留原文件对象而非重建同名文件');
  }
}

for (const variant of ['existing-file', 'existing-hardlink']) {
  test(`暂存路径 ${variant} 碰撞：真实 EEXIST 后不能清理他人文件`, async (t) => {
    const f = await fixture(t);
    let stage;
    let before;
    let unlinkCalls = 0;
    f.io.writeFile = async (file, data, options, ...rest) => {
      if (!stage && isStage(file, f.target, options)) {
        stage = path.resolve(file);
        if (variant === 'existing-hardlink') await f.io.link(f.seed, stage);
        else await f.originalWrite.call(f.io, stage, f.sentinel, { encoding: 'utf8', flag: 'wx' });
        before = await f.io.stat(stage);
        // Use the real wx call to produce EEXIST, rather than merely inventing it.
        try { await f.originalWrite.call(f.io, file, data, options, ...rest); }
        catch (error) { assert.equal(error.code, 'EEXIST'); throw error; }
        assert.fail('a real exclusive creation must reject an occupied path');
      }
      return f.originalWrite.call(f.io, file, data, options, ...rest);
    };
    f.io.unlink = async (file, ...args) => {
      if (stage && path.resolve(String(file)) === stage) unlinkCalls++;
      return f.originalUnlink.call(f.io, file, ...args);
    };
    syncBuiltinESMExports();
    const result = await f.rejectCandidate();
    assert.ok(stage && before, '故障必须命中真实暂存路径');
    assert.equal(unlinkCalls, 0, '未确认创建成功的路径绝不能调用 unlink');
    await assertOutcome(f, result, stage, before, f.sentinel);
    if (variant === 'existing-hardlink') {
      assert.equal(await f.io.readFile(f.seed, 'utf8'), f.sentinel);
      const seedStat = await f.io.stat(f.seed);
      if (before.ino && seedStat.ino) assert.equal(seedStat.ino, before.ino);
    }
  });
}

test('暂存文件实际部分写入后抛错：不能盲目清理未知状态的路径', async (t) => {
  const f = await fixture(t);
  let stage;
  let before;
  let partial;
  let unlinkCalls = 0;
  f.io.writeFile = async (file, data, options, ...rest) => {
    if (!stage && isStage(file, f.target, options)) {
      stage = path.resolve(file);
      partial = String(data).slice(0, 8);
      assert.ok(partial.length > 0 && partial.length < String(data).length);
      await f.originalWrite.call(f.io, file, partial, options, ...rest);
      before = await f.io.stat(stage);
      throw fault('EIO');
    }
    return f.originalWrite.call(f.io, file, data, options, ...rest);
  };
  f.io.unlink = async (file, ...args) => {
    if (stage && path.resolve(String(file)) === stage) unlinkCalls++;
    return f.originalUnlink.call(f.io, file, ...args);
  };
  syncBuiltinESMExports();
  const result = await f.rejectCandidate();
  assert.ok(stage && before, '故障必须发生在真实部分写入之后');
  assert.equal(unlinkCalls, 0, '暂存写入回执未确认，不应盲删路径');
  await assertOutcome(f, result, stage, before, partial);
});
