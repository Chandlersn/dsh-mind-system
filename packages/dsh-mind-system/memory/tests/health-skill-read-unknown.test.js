// Exercise the actual host skill walk, faulting only an isolated fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runHealthCheck, DEFAULTS } from '../server.js';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'health-skill-read-unknown-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  const bad = path.join(skills, 'a-unreadable', 'SKILL.md');
  const good = path.join(skills, 'z-readable', 'SKILL.md');
  const index = path.join(root, 'MEMORY.md');
  const historical = path.join(root, 'functions', 'history.md');
  await mkdir(path.dirname(bad), { recursive: true });
  await mkdir(path.dirname(good), { recursive: true });
  await mkdir(path.dirname(historical), { recursive: true });
  await writeFile(index, '# 隔离索引\n', 'utf8');
  await writeFile(historical, '# 历史原文\n不得被体检改写\n', 'utf8');
  await writeFile(bad, '---\nname: a-unreadable\nagent_created: true\nstatus: active\n---\n# 原文必须保留\n', 'utf8');
  await writeFile(good, '---\nname: z-readable\nagent_created: true\nstatus: active\n---\n# 后续技能正控\n', 'utf8');
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^health-skill-read-unknown-/);
    await rm(home, { recursive: true, force: true });
  });
  return { root, skills, bad, good, index, historical };
}

for (const code of ['EIO', 'EACCES']) {
  test(`宿主技能单文件持续 ${code} 时 R20e 标明未知，后续技能和 R26 仍执行`, async (t) => {
    const f = await fixture(t);
    const originalRead = fs.promises.readFile;
    const tracked = [f.bad, f.good, f.index, f.historical];
    const before = await Promise.all(tracked.map((p) => originalRead(p)));
    let failedReads = 0;
    let goodReads = 0;
    fs.promises.readFile = async function (name, ...args) {
      if (typeof name === 'string' && path.resolve(name) === f.bad) {
        failedReads++;
        throw Object.assign(new Error('injected persistent skill read failure'), { code });
      }
      if (typeof name === 'string' && path.resolve(name) === f.good) goodReads++;
      return originalRead.call(this, name, ...args);
    };
    syncBuiltinESMExports();
    let report;
    try {
      report = await runHealthCheck(f.root, { ...DEFAULTS, skillRoot: f.skills });
    } finally {
      fs.promises.readFile = originalRead;
      syncBuiltinESMExports();
    }
    assert.ok(failedReads >= 1, 'the persistent fault must actually hit the targeted skill');
    assert.ok(goodReads >= 1, 'a later skill file must actually be read');
    assert.ok(report.results.some((r) => r.rule === 'R20e' && r.level === 'WARN' && r.message.includes('a-unreadable') && r.message.includes(code) && /未检查/.test(r.message) && /未知/.test(r.message)), 'the unreadable skill must be reported as unknown');
    assert.ok(!report.results.some((r) => r.rule === 'R20e' && r.message.includes('a-unreadable') && /有包无索引行|索引行状态/.test(r.message)), 'do not assert lifecycle facts for an unread skill');
    assert.ok(report.results.some((r) => r.rule === 'R20e' && r.message.includes('z-readable') && /有包无索引行/.test(r.message)), 'the later skill must be parsed and checked, not merely opened');
    assert.ok(report.results.some((r) => r.rule === 'R26'), 'the later R26 ledger audit must run');
    const after = await Promise.all(tracked.map((p) => readFile(p)));
    for (let i = 0; i < tracked.length; i++) assert.deepEqual(after[i], before[i], `read-only check must preserve ${path.basename(tracked[i])}`);
  });
}

test('真实缺失 SKILL.md 不被当作读取成功或读取错误，后续技能继续检查', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.skills, 'a-missing'));
  const report = await runHealthCheck(f.root, { ...DEFAULTS, skillRoot: f.skills });
  assert.ok(!report.results.some((r) => r.rule === 'R20e' && r.message.includes('a-missing')), 'a truly absent SKILL.md must not fabricate either read facts or an I/O failure');
  assert.ok(report.results.some((r) => r.rule === 'R20e' && r.message.includes('z-readable') && /有包无索引行/.test(r.message)), 'the next genuine skill is inspected');
  assert.ok(report.results.some((r) => r.rule === 'R26'), 'later audit still runs');
});
