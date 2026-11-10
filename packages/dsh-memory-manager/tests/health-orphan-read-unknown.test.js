// Real runHealthCheck with isolated roots and persistent I/O faults.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runHealthCheck, DEFAULTS } from '../server.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'health-orphan-unknown-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await mkdir(root, { recursive: true });
  await mkdir(skills, { recursive: true });
  for (const zone of ['functions', 'insights', 'dao', 'capabilities']) await mkdir(path.join(root, zone));
  await writeFile(path.join(root, 'MEMORY.md'), '# 测试索引\n', 'utf8');
  await writeFile(path.join(root, 'capabilities', 'other.md'), '# 其他分区正控\n', 'utf8');
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^health-orphan-unknown-/);
    await rm(home, { recursive: true, force: true });
  });
  return { root, skills };
}

async function withFault({ target, op, code }, fn) {
  const original = fs.promises[op];
  let hits = 0;
  fs.promises[op] = async function (name, ...args) {
    if (typeof name === 'string' && path.resolve(name) === path.resolve(target)) {
      hits++;
      throw Object.assign(new Error('synthetic persistent failure'), { code });
    }
    return original.call(this, name, ...args);
  };
  syncBuiltinESMExports();
  try { return { result: await fn(), hits }; }
  finally { fs.promises[op] = original; syncBuiltinESMExports(); }
}

function check(root, skills) { return runHealthCheck(root, { ...DEFAULTS, skillRoot: skills }); }
function r5(result) { return result.results.filter((r) => r.rule === 'R5'); }
function unknown(result, key, code) {
  return r5(result).some((r) => r.level === 'WARN' && r.message.includes(key) && r.message.includes(code) && /检查不完整/.test(r.message) && /状态未知/.test(r.message));
}
function hasOrphan(result, key) {
  return r5(result).some((r) => /没有索引行/.test(r.message) && r.message.includes(key));
}

for (const [zone, code] of [['insights', 'EIO'], ['insights', 'EACCES'], ['dao', 'EIO'], ['dao', 'EACCES']]) {
  test(`${zone} 文件持续 ${code}：标未知，继续同区和后续规则`, async (t) => {
    const { root, skills } = await fixture(t);
    const target = path.join(root, zone, 'bad.md');
    const good = path.join(root, zone, 'good.md');
    await writeFile(target, '# 故障文件原文\n', 'utf8');
    await writeFile(good, '# 同区正常孤儿\n', 'utf8');
    const beforeBad = await readFile(target, 'utf8');
    const beforeGood = await readFile(good, 'utf8');
    const beforeIndex = await readFile(path.join(root, 'MEMORY.md'), 'utf8');
    const beforeOther = await readFile(path.join(root, 'capabilities', 'other.md'), 'utf8');
    const { result, hits } = await withFault({ target, op: 'readFile', code }, () => check(root, skills));
    assert.ok(hits >= 2, 'persistent fault must reach R5 and the later production scan');
    assert.ok(unknown(result, `${zone}/bad.md`, code));
    assert.ok(!hasOrphan(result, `${zone}/bad.md`), 'an unreadable file cannot be classified as a definite orphan');
    assert.ok(hasOrphan(result, `${zone}/good.md`), 'the same zone must continue after the fault');
    assert.ok(hasOrphan(result, 'capabilities/other.md'), 'other zones must still be checked');
    assert.ok(result.results.some((r) => r.rule === 'R26'), 'later audit must execute');
    assert.ok(result.results.every((r) => typeof r.level === 'string' && typeof r.rule === 'string' && typeof r.message === 'string'), 'result schema remains compatible');
    assert.equal(await readFile(target, 'utf8'), beforeBad);
    assert.equal(await readFile(good, 'utf8'), beforeGood);
    assert.equal(await readFile(path.join(root, 'MEMORY.md'), 'utf8'), beforeIndex);
    assert.equal(await readFile(path.join(root, 'capabilities', 'other.md'), 'utf8'), beforeOther);
  });
}

for (const code of ['EIO', 'EACCES']) {
  test(`目录持续 ${code}：R5 报路径未知并检查其他区`, async (t) => {
    const { root, skills } = await fixture(t);
    const dir = path.join(root, 'insights');
    const target = path.join(dir, 'existing.md');
    await writeFile(target, '# 此文件不得改变\n', 'utf8');
    const before = await readFile(target, 'utf8');
    const { result, hits } = await withFault({ target: dir, op: 'readdir', code }, () => check(root, skills));
    assert.ok(hits >= 2, 'fault must reach R5 and later directory consumers');
    assert.ok(unknown(result, 'insights/', code));
    assert.ok(hasOrphan(result, 'capabilities/other.md'));
    assert.ok(result.results.some((r) => r.rule === 'R26'));
    assert.equal(await readFile(target, 'utf8'), before);
  });
}

for (const code of ['ENOENT', 'ENOTDIR']) {
  test(`目录 ${code}：R5 按缺失处理，不伪报未知`, async (t) => {
    const { root, skills } = await fixture(t);
    const dir = path.join(root, 'insights');
    const { result, hits } = await withFault({ target: dir, op: 'readdir', code }, () => check(root, skills));
    assert.ok(hits > 0);
    assert.ok(!r5(result).some((r) => r.message.includes('insights/') && /检查不完整/.test(r.message)));
    assert.ok(hasOrphan(result, 'capabilities/other.md'));
    assert.ok(result.results.some((r) => r.rule === 'R26'));
  });
}
