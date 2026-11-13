import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Exercise the registered, authenticated panel handler with an isolated root.
// Faults are scoped to the temporary archive or ledger; real memory is untouched.
async function fixture(t) {
  const io = fs.promises;
  const home = await io.mkdtemp(path.join(tmpdir(), 'panel-write-partial-'));
  const root = path.join(home, 'memory');
  const skillRoot = path.join(home, 'skills');
  const candidate = path.join(root, 'dao', '_candidates', '测试候选.md');
  const target = path.join(root, 'dao', '_candidates', '_rejected', '测试候选.md');
  const ledger = path.join(root, '.write-ledger.jsonl');
  const originalHome = process.env.DSH_HOME;
  const original = Object.fromEntries(['writeFile', 'appendFile', 'link', 'rename'].map((name) => [name, io[name]]));
  const text = '# 测试候选\n\n## 命题\n\n世界随着关系变化。\n';
  await io.mkdir(path.dirname(candidate), { recursive: true });
  await io.mkdir(skillRoot, { recursive: true });
  await original.writeFile.call(io, path.join(root, 'MEMORY.md'), '# 测试索引\n', 'utf8');
  await original.writeFile.call(io, candidate, text, 'utf8');
  process.env.DSH_HOME = home;
  t.after(async () => {
    for (const [method, fn] of Object.entries(original)) io[method] = fn;
    syncBuiltinESMExports();
    if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith('panel-write-partial-'));
    await io.rm(home, { recursive: true, force: true });
  });
  let route;
  let authCalls = 0;
  const noop = () => {};
  const ctx = {
    tools: { register: () => noop },
    on: () => noop,
    inject(_names, callback) {
      callback({
        webServer: { register(r) { if (r.path === '/api/memory-org') route = r.handler; return noop; } },
        connection: { requestRejection() { authCalls++; return undefined; } },
        effect: (f) => f(),
      });
    },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  const modulePath = path.resolve(import.meta.dirname, '..', 'server.js');
  const { apply } = await import(pathToFileURL(modulePath).href);
  const dispose = apply(ctx, { memoryRoot: root, skillRoot, dshRoot: process.env.DSH_INSTALL_DIR });
  if (typeof dispose === 'function') t.after(() => dispose());
  assert.equal(typeof route, 'function', 'actual apply must register the panel route');
  const server = createServer((req, res) => { void route(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
  async function rejectCandidate() {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/memory-org/axiom-action`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reject', name: '测试候选', reason: '隔离反例' }),
    });
    const body = await response.json();
    assert.equal(authCalls, 1, 'authenticated route must execute its own authentication gate');
    return { status: response.status, body };
  }
  return { io, root, candidate, target, ledger, text, original, rejectCandidate };
}

function injectedError() { const error = new Error('模拟 EIO：写入后确认丢失'); error.code = 'EIO'; return error; }
function pathIs(file, expected) { return typeof file === 'string' && path.resolve(file).toLowerCase() === path.resolve(expected).toLowerCase(); }
function responseText(result) { return JSON.stringify(result.body); }

test('真实面板否决：正文写了一部分后 EIO，正式归档路径不得暴露残片，源保留', async (t) => {
  const f = await fixture(t);
  let injected = false;
  // 2026-11-13：暂存已移入 .stage/，正文写入走 handle.writeFile（open 'wx'）。
  // 故障注入改为：拦截 open，命中 .stage- 命名后替换 handle.writeFile 为
  // "写一半再抛 EIO"。
  const originalOpen = f.io.open;
  f.io.open = async (file, ...args) => {
    const handle = await originalOpen.call(f.io, file, ...args);
    if (!injected && typeof file === 'string' && args[0] === 'wx' && pathIs(path.dirname(file), path.join(f.root, '.stage')) && String(file).endsWith('.tmp')) {
      injected = true;
      const originalWrite = handle.writeFile.bind(handle);
      handle.writeFile = async (data, ...rest) => {
        const partial = String(data).slice(0, 8);
        assert.ok(partial.length > 0 && partial.length < String(data).length);
        await originalWrite(partial, ...rest);
        throw injectedError();
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  const result = await f.rejectCandidate();
  assert.equal(injected, true, 'fault must hit actual archive body write');
  assert.ok(result.status >= 400, `must not report success: ${responseText(result)}`);
  assert.equal(await f.io.readFile(f.candidate, 'utf8'), f.text, 'source bytes must survive');
  await assert.rejects(f.io.readFile(f.target, 'utf8'), { code: 'ENOENT' }, 'formal target must not expose partial bytes');
});

test('真实面板否决：link 或 rename 已提交后回执丢失，明确未知并先核对，源保留', async (t) => {
  const f = await fixture(t);
  let injected = false;
  for (const method of ['link', 'rename']) {
    f.io[method] = async (from, to, ...args) => {
      if (!injected && pathIs(to, f.target)) {
        injected = true;
        await f.original[method].call(f.io, from, to, ...args);
        throw injectedError();
      }
      return f.original[method].call(f.io, from, to, ...args);
    };
  }
  syncBuiltinESMExports();
  const result = await f.rejectCandidate();
  assert.equal(injected, true, 'fault must occur after a real link/rename to the final archive');
  assert.ok(result.status >= 400, `must not report success: ${responseText(result)}`);
  assert.match(responseText(result), /未知/);
  assert.match(responseText(result), /核对/);
  assert.match(responseText(result), /不要盲目重试/);
  assert.equal(await f.io.readFile(f.candidate, 'utf8'), f.text, 'do not delete candidate after uncertain commit');
  const persisted = await f.io.readFile(f.target, 'utf8');
  assert.ok(persisted.startsWith(f.text), 'real commit happened; complete archive is on disk');
  assert.match(persisted, /隔离反例/);
});

test('真实面板否决：账本已追加后回执丢失，明确未确认并先核对，源保留', async (t) => {
  const f = await fixture(t);
  let injected = false;
  f.io.appendFile = async (file, ...args) => {
    if (!injected && pathIs(file, f.ledger)) {
      injected = true;
      await f.original.appendFile.call(f.io, file, ...args);
      throw injectedError();
    }
    return f.original.appendFile.call(f.io, file, ...args);
  };
  syncBuiltinESMExports();
  const result = await f.rejectCandidate();
  assert.equal(injected, true, 'fault must occur after the actual ledger append');
  assert.ok(result.status >= 400, `must not report success: ${responseText(result)}`);
  assert.match(responseText(result), /未知|未能确认/);
  assert.match(responseText(result), /核对/);
  assert.match(responseText(result), /不要盲目重试/);
  assert.equal(await f.io.readFile(f.candidate, 'utf8'), f.text, 'source must remain until target and ledger are confirmed');
  assert.ok((await f.io.readFile(f.target, 'utf8')).startsWith(f.text));
  const entries = (await f.io.readFile(f.ledger, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(entries.some((entry) => entry.key === 'dao/_candidates/_rejected/测试候选.md' && entry.tool === 'axiom-action:reject' && typeof entry.hash === 'string'), 'ledger append really landed despite lost receipt');
});
