import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runHealthCheck, DEFAULTS } from '../server.js';

const zones = ['functions', 'insights', 'dao', 'capabilities', 'skills'];
const syntheticSecret = 'sk-' + 'A'.repeat(32);

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'health-zone-read-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'host-skills');
  await mkdir(root, { recursive: true });
  await mkdir(skills, { recursive: true });
  for (const zone of zones) {
    await mkdir(path.join(root, zone));
    await writeFile(path.join(root, zone, 'bad.md'), '# 故障文件\n原文不得改变\n');
    await writeFile(path.join(root, zone, 'good.md'), `# 可读正控\n${syntheticSecret}\n`);
  }
  // R5's earlier orphan check bypasses content reads for indexed insights/dao;
  // both paths then reach the specific zone traversal under test.
  await writeFile(path.join(root, 'MEMORY.md'), [
    '# 测试',
    '## 创新优化思想索引',
    '| 名称 | 摘要 |',
    '|---|---|',
    '| [bad](insights/bad.md) | 测试 |',
    '| [good](insights/good.md) | 测试 |',
    '## 道层',
    '- [正文](dao/bad.md)',
    '- [正文](dao/good.md)',
    '',
  ].join('\n'));
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^health-zone-read-/);
    await rm(home, { recursive: true, force: true });
  });
  return { root, skills, home };
}

async function injectFault({ target, method, code }, run) {
  const original = fs.promises[method];
  let injected = 0;
  fs.promises[method] = async function (name, ...args) {
    if (typeof name === 'string' && path.resolve(name) === target) {
      injected++;
      throw Object.assign(new Error('synthetic inaccessible path'), { code });
    }
    return original.call(this, name, ...args);
  };
  syncBuiltinESMExports();
  try { return { result: await run(), injected }; }
  finally { fs.promises[method] = original; syncBuiltinESMExports(); }
}

const check = ({ root, skills }) => runHealthCheck(root, { ...DEFAULTS, skillRoot: skills });
const unknown = (report, rule, label, code) => report.results.some((r) =>
  r.level === 'WARN' && r.rule === rule && r.message.includes(label) && r.message.includes(code) && /未知/.test(r.message));
const isSecretControl = (report, zone) => report.results.some((r) =>
  r.rule === 'R21' && r.level === 'FAIL' && r.message.includes(`${zone}/good.md`));

for (const zone of zones) {
  test(`${zone} 文件持续 EIO：报告未知，继续同区及后续体检`, async (t) => {
    const f = await fixture(t);
    const target = path.join(f.root, zone, 'bad.md');
    const before = await readFile(target, 'utf8');
    const { result, injected } = await injectFault({ target, method: 'readFile', code: 'EIO' }, () => check(f));
    assert.ok(injected >= 1, 'fault must hit the target file');
    for (const rule of ['R10', 'R10e', 'R21']) assert.ok(unknown(result, rule, `${zone}/bad.md`, 'EIO'), `${rule} must expose unknown`);
    const zoneRule = { functions: 'R9', insights: 'R23', dao: 'R24', skills: 'R20' }[zone];
    if (zoneRule) assert.ok(unknown(result, zoneRule, `${zone}/bad.md`, 'EIO'), `${zoneRule} must expose unknown`);
    assert.ok(isSecretControl(result, zone), 'a readable file in the same zone must be inspected');
    if (zone !== 'skills') assert.ok(isSecretControl(result, 'skills'), 'a later zone must be inspected');
    if (zone === 'dao') {
      assert.ok(result.results.some((r) => r.rule === 'R24' && /检查不完整/.test(r.message)), 'persistent dao failure must be surfaced as R24 unknown');
    } else {
      assert.ok(result.results.some((r) => r.rule === 'R24' && r.message.includes('good') && r.message.includes('命题')), 'later R24 must inspect the readable dao positive control');
    }
    assert.ok(result.results.some((r) => r.rule === 'R26'), 'later R26 must actually execute');
    assert.equal(await readFile(target, 'utf8'), before, 'the failing file must remain unmodified');
    assert.equal(await fs.promises.stat(path.join(f.home, 'memory-inbox.json')).then(() => true, () => false), false, 'health check must not write an inbox');
  });
}

for (const code of ['EIO', 'EACCES']) {
  test(`分区目录 ${code}：扫描范围未知，后续分区仍执行`, async (t) => {
    const f = await fixture(t);
    const target = path.join(f.root, 'functions');
    const before = await readFile(path.join(target, 'bad.md'), 'utf8');
    const { result, injected } = await injectFault({ target, method: 'readdir', code }, () => check(f));
    assert.ok(injected >= 1);
    for (const rule of ['R3', 'R8', 'R9', 'R10', 'R10e', 'R14', 'R21', 'TEMP']) {
      assert.ok(unknown(result, rule, 'functions/', code), `${rule} must identify the unknown scan scope`);
    }
    assert.ok(isSecretControl(result, 'insights'), 'later zone must actually be read');
    assert.ok(result.results.some((r) => r.rule === 'R24'));
    assert.ok(result.results.some((r) => r.rule === 'R26'));
    assert.equal(await readFile(path.join(target, 'bad.md'), 'utf8'), before);
  });
}

test('真实缺失和非目录的分区保留既有缺失语义', async (t) => {
  const f = await fixture(t);
  const missing = path.join(f.root, 'skills');
  await rm(missing, { recursive: true });
  let report = await check(f);
  assert.ok(!report.results.some((r) => r.level === 'WARN' && /skills\/ 扫描 检查不完整/.test(r.message)));
  await writeFile(missing, 'not a directory');
  report = await check(f);
  assert.ok(!report.results.some((r) => r.level === 'WARN' && /skills\/ 扫描 检查不完整/.test(r.message)));
});

test('不完整的 functions 或 insights 引用来源不导致其他文件被误判为冷记忆', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, 'functions', 'bad.md');
  const { result } = await injectFault({ target, method: 'readFile', code: 'EIO' }, () => check(f));
  assert.ok(unknown(result, 'TEMP', 'functions/bad.md', 'EIO'));
  assert.ok(!result.results.some((r) => r.rule === 'TEMP' && /冷记忆/.test(r.message)), 'partial backlinks cannot prove a file is cold');
});
