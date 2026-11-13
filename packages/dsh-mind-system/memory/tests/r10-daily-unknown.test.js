// R10's actual health-check implementation is exercised only against disposable
// directories. Faults target exact synthetic paths and are restored after each test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply, runHealthCheck, DEFAULTS } from '../server.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'r10-daily-unknown-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await mkdir(root, { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# 隔离测试索引\n', 'utf8');
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^r10-daily-unknown-/);
    await rm(home, { recursive: true, force: true });
  });
  return { home, root, skills };
}

async function withFsFault({ root, badDaily, failListing = false }, action) {
  const originalRead = fs.promises.readFile;
  const originalReaddir = fs.promises.readdir;
  let failedReadCalls = 0;
  let failedListingCalls = 0;
  fs.promises.readFile = async function (name, ...args) {
    if (typeof name === 'string' && badDaily && path.resolve(name) === badDaily) {
      failedReadCalls++;
      throw Object.assign(new Error('synthetic unreadable daily'), { code: 'EACCES' });
    }
    return originalRead.call(this, name, ...args);
  };
  fs.promises.readdir = async function (name, ...args) {
    if (typeof name === 'string' && path.resolve(name) === root && args.length === 0) {
      if (failListing) {
        failedListingCalls++;
        throw Object.assign(new Error('synthetic root listing denied'), { code: 'EACCES' });
      }
      // Fix the traversal order across filesystems: the unreadable file is first.
      const entries = await originalReaddir.call(this, name, ...args);
      return entries.sort();
    }
    return originalReaddir.call(this, name, ...args);
  };
  syncBuiltinESMExports();
  try {
    const result = await action();
    return { result, failedReadCalls, failedListingCalls };
  } finally {
    fs.promises.readFile = originalRead;
    fs.promises.readdir = originalReaddir;
    syncBuiltinESMExports();
  }
}

const r10 = (report) => report.results.filter((r) => r.rule === 'R10');
const isUnknown = (r) => r.level === 'WARN' && /未知|无法|未完成/.test(r.message);

// Positive control: the same second daily file's dangling link must be found
// when the first file is readable; otherwise the fault test proves nothing.
test('正常扫描每日文件时发现后续文件的真实死链', async (t) => {
  const { root, skills } = await fixture(t);
  await writeFile(path.join(root, '2026-01-01.md'), '# 正常记录\n', 'utf8');
  await writeFile(path.join(root, '2026-01-02.md'), '[后续死链](missing-daily-target.md)\n', 'utf8');
  const report = await runHealthCheck(root, { ...DEFAULTS, skillRoot: skills });
  assert.ok(r10(report).some((r) => r.level === 'FAIL' && r.message.includes('2026-01-02.md') && r.message.includes('missing-daily-target.md')));
});

test('单个每日文件不可读时报告未知并继续检查后续文件', async (t) => {
  const { root, skills } = await fixture(t);
  const badDaily = path.join(root, '2026-01-01.md');
  await writeFile(badDaily, '# 原始记录\n', 'utf8');
  await writeFile(path.join(root, '2026-01-02.md'), '[后续死链](missing-daily-target.md)\n', 'utf8');
  const { result, failedReadCalls } = await withFsFault({ root, badDaily }, () => runHealthCheck(root, { ...DEFAULTS, skillRoot: skills }));
  assert.ok(failedReadCalls > 0, 'fault must actually target the daily file');
  assert.ok(r10(result).some((r) => r.level === 'FAIL' && r.message.includes('2026-01-02.md') && r.message.includes('missing-daily-target.md')), '后续每日文件必须仍被扫描并报告死链');
  assert.ok(r10(result).some((r) => isUnknown(r) && r.message.includes('2026-01-01.md')), '不可读文件必须以 R10 WARN 报告检查状态未知');
});

test('唯一每日文件不可读时不得将零死链视为已确认', async (t) => {
  const { root, skills } = await fixture(t);
  const badDaily = path.join(root, '2026-01-01.md');
  await writeFile(badDaily, '[未能检查的死链](missing-daily-target.md)\n', 'utf8');
  const { result, failedReadCalls } = await withFsFault({ root, badDaily }, () => runHealthCheck(root, { ...DEFAULTS, skillRoot: skills }));
  assert.ok(failedReadCalls > 0, 'fault must actually target the daily file');
  assert.ok(r10(result).some((r) => isUnknown(r) && r.message.includes('2026-01-01.md')), '零条 R10 FAIL 不能代替明确未知状态');
});

test('真实 memory_rename 回执不得把未完整检查呈现为已确认零死链', async (t) => {
  const { home, root, skills } = await fixture(t);
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; });
  await mkdir(path.join(root, 'functions'), { recursive: true });
  await writeFile(path.join(root, 'functions', 'source.md'), '# Source\n', 'utf8');
  const badDaily = path.join(root, '2026-01-01.md');
  await writeFile(badDaily, '[历史引用](functions/source.md)\n', 'utf8');
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
  assert.ok(tool && typeof tool.execute === 'function');
  const args = { from: 'source', to: 'target' };
  const { result, failedReadCalls } = await withFsFault({ root, badDaily }, () => tool.execute(args, {}));
  assert.ok(failedReadCalls > 0, 'rename verification must have encountered the injected daily read fault');
  assert.ok(result.warnings.some((s) => /(?:R10|死链|链接).*(?:未知|未完成|不完整)/.test(s)), '返回值必须提醒 R10 死链检查不完整');
  const rendered = tool.output.render(args, result).map((block) => block.text).join('\n');
  assert.match(rendered, /未知|未完成|不完整/);
  assert.doesNotMatch(rendered, /^改写后死链数：0\s*$/m, '不能单独展示“改写后死链数：0”作为已确认结论');
});

test('根目录无法枚举时 R10 必须明确未知而非零死链已确认', async (t) => {
  const { root, skills } = await fixture(t);
  await writeFile(path.join(root, '2026-01-02.md'), '[未能检查的死链](missing-daily-target.md)\n', 'utf8');
  const { result, failedListingCalls } = await withFsFault({ root, failListing: true }, () => runHealthCheck(root, { ...DEFAULTS, skillRoot: skills }));
  assert.ok(failedListingCalls > 0, 'fault must actually target root enumeration');
  assert.ok(r10(result).some(isUnknown), '根目录枚举失败必须以 R10 WARN 标记死链扫描未知，不能只报告零个 R10 FAIL');
});
