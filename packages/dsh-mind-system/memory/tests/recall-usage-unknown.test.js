// Exercise the real pre-step hook with an isolated memory root.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../server.js';

for (const budget of [0, 500]) test(`usage EACCES preserves mandatory status and rules at budget ${budget}`, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'recall-usage-unknown-'));
  const root = path.join(home, 'memory'), skills = path.join(home, 'skills');
  await mkdir(path.join(root, '.usage'), { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), `# Empty index\n\n## 决策共识 / 规范\n\n- alpha bravo ${'档'.repeat(80)}\n`);
  const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const hooks = new Map(), services = new Map(), noop = () => {};
  let rulesRead = 0;
  const valves = { upward() {}, negativeRules() { rulesRead++; return [{ id: 'forbidden-test', statement: 'Do not execute the risky action', keywords: ['risk-token'] }]; } };
  const ctx = {
    tools: { register: () => noop }, systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on(name, fn) { hooks.set(name, fn); return noop; },
    get(name) { return name === 'valves' ? valves : services.get(name); }, set(name, value) { services.set(name, value); },
    inject(_names, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); return noop; },
  };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, recallTimeoutMs: 500, recallOptionalBudgetBytes: budget, dshRoot: process.env.DSH_INSTALL_DIR || process.env.DSH_ROOT || 'D:/dsh' });
  t.after(async () => {
    dispose?.(); if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir())); await rm(home, { recursive: true, force: true });
  });
  const original = fs.promises.opendir;
  let failures = 0;
  fs.promises.opendir = async function (name, ...args) {
    if (typeof name === 'string' && path.resolve(name) === path.join(root, '.usage')) {
      failures++; throw Object.assign(new Error('injected access error'), { code: 'EACCES' });
    }
    return original.call(this, name, ...args);
  };
  syncBuiltinESMExports();
  const invoke = async (turn) => {
    let count = 0;
    const decision = { kind: 'enter', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'original' }] }] };
    const result = await hooks.get('agent/pre-step')({ agent: { id: 'test-agent' }, turn, messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'alpha bravo risk-token' }] }] }, async () => { count++; return decision; });
    assert.equal(count, 1);
    assert.deepEqual(result.messages.at(-1), decision.messages[0]);
    return result.messages[0].content[0].text;
  };
  let text;
  try { text = await invoke(1); }
  finally { fs.promises.opendir = original; syncBuiltinESMExports(); }
  assert.ok(failures > 0);
  assert.ok(rulesRead > 0);
  assert.match(text, /forbidden-test/);
  assert.match(text, /使用热度与纠偏状态未知/);
  const prefix = text.split('\n\n### ⛔ 负向规则')[0].split('\n\n### ♻ 日记录候选扫描')[0];
  const warning = '⚠ 使用账本读取失败：使用热度与纠偏状态未知，本轮仅按其他可用证据召回。';
  assert.ok(prefix.endsWith(warning));
  const optional = prefix.slice(0, -warning.length).replace(/\n\n$/, '');
  const bytes = Buffer.byteLength(optional, 'utf8');
  assert.ok(bytes <= budget, `optional UTF-8 bytes must fit: ${bytes}`);
  if (budget === 0) assert.equal(bytes, 0);
  else assert.match(optional, /档案/, 'the budget fixture must contain independently rendered recall text');
  const report = await services.get('memory.healthProbe').probe();
  const finding = report.findings.find((f) => f.code === 'memory.recall-dual-side');
  assert.match(finding.message, new RegExp(`可选文本峰值\\s*${bytes}\\s*字节`));
  assert.deepEqual(await readdir(path.join(root, '.usage')), [], 'rules-only recall must not create usage rows');
  const recovered = await invoke(2);
  assert.match(recovered, /forbidden-test/);
  assert.doesNotMatch(recovered, /使用热度与纠偏状态未知/, 'a failed read must not cache an empty success');
});
