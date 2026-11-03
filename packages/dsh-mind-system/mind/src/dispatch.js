/**
 * 调度机制 —— 把"该看谁"从启发式关键词，变成**可声明、可注册、可查**的机制。
 *
 * ## 为什么要固化（2026-11-02 用户："mind（调度），固化为代码机制"）
 *
 * 旧版的处境判定是 `classifySituation()` 里的一串关键词匹配：
 * 看到"反复""无效"就是 diagnose，看到"搜一下"就是 retrieve。它能用，但：
 *
 * 1. **不可查**：没人知道"为什么这一轮排了这个顺序"，只有一个代号
 * 2. **不可调**：症状词写死在代码里，加一个信号就要改代码 + 改测试
 * 3. **不可扩展**：别的插件想贡献自己的信号（"我的失败模式是 X"）没有入口
 *
 * 第 3 条最要命：调度层如果只有自己说了算，它就成了新的"并列广告"——
 * 只是把"每个插件各自说该用我"换成"一个插件说该用谁"。
 *
 * ## 固化成什么
 *
 * 三件事：
 *
 * - **信号可注册**：`registerSignal()` 让任何单元贡献自己的处境信号，
 *   带自己的名字、权重与反例。调度层不硬编码别人的词汇。
 * - **判定可解释**：`explainSituation()` 返回"判成这个处境是因为哪些信号命中"，
 *   命中与落选都能查。这让"为什么排这个顺序"变成可回答的问题。
 * - **命中可记账**：每次判定留下命中/落选，供探针与自检读取 ——
 *   没有它，"调度没生效"与"调度生效但这一轮没信号"在观察上同形。
 *
 * ## 边界不变
 *
 * 调度层仍然**不裁决对错**、不注册工具、不提供服务。它只决定"此刻把谁推到
 * 眼前"。判据的所有权仍在各领域（CLIS 管结构、memory 管记忆准入）。
 *
 * @module src/dispatch
 */

import { SITUATIONS } from './orchestrate.js';

/**
 * 处境判定的可解释结果。
 *
 * @typedef {object} DispatchDecision
 * @property {string} situation 判出的处境。
 * @property {readonly string[]} hits 命中的信号名（按证据降序）。
 * @property {readonly string[]} misses 落选的信号名。
 * @property {Record<string, number>} evidence 各信号命中了几处（证据计数）。
 * @property {boolean} unknown 判不出时为 true。
 */

/**
 * 一个可注册的处境信号。
 *
 * @typedef {object} SituationSignal
 * @property {string} name 信号名（唯一；用于解释与记账）。
 * @property {string} situation 指向哪个处境。
 * @property {readonly string[]} words 触发该信号的词（子串匹配，大小写不敏感）。
 * @property {number} [weight] 权重：命中越多越优先。缺省 1。
 * @property {readonly string[]} [counterWords] 反例：出现这些词时该信号失效。
 * @property {string} [owner] 该信号贡献者的名字（哪个单元注册的）。
 */

/**
 * 内置信号表 —— 调度层自己的词汇（不是别人的）。
 *
 * ## 为什么有"症状"与"意图"两族（2026-11-02 客观审查的实测）
 *
 * 旧表只有**症状词**（没效果/无效/反复/还是不行）。拿两批真实输入实测：
 *
 * ```
 * 每日记录的历史样本（多为具体任务）  → 命中率 75%
 * 本会话的真实输入（多为抽象指令）      → 命中率 20%
 * ```
 *
 * 同一套词表，两种分布差 55 个百分点。失灵样本逐条看，共同特征是
 * **全是意图动词、零症状词**：
 *
 * ```
 * 「你来评估插件，给个评价」          ← 无症状词
 * 「心智系统成型了吗？请客观审查」    ← 无症状词
 * 「依次完善」                       ← 无症状词
 * ```
 *
 * 所以补一族**意图信号**：用户说"评估/审查/检查/完善/设计"时，
 * 此刻需要的**就是先看**（诊断或回忆），不是直接动手。这不是词表变长，
 * 是缺了一整族信号 —— 症状族管"事情没成"，意图族管"我在问什么"。
 *
 * 两族并存、权重不同：症状词证据更硬（"还是不行"几乎必然是诊断），
 * 意图词证据更软（"检查"可能指检查代码也可能是审查结论）。
 */
const BUILTIN_SIGNALS = [
  {
    name: 'no-effect',
    situation: SITUATIONS.diagnose,
    owner: 'mind',
    weight: 3,
    words: ['没效果', '无效', '越调越糟', '还是不行', '反复', '震荡', '弹回来', '谁因谁果', '判一下', '因果结构'],
    counterWords: ['测试反复失败', '用例反复失败'],
  },
  {
    name: 'need-external',
    situation: SITUATIONS.retrieve,
    owner: 'mind',
    weight: 2,
    words: ['搜一下', '查一下网上', '最新', '外部', '文档', '资料', '论文', '版本'],
  },
  {
    name: 'need-prior',
    situation: SITUATIONS.recall,
    owner: 'mind',
    weight: 2,
    words: ['以前', '上次', '之前说', '约定', '踩过', '记得', '记忆', '历史'],
  },
  {
    name: 'do-it',
    situation: SITUATIONS.execute,
    owner: 'mind',
    weight: 1,
    words: ['改', '修', '写', '跑', '执行', '加', '删', '安装', '部署'],
  },
  {
    // —— 意图族（2026-11-02 新增）——
    // 判据："此刻需要先看，而不是直接动手"。评估/审查/检查/核对/检验
    // 这类动词，用户要的是**判断**，不是修改。
    name: 'intent-review',
    situation: SITUATIONS.diagnose,
    owner: 'mind',
    weight: 2,
    words: ['评估', '评价', '审查', '审核', '检验', '核对', '检查', '客观', '合格吗', '成型了吗', '是否', '该不该', '对不对', '通不通'],
  },
  {
    // 意图族：用户要"想清楚怎么做" —— 需要先看结构再动手。
    name: 'intent-design',
    situation: SITUATIONS.diagnose,
    owner: 'mind',
    weight: 2,
    words: ['设计', '构建', '搭建', '编排', '整合', '治理', '对齐', '怎么设计', '怎么来', '如何', '方案', '架构', '体系'],
  },
  {
    // 意图族：完善/优化/升级 —— 改动现有东西，偏向执行。
    name: 'intent-improve',
    situation: SITUATIONS.execute,
    owner: 'mind',
    weight: 2,
    words: ['完善', '改进', '优化', '升级', '迭代', '固化为', '重写', '重绘', '重做', '补上', '加上', '纳入', '并入'],
  },
  {
    // 意图族：继续/依次/先做 —— 明确是动手，且没有症状词。
    name: 'intent-continue',
    situation: SITUATIONS.execute,
    owner: 'mind',
    weight: 1,
    words: ['继续', '依次', '接着', '下一步', '再来', '先做', '开始'],
  },
  {
    // —— 疑问族（2026-11-02 第二轮补）——
    // 全新样本测出的缺口：「有没有隐患」「靠谱吗」「给我一份总结」全是
    // 疑问句，没有一个症状词也没有一个意图动词。
    //
    // 疑问句是**最强的"先看"信号**：用户问"是不是/有没有/靠谱吗"，
    // 此刻要的是判断，不是动手。权重给 2 —— 与意图族同档。
    name: 'intent-question',
    situation: SITUATIONS.diagnose,
    owner: 'mind',
    weight: 2,
    words: ['有没有', '是不是', '是否', '靠谱吗', '怎么样', '如何', '什么样子', '什么样子', '给我一份', '总结', '状态', '隐患', '靠谱', '能行吗', '行吗'],
  },
  {
    // 意图族：整理/汇总/画图 —— 明确要产出，偏向执行。
    name: 'intent-produce',
    situation: SITUATIONS.execute,
    owner: 'mind',
    weight: 2,
    words: ['整理', '汇总', '画', '绘制', '输出', '导出', '生成', '列一份', '呈现', '重画'],
  },
  {
    // 意图族：犹豫 —— 「先别动，我想清楚再说」是要先看，不是要动手。
    name: 'intent-hesitate',
    situation: SITUATIONS.diagnose,
    owner: 'mind',
    weight: 2,
    words: ['先别动', '先不', '想清楚', '再想想', '慎重', '等等', '别急'],
  },
];

/** 已注册信号（模块级）。 */
const registry = new Map();

/**
 * 注册一个处境信号。
 *
 * ## 这是"零配合层"的入口
 *
 * 任何单元（插件、脚本、甚至 agent 本身）都能贡献自己的处境信号，
 * 而不必让调度层改代码。CLIS 可以注册"因果信号"、memory 可以注册
 * "记忆信号"，谁都没法强迫别人改。
 *
 * 重复注册同名信号会**覆盖**（以最后一次为准）—— 与 CLIS 的
 * `ProbeRegistry.add` 同一语义。
 *
 * @param signal 信号定义。
 * @returns 注销函数。
 */
export function registerSignal(signal) {
  const name = String(signal?.name ?? '').trim();
  if (name.length === 0) throw new Error('信号必须有名字');
  const words = Array.isArray(signal?.words) ? signal.words.filter((w) => typeof w === 'string' && w.length > 0) : [];
  if (words.length === 0) throw new Error(`信号「${name}」至少要有一个触发词`);
  const entry = {
    name,
    situation: String(signal.situation ?? SITUATIONS.unknown),
    words,
    weight: typeof signal.weight === 'number' && Number.isFinite(signal.weight) ? signal.weight : 1,
    ...(Array.isArray(signal.counterWords) ? { counterWords: signal.counterWords.filter((w) => typeof w === 'string') } : {}),
    ...(typeof signal.owner === 'string' ? { owner: signal.owner } : {}),
  };
  registry.set(name, entry);
  return () => {
    if (registry.get(name) === entry) registry.delete(name);
  };
}

/**
 * 列出全部已注册信号（内置 + 外部注册的）。
 *
 * @returns 信号列表。
 */
export function listSignals() {
  return [...BUILTIN_SIGNALS, ...registry.values()].map((s) => ({ ...s }));
}

/**
 * 判定处境，并给出**可解释**的理由。
 *
 * ## 打分规则（2026-11-02 对抗式审查修）
 *
 * 旧规则是 `score = weight × 命中处数`，**权重压不住广度**：一条权重 1 但
 * 命中 9 个词的信号，会赢过权重 10 但只命中 1 个词的信号。实测：
 *
 * ```
 * heavy(权重10, 1词) vs many(权重1, 9词)  →  many 赢
 * ```
 *
 * 这让"权重"这个字段名不副实 —— 它不是"这个信号有多可信"，而是"每多命中
 * 一处算几分"。改判据：**score = weight × (1 + log2(命中处数))**，命中处数
 * 只贡献对数级加成，权重仍是主导项。
 *
 * ## 同分规则（旧文档与代码不一致，已对齐）
 *
 * 旧文档写"同分取权重高者，再同则取**注册顺序靠后者**（后注册的更具体）"，
 * 但代码用严格 `>` 比较，遍历顺序是"内置在前、注册在后" —— 严格 `>` 意味着
 * **先到先赢**，同分时**内置赢**，与文档相反。
 *
 * 现在两者一致：**同分取后注册者**（外部信号更具体，理应覆盖内置）。
 * 实现上把比较改成 `>=`，并保证注册信号排在内置之后遍历。
 *
 * @param text 本轮输入文本。
 * @returns 判定结果（含命中、落选与证据计数）。
 */
export function explainSituation(text) {
  const haystack = String(text ?? '').toLowerCase();
  const signals = [...BUILTIN_SIGNALS, ...registry.values()];

  const evidence = {};
  const hits = [];
  const misses = [];
  let best = null;
  let bestScore = 0;

  for (const signal of signals) {
    const counterHit = (signal.counterWords ?? []).some((w) => haystack.includes(w.toLowerCase()));
    let count = 0;
    if (!counterHit) {
      for (const w of signal.words) {
        if (haystack.includes(w.toLowerCase())) count += 1;
      }
    }
    if (count === 0) {
      misses.push(signal.name);
      continue;
    }
    const score = scoreOf(signal, count);
    evidence[signal.name] = count;
    hits.push(signal.name);
    // `>=` 而非 `>`：同分时**后遍历到的胜出**。遍历顺序是"内置在前、注册在后"，
    // 所以同分时外部（后注册、更具体）信号赢 —— 与文档一致。
    if (score >= bestScore) {
      bestScore = score;
      best = signal;
    }
  }

  if (best === null) {
    return {
      situation: SITUATIONS.unknown,
      hits: [],
      misses,
      evidence,
      unknown: true,
    };
  }
  return {
    situation: best.situation,
    hits: hits.sort((a, b) => (evidence[b] ?? 0) - (evidence[a] ?? 0)),
    misses,
    evidence,
    unknown: false,
  };
}

/**
 * 算一个信号的得分。
 *
 * 命中处数只给**对数级**加成：多命中几处说明信号更贴合，但不该压过一条
 * 权重明显更高的信号。用 `1 + log2(count)` 是为了让 count=1 时得 1 分、
 * count=2 时得 2 分、count=4 时得 3 分 —— 边际递减。
 *
 * @param {{weight: number}} signal 信号。
 * @param {number} count 命中处数。
 * @returns 得分。
 */
function scoreOf(signal, count) {
  const weight = typeof signal.weight === 'number' && Number.isFinite(signal.weight) ? signal.weight : 1;
  return weight * (1 + Math.log2(Math.max(1, count)));
}

/** 最近一次判定的记录（供探针与自检读取）。 */
let lastDecision = null;

/**
 * 记录一次判定（由调用方在判定后写入）。
 *
 * @param decision 判定结果。
 */
export function recordDecision(decision) {
  lastDecision = decision;
}

/**
 * 读最近一次判定（只读）。
 *
 * @returns 判定结果；还没有过则 undefined。
 */
export function lastDecisionOf() {
  return lastDecision;
}

/**
 * 清空外部注册的信号（仅测试用）。
 *
 * @internal
 */
export function __clearSignalsForTest() {
  registry.clear();
}
