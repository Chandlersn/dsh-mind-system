import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Real apply/registered execute with a different, temporary DSH_HOME per case.
// Mock only fs calls for the explicit daily paths in that fixture.
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'memory-resolve-safety-'));
  const root = path.join(home, 'memory');
  const functions = path.join(root, 'functions');
  const skills = path.join(home, 'skills');
  await mkdir(functions, { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# 隔离测试索引\n', 'utf8');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith('memory-resolve-safety-'));
    await rm(home, { recursive: true, force: true });
  });
  const registered = [];
  const noop = () => {};
  const ctx = {
    tools: { register: (definition) => (registered.push(definition), noop) },
    on: () => noop,
    inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  const mod = await import('../server.js');
  const dispose = mod.apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR });
  if (typeof dispose === 'function') t.after(() => dispose());
  const tool = registered.find((entry) => entry?.name === 'memory_write' && typeof entry.execute === 'function');
  assert.ok(tool, 'real apply must register memory_write');
  const args = { feature: '主体功能', title: '验证主题', summary: '验证主体功能的保存', date: '2026-11-10', result: 'done', resolve: '待解决功能' };
  return { root, functions, args, run: (overrides = {}) => tool.execute({ ...args, ...overrides }, {}) };
}

const thread = (label) => `# ${label}\n\n## 待观察\n\n- ${label} → [待解决功能](functions/待解决功能.md)\n`;
function fail(code, what) { const error = new Error(what); error.code = code; return error; }
function isSame(a, b) { return typeof a === 'string' && path.resolve(a) === path.resolve(b); }
function checkWarning(result, completedCount) {
  assert.ok(Array.isArray(result.warnings));
  const warning = result.warnings.find((entry) => /更新每日待观察项未全部完成/.test(entry));
  assert.ok(warning, 'receipt must explicitly identify the partially completed operation');
  assert.match(warning, /功能文件已写入/);
  assert.match(warning, new RegExp(`已完成 ${completedCount} 个文件`));
  assert.match(warning, /不要盲目重试/);
  assert.ok(!result.warnings.some((entry) => /没有未解决条目/.test(entry)), 'an I/O failure must not be reported as an empty scan');
  return warning;
}
async function checkMain(f, result) {
  assert.equal(result.featureFile, path.join(f.functions, '主体功能.md'));
  assert.match(await readFile(result.featureFile, 'utf8'), /验证主题/);
}

// Live bindings imported via node:fs/promises require syncBuiltinESMExports.
// Restore each altered builtin even when an assertion or the tool throws.
async function withMockedFs(replacements, run) {
  const old = {};
  try {
    for (const [name, wrap] of Object.entries(replacements)) {
      old[name] = fs.promises[name];
      fs.promises[name] = wrap(old[name]);
    }
    syncBuiltinESMExports();
    return await run();
  } finally {
    for (const [name, original] of Object.entries(old)) fs.promises[name] = original;
    syncBuiltinESMExports();
  }
}

test('daily read failure reports partial completion while preserving saved function', async (t) => {
  const f = await fixture(t);
  const daily = path.join(f.root, '2026-11-08.md');
  const original = thread('读失败记录');
  await writeFile(daily, original, 'utf8');
  await withMockedFs({
    readFile: (real) => async (file, ...args) => {
      if (isSame(file, daily)) throw fail('EACCES', 'injected daily read failure');
      return real.call(fs.promises, file, ...args);
    },
  }, async () => {
    const result = await f.run();
    await checkMain(f, result);
    assert.deepEqual(result.resolvedDailyLogs, []);
    assert.match(checkWarning(result, 0), /injected daily read failure/);
  });
  assert.equal(await readFile(daily, 'utf8'), original);
});

test('daily write failure reports partial completion and leaves the original daily file intact', async (t) => {
  const f = await fixture(t);
  const daily = path.join(f.root, '2026-11-08.md');
  const original = thread('写失败记录');
  await writeFile(daily, original, 'utf8');
  await withMockedFs({
    rename: (real) => async (from, to, ...args) => {
      if (isSame(to, daily)) throw fail('EACCES', 'injected daily write failure');
      return real.call(fs.promises, from, to, ...args);
    },
  }, async () => {
    const result = await f.run();
    await checkMain(f, result);
    assert.deepEqual(result.resolvedDailyLogs, []);
    assert.match(checkWarning(result, 0), /injected daily write failure/);
  });
  assert.equal(await readFile(daily, 'utf8'), original);
});

test('failure after the first daily update reports the completed file and preserves both outcomes', async (t) => {
  const f = await fixture(t);
  const first = path.join(f.root, '2026-11-07.md');
  const second = path.join(f.root, '2026-11-08.md');
  const firstText = thread('先完成记录');
  const secondText = thread('后失败记录');
  await writeFile(first, firstText, 'utf8');
  await writeFile(second, secondText, 'utf8');
  await withMockedFs({
    readdir: (real) => async (dir, ...args) => {
      const entries = await real.call(fs.promises, dir, ...args);
      return isSame(dir, f.root) ? entries.sort() : entries;
    },
    readFile: (real) => async (file, ...args) => {
      if (isSame(file, second)) throw fail('EACCES', 'injected second daily read failure');
      return real.call(fs.promises, file, ...args);
    },
  }, async () => {
    const result = await f.run();
    await checkMain(f, result);
    assert.match(checkWarning(result, 1), /2026-11-07\.md/);
    assert.match(checkWarning(result, 1), /injected second daily read failure/);
  });
  assert.match(await readFile(first, 'utf8'), /✅ 2026-11-10 已解决/);
  assert.equal(await readFile(second, 'utf8'), secondText);
});

test('invalid resolve slug is rejected before the main file is created', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run({ resolve: '../escape' }), /slug|invalid|path|非法/i);
  assert.deepEqual(await readdir(f.functions), [], 'invalid resolve must not commit the feature file');
});

test('a successful scan with no matching item is distinguishable from an I/O error', async (t) => {
  const f = await fixture(t);
  const daily = path.join(f.root, '2026-11-08.md');
  const original = '# unrelated\n\n- 别的事情 → [其他](functions/其他.md)\n';
  await writeFile(daily, original, 'utf8');
  const result = await f.run();
  await checkMain(f, result);
  assert.deepEqual(result.resolvedDailyLogs, []);
  assert.ok(result.warnings.some((entry) => /没有未解决条目/.test(entry)));
  assert.ok(!result.warnings.some((entry) => /未全部完成/.test(entry)));
  assert.equal(await readFile(daily, 'utf8'), original);
});
