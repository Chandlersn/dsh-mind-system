/**
 * 调度机制测试（2026-11-02 用户："mind（调度），固化为代码机制"）。
 *
 * 固化前：处境判定是 `classifySituation()` 里的一串关键词匹配——
 * 不可查、不可调、别的单元无法贡献信号。固化后：
 *
 * - 信号可注册（任何单元贡献自己的处境信号，带反例）
 * - 判定可解释（命中/落选都能查）
 * - 命中可记账（探针能区分"没生效"与"本轮无信号"）
 *
 * 重点是**拒绝路径**：信号没词、没名字，都必须当场拒绝。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  registerSignal,
  listSignals,
  explainSituation,
  recordDecision,
  lastDecisionOf,
  __clearSignalsForTest,
} from '../src/dispatch.js';
import { SITUATIONS } from '../src/orchestrate.js';

test('内置信号能判出四种处境', () => {
  assert.equal(explainSituation('改了没效果，反复都不行').situation, SITUATIONS.diagnose);
  assert.equal(explainSituation('搜一下网上的最新资料').situation, SITUATIONS.retrieve);
  assert.equal(explainSituation('上次说过的约定还记得吗').situation, SITUATIONS.recall);
  assert.equal(explainSituation('帮我修一下这个文件').situation, SITUATIONS.execute);
});

test('判不出时是 unknown，且明确标记', () => {
  const d = explainSituation('你好');
  assert.equal(d.situation, SITUATIONS.unknown);
  assert.equal(d.unknown, true);
  assert.deepEqual(d.hits, []);
});

test('判定可解释：命中的信号名与落选的都能查', () => {
  const d = explainSituation('改了没效果，反复都不行');
  assert.ok(d.hits.includes('no-effect'), `应命中 no-effect，实际 ${JSON.stringify(d.hits)}`);
  // 命中与落选是**互补**的两组：命中的进 hits，落选的进 misses。
  // 注意"改"会同时命中 do-it，所以 do-it 也在 hits 里 —— 这不是 bug，
  // 是"多个信号同时命中"的事实，只是 no-effect 权重更高所以赢了判定。
  assert.ok(d.hits.includes('do-it'), '多个信号可同时命中（"改"命中 do-it）');
  assert.ok(d.misses.includes('need-external'), '未命中的信号进 misses');
  assert.ok(d.misses.includes('need-prior'), '未命中的信号进 misses');
  // 两组不重叠，且并起来等于全部信号
  const all = listSignals().map((s) => s.name);
  assert.equal(d.hits.length + d.misses.length, all.length, '命中+落选 = 全部信号');
  assert.equal(d.evidence['no-effect'] >= 1, true, '要有证据计数');
});

test('外部单元可以登记自己的信号（零配合：调度层不必改代码）', () => {
  __clearSignalsForTest();
  const before = listSignals().length;
  const dispose = registerSignal({
    name: 'clis-causal',
    situation: SITUATIONS.diagnose,
    owner: 'dsh-clis',
    weight: 5,
    words: ['环状', '反馈回路'],
  });
  assert.equal(listSignals().length, before + 1, '外部信号应出现在列表里');

  const d = explainSituation('这是个环状结构');
  assert.equal(d.situation, SITUATIONS.diagnose);
  assert.ok(d.hits.includes('clis-causal'));

  dispose();
  assert.equal(listSignals().length, before, '注销后应回到原状');
  __clearSignalsForTest();
});

test('权重决定谁赢：外部高权重信号压过内置', () => {
  __clearSignalsForTest();
  registerSignal({
    name: 'heavy',
    situation: SITUATIONS.retrieve,
    weight: 10,
    words: ['装'],
  });
  const d = explainSituation('装一下');
  assert.equal(d.situation, SITUATIONS.retrieve, '高权重信号应胜出');
  __clearSignalsForTest();
});

test('反例词让信号能自己否定自己', () => {
  __clearSignalsForTest();
  registerSignal({
    name: 'with-counter',
    situation: SITUATIONS.diagnose,
    weight: 9,
    words: ['反复'],
    counterWords: ['测试反复失败'],
  });
  // 反例命中 → 该信号作废
  const d = explainSituation('这个测试反复失败');
  assert.ok(!d.hits.includes('with-counter'), '反例命中时信号应作废');
  __clearSignalsForTest();
});

test('登记不合法的信号直接拒绝（不是静默忽略）', () => {
  assert.throws(() => registerSignal({ name: '', words: ['x'] }), /名字/);
  assert.throws(() => registerSignal({ name: 'ok', words: [] }), /至少要有一个触发词/);
});

test('同名信号覆盖（与 CLIS 的 ProbeRegistry 同一语义）', () => {
  __clearSignalsForTest();
  registerSignal({ name: 'dup', situation: SITUATIONS.diagnose, words: ['甲'] });
  registerSignal({ name: 'dup', situation: SITUATIONS.recall, words: ['甲'] });
  const d = explainSituation('甲');
  assert.equal(d.situation, SITUATIONS.recall, '后注册的应覆盖');
  __clearSignalsForTest();
});

test('判定可记账：写进去能读回来', () => {
  const d = explainSituation('改了没效果');
  recordDecision(d);
  const back = lastDecisionOf();
  assert.equal(back.situation, d.situation);
  assert.deepEqual(back.hits, d.hits);
});
