import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveBlocks, matchIndexRows, tokensOf } from '../src/recall.js';

const query = tokensOf('宇宙秩序演化 证据');
const options = { strongBar: 0, holdBar: 0, archiveBar: 1, archiveMax: 20 };
const inactive = [
  'dao/_candidates/提案.md',
  'dao/_candidates',
  './dao/_candidates/提案.md',
  'dao/./_candidates/提案.md',
  'dao/其他/../_candidates/提案.md',
  'dao/_candidates/_rejected/提案.md',
  'dao/_rejected/提案.md',
  'dao/_deleted/提案.md',
  'dao/candidate/提案.md',
  'dao/%5Fcandidates/%E6%8F%90%E6%A1%88.md',
  'dao/%5Fcandidates/不完整%zz.md',
  'dao%2F_candidates%2F提案.md',
  'dao%252F_candidates%252F提案.md',
  'dao%252525252F_candidates%252525252F提案.md',
  'dao/&#95;candidates/提案.md',
  'dao/_candidates/提案.md?view=1',
  'dao\\_deleted\\提案.md',
  'file:///tmp/memory/dao/_deleted/提案.md',
];

for (const target of inactive) {
  test(`索引和档案均不召回未生效路径：${target}`, () => {
    const link = `[提案](<${target}>)`;
    const index = `| ${link} | 宇宙秩序演化 证据 |\n\n## 道层\n> 宇宙秩序演化 证据 ${link}\n\n## 决策共识 / 规范\n- 宇宙秩序演化 证据 ${link}\n`;
    const rows = matchIndexRows(index, query, 3, undefined, options);
    assert.equal(rows.length, 0);
    assert.equal(rows.heldRows?.length ?? 0, 0);
    assert.deepEqual(archiveBlocks(index, query, options), []);
  });
}

test('混合行与档案块：任何一个未生效链接都阻止整条内容注入', () => {
  const mixed = '[正式](dao/正式.md) [未确认](./dao/_candidates/未确认.md)';
  const index = `| ${mixed} | 宇宙秩序演化 证据 |\n\n## 道层\n> 宇宙秩序演化 证据 ${mixed}`;
  assert.equal(matchIndexRows(index, query, 3, undefined, options).length, 0);
  assert.deepEqual(archiveBlocks(index, query, options), []);
});

test('引用式链接的定义可在章节之外，不能绕过过滤', () => {
  const index = '| [提案][待决] | 宇宙秩序演化 证据 |\n\n## 道层\n> 宇宙秩序演化 证据 [提案][待决]\n\n## 其他\n[待决]: <./dao/%5Fcandidates/提案.md>\n';
  assert.equal(matchIndexRows(index, query, 3, undefined, options).length, 0);
  assert.deepEqual(archiveBlocks(index, query, options), []);
});

test('未包尖括号的嵌套括号、标题和转义括号不会绕过候选过滤', () => {
  for (const target of ['dao/_candidates/提案(a(b)).md', 'dao/_candidates/提案\\\\(旧版\\\\).md']) {
    const link = `[未决](${target} "参考")`;
    const index = `| ${link} | 宇宙秩序演化 证据 |\n\n## 道层\n> 宇宙秩序演化 证据 ${link}`;
    assert.equal(matchIndexRows(index, query, 3, undefined, options).length, 0);
    assert.deepEqual(archiveBlocks(index, query, options), []);
  }
});

test('快捷引用形式不会绕过候选过滤', () => {
  const index = '| [待决] | 宇宙秩序演化 证据 |\n\n## 道层\n> 宇宙秩序演化 证据 [待决]\n\n## 其他\n[待决]: dao/_candidates/提案.md\n';
  assert.equal(matchIndexRows(index, query, 3, undefined, options).length, 0);
  assert.deepEqual(archiveBlocks(index, query, options), []);
});

test('正式道在不同有效 Markdown 路径形态下仍可被索引与档案召回', () => {
  for (const target of ['dao/正式.md', './dao/正式.md', 'dao/./正式.md', 'dao/%E6%AD%A3%E5%BC%8F.md', 'dao/候选理论.md', 'dao/_candidates.md', 'dao/有 空格.md', 'dao/正式%23版本.md']) {
    const index = `| [正式](<${target}>) | 宇宙秩序演化 证据 |\n\n## 道层\n> 宇宙秩序演化 证据 [正式](<${target}>)`;
    const rows = matchIndexRows(index, query, 3, undefined, options);
    assert.equal(rows.length, 1, target);
    assert.equal(rows[0].zone, 'dao');
    assert.equal(archiveBlocks(index, query, options).length, 1, target);
  }
});

test('普通路径归一化后为正式道，而不是按原始字符串误判', () => {
  const index = '| [正式](dao/_candidates/../正式.md) | 宇宙秩序演化 证据 |\n\n## 道层\n> 宇宙秩序演化 证据 [正式](dao/_candidates/../正式.md)';
  assert.equal(matchIndexRows(index, query, 3, undefined, options)[0]?.href, 'dao/正式.md');
  assert.equal(archiveBlocks(index, query, options).length, 1);
});
