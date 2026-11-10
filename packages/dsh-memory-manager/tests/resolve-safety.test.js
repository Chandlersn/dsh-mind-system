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
  return { root, functions, args, run: (overrides = {}) => tool.execute(Object.fromEntries(Object.entries({ ...args, ...overrides }).filter(([, value]) => value !== undefined)), {}) };
}

const thread = (label) => `# ${label}\n\n## 待观察\n\n- ${label} → [待解决功能](functions/待解决功能.md)\n`;
function fail(code, what) { const error = new Error(what); error.code = code; return error; }
function isSame(a, b) { return typeof a === 'string' && path.resolve(a) === path.resolve(b); }
function checkPreservationWarning(result) {
  assert.ok(Array.isArray(result.warnings));
  const warning = result.warnings.find((entry) => entry.includes('resolve: 待解决功能'));
  assert.ok(warning, 'receipt must identify the requested resolve target');
  assert.match(warning, /保留原始证据/);
  assert.match(warning, /未修改或勾选任何历史每日记录/);
  assert.match(warning, /未确认.*待观察项已解决/);
  assert.ok(!result.warnings.some((entry) => /没有未解决条目|更新每日待观察项未全部完成/.test(entry)), 'no scan result or partial update may be claimed');
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

test('resolve preserves multiple daily files without scanning, reading or writing them', async (t) => {
  const f = await fixture(t);
  const originals = new Map([
    [path.join(f.root, '2026-11-07.md'), thread('第一份待观察')],
    [path.join(f.root, '2026-11-08.md'), thread('第二份待观察')],
    [path.join(f.root, '2026-11-09.md'), '# 无匹配记录\n\n- 其他主题\n'],
  ]);
  for (const [file, text] of originals) await writeFile(file, text, 'utf8');
  const touched = [];
  const dailyOrStage = (file) => typeof file === 'string' && [...originals.keys()].some((daily) => isSame(file, daily) || file.startsWith(`${daily}.tmp-`));
  const reject = (op, target) => { touched.push(`${op}:${target}`); throw fail('EACCES', `injected ${op} failure`); };
  await withMockedFs({
    readdir: (real) => async (dir, ...args) => isSame(dir, f.root) ? reject('scan', dir) : real.call(fs.promises, dir, ...args),
    readFile: (real) => async (file, ...args) => dailyOrStage(file) ? reject('read', file) : real.call(fs.promises, file, ...args),
    writeFile: (real) => async (file, ...args) => dailyOrStage(file) ? reject('write', file) : real.call(fs.promises, file, ...args),
    appendFile: (real) => async (file, ...args) => dailyOrStage(file) ? reject('append', file) : real.call(fs.promises, file, ...args),
    rename: (real) => async (from, to, ...args) => dailyOrStage(from) || dailyOrStage(to) ? reject('rename', to) : real.call(fs.promises, from, to, ...args),
  }, async () => {
    // Positive controls prove that the injection itself catches scan, read,
    // direct write, staged write, append and rename before testing the tool.
    await assert.rejects(fs.promises.readdir(f.root), /injected scan failure/);
    for (const file of originals.keys()) {
      await assert.rejects(fs.promises.readFile(file), /injected read failure/);
      await assert.rejects(fs.promises.writeFile(file, 'bad'), /injected write failure/);
      await assert.rejects(fs.promises.writeFile(`${file}.tmp-control`, 'bad'), /injected write failure/);
      await assert.rejects(fs.promises.appendFile(file, 'bad'), /injected append failure/);
      await assert.rejects(fs.promises.rename(`${file}.tmp-control`, file), /injected rename failure/);
    }
    assert.equal(touched.length, 1 + originals.size * 5, 'all injected paths must be demonstrably active');
    touched.length = 0;
    const result = await f.run();
    await checkMain(f, result);
    assert.deepEqual(result.resolvedDailyLogs, []);
    checkPreservationWarning(result);
    assert.deepEqual(touched, [], 'resolve must not scan the root or access any daily file');
  });
  for (const [file, text] of originals) assert.equal(await readFile(file, 'utf8'), text, `${file} must remain byte-for-byte intact`);
});

test('invalid resolve slug is rejected before the main file is created', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run({ resolve: '../escape' }), /slug|invalid|path|非法/i);
  assert.deepEqual(await readdir(f.functions), [], 'invalid resolve must not commit the feature file');
});

test('omitting resolve saves the feature without a resolve-specific warning or daily changes', async (t) => {
  const f = await fixture(t);
  const daily = path.join(f.root, '2026-11-08.md');
  const original = thread('无 resolve 对照');
  await writeFile(daily, original, 'utf8');
  const result = await f.run({ resolve: undefined });
  await checkMain(f, result);
  assert.deepEqual(result.resolvedDailyLogs, []);
  assert.ok(!result.warnings.some((entry) => /resolve:/.test(entry)), 'the preservation warning is specific to a requested resolve');
  assert.equal(await readFile(daily, 'utf8'), original);
});

test('resolve warns about preserved evidence even when there are no daily files', async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  await checkMain(f, result);
  assert.deepEqual(result.resolvedDailyLogs, []);
  checkPreservationWarning(result);
});
