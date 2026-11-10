import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { eligibleIndexRows, matchIndexRows, tokensOf } from '../src/recall.js';

const temp = mkdtempSync(path.join(tmpdir(), 'recall-eligibility-'));
after(() => {
  const resolved = path.resolve(temp);
  assert.ok(path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('recall-eligibility-'));
  rmSync(resolved, { recursive: true, force: true });
});

function skill(name, fields = {}) {
  const dir = path.join(temp, name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  writeFileSync(file, `---\nname: ${name}\nstatus: ${fields.status ?? 'active'}\n${fields.scope === undefined ? '' : `scope: ${fields.scope}\n`}${fields.project === undefined ? '' : `scope_project: ${fields.project}\n`}---\n\n# Fixture\n`, 'utf8');
  return pathToFileURL(file).href;
}
const globalHref = skill('global-skill', { scope: 'global' });
const projectHref = skill('project-skill', { scope: 'project', project: 'alpha' });
const missingScopeHref = skill('missing-scope');
const retiredBodyHref = skill('retired-body', { scope: 'global', status: 'retired' });
const row = (name, href, status = 'active') => `| [${name}](${href}) | 测试步骤与分析 | ${status} |`;
const q = tokensOf('测试步骤与分析');

for (const status of ['candidate', 'retired', 'unknown', '', 'ACTIVE']) {
  test(`索引状态 ${status || '缺失'} 不准入决策修复与常规召回`, () => {
    const index = row('global-skill', globalHref, status);
    assert.equal(eligibleIndexRows(index).length, 0);
    assert.equal(matchIndexRows(index, q).length, 0);
  });
}

test('摘要中的 active 不能冒充最终状态列', () => {
  for (const status of ['unknown', 'candidate', 'retired', '']) {
    const index = `| [global-skill](${globalHref}) | active | ${status} |`;
    assert.equal(eligibleIndexRows(index).length, 0);
    assert.equal(matchIndexRows(index, q).length, 0);
  }
});

test('真实三列索引：active 且技能 frontmatter 为 global 正常准入', () => {
  const index = `## 技能台账（可复用操作程序）\n\n| 技能 | 一句话用途 | 状态 |\n|---|---|---|\n${row('global-skill', globalHref)}\n`;
  const expected = { name: 'global-skill', summary: '测试步骤与分析', href: globalHref, zone: 'skill' };
  assert.deepEqual(eligibleIndexRows(index), [expected]);
  assert.equal(matchIndexRows(index, q)[0]?.href, globalHref);
});

test('候选道和混合候选道链接均不进入任何索引通道；正式道仍可召回', () => {
  const index = '| [候选](./dao/%5Fcandidates/提案.md) | 测试步骤与分析 |\n| [正式](dao/正式.md) [候选](dao/_deleted/旧.md) | 测试步骤与分析 |\n| [正式](dao/正式.md) | 测试步骤与分析 |';
  assert.deepEqual(eligibleIndexRows(index).map((r) => r.href), ['dao/正式.md']);
  assert.deepEqual(matchIndexRows(index, q).map((r) => r.href), ['dao/正式.md']);
});

test('无上下文或项目不符时不放行 project 技能；仅精确项目可用', () => {
  const index = row('project-skill', projectHref);
  assert.equal(eligibleIndexRows(index).length, 0);
  assert.equal(matchIndexRows(index, q).length, 0);
  for (const project of ['', 'beta', 'Alpha', 'alpha/other']) {
    assert.equal(eligibleIndexRows(index, { project }).length, 0);
    assert.equal(matchIndexRows(index, q, 3, undefined, { project }).length, 0);
  }
  assert.equal(eligibleIndexRows(index, { project: 'alpha' })[0]?.href, projectHref);
  assert.equal(matchIndexRows(index, q, 3, undefined, { project: 'alpha' })[0]?.href, projectHref);
});

test('无法确定作用域、找不到技能文件或文件状态不一致时拒绝', () => {
  const missingHref = pathToFileURL(path.join(temp, 'not-there', 'SKILL.md')).href;
  for (const href of [missingScopeHref, missingHref, retiredBodyHref]) {
    assert.equal(eligibleIndexRows(row('skill', href)).length, 0, href);
    assert.equal(matchIndexRows(row('skill', href), q).length, 0, href);
  }
});

test('四列索引保留现有列扫描和相关性排序', () => {
  const index = `| 项 | 其他文字 | [global-skill](${globalHref}) | active |\n| [模块](functions/模块.md) | 模块 测试步骤与分析 |`;
  const rows = eligibleIndexRows(index);
  assert.equal(rows.find((r) => r.zone === 'skill')?.href, globalHref);
  const ranked = matchIndexRows(index, tokensOf('global-skill'));
  assert.equal(ranked[0]?.href, globalHref);
});

test('legacy 相对技能地址必须给记忆根且文件证实 global', () => {
  const dir = path.join(temp, 'legacy-root', 'skills');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'legacy.md'), '---\nstatus: active\nscope: global\n---\n\n# 内容\n');
  const index = row('legacy', 'skills/legacy.md');
  assert.equal(eligibleIndexRows(index).length, 0);
  assert.equal(eligibleIndexRows(index, { memoryRoot: path.dirname(dir) })[0]?.href, 'skills/legacy.md');
  assert.equal(eligibleIndexRows(row('escape', 'skills/%2e%2e%2fsecret.md'), { memoryRoot: path.dirname(dir) }).length, 0);
});
