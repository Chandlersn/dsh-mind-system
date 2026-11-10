import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply, runHealthCheck, DEFAULTS } from '../server.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'r10-link-stat-unknown-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await mkdir(path.join(root, 'functions'), { recursive: true });
  await mkdir(skills, { recursive: true });
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^r10-link-stat-unknown-/);
    await rm(home, { recursive: true, force: true });
  });
  return { home, root, skills };
}

async function faultStats(faults, action) {
  const original = fs.promises.stat;
  const counts = new Map();
  fs.promises.stat = async function (file, ...args) {
    const key = typeof file === 'string' ? path.resolve(file) : '';
    if (faults.has(key)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      throw Object.assign(new Error('synthetic stat failure'), { code: faults.get(key) });
    }
    return original.call(this, file, ...args);
  };
  syncBuiltinESMExports();
  try { return { result: await action(), counts }; }
  finally { fs.promises.stat = original; syncBuiltinESMExports(); }
}

const r10 = (report) => report.results.filter((x) => x.rule === 'R10');
const warns = (r, file, code) => r.level === 'WARN' && r.message.includes(file) && r.message.includes(code) && /未知|无法|不完整/.test(r.message);

test('单个链接 stat 失败只报告该链接未知，继续扫描后续真实缺失和外链', async (t) => {
  const { home, root, skills } = await fixture(t);
  const bad = path.join(root, 'unknown.md');
  const external = path.join(home, 'external-unknown.md');
  const urlTarget = path.join(home, 'skill-unknown.md');
  await writeFile(path.join(root, 'MEMORY.md'), [
    '[未知](unknown.md)', '[缺失](missing.md)', '[外部未知](../external-unknown.md)',
    `[宿主技能](${pathToFileURL(urlTarget).href})`, '[非目录](not-directory/child.md)', '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(root, 'not-directory'), 'file', 'utf8');
  const { result, counts } = await faultStats(new Map([[bad, 'EACCES'], [external, 'EIO'], [urlTarget, 'EACCES']]), () => runHealthCheck(root, { ...DEFAULTS, skillRoot: skills }));
  for (const file of [bad, external, urlTarget]) assert.ok(counts.get(file) > 0, `fault not exercised: ${file}`);
  const findings = r10(result);
  assert.ok(findings.some((r) => warns(r, 'MEMORY.md', 'EACCES') && r.message.includes('-> unknown.md（')));
  assert.ok(findings.some((r) => warns(r, 'MEMORY.md', 'EIO') && r.message.includes('external-unknown.md')));
  assert.ok(findings.some((r) => warns(r, 'MEMORY.md', 'EACCES') && r.message.includes('skill-unknown.md')));
  for (const rel of ['unknown.md', 'external-unknown.md', 'skill-unknown.md']) {
    assert.ok(!findings.some((r) => r.level === 'FAIL' && r.message.includes(rel)), `${rel} 的未知状态不得当作不存在`);
  }
  for (const rel of ['missing.md', 'not-directory/child.md']) assert.ok(findings.some((r) => r.level === 'FAIL' && r.message.includes(rel)), `${rel} 必须仍为已确认缺失`);
  const escape = result.results.filter((r) => r.rule === 'R10e' && r.message.includes('external-unknown.md'));
  assert.equal(escape.length, 1, '确定的路径越界应独立标记，目标是否存在另记未知');
  assert.match(escape[0].message, /未知/);
  for (const item of escape) assert.doesNotMatch(item.message, /不存在|missing|dangling/i, '越界路径无法 stat 不是已确认不存在');
});

for (const missing of [true, false]) test(`真实 memory_rename 完成后 stat 未知，${missing ? '有' : '无'}已发现死链时回执均为下界`, async (t) => {
  const { home, root, skills } = await fixture(t);
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; });
  await writeFile(path.join(root, 'functions', 'source.md'), '# Source\n', 'utf8');
  await writeFile(path.join(root, 'MEMORY.md'), `[未知](unknown.md)\n${missing ? '[缺失](missing.md)\n' : ''}`, 'utf8');
  const bad = path.join(root, 'unknown.md');
  const registered = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register: (def) => { registered.set(def.name, def); return noop; } },
    on: () => noop,
    inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR });
  t.after(() => dispose?.());
  const tool = registered.get('memory_rename');
  const args = { from: 'source', to: 'target' };
  const { result, counts } = await faultStats(new Map([[bad, 'EIO']]), () => tool.execute(args, {}));
  assert.ok(counts.get(bad) > 0, 'rename 后验证必须触发目标故障');
  assert.equal(result.mode, 'renamed');
  assert.equal(await readFile(path.join(root, 'functions', 'target.md'), 'utf8'), '# Source\n');
  assert.equal(result.danglingAfter, missing ? 1 : 0, '仅统计可确认的 missing.md');
  assert.ok(result.warnings.some((s) => s.includes('R10 死链检查不完整') && s.includes('EIO') && s.includes('MEMORY.md') && s.includes('下界')));
  const text = tool.output.render(args, result).map((x) => x.text).join('\n');
  assert.match(text, /检查不完整.*下界/);
  assert.doesNotMatch(text, /^改写后死链数：\d+$/m);
});

test('真实 memory_rename 体检因索引缺失提前退出时不得报告完整零死链', async (t) => {
  const { home, root, skills } = await fixture(t);
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; });
  await writeFile(path.join(root, 'functions', 'source.md'), '# Source\n', 'utf8');
  const registered = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register: (def) => { registered.set(def.name, def); return noop; } },
    on: () => noop,
    inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR });
  t.after(() => dispose?.());
  const tool = registered.get('memory_rename');
  const args = { from: 'source', to: 'target' };
  const result = await tool.execute(args, {});
  assert.equal(result.mode, 'renamed');
  assert.equal(await readFile(path.join(root, 'functions', 'target.md'), 'utf8'), '# Source\n');
  assert.equal(result.danglingAfter, 0);
  assert.ok(result.warnings.some((s) => s.includes('R10 死链检查不完整') && s.includes('下界')), 'R0 提前退出意味着 R10 未执行');
  const text = tool.output.render(args, result).map((x) => x.text).join('\n');
  assert.match(text, /检查不完整.*下界/);
});

test('rename 已完成后的体检抛错返回成功及不完整下界', async (t) => {
  const { home, root, skills } = await fixture(t);
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; });
  await writeFile(path.join(root, 'functions', 'source.md'), '# Source\n', 'utf8');
  await writeFile(path.join(root, 'MEMORY.md'), '# Index\n', 'utf8');
  const registered = new Map();
  const noop = () => {};
  const ctx = { tools: { register: (def) => { registered.set(def.name, def); return noop; } }, on: () => noop,
    inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop } };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR });
  t.after(() => dispose?.());
  const tool = registered.get('memory_rename');
  const target = path.join(root, 'functions', 'target.md');
  const original = fs.promises.readFile;
  let successfulTargetReads = 0, faulted = false;
  fs.promises.readFile = async function (file, ...args) {
    const result = await original.call(this, file, ...args);
    if (typeof file === 'string' && path.resolve(file) === target && ++successfulTargetReads === 2) {
      faulted = true;
      throw Object.assign(new Error('synthetic health read failure'), { code: 'EIO' });
    }
    return result;
  };
  syncBuiltinESMExports();
  let result;
  try { result = await tool.execute({ from: 'source', to: 'target' }, {}); }
  finally { fs.promises.readFile = original; syncBuiltinESMExports(); }
  assert.ok(faulted, 'fault must be triggered during verification');
  assert.equal(result.mode, 'renamed');
  assert.equal(await readFile(target, 'utf8'), '# Source\n');
  assert.equal(result.danglingAfter, 0);
  assert.ok(result.warnings.some((s) => s.includes('R10 死链检查不完整') && s.includes('EIO') && s.includes('下界')));
});
