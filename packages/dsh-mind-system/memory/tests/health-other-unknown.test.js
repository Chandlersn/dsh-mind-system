// Faults hit real runHealthCheck I/O against disposable roots only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runHealthCheck, DEFAULTS } from '../server.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'health-other-unknown-'));
  const root = path.join(home, 'memory'), skills = path.join(home, 'skills');
  await mkdir(root, { recursive: true });
  await mkdir(skills);
  await writeFile(path.join(root, 'MEMORY.md'), '# 索引\n', 'utf8');
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^health-other-unknown-/);
    await rm(home, { recursive: true, force: true });
  });
  return { root, skills, opts: { ...DEFAULTS, skillRoot: skills } };
}

async function fault({ read, list, stat, order, code = 'EIO' }, run) {
  const originals = { readFile: fs.promises.readFile, readdir: fs.promises.readdir, stat: fs.promises.stat };
  const hits = { read: 0, list: 0, stat: 0 };
  for (const [method, key] of [['readFile', 'read'], ['readdir', 'list'], ['stat', 'stat']]) {
    fs.promises[method] = async function (name, ...args) {
      if (typeof name === 'string' && ({ read, list, stat })[key]?.(path.resolve(name), ...args)) {
        hits[key]++;
        throw Object.assign(new Error(`synthetic ${key} failure`), { code });
      }
      const result = await originals[method].call(this, name, ...args);
      return method === 'readdir' && order ? order(path.resolve(name), result) : result;
    };
  }
  syncBuiltinESMExports();
  try { return { report: await run(), hits }; }
  finally {
    Object.assign(fs.promises, originals);
    syncBuiltinESMExports();
  }
}
const unknown = (report, rule, subject = '') => report.results.some((r) => r.level === 'WARN' && r.rule === rule && r.message.includes('检查不完整') && r.message.includes('未知') && r.message.includes(subject));
const later = (report) => assert.ok(report.results.some((r) => r.rule === 'R26'), 'subsequent R26 must actually run');

test('R13 文件读取失败不隐藏后续历史文件缺头部', async (t) => {
  const { root, opts } = await fixture(t);
  const dir = path.join(root, 'legacy');
  await mkdir(dir);
  await writeFile(path.join(dir, 'a.md'), '历史原貌', 'utf8');
  await writeFile(path.join(dir, 'b.md'), '没有要求的头部', 'utf8');
  const { report, hits } = await fault({ read: (p) => p === path.join(dir, 'a.md'), order: (p, entries) => p === dir ? [...entries].sort() : entries }, () => runHealthCheck(root, opts));
  assert.ok(hits.read > 0);
  assert.ok(unknown(report, 'R13', 'legacy/a.md'));
  assert.ok(report.results.some((r) => r.rule === 'R13' && r.message.includes('legacy/b.md') && r.message.includes('缺少')));
  later(report);
  const missing = await fault({ code: 'ENOENT', read: (p) => p === path.join(dir, 'a.md'), order: (p, entries) => p === dir ? [...entries].sort() : entries }, () => runHealthCheck(root, opts));
  assert.ok(missing.hits.read > 0);
  assert.ok(!unknown(missing.report, 'R13', 'legacy/a.md'), 'disappeared file keeps ENOENT semantics');
  assert.ok(missing.report.results.some((r) => r.rule === 'R13' && r.message.includes('legacy/b.md') && r.message.includes('缺少')));
});

test('R13 和技能根枚举 EACCES 明确未知，真实缺失仍为可选', async (t) => {
  const { root, skills, opts } = await fixture(t);
  const legacy = path.join(root, 'legacy');
  await mkdir(legacy);
  const { report, hits } = await fault({ code: 'EACCES', list: (p) => p === legacy || p === skills }, () => runHealthCheck(root, opts));
  assert.ok(hits.list >= 2);
  assert.ok(unknown(report, 'R13', 'legacy/'));
  assert.ok(unknown(report, 'R20e', '技能目录'));
  later(report);
  await rm(legacy, { recursive: true });
  await rm(skills, { recursive: true });
  const missing = await runHealthCheck(root, opts);
  assert.ok(!unknown(missing, 'R13'));
  assert.ok(!unknown(missing, 'R20e'));
  assert.ok(!unknown(missing, 'R27'), 'absent functions directory keeps optional ENOENT semantics');
});

test('R22 使用记录 EIO 不伪装为空，真实缺失不报警', async (t) => {
  const { root, opts } = await fixture(t);
  const target = path.join(root, '.usage.jsonl');
  await writeFile(target, '{}\n', 'utf8');
  const { report, hits } = await fault({ read: (p) => p === target }, () => runHealthCheck(root, opts));
  assert.ok(hits.read > 0);
  assert.ok(unknown(report, 'R22'));
  later(report);
  await rm(target);
  assert.ok(!unknown(await runHealthCheck(root, opts), 'R22'));
});

test('R27 单文件 EIO 报未知，其余文件仍检出重复段', async (t) => {
  const { root, opts } = await fixture(t);
  const dir = path.join(root, 'functions');
  await mkdir(dir);
  await writeFile(path.join(dir, 'a.md'), '# 甲\n', 'utf8');
  await writeFile(path.join(dir, 'b.md'), '# 乙\n## 早期演化\n正文\n## 早期演化\n正文\n', 'utf8');
  let seen = 0;
  const { report, hits } = await fault({ read: (p) => p === path.join(dir, 'a.md') && ++seen === 3 }, () => runHealthCheck(root, opts));
  assert.equal(hits.read, 1, `must reach the R27 read (observed ${seen})`);
  assert.ok(unknown(report, 'R27', 'functions/a.md'));
  assert.ok(report.results.some((r) => r.rule === 'R27' && r.message.includes('functions/b.md') && r.message.includes('重复')));
});

test('TEMP 修改时间 EIO 明确未知，不把宽限期未知的文件误判冷记忆', async (t) => {
  const { root, opts } = await fixture(t);
  const dir = path.join(root, 'functions');
  await mkdir(dir);
  const young = path.join(dir, 'young.md'), old = path.join(dir, 'old.md');
  await writeFile(young, '# 新文件\n', 'utf8');
  await writeFile(old, '# 旧文件\n', 'utf8');
  const past = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  await utimes(old, past, past);
  const { report, hits } = await fault({ stat: (p) => p === young }, () => runHealthCheck(root, { ...opts, newFeatureGraceDays: 3 }));
  assert.ok(hits.stat > 0);
  assert.ok(unknown(report, 'TEMP', 'functions/young.md'));
  assert.ok(!report.results.some((r) => r.rule === 'TEMP' && r.message.includes('functions/young.md') && r.message.includes('冷记忆）')));
  assert.ok(report.results.some((r) => r.rule === 'TEMP' && r.message.includes('functions/old.md') && r.message.includes('冷记忆')),
    'the old readable file must still be assessed as a positive control');
  later(report);
});

test('R27 目录枚举 EIO 不伪装为空，后续规则保留', async (t) => {
  const { root, opts } = await fixture(t);
  const dir = path.join(root, 'functions');
  await mkdir(dir);
  await writeFile(path.join(dir, 'a.md'), '# 函数\n', 'utf8');
  let plainLists = 0;
  const { report, hits } = await fault({ list: (p, ...args) => p === dir && !args[0]?.withFileTypes && ++plainLists === 3 }, () => runHealthCheck(root, opts));
  assert.equal(hits.list, 1, `must reach R27 enumeration (observed ${plainLists})`);
  assert.ok(unknown(report, 'R27', 'functions/'));
  assert.ok(report.results.some((r) => r.rule === 'R26'));
});
