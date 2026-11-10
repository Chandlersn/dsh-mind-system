import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runHealthCheck, DEFAULTS } from '../server.js';

test('R16 逐路径区分未知与缺失，并在故障后继续检查', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'r16-path-unknown-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  const denied = path.join(home, 'denied');
  const io = path.join(home, 'io-error');
  const missing = path.join(home, 'definitely-missing');
  const present = path.join(home, 'present');
  await mkdir(root, { recursive: true });
  await mkdir(skills, { recursive: true });
  await mkdir(present);
  await writeFile(path.join(root, 'MEMORY.md'), [
    '# 测试索引', `- \`${denied}\``, `- \`${io}\``,
    `- \`${missing}\``, `- \`${present}\``, `- \`${denied}\``, '',
  ].join('\n'), 'utf8');
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^r16-path-unknown-/);
    await rm(home, { recursive: true, force: true });
  });

  const targets = new Map([[denied, 'EACCES'], [io, 'EIO']]);
  const observed = new Map();
  const original = fs.promises.stat;
  fs.promises.stat = async function (file, ...args) {
    if (typeof file === 'string' && [denied, io, missing, present].includes(file)) {
      observed.set(file, (observed.get(file) ?? 0) + 1);
      if (targets.has(file)) throw Object.assign(new Error('isolated synthetic stat error'), { code: targets.get(file) });
    }
    return original.call(this, file, ...args);
  };
  syncBuiltinESMExports();
  let report;
  try { report = await runHealthCheck(root, { ...DEFAULTS, skillRoot: skills }); }
  finally { fs.promises.stat = original; syncBuiltinESMExports(); }

  for (const file of [denied, io, missing, present]) assert.equal(observed.get(file), 1, `${file} 必须恰好被 R16 检查一次`);
  const findings = report.results.filter((entry) => entry.rule === 'R16');
  for (const [file, code] of targets) {
    const matched = findings.filter((entry) => entry.message.includes(file));
    assert.equal(matched.length, 1, `${file} 应有一条未知告警`);
    assert.equal(matched[0].level, 'WARN');
    assert.match(matched[0].message, /未知/);
    assert.ok(matched[0].message.includes(code));
    assert.doesNotMatch(matched[0].message, /不存在|已删除/);
  }
  const missingFinding = findings.filter((entry) => entry.message.includes(missing));
  assert.equal(missingFinding.length, 1);
  assert.equal(missingFinding[0].level, 'WARN');
  assert.match(missingFinding[0].message, /不存在/);
  assert.ok(!findings.some((entry) => entry.message.includes(present)), '确实存在的后续路径不得告警');
});
