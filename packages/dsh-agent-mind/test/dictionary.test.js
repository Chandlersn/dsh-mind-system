/**
 * 信号词典回归测试（2026-11-10）。
 *
 * 每一条断言都对应**一次真实漏判**：用户说了什么 → 旧版判成什么 → 现在该判成什么。
 * 词表没有测试就会腐烂成"谁都不敢动的祖传常量"，所以这里既钉住新词，
 * 也钉住**反例**（同一个词在别的语境里不该触发）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainSituation, registerSignal, listSignals } from '../src/dispatch.js';

/** 判定结果的主处境（无信号时为 'unknown'）。 */
const site = (t) => explainSituation(t).situation;

// ——————————————————————————————————————————————
// 元问题族：问"系统自己做得怎么样" → 先查账本，不能凭印象
// ——————————————————————————————————————————————

test('meta-self：元问题（问系统自身效果）命中 diagnose，不再 no-signal', () => {
  // 真实漏判：这句话 13 条信号全未命中。
  const d = explainSituation('你知道什么时候调用心智插件吗？实测效果咋样？');
  assert.equal(d.situation, 'diagnose');
  assert.ok(d.hits.includes('meta-self'), 'meta-self 应命中');
});

test('meta-self：账本/命中率一类词也命中（答这类问题只能来自账本）', () => {
  for (const t of ['实测效果怎么样', '漏判率是多少', '信号词典怎么维护', '判据校准了没']) {
    assert.ok(explainSituation(t).hits.includes('meta-self'), `「${t}」应命中 meta-self`);
  }
});

// ——————————————————————————————————————————————
// 视觉缺陷族：用户描述看到的问题 → 先看实镜（截图/DOM），不是猜设计
// ——————————————————————————————————————————————

test('visual-defect：用户描述界面缺陷时命中 diagnose', () => {
  // 真实漏判两例。
  assert.equal(site('按钮文本有被遮挡'), 'diagnose');
  assert.equal(site('页面都不同，混合重叠显示了'), 'diagnose');
  assert.ok(explainSituation('卡片被裁掉了').hits.includes('visual-defect'));
});

test('visual-defect 反例：术语语境里的「重叠」不触发', () => {
  // 「越界」不加是硬教训：它让「把越界判断修好」从 execute 变 diagnose。
  assert.ok(!explainSituation('检查区间重叠的部分').hits.includes('visual-defect'),
    '「区间重叠」是算法术语，不该判成界面缺陷');
  assert.ok(!explainSituation('把越界判断修好').hits.includes('visual-defect'),
    '「越界判断」是业务含义，绝不能再把 execute 判成 diagnose');
});

// ——————————————————————————————————————————————
// 报错族：最直白的问题陈述，此前全 unknown
// ——————————————————————————————————————————————

test('something-wrong：写错了/不对/报错 一类命中 diagnose', () => {
  for (const t of ['这段代码写错了', '这个逻辑不对', '判断写错了', '接口报错了', '服务挂了']) {
    assert.equal(site(t), 'diagnose', `「${t}」应判 diagnose`);
  }
});

test('something-wrong 反例：条件句里的「不对」不触发', () => {
  // 「如果不对就修正」是完整指令，动作是修正，不是报问题。
  assert.equal(site('如果不对就修正它'), 'execute', '条件语境应让位给动手');
});

// ——————————————————————————————————————————————
// UI 动作词补进执行族
// ——————————————————————————————————————————————

test('intent-improve：定位/高亮/筛选 一类 UI 动作算执行意图', () => {
  // 真实漏判：「要自动完成工作区的筛选和卡片定位高亮显示」此前判 unknown。
  assert.equal(site('要自动完成工作区的筛选和卡片定位高亮显示'), 'execute');
});

// ——————————————————————————————————————————————
// 词典可积累：registerSignal 支持 source（每条词有出处）
// ——————————————————————————————————————————————

test('registerSignal 保留 source，listSignals 能回查每个信号的出处', () => {
  const off = registerSignal({
    name: 'dict-probe', situation: 'diagnose', weight: 2,
    words: ['词典探针'], source: '2026-11-10 测试：验证 source 字段可登记可回查',
  });
  try {
    const got = listSignals().find((s) => s.name === 'dict-probe');
    assert.ok(got, '应出现在信号列表里');
    assert.equal(got.source, '2026-11-10 测试：验证 source 字段可登记可回查');
    assert.equal(site('词典探针'), 'diagnose', '注册后即可命中');
  } finally {
    off();
  }
  assert.equal(site('词典探针'), 'unknown', '注销后不再命中');
});

test('内置的新三族都带 source（词从哪来可回查，删改有据）', () => {
  const builtin = listSignals().filter((s) => ['meta-self', 'visual-defect', 'something-wrong'].includes(s.name));
  assert.equal(builtin.length, 3, '三族都应在表里');
  for (const s of builtin) {
    assert.ok(typeof s.source === 'string' && s.source.length > 10, `${s.name} 必须有可回查的出处`);
  }
});
