import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('concurrent memory_write preserves both blocks and unique same-day headings', { timeout: 15000 }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'memory-write-concurrency-'));
  const root = path.join(home, 'memory');
  const skillRoot = path.join(home, 'skills');
  const target = path.join(root, 'functions', '并发功能.md');
  const index = path.join(root, 'MEMORY.md');
  await mkdir(path.dirname(target), { recursive: true });
  await mkdir(skillRoot, { recursive: true });
  await writeFile(index, '# 隔离测试索引\n', 'utf8');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const registered = [];
  const noop = () => {};
  const ctx = {
    tools: { register: (tool) => (registered.push(tool), noop) },
    on: () => noop,
    inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  let dispose;
  const originalRead = fs.promises.readFile;
  const release = deferred();
  t.after(async () => {
    release.resolve();
    fs.promises.readFile = originalRead;
    syncBuiltinESMExports();
    if (typeof dispose === 'function') dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    assert.equal(path.dirname(path.resolve(home)), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith('memory-write-concurrency-'));
    await rm(home, { recursive: true, force: true });
  });
  const { apply } = await import('../server.js');
  dispose = apply(ctx, { memoryRoot: root, skillRoot, dshRoot: process.env.DSH_INSTALL_DIR });
  const tool = registered.find((entry) => entry?.name === 'memory_write' && typeof entry.execute === 'function');
  assert.ok(tool, 'real apply must register the memory_write executor');
  const date = '2026-05-10';
  const base = { feature: '并发功能', date, result: 'done' };
  await tool.execute({ ...base, title: '原有迭代', summary: '原有功能域的基准记录' }, {});
  const initial = await originalRead.call(fs.promises, target, 'utf8');
  let indexText;
  try { indexText = await originalRead.call(fs.promises, index, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const entered = deferred();
  let first = true;
  let released = false;
  let overlappingReads = 0;
  fs.promises.readFile = async (file, ...args) => {
    if (typeof file === 'string' && path.resolve(file) === path.resolve(target)) {
      if (first) {
        first = false;
        const snapshot = await originalRead.call(fs.promises, file, ...args);
        entered.resolve();
        await release.promise;
        return snapshot;
      }
      if (!released) {
        overlappingReads++;
        return initial;
      }
    }
    // Keep the second call's pre-read deterministic: a queued lock won't call
    // this, while a lock-free callback reaches the target in this microtask turn.
    if (typeof file === 'string' && path.resolve(file) === path.resolve(index) && indexText !== undefined) return indexText;
    return originalRead.call(fs.promises, file, ...args);
  };
  syncBuiltinESMExports();
  const writeA = tool.execute({ ...base, title: '并发提交甲', summary: '并发甲的独立结论' }, {});
  await entered.promise;
  const writeB = tool.execute({ ...base, title: '并发提交乙', summary: '并发乙的独立结论' }, {});
  // Launch B while A is paused, then yield the microtask queue. Never wait for
  // B's read: with a correct outer transaction it cannot happen until A exits.
  await new Promise((resolve) => setImmediate(resolve));
  released = true;
  release.resolve();
  const [a, b] = await Promise.all([writeA, writeB]);
  assert.ok(a && b, 'both actual tool calls must complete');
  const finalText = await originalRead.call(fs.promises, target, 'utf8');
  const headings = [...finalText.matchAll(/^## \[(2026-05-10(?:补\d*)?)\] (.+)$/gm)];
  assert.deepEqual(headings.map((m) => m[2]), ['原有迭代', '并发提交甲', '并发提交乙'], `both blocks must survive; overlapping reads while paused: ${overlappingReads}`);
  assert.deepEqual(headings.map((m) => m[1]), ['2026-05-10', '2026-05-10补', '2026-05-10补2']);
});
