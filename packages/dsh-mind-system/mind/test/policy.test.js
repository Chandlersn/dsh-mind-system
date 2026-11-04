/**
 * 行为策略测试（2026-11-03）。
 *
 * ## 这个文件守什么
 *
 * 上一轮（`review-fixes.test.js` / `regressions.test.js`）守的是"机制在不在"。
 * 这一轮守的是**判断对不对**，以及**判断与引导有没有被混为一谈**。
 *
 * 任务书点名的七类，逐类一条：
 *
 * 1. 正常触发和不应触发
 * 2. 否定、歧义及多意图输入
 * 3. 用户消息与插件注入消息的区分
 * 4. 多 agent 状态隔离
 * 5. 策略冲突及用户明确指令优先
 * 6. 诊断信息与实际决策一致
 * 7. 真实 DSH 集成点上的调用与生效（在 integration.test.js，用真宿主）
 *
 * ## 这些用例怎么来的
 *
 * 不是"想到什么写什么"：先跑 `reports/mind-policy-20261103/notes/probe-current.mjs`
 * 拿 18 条语料把旧实现打红 3 条（否定审查 / 否定整理 / 引用文本），
 * 再按**打红的那三类**写成断言。也就是说每条失败的用例都对应一个
 * 真实发生过的误判，而不是假想的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  explainSituation,
  normalizeForMatching,
  DECISION_REASONS,
  registerSignal,
  __clearSignalsForTest,
  listVetoes,
} from '../src/dispatch.js';
import { SITUATIONS, isFamilyTool, familyOf, arrangeTools } from '../src/orchestrate.js';
import { createSituationStore } from '../src/situation.js';

/** 判到处境代号（unknown 归一成字符串，便于断言）。 */
const site = (text) => {
  const d = explainSituation(text);
  return d.unknown ? 'unknown' : d.situation;
};

// ───────────────────────── 1. 正常触发 / 不应触发 ─────────────────────────

test('四种处境在典型表述上都能判出', () => {
  assert.equal(site('改了三次都没效果，指标还来回震荡'), SITUATIONS.diagnose);
  assert.equal(site('把 config.json 里的 port 改成 8080'), SITUATIONS.execute);
  assert.equal(site('上次说过的那个约定还记得吗'), SITUATIONS.recall);
  assert.equal(site('搜一下最新的 Node 22 稳定版'), SITUATIONS.retrieve);
});

test('不应触发：短输入、闲聊、纯格式转换都保持 unknown', () => {
  for (const text of ['嗯', '你好，今天天气不错', '把这段文本转成大写']) {
    assert.equal(site(text), 'unknown', `「${text}」不该触发任何处境`);
  }
});

test('动手类说法不该漏判：「统一/替换/重命名/迁移/清理」都是执行意图', () => {
  // 实测打红：「把三个文件里的 import 路径都统一一下」判成 unknown ——
  // 旧词表里没有任何一个"改"的说法覆盖"统一"。
  for (const text of [
    '把这三个文件里的 import 路径都统一一下',
    '把这个变量的名字替换掉',
    '把目录结构迁移到新位置',
    '清理掉不再使用的依赖',
  ]) {
    assert.equal(site(text), SITUATIONS.execute, `「${text}」应判 execute`);
  }
  // 这些词同样必须能被否定 —— 否则「不要统一」会照样触发执行。
  assert.equal(site('不要统一，保持原样'), 'unknown');
});

test('判不出时区分"输入没内容"与"词表没覆盖"', () => {
  // 这两个在旧实现里都是 unknown:true，于是"该扩词表"与"这条本来就没法判"
  // 在观察上同形。归因错了，就会拿不该扩词表的样本去扩词表。
  assert.equal(explainSituation('嗯').reason, DECISION_REASONS.nothingActionable);
  assert.equal(explainSituation('把这段文本转成大写').reason, DECISION_REASONS.noSignal);
  // 空输入恒为 nothing-actionable
  assert.equal(explainSituation('').reason, DECISION_REASONS.nothingActionable);
});

// ─────────────────────── 2. 否定 / 歧义 / 多意图 ───────────────────────

test('否定表达：否定词要管到意图族，而不只是 do-it 族', () => {
  // 旧实现的 actionText 只剥 do-it 的词，于是：
  // 「不用审查」→ intent-review 照样命中 → diagnose（错）
  assert.equal(site('不用审查，直接跑测试就行'), SITUATIONS.execute);
  // 「不要整理，也不要汇总」→ intent-produce 照样命中 → execute（错）
  assert.equal(site('不要整理，也不要汇总，直接把原始日志贴出来'), 'unknown');
});

test('否定表达：否定只作用于动作，不得吞掉症状词', () => {
  // 「没有效果」里的"没有"是症状词的一部分。若把它当否定词去剥"效果"，
  // 一条最硬的诊断信号会被自己消掉 —— 这条就是防那个回归。
  const d = explainSituation('改了没有效果');
  assert.equal(d.unknown ? 'unknown' : d.situation, SITUATIONS.diagnose);
  assert.ok(d.hits.includes('no-effect'), `"没有效果"必须保留 no-effect，实际 ${JSON.stringify(d.hits)}`);
});

test('否定表达：一个句子里"否定 A + 肯定 B"要保住 B', () => {
  // 跨句否定不该管到下一句；同一句里否定的辖域到标点为止。
  assert.equal(site('不要修改旧文件，但请修复新的错误'), SITUATIONS.execute);
  assert.equal(site('不要修改任何文件，只读取'), 'unknown');
});

test('引用语境：引号/代码里的文字是"提及"，不是"指令"', () => {
  // 旧实现：注释里写着"修复登录超时" → do-it 命中"修复" → execute（错）
  assert.equal(site('这个函数的注释写着"修复登录超时"，请解释它的作用'), 'unknown');
  const n = normalizeForMatching('注释写着"修复登录超时"');
  assert.equal(n.counts.quoted, 1, '要报告剥掉了几处引用（只报数字，不报原文）');
  assert.ok(!n.text.includes('修复'), '引用内的文字应已从可匹配文本里移除');
});

test('引用语境：中文引号与代码围栏同样处理', () => {
  assert.equal(normalizeForMatching('文档说「请修复这个问题」').counts.quoted, 1);
  assert.equal(normalizeForMatching('代码 `git push --force` 很危险').counts.quoted, 1);
  assert.equal(normalizeForMatching('```js\n修复();\n```').counts.quoted, 1);
});

test('条件表达：「如果…的话」是假设，不是请求', () => {
  assert.equal(normalizeForMatching('如果失败的话，再看日志').counts.conditional, 1);
  // 不带"的话"的条件句不剥 —— 那里的请求恰恰在从句里，剥掉就把事弄丢了
  assert.equal(normalizeForMatching('如果要改就改这里').counts.conditional, 0);
  // 这是**刻意**取舍，不是漏网。上面那条断言就是它的守卫：
  // 若有人把中文正则放宽成「如果…，」这里会变红，提醒他先想清楚
  // 「如果要改就改这里」这类句子里的请求该不该留。
  assert.equal(normalizeForMatching('如果以后要支持暗色模式，我们可以顺便重构一下配色系统').counts.conditional, 0);
});

test('条件表达：英文假设语气词是标记，剥标记而不剥整句（2026-11-03）', () => {
  // 跨语言差异：中文的假设标记在句尾（…的话），英文在句首（maybe / what if）。
  // 英文剥掉语气词即可，剩下的「our app should…」本就是纯偏好陈述。
  const n = normalizeForMatching('maybe our app should show unread counts like theirs');
  assert.equal(n.counts.conditional, 1, 'maybe 应被记为假设标记');
  assert.ok(!n.text.toLowerCase().includes('maybe'), '语气词本身应从可匹配文本移除');
  assert.ok(n.text.includes('unread counts'), '只剥标记，不剥整句 —— 内容要留给判断');
});

test('条件表达：英文假设族覆盖多种说法，且不误伤普通词', () => {
  const marks = [
    'perhaps we could add a toggle',
    'what if we renamed this column',
    'I wonder if the sidebar should collapse',
    'if we ever support dark mode, we could refactor',
    "wouldn't it be nice if the table were sortable",
  ];
  for (const text of marks) {
    assert.equal(normalizeForMatching(text).counts.conditional, 1, `应识别为假设：${text}`);
  }
  // 反例：这些含 may/if 但**不是**假设标记，不能被剥
  const notMarks = [
    'may I ask why this failed',
    'we may need to bump the version',
    'if the build fails, fix it',
    'maybe@example.com is the contact',
  ];
  for (const text of notMarks) {
    assert.equal(normalizeForMatching(text).counts.conditional, 0, `不该误判为假设：${text}`);
  }
});

test('多意图：两类同时命中时 intents 里有两条，而不是被压成一个代号', () => {
  const d = explainSituation('先查一下我们以前怎么处理这个的，然后修改代码');
  assert.ok(d.intents.length >= 2, `多意图应可见，实际 ${JSON.stringify(d.intents)}`);
  const situations = d.intents.map((i) => i.situation);
  assert.ok(situations.includes(SITUATIONS.recall), 'recall 应在 intents 里');
  assert.ok(situations.includes(SITUATIONS.execute), 'execute 应在 intents 里');
});

test('「先查再做」：有明确动手要求时主处境是 execute，不是 recall', () => {
  // 实测缺陷：`need-prior`（权重 2）压过 `do-it`（权重 1），于是
  // 「按那个约定来，把越界判断修好」被判成 recall —— 记忆工具推到最前、
  // 动手工具排后，而用户要的结果是**改完**。
  // recall 是前置步骤，不是这一轮要做的事。
  const d = explainSituation('按那个约定来，把 src/limit.js 里的越界判断修好');
  assert.equal(d.situation, SITUATIONS.execute, '主处境应为 execute');
  assert.equal(d.override, 'recall-precedes-execute', '要标明这是"先查再做"的处置');
  // 但记忆信号**不能被丢掉** —— 它仍在 hits 里，诊断看得见
  assert.ok(d.hits.includes('need-prior'), '记忆信号仍应留在 hits 里（只是不作为主处境）');
  assert.ok(d.intents.some((i) => i.situation === SITUATIONS.recall), 'intents 里应保留 recall');
});

test('「先查再做」的边界：单纯问旧约定仍是 recall（不得被 execute 吞掉）', () => {
  for (const text of ['以前我们怎么约定的？', '上次说过的那个约定还记得吗', '我们以前踩过这个坑吧']) {
    assert.equal(site(text), SITUATIONS.recall, `「${text}」应仍是 recall`);
  }
});

test('动补结构（修好/改好/搞定）算执行意图，且不误伤引用与否定', () => {
  // 词表缺口实测：「把越界判断修好」判成 unknown（旧词表只有"修复/修一下"）。
  // 用"修好"而不是单字"修"，是为了不误伤"修复登录超时"这种名词化引用。
  assert.equal(site('把越界判断修好'), SITUATIONS.execute);
  assert.equal(site('把这个函数改好'), SITUATIONS.execute);
  assert.equal(site('把这件事搞定'), SITUATIONS.execute);
  // 引用语境仍然要剥掉
  assert.equal(site('这个函数的注释写着"修复登录超时"，请解释它的作用'), 'unknown');
  // 否定仍然要覆盖这些新词
  assert.equal(site('不要修好它'), 'unknown');
});

test('软意图让位给明确动作（真实使用里 95% 的 diagnose 来自软意图）', () => {
  // 真实采样实测：diagnose 占 70%，其中 432/456 只靠 intent-review/question 判定。
  // 「检查/核对/评估/是否」在中文里常是"顺便看一眼再动手"的前缀动作。
  const d = explainSituation('检查并修复 login.js 的超时问题');
  assert.equal(d.situation, SITUATIONS.execute, '有明确动作时不该判 diagnose');
  assert.equal(d.override, 'soft-intent-yields-to-action');

  for (const text of [
    '核对一下这两个数字，不对就修正',
    '评估这个方案，然后按它实现',
    '是否可以把端口改成 8080',
    '审查这段代码，发现问题就修复',
    '看看有没有语法错误，有就改掉',
  ]) {
    assert.equal(site(text), SITUATIONS.execute, `「${text}」应判 execute`);
  }
});

test('软意图的边界：硬症状与纯只读审阅仍判 diagnose', () => {
  // 硬症状是**事实陈述**（我试过了，没用）→ 要的确实是先诊断
  assert.equal(site('改了三次都没效果，检查一下'), SITUATIONS.diagnose);
  assert.equal(site('这个指标反复震荡，帮我评估'), SITUATIONS.diagnose);
  // 纯只读，没有任何动作要求 → 仍是先看
  assert.equal(site('检查一下这个插件有没有隐患'), SITUATIONS.diagnose);
  assert.equal(site('评估一下这个方案是否可行'), SITUATIONS.diagnose);
  assert.equal(site('检查一下这个函数的返回值'), SITUATIONS.diagnose);
});

test('判断式否定（「不对就修正」）不得吞掉后面的动作词', () => {
  // 实测缺陷：「核对一下这两个数字，不对就修正」里，单字"不"把辖域伸到"修正"，
  // 归一化后整句后半段被清空 → 判成 diagnose。而"不对"是条件前件，
  // 意思恰恰是"错了就改"。
  const n = normalizeForMatching('核对一下这两个数字，不对就修正');
  assert.equal(n.counts.negated, 0, '"不对"是判断式否定，不该算作否定辖域');
  assert.ok(n.text.includes('修正'), '后面的动作词必须保住');
  assert.equal(site('核对一下这两个数字，不对就修正'), SITUATIONS.execute);

  // 但真正的否定不能被豁免掉
  assert.equal(site('不要修改任何文件'), 'unknown');
  assert.equal(site('不改代码，只回答'), 'unknown');
  assert.equal(site('不要修好它'), 'unknown');
});

test('歧义：两类势均力敌时标 ambiguous，且上层因此不重排', () => {
  __clearSignalsForTest();
  try {
    // 构造一个真正势均力敌的输入：两类各命中一条同权重信号。
    registerSignal({ name: 'tie-a', situation: SITUATIONS.retrieve, weight: 2, words: ['甲'] });
    registerSignal({ name: 'tie-b', situation: SITUATIONS.recall, weight: 2, words: ['乙'] });
    const d = explainSituation('甲乙');
    assert.equal(d.ambiguous, true, `势均力敌应标 ambiguous，intents=${JSON.stringify(d.intents)}`);
    assert.equal(d.reason, DECISION_REASONS.ambiguous);
  } finally {
    __clearSignalsForTest();
  }
});

test('歧义不等于判不出：situation 仍报出来，克制只发生在引导层', () => {
  __clearSignalsForTest();
  try {
    registerSignal({ name: 'tie-a', situation: SITUATIONS.retrieve, weight: 2, words: ['甲'] });
    registerSignal({ name: 'tie-b', situation: SITUATIONS.recall, weight: 2, words: ['乙'] });
    const store = createSituationStore();
    const agent = { id: 'ambiguous-agent' };
    const d = store.judge('甲乙', agent);
    assert.equal(d.ambiguous, true);
    assert.equal(d.unknown, false, 'ambiguous 不是 unknown —— 判断照常作出');
    assert.equal(
      store.currentSituationOf(agent),
      SITUATIONS.unknown,
      '克制闸门：ambiguous 时处境置 unknown，工具面不动',
    );
  } finally {
    __clearSignalsForTest();
  }
});

// ──────────────── 3. 用户明确指令优先（否决权） ────────────────

test('用户明确排除某类分析时，该类信号整类作废', () => {
  // 「别做因果分析」—— 用户刚禁止了这件事，插件不能因为"因果"这个词
  // 反而把 clis 工具推到最前。词表覆盖越好，这种冲突越容易出现。
  const d = explainSituation('别做因果分析，就把这份 CSV 求和');
  assert.equal(d.unknown ? 'unknown' : d.situation, 'unknown');
  assert.ok(d.vetoed.includes(SITUATIONS.diagnose), `应记 vetoed，实际 ${JSON.stringify(d.vetoed)}`);
});

test('用户明确禁止动手时，execute 被否决，但判断类信号仍然有效', () => {
  // 「别动代码」只排斥"动手"，不排斥"判断"。
  const d = explainSituation('直接判一下这是不是反馈回路，别动代码');
  assert.ok(d.vetoed.includes(SITUATIONS.execute), 'execute 应被否决');
  assert.equal(d.unknown ? 'unknown' : d.situation, SITUATIONS.diagnose, '判断类处境不受影响');
});

test('否决清单可查（诊断要能说清"为什么这一类没生效"）', () => {
  const vetoes = listVetoes();
  assert.ok(vetoes.length > 0);
  assert.ok(vetoes.some((v) => v.situation === SITUATIONS.diagnose));
  // 只报处境名与规则条数，不报用户原话
  assert.deepEqual(Object.keys(vetoes[0]).sort(), ['count', 'situation']);
});

// ───────────────── 4. 三级诊断：判断 / 提供 / 照做 ─────────────────

test('三级分开记账：判出了不等于提供了，也不等于照做了', () => {
  const store = createSituationStore();
  const agent = { id: 'three-levels' };

  // 第一级：判出
  store.judge('帮我审查一下这个插件', agent);
  assert.equal(store.currentSituationOf(agent), SITUATIONS.diagnose);
  assert.equal(store.guidanceOf(agent), null, '判出但还没重排 → 不得说"已提供引导"');
  assert.equal(store.outcomeOf(agent).matched, null, '没观察 → 不得说"没照做"');

  // 第二级：提供（只有真的重排了才记）
  store.recordGuidance(agent, { situation: SITUATIONS.diagnose, tools: 25, at: 1 });
  assert.equal(store.guidanceOf(agent).situation, SITUATIONS.diagnose);
  assert.equal(store.outcomeOf(agent).matched, null, '提供了也不等于照做了');

  // 第三级：观察（工具调用）
  store.recordToolCall(agent, 'clis_classify');
  assert.deepEqual(store.outcomeOf(agent).calls, ['clis_classify']);
  assert.ok(isFamilyTool(SITUATIONS.diagnose, 'clis_classify'), 'clis_classify 属 diagnose 族');
});

test('新一轮输入作废上一轮的引导与观察（不能拿旧事实当新结论）', () => {
  const store = createSituationStore();
  const agent = { id: 'turn-reset' };
  store.judge('帮我审查一下', agent);
  store.recordGuidance(agent, { situation: SITUATIONS.diagnose, tools: 25, at: 1 });
  store.recordToolCall(agent, 'clis_classify');

  store.judge('现在改成搜索最新资料', agent);
  assert.equal(store.guidanceOf(agent), null, '上一轮的引导必须作废');
  assert.deepEqual(store.outcomeOf(agent).calls, [], '上一轮的工具调用必须作废');
});

test('工具调用只记名字，不记参数（参数里有路径/密钥/用户数据）', () => {
  const store = createSituationStore();
  const agent = { id: 'privacy' };
  store.recordToolCall(agent, 'read');
  const outcome = store.outcomeOf(agent);
  assert.deepEqual(Object.keys(outcome).sort(), ['calls', 'matched']);
  assert.deepEqual(outcome.calls, ['read']);
});

// ───────────────── 5. 多 agent 隔离 ─────────────────

test('多 agent：各自的处境、引导、观察互不覆盖', () => {
  const store = createSituationStore();
  const a = { id: 'agent-a' }, b = { id: 'agent-b' };

  store.judge('帮我审查这个问题', a);
  store.recordGuidance(a, { situation: SITUATIONS.diagnose, tools: 25, at: 1 });
  store.recordToolCall(a, 'clis_classify');

  store.judge('搜一下最新资料', b);
  store.recordGuidance(b, { situation: SITUATIONS.retrieve, tools: 25, at: 2 });
  store.recordToolCall(b, 'web_search');

  assert.equal(store.currentSituationOf(a), SITUATIONS.diagnose);
  assert.equal(store.currentSituationOf(b), SITUATIONS.retrieve);
  assert.deepEqual(store.outcomeOf(a).calls, ['clis_classify'], 'A 的观察不得被 B 污染');
  assert.deepEqual(store.outcomeOf(b).calls, ['web_search']);
  assert.equal(store.guidanceOf(a).situation, SITUATIONS.diagnose);
});

test('无 agent 身份时退到同一个无身份槽（单 agent 宿主仍可用）', () => {
  const store = createSituationStore();
  store.judge('帮我审查这个问题', undefined);
  assert.equal(store.currentSituationOf(undefined), SITUATIONS.diagnose);
  assert.equal(store.currentSituationOf(null), SITUATIONS.diagnose, 'null 与 undefined 共用同一槽');
});

// ───────────────── 6. 诊断与决策一致 ─────────────────

test('诊断不报原文：归一化只留计数', () => {
  const d = explainSituation('不要修改任何文件');
  assert.deepEqual(Object.keys(d.normalization).sort(), ['chars', 'conditional', 'negated', 'quoted']);
  for (const v of Object.values(d.normalization)) {
    assert.equal(typeof v, 'number', '归一化信息只能是指标，不能带原文片段');
  }
  assert.equal(d.normalization.negated, 1, '应报告剥掉了几处否定');
});

test('判定可解释：命中、落选、每个处境的得分都可查', () => {
  const d = explainSituation('修改后没效果，反复都不行');
  assert.ok(d.hits.includes('no-effect'));
  assert.ok(d.hits.includes('do-it'));
  assert.ok(d.misses.includes('need-external'));
  // intents 给出每个处境的合计分，这是"为什么是这个处境"的直接依据
  assert.ok(Array.isArray(d.intents) && d.intents.length > 0);
  assert.equal(typeof d.intents[0].score, 'number');
  assert.ok(Array.isArray(d.intents[0].signals));
  // 命中 + 落选 = 全部信号（否决的进 misses，不凭空消失）
  const total = d.hits.length + d.misses.length;
  assert.ok(total > 0);
});

test('工具族清单与排序判据同源（诊断不得自己再写一份）', () => {
  // 若诊断自己写一份 startsWith 判断，两份漂移之后会谎报"已照做"。
  for (const situation of [SITUATIONS.diagnose, SITUATIONS.execute, SITUATIONS.recall, SITUATIONS.retrieve]) {
    const family = familyOf(situation);
    assert.ok(Array.isArray(family), `${situation} 应有族清单`);
    if (family.length > 0) {
      const probe = `${family[0]}probe`;
      assert.ok(isFamilyTool(situation, probe), `${probe} 应被认作 ${situation} 族`);
      const ordered = arrangeTools([{ name: probe }, { name: 'zzz_other' }], situation).map((t) => t.name);
      assert.equal(ordered[0], probe, `排序判据与 isFamilyTool 必须一致（${situation}）`);
    }
  }
});

test('unknown 处境不重排工具面（宁可不动，不凭猜）', () => {
  const tools = [{ name: 'clis_classify' }, { name: 'read' }, { name: 'web_search' }];
  assert.deepEqual(arrangeTools(tools, SITUATIONS.unknown), tools);
});
