import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runHealthCheck, DEFAULTS } from '../server.js';

async function fixture(t, names) {
  const home = await mkdtemp(path.join(tmpdir(), 'health-existence-unknown-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await mkdir(path.join(root, 'functions'), { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# 测试\n', 'utf8');
  await writeFile(path.join(root, '.usage.jsonl'), names.map((name) => JSON.stringify({ href: `functions/${name}.md`, kind: 'read', at: '2026-01-01T00:00:00.000Z' })).join('\n') + '\n', 'utf8');
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^health-existence-unknown-/);
    await rm(home, { recursive: true, force: true });
  });
  return { root, skills };
}

async function checked(root, skills, faults = {}) {
  const original = fs.promises.stat;
  const calls = new Map();
  fs.promises.stat = async function (file, ...args) {
    const key = typeof file === 'string' ? path.resolve(file) : '';
    const code = faults[key];
    if (key.startsWith(path.join(root, 'functions') + path.sep)) calls.set(path.basename(key), (calls.get(path.basename(key)) ?? 0) + 1);
    if (code) throw Object.assign(new Error('isolated stat failure'), { code });
    return original.call(this, file, ...args);
  };
  syncBuiltinESMExports();
  try {
    return { report: await runHealthCheck(root, { ...DEFAULTS, skillRoot: skills, insightBudget: { maxInsights: 24, maxSingleSourceShare: 0.6, minLedgerMisses: 3 } }), calls };
  } finally {
    fs.promises.stat = original;
    syncBuiltinESMExports();
  }
}

const resultsFor = (r, rule) => r.results.filter((x) => x.rule === rule);
const unknownFor = (r, rule) => resultsFor(r, rule).filter((x) => x.level === 'WARN' && /状态未知/.test(x.message));
const missingFor = (r, rule) => resultsFor(r, rule).filter((x) => /已不存在的文件|记忆文件不见了/.test(x.message));

for (const code of ['EIO', 'EACCES', 'ENOTDIR']) {
  test(`${code}: 未知与真实缺失分离，继续检查后续并保留两个规则的真实缺失告警`, async (t) => {
    const { root, skills } = await fixture(t, ['unknown', 'gone-a', 'present', 'gone-b', 'gone-c']);
    await writeFile(path.join(root, 'functions', 'present.md'), '# exists\n', 'utf8');
    const bad = path.join(root, 'functions', 'unknown.md');
    await writeFile(bad, '# exists, but stat is unknown\n', 'utf8');
    const { report, calls } = await checked(root, skills, { [bad]: code });
    assert.ok((calls.get('unknown.md') ?? 0) >= 2, 'both rules exercise the fault');
    assert.ok((calls.get('gone-c.md') ?? 0) >= 2, 'both rules continue after the fault');
    assert.ok((calls.get('present.md') ?? 0) >= 2, 'normal target actually gets checked');
    for (const rule of ['R23', 'R25']) {
      const unknown = unknownFor(report, rule);
      const missing = missingFor(report, rule);
      assert.equal(unknown.length, 1, `${rule}: unknown must be explicit`);
      assert.match(unknown[0].message, new RegExp(`unknown\\.md: ${code}`));
      assert.match(unknown[0].message, /扫描不完整/);
      assert.equal(missing.length, 1, `${rule}: real findings must survive unknown`);
      assert.match(missing[0].message, /至少 3 个/, 'partial scan must present missing count as a lower bound');
      for (const name of ['gone-a.md', 'gone-b.md', 'gone-c.md']) assert.ok(missing[0].message.includes(name), `${rule} omits ${name}`);
      assert.ok(!missing[0].message.includes('unknown.md') && !missing[0].message.includes('present.md'));
    }
  });
}

test('两个真实缺失加一个未知不得凑成三个缺失，且未知不能被当作通过', async (t) => {
  const { root, skills } = await fixture(t, ['gone-a', 'unknown', 'present', 'gone-b']);
  await writeFile(path.join(root, 'functions', 'present.md'), '# exists\n', 'utf8');
  await writeFile(path.join(root, 'functions', 'unknown.md'), '# exists, but stat is unknown\n', 'utf8');
  const { report, calls } = await checked(root, skills, { [path.join(root, 'functions', 'unknown.md')]: 'EIO' });
  assert.ok((calls.get('gone-b.md') ?? 0) >= 2);
  for (const rule of ['R23', 'R25']) {
    assert.equal(unknownFor(report, rule).length, 1);
    assert.equal(missingFor(report, rule).length, 0, `${rule} must count confirmed ENOENT only`);
  }
});

test('全部正常存在时两项均不产生未知或缺失告警', async (t) => {
  const { root, skills } = await fixture(t, ['present-a', 'present-b', 'present-c']);
  for (const name of ['present-a', 'present-b', 'present-c']) await writeFile(path.join(root, 'functions', `${name}.md`), '# exists\n', 'utf8');
  const { report, calls } = await checked(root, skills);
  assert.ok((calls.get('present-c.md') ?? 0) >= 2);
  for (const rule of ['R23', 'R25']) {
    assert.equal(unknownFor(report, rule).length, 0);
    assert.equal(missingFor(report, rule).length, 0);
  }
});

test('全为真实缺失时恰好达到阈值，两项均告警且没有未知', async (t) => {
  const { root, skills } = await fixture(t, ['gone-a', 'gone-b', 'gone-c']);
  const { report } = await checked(root, skills);
  for (const rule of ['R23', 'R25']) {
    assert.equal(unknownFor(report, rule).length, 0);
    assert.equal(missingFor(report, rule).length, 1);
    assert.match(missingFor(report, rule)[0].message, /3 个/);
  }
});
