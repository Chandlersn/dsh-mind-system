/**
 * 隔离合成索引的人工标注基准：只测索引排序通道，不读取或修改真实记忆。
 *
 * 运行：node --test tests/recall-relevance.test.js
 *
 * 标签是本夹具上的人工相关性判断，不代表生产流量的真实分布。低证据和
 * 索引未覆盖的请求标为空集，表示在本基准中期望弃权；这不是算法现有承诺。
 * 每个请求比较完整 injected 集合，而不是只看第一名。质量数字作为基线
 * 通过 diagnostic 报告，不以当前分数作硬编码断言，以免改进反而使测试失败。
 * 结果不包含独立的档案、纠正提示和负向规则通道，也不代表模型实际使用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eligibleIndexRows, matchIndexRows, tokensOf } from '../src/recall.js';

// 全部名称与摘要为合成示例；彼此刻意共享“管理”“插件”“守卫”等通用词。
const documents = [
  ['memory-manager', '记忆插件：层级索引、召回、写入来源保护和账本审计。'],
  ['purrge与系统管理', '空间管家：文件归属、跨卷聚合、磁盘清理与存储管理。'],
  ['批印坊工程加固', 'Excel 闸门、原型槽防护、目录互斥与口径守卫。'],
  ['浏览器自动化', '浏览器会话、页面定位、点击和前端调试。'],
  ['dsh视频工坊', '生视频插件：视频素材、镜头生成、逐帧渲染与编码。'],
  ['模型闸门漏判账本', '模型闸门指标：漏判分母、越权记录和判定统计。'],
  ['学习模式插件', '学习计划、课程进度和复习提示。'],
  ['网络诊断', '网络请求超时、代理连接和域名解析。'],
  ['图片处理', '照片裁剪、图像缩放和色彩校正。'],
  ['数据库备份', '数据库快照、备份恢复和存储容量。'],
  ['部署系统', '插件发布、构建产物和服务重载。'],
  ['邮件通知', '邮件模板、发送队列和投递状态。'],
].map(([slug, summary]) => ({ slug, summary, href: `functions/${slug}.md` }));
const index = `## 功能模块索引\n\n| 功能域 | 一行摘要 |\n|---|---|\n${documents.map(({ slug, summary, href }) => `| [${slug}](${href}) | ${summary} |`).join('\n')}\n`;

// 预期集合只含索引中能支持当前问题的领域。不同领域或完全空集合均是
// 显式标注；“低证据”是策略期望，不是现实世界中证明完全无关。
const cases = [
  { id: 'mem-name', group: 'memory-manager', query: 'memory-manager 召回索引', expected: ['memory-manager'] },
  { id: 'mem-zh', group: 'memory-manager', query: '记忆管理插件 写入守卫', expected: ['memory-manager'] },
  { id: 'mem-audit', group: 'memory-manager', query: '记忆插件 写入来源保护 账本审计', expected: ['memory-manager'] },
  { id: 'space-brand', group: '空间管家', query: '空间管家 跨卷聚合', expected: ['purrge与系统管理'] },
  { id: 'space-file', group: '空间管家', query: 'purrge 文件归属 磁盘清理', expected: ['purrge与系统管理'] },
  { id: 'space-volume', group: '空间管家', query: '空间管家 存储管理', expected: ['purrge与系统管理'] },
  { id: 'excel-name', group: 'Excel', query: '批印坊工程加固 Excel 原型槽', expected: ['批印坊工程加固'] },
  { id: 'excel-gate', group: 'Excel', query: 'Excel 闸门 目录互斥', expected: ['批印坊工程加固'] },
  { id: 'excel-protection', group: 'Excel', query: 'Excel 原型槽防护 口径守卫', expected: ['批印坊工程加固'] },
  { id: 'browser-name', group: '浏览器', query: '浏览器自动化 页面定位', expected: ['浏览器自动化'] },
  { id: 'browser-session', group: '浏览器', query: '浏览器会话 点击 前端调试', expected: ['浏览器自动化'] },
  { id: 'browser-ui', group: '浏览器', query: '浏览器页面调试', expected: ['浏览器自动化'] },
  { id: 'video-name', group: '视频', query: 'dsh视频工坊 生视频插件', expected: ['dsh视频工坊'] },
  { id: 'video-frame', group: '视频', query: '视频工坊 逐帧渲染 编码', expected: ['dsh视频工坊'] },
  { id: 'video-shot', group: '视频', query: '视频素材 镜头生成', expected: ['dsh视频工坊'] },
  { id: 'cross-mem-excel', group: '多领域', query: 'memory-manager 召回索引和批印坊工程加固 Excel 原型槽', expected: ['memory-manager', '批印坊工程加固'] },
  { id: 'cross-browser-video', group: '多领域', query: '浏览器自动化 页面定位以及 dsh视频工坊 生视频插件', expected: ['浏览器自动化', 'dsh视频工坊'] },
  { id: 'cross-space-mem', group: '多领域', query: '空间管家跨卷聚合与 memory-manager 记忆召回', expected: ['purrge与系统管理', 'memory-manager'] },
  { id: 'unrelated-science', group: '无关', query: '量子纠缠拓扑绝缘体', expected: [] },
  { id: 'unrelated-random', group: '无关', query: 'zzzzqv194327', expected: [] },
  { id: 'unrelated-garden', group: '无关', query: '阳台种植番茄', expected: [] },
  { id: 'weak-guard', group: '低证据', query: '写入守卫', expected: [] },
  { id: 'weak-generic', group: '低证据', query: '管理插件', expected: [] },
  { id: 'weak-browser-guard', group: '低证据', query: '浏览器 写入守卫', expected: [] },
  { id: 'uncovered-excel-email', group: '低证据', query: 'Excel 邮件投递接口', expected: [] },
];

function evaluate(corpus, usage) {
  return corpus.map((entry) => {
    const rows = matchIndexRows(index, tokensOf(entry.query), 3, usage);
    const actual = rows.map((row) => row.name).sort();
    const expected = [...entry.expected].sort();
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    return {
      id: entry.id, group: entry.group, query: entry.query, expected, actual,
      falsePositive: actual.filter((name) => !expectedSet.has(name)),
      falseNegative: expected.filter((name) => !actualSet.has(name)),
    };
  });
}

function summarize(results) {
  const tp = results.reduce((n, r) => n + r.expected.length - r.falseNegative.length, 0);
  const fp = results.reduce((n, r) => n + r.falsePositive.length, 0);
  const fn = results.reduce((n, r) => n + r.falseNegative.length, 0);
  const negatives = results.filter((r) => r.expected.length === 0);
  return {
    cases: results.length,
    exactSets: results.filter((r) => r.falsePositive.length === 0 && r.falseNegative.length === 0).length,
    truePositiveRows: tp, falsePositiveRows: fp, falseNegativeRows: fn,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    negativeQueries: negatives.length,
    negativeQueriesWithInjection: negatives.filter((r) => r.actual.length > 0).length,
  };
}

test('隔离多领域标注基准：报告注入全集、误召与漏召', (t) => {
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, '样本 id 必须唯一');
  assert.deepEqual(eligibleIndexRows(index).map((r) => r.name).sort(), documents.map((d) => d.slug).sort(), '所有合成索引行均被真实准入解析');
  const names = new Set(documents.map((d) => d.slug));
  for (const c of cases) {
    assert.equal(new Set(c.expected).size, c.expected.length, `${c.id}: 标签不可重复`);
    assert.ok(c.expected.every((name) => names.has(name)), `${c.id}: 标签必须引用夹具内领域`);
  }
  const results = evaluate(cases, undefined); // 无 usage 热度；不读取真实记忆或统计。
  const summary = summarize(results);
  assert.equal(summary.truePositiveRows + summary.falseNegativeRows, cases.reduce((n, c) => n + c.expected.length, 0));
  assert.equal(summary.truePositiveRows + summary.falsePositiveRows, results.reduce((n, r) => n + r.actual.length, 0));
  t.diagnostic(`BASELINE no-usage ${JSON.stringify(summary)}`);
  for (const group of [...new Set(cases.map((c) => c.group))]) {
    t.diagnostic(`GROUP ${group} ${JSON.stringify(summarize(results.filter((r) => r.group === group)))}`);
  }
  for (const r of results) t.diagnostic(`CASE ${JSON.stringify(r)}`);
});

test('合成热度对照：同一标签测注入全集与双侧错误', (t) => {
  // Purely synthetic engagement: this does not read the actual usage ledger.
  const usage = new Map([
    ['functions/purrge与系统管理.md', { uses: 20, positives: 2, badRate: 0 }],
    ['functions/批印坊工程加固.md', { uses: 10, positives: 1, badRate: 0 }],
    ['functions/memory-manager.md', { uses: 1, positives: 0, badRate: 0 }],
  ]);
  const baseline = evaluate(cases, undefined);
  const results = evaluate(cases, usage);
  const changed = results.filter((r, i) => JSON.stringify(r.actual) !== JSON.stringify(baseline[i].actual)).map((r) => r.id);
  t.diagnostic(`BASELINE synthetic-usage ${JSON.stringify({ ...summarize(results), changedFromNoUsage: changed })}`);
  for (const r of results) t.diagnostic(`HEATED CASE ${JSON.stringify(r)}`);
  assert.equal(results.length, cases.length);
  assert.ok(results.every((r) => new Set(r.actual).size === r.actual.length), '不得重复注入相同行');
});
