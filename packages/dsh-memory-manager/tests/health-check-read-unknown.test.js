// Exercise the production health check against disposable roots only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runHealthCheck, DEFAULTS } from '../server.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'health-read-unknown-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await mkdir(root, { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# 隔离索引\n\n## 道层\n- [正文](dao/example.md)\n', 'utf8');
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^health-read-unknown-/);
    await rm(home, { recursive: true, force: true });
  });
  return { root, skills };
}

async function withFault({ read, list }, run) {
  const originalRead = fs.promises.readFile;
  const originalList = fs.promises.readdir;
  let readCalls = 0;
  let listCalls = 0;
  fs.promises.readFile = async function (name, ...args) {
    if (typeof name === 'string' && read && read(path.resolve(name), ++readCalls)) {
      throw Object.assign(new Error('synthetic read failure'), { code: 'EIO' });
    }
    return originalRead.call(this, name, ...args);
  };
  fs.promises.readdir = async function (name, ...args) {
    if (typeof name === 'string' && list && list(path.resolve(name), ++listCalls)) {
      throw Object.assign(new Error('synthetic listing failure'), { code: 'EACCES' });
    }
    return originalList.call(this, name, ...args);
  };
  syncBuiltinESMExports();
  try { return await run(); }
  finally {
    fs.promises.readFile = originalRead;
    fs.promises.readdir = originalList;
    syncBuiltinESMExports();
  }
}

function isUnknown(report, rule, code) {
  return report.results.some((r) => r.rule === rule && r.level === 'WARN' && /不完整/.test(r.message) && /未知/.test(r.message) && r.message.includes(code));
}
function check(root, skills) { return runHealthCheck(root, { ...DEFAULTS, skillRoot: skills }); }

test('使用账本 EIO 时 R18、R23、R25 标明未知，后续 R24 仍实际运行', async (t) => {
  const { root, skills } = await fixture(t);
  await mkdir(path.join(root, 'dao'));
  await writeFile(path.join(root, 'dao', 'example.md'), '# 无命题正控\n', 'utf8');
  const target = path.join(root, '.usage.jsonl');
  await writeFile(target, '{}\n', 'utf8');
  let injected = 0;
  const result = await withFault({ read: (name) => { if (name === target) { injected++; return true; } return false; } }, () => check(root, skills));
  assert.ok(injected >= 4, 'must actually encounter R18, R22, R23, and R25 ledger reads');
  for (const rule of ['R18', 'R23', 'R25']) assert.ok(isUnknown(result, rule, 'EIO'), `${rule} must report an incomplete check with EIO`);
  assert.ok(result.results.some((r) => r.rule === 'R24' && /缺少「## 命题」/.test(r.message)), 'later R24 must inspect the actual dao file');
  assert.ok(result.results.some((r) => r.rule === 'R26'), 'the later R26 must still run');
});

test('道文件读取失败时 R24 标明未知，后续 R26 仍运行', async (t) => {
  const { root, skills } = await fixture(t);
  await mkdir(path.join(root, 'dao'));
  const dao = path.join(root, 'dao', 'example.md');
  await writeFile(dao, '# 道\n', 'utf8');
  let reads = 0;
  // The ordinary zone scan reads the indexed file first; fail only the next
  // read, which belongs to R24, leaving the later R26 read untouched.
  const result = await withFault({ read: (name) => name === dao && ++reads === 2 }, () => check(root, skills));
  assert.ok(reads >= 2, 'fault must reach the R24 dao read');
  assert.ok(isUnknown(result, 'R24', 'EIO'));
  assert.ok(result.results.some((r) => r.rule === 'R26'), 'later rule must still run');
});

test('insights 目录拒绝枚举时 R23、R24 均不得伪装为空目录', async (t) => {
  const { root, skills } = await fixture(t);
  const dir = path.join(root, 'insights');
  await mkdir(dir);
  let failed = 0;
  const result = await withFault({ list: (name) => { if (name === dir) { failed++; return true; } return false; } }, () => check(root, skills));
  assert.ok(failed >= 2);
  assert.ok(isUnknown(result, 'R23', 'EACCES'));
  assert.ok(isUnknown(result, 'R24', 'EACCES'));
  assert.ok(result.results.some((r) => r.rule === 'R26'), 'later rule must still run');
});

test('dao 目录拒绝枚举时 R24 明确未知，后续规则继续', async (t) => {
  const { root, skills } = await fixture(t);
  const dir = path.join(root, 'dao');
  await mkdir(dir);
  let failed = 0;
  const result = await withFault({ list: (name) => { if (name === dir) { failed++; return true; } return false; } }, () => check(root, skills));
  assert.ok(failed > 0);
  assert.ok(isUnknown(result, 'R24', 'EACCES'));
  assert.ok(result.results.some((r) => r.rule === 'R26'), 'later rule must still run');
});

test('真实缺失的 usage、insights 和 dao 不产生不完整假警告', async (t) => {
  const { root, skills } = await fixture(t);
  const result = await check(root, skills);
  for (const rule of ['R18', 'R23', 'R24', 'R25']) {
    assert.ok(!result.results.some((r) => r.rule === rule && /检查不完整/.test(r.message)), `${rule}: ENOENT is optional absence`);
  }
});
