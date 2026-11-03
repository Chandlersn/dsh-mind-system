/**
 * 固定历史样本的信号覆盖回归。样本无标准标签，也无法证明独立留出；
 * 这些断言不衡量分类准确率、泛化能力或任务完成质量。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hitRate, hitRateLine, extractUserQuotes } from '../src/hitrate.js';

/** A 批：真实用户原话（每日记录摘出，措辞偏具体任务）。 */
const BATCH_A = [
  '把之前记录的先应用一遍',
  '侧边栏哪些数据没显示的加上',
  '记忆管理的数据流走向符合我们的工作设定吗？现在思想累计 26 条了，感觉有点问题',
  '思想层到底留什么、什么升到更高层',
  '那按照最新的功能和要求执行，思想层里到底留下些什么，又有哪些去到更高的层级呢？',
  '索引显示面板有重复。刚刚更新了机制，你运用它治理记忆管理的数据，看看有何变化',
  '仔细审查记忆管理',
];

/** B 批：本会话真实输入（抽象指令，当前真实分布）。 */
const BATCH_B = [
  '你来评估插件，给个评价',
  '那你对齐，如何利用已有的插件和工具编排，对插件进行自我迭代升级',
  '重点要检验是否符合层级的定义和约束条件、边界',
  'mind（调度），固化为代码机制。检查所有单元的调用接口是否畅通',
  '心智系统成型了吗？请客观审查',
  '依次完善',
  '那如果依照我的这个猜想和构建的公式，你怎么来设计这个心智系统？',
  'clis和元框架也纳入进去一起展现',
  '执行流程图重绘',
  '不要体现修改了什么。直接呈现最终正确的结果架构',
];

/**
 * C 批：固定覆盖样本。
 *
 * 措辞与 A/B 批不同，但它是公开的固定样本，不能证明泛化能力。
 */
const BATCH_C = [
  '这份设计有没有逻辑漏洞',
  '帮我评估下当前进度',
  '把最近的变更汇总一下',
  '这个方案该怎么落地',
  '现有的约束是什么',
  '查一下官方文档怎么说',
  '以前踩过的坑还有哪些',
  '删掉那个废弃的模块',
  '缓一缓，我想先看看数据',
  '重做一版流程图',
];

const asSamples = (list) => list.map((text) => ({ text, expect: '', source: 'batch' }));
const THRESHOLD = 0.6;

test('A 批（历史原话）信号覆盖率 ≥ 50%', () => {
  const r = hitRate(asSamples(BATCH_A));
  assert.ok(r.coverageRate >= 0.5, `${hitRateLine(r)}（A 批是真实但偏具体任务）`);
});

test('B 批（会话输入）信号覆盖率 ≥ 50%', () => {
  const r = hitRate(asSamples(BATCH_B));
  assert.ok(r.coverageRate >= 0.5, hitRateLine(r));
});

test('C 批样本信号覆盖率 ≥ 60%（不衡量分类正确率）', () => {
  const r = hitRate(asSamples(BATCH_C));
  assert.ok(r.coverageRate >= THRESHOLD, hitRateLine(r));
});

test('命中率统计口径：无信号与判错分开计', () => {
  const r = hitRate(asSamples(['完全没有任何触发词的句子']));
  assert.equal(r.total, 1);
  assert.equal(r.hit, 0);
  assert.equal(r.unknown, 1);
  assert.equal(r.unknownRate, 1);
  assert.equal(r.missed, 0, '无信号不算"判错"，它是另一类失败');
});

test('无样本时不得报健康（基准缺失本身就是信息）', () => {
  const r = hitRate([]);
  assert.equal(r.rate, null);
  assert.match(hitRateLine(r), /无真实样本/);
});

test('从每日记录抽用户原话：抽到真实输入，且不抽我们自己的引号', () => {
  const daily = [
    '- **用户原话**：「帮我查一下记忆管理的数据流走向，符合我们的工作设定吗？」',
    '- 用户原话：「侧边栏哪些数据没显示的加上」',
    '- 用户追问「那按照最新的功能和要求执行，思想层里到底留下些什么？」',
    // 这一行是我们**引用自己的判据**，不是用户输入 —— 绝不能收
    '- 核心原则是「绿灯不携带信息」，它要求自产信号不能给自己背书。',
  ].join('\n');
  const samples = extractUserQuotes(daily);
  assert.equal(samples.length, 3, `应抽到 3 条用户输入，实际 ${samples.length}`);
  assert.ok(samples.every((s) => !s.text.includes('绿灯不携带信息')), '不得把我们自己的引号当用户输入');
});
