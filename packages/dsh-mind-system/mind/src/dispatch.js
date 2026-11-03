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
 * ## 2026-11-03 第二轮：从"词表匹配"到"可解释的归一化 + 界限"
 *
 * 上一轮固化了"可注册/可解释/可记账"，但**判断本身仍是裸子串匹配**，
 * 拿 18 条真实语料实测，3 条判错，且都落在同一族缺陷上：
 *
 * ```
 * 「不用审查，直接跑测试就行」        → diagnose   （否定词没管到意图族）
 * 「不要整理，也不要汇总，直接贴日志」 → execute    （"不要整理"里的"整理"仍命中）
 * 「注释写着"修复登录超时"，请解释它的作用」→ execute （引号内是被引用文本，不是指令）
 * ```
 *
 * 根因不是"词不够多"，是**匹配之前缺一层归一化**：旧代码只对 `do-it` 一族
 * 做了否定剥离（`actionText`），意图族完全裸奔；引用语境没有任何处理。
 *
 * 现在把这件事做成**四条具名规则**（见 `NORMALIZATION_RULES`），每条可单独
 * 测试、可在诊断里单独计数，而不是继续往正则里堆词：
 *
 * | 规则 | 做什么 | 为什么 |
 * |---|---|---|
 * | `quoted` | 剥掉引号/代码跨度 | 被引用的文字是**提及**，不是**指令** |
 * | `negated` | 剥掉"否定词 + 可请求动作"跨度 | 「不要修改 A，修复 B」须保住 B |
 * | `conditional` | 剥掉「如果…的话」假设从句 | 假设不是请求 |
 * | `vetoed` | 整类处境被用户明确排除 | **用户明确指令优先于插件推断** |
 *
 * 同时补一个**克制闸门**：两种处境得分接近时，判定照常报出，但标记
 * `ambiguous` —— 上层据此**不重排工具面**。宁可不动，也不凭猜引导。
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
 * @property {string} reason 判定路径的代号（见 DECISION_REASONS）。
 * @property {boolean} ambiguous 最高分处境与次高**不同**处境得分接近时为 true。
 * @property {ReadonlyArray<{situation: string, score: number, signals: string[]}>} intents
 *   所有得分 > 0 的处境，按分数降序。**多意图请求**在这里是可见的，
 *   而不是被压成一个代号后丢失。
 * @property {readonly string[]} vetoed 被用户明确排除的处境。
 * @property {object} normalization 归一化的**计数**（不含原文）：
 *   `{quoted, negated, conditional, chars}`。
 */

/**
 * 判定路径代号。
 *
 * 为什么要把"判不出"拆成好几种：它们对维护者的含义完全不同。
 *
 * - `nothing-actionable`：输入没有可判的动作内容（空、过短、全是引用）
 *   → 这是**输入**的性质，不是词表的缺口，不该拿去修词表
 * - `no-signal`：有内容但一条信号都没命中 → 这是**词表**的缺口
 * - `ambiguous`：命中了两类且势均力敌 → 这是**判断力**的边界，该保持克制
 * - `matched`：判出了一个处境
 *
 * 旧实现把前两者都塞进一个 `unknown: true`，于是"词表该扩"与"这条输入
 * 本来就没法判"在观察上同形 —— 拿错的那批去扩词表，只会把词表撑坏。
 */
export const DECISION_REASONS = {
  /** 判出了一个处境。 */
  matched: 'matched',
  /** 归一化后没有可判的内容（空输入 / 过短 / 只有被引用文本）。 */
  nothingActionable: 'nothing-actionable',
  /** 有内容，但没有一条信号命中 —— 词表缺口。 */
  noSignal: 'no-signal',
  /** 命中多类且势均力敌 —— 上层不得据此引导。 */
  ambiguous: 'ambiguous',
};

/**
 * 归一化规则名。
 *
 * 与 `normalizeForMatching()` 的返回字段一一对应，供诊断逐个计数。
 */
export const NORMALIZATION_RULES = ['quoted', 'negated', 'conditional'];

/** 判定所需的最短归一化文本长度（字符）。 */
export const MIN_MATCH_LENGTH = 2;

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
    // 「没有效果」与「没效果」是两个不同的字符串 —— 少一个就漏一整类真实说法。
    // 实测打红：用户写「改了没有效果」，旧词表只有「没效果」，判成 unknown。
    words: ['没效果', '没有效果', '无效', '没用', '没有用', '越调越糟', '还是不行', '反复', '震荡', '弹回来', '谁因谁果', '判一下', '因果结构'],
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
    // 2026-11-03 实测补「修好/改好/弄好/搞定/处理掉」这一族**动补结构**。
    // 它们是极常见的祈使说法，但旧词表只有"修复/修一下"：
    // 实测「把越界判断修好」判成 unknown（漏触发）。
    //
    // 为什么用"修好"而不是单字"修"：单字太宽，"修复登录超时"这种
    // **名词化引用**会被误伤（那是别人写的注释，不是指令）。
    // 加"好/掉/定"这些补语，反而让意图更明确。
    words: ['修改', '改一下', '改成', '修复', '修一下', '修好', '改好', '弄好', '搞定', '处理掉',
      // 2026-11-03 实测补：与"检查/核对"常成对出现的动宾结构。
      // 实测「核对一下这两个数字，不对就修正」「评估这个方案，然后按它实现」
      // 都判成 diagnose —— 因为"修正/实现"不在动作表里，`do-it` 一条未中。
      '修正', '实现', '落地', '补完', '改对', '改掉', '换掉', '调整', '重设', '设为',
      '写入', '写个', '写一个', '创建', '跑', '执行', '加上', '增加', '删除', '删掉', '安装', '部署'],
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
    //
    // 2026-11-03 实测补「统一 / 替换 / 重命名 / 迁移 / 补全 / 去掉 / 清理」：
    // 这些是**动手改**的常见说法，但旧词表一个都没有，于是
    // 「把三个文件里的 import 路径都统一一下」判成 unknown（漏触发）。
    // 补词的判据是"用户说完这句，期待的是改完的结果还是先给判断" ——
    // 这些都是前者。
    name: 'intent-improve',
    situation: SITUATIONS.execute,
    owner: 'mind',
    weight: 2,
    words: ['完善', '改进', '优化', '升级', '迭代', '固化为', '重写', '重绘', '重做', '补上', '加上', '纳入', '并入',
      '统一', '替换', '重命名', '迁移', '补全', '去掉', '清理', '改成一致'],
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
    //
    // 2026-11-03 补「符合吗/一致吗」一类：在问"现状与规范是否一致"，
    // 同样是先看（实测样本：README 里说…我们现在的做法符合吗）。
    name: 'intent-question',
    situation: SITUATIONS.diagnose,
    owner: 'mind',
    weight: 2,
    words: ['有没有', '是不是', '是否', '靠谱吗', '怎么样', '如何', '什么样子', '给我一份', '总结', '状态', '隐患', '靠谱', '能行吗', '行吗', '符合吗', '一致吗', '对得上吗'],
  },
  {
    // 意图族：整理/汇总/画图 —— 明确要产出，偏向执行。
    name: 'intent-produce',
    situation: SITUATIONS.execute,
    owner: 'mind',
    weight: 2,
    words: ['整理', '汇总', '画', '绘制', '导出', '生成', '列一份', '呈现', '重画'],
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

/**
 * 否定触发词。
 *
 * ## 顺序有意义
 *
 * 必须**按长度降序**匹配：`不用再` 要在 `不用` 之前命中，否则
 * 「不用再改了」会被切成「不用」+「再改了」，跨度算错一位。
 * 代码里按长度排过序，这里按可读性分组书写。
 *
 * ## 为什么单字 `不` / `没` / `没有` 也在表里（2026-11-03 实测补回）
 *
 * 一度把它们删掉，理由是"太宽的否定"。实测立刻打红：
 *
 * ```
 * 「不修改任何文件」 → 修改 仍被当成指令 → execute
 * ```
 *
 * 而它们**不会**伤到症状词：否定只作用于 {@link REQUESTABLE_ACTIONS}
 * 里的**动作**，而 `没效果` / `无效` / `反复` 都是事实描述，不在那张表里。
 * 所以「没有效果」永远不会被自己的"没有"剥掉 —— 这个安全性由**作用域**
 * 保证，不需要靠砍词来保。
 */
const NEGATION_TRIGGERS = [
  '不用再', '不需要再',
  '不要', '不用', '不必', '无需', '无须', '禁止', '请勿', '不许', '不准', '不得',
  '避免', '不想', '甭', '勿', '别', '没再', '不', '没',
];

/**
 * 可能被否定辖域覆盖的**可请求动作**词 —— 只有这些词才会被剥离。
 *
 * ## 为什么不能对全部信号词生效
 *
 * 反例：「**没有**效果」里的"没有"是"没效果"的一部分，如果把它当否定词
 * 去剥"效果"，一条最硬的症状信号会被自己消掉。实测踩过。
 *
 * 所以否定只作用于**动作**：用户能"不要"的是"修改/审查/整理"这类行为，
 * 不能"不要"的是"无效/反复"这类事实描述。
 */
const REQUESTABLE_ACTIONS = [
  // do-it
  '修改', '改一下', '改成', '修复', '修一下', '修好', '改好', '弄好', '搞定', '处理掉',
  '修正', '实现', '落地', '补完', '改对', '改掉', '换掉', '调整', '重设', '设为',
  '写入', '写个', '写一个', '创建', '跑', '执行',
  '加上', '增加', '删除', '删掉', '安装', '部署',
  // intent-improve
  '完善', '改进', '优化', '升级', '迭代', '固化为', '重写', '重绘', '重做', '补上', '纳入', '并入',
  '统一', '替换', '重命名', '迁移', '补全', '去掉', '清理',
  // intent-produce
  '整理', '汇总', '画', '绘制', '导出', '生成', '列一份', '呈现', '重画',
  // intent-review（"不用审查"必须能剥掉）
  '评估', '评价', '审查', '审核', '检验', '核对', '检查',
  // intent-continue / intent-design（"不要继续""别设计了"）
  '继续', '依次', '接着', '再来', '先做',
  '设计', '构建', '搭建', '编排', '整合', '治理',
  // intent-question 里明确是动作的两条
  '总结', '再想想',
];

/**
 * 用户**明确排除**某类判定的说法。
 *
 * ## 这是"用户明确指令优先于插件推断"的落点
 *
 * 「别做因果分析，就把这份 CSV 求和」：如果插件只看"因果"这两个字，
 * 会判 diagnose 并把 clis 工具推到最前 —— 而用户刚刚**禁止**了这件事。
 * 词表覆盖得越好，这种冲突越容易出现，因为外部单元贡献的领域词汇
 * 恰恰就是用户想排除的那一族。
 *
 * 所以这里不是"再加一层关键词"，而是一条**否决权**：命中即把该处境
 * 从候选里整类删掉，并在诊断里记 `vetoed`。用户说别做，就是别做。
 *
 * 每条 `{situation, patterns: RegExp[]}`。正则作用在归一化后的文本上。
 */
const SITUATION_VETOES = [
  {
    situation: SITUATIONS.diagnose,
    patterns: [
      // 「别做因果分析」→「不用再检查结构」
      /(?:别|不要|不用|不必|无需|禁止|别去|不要再)(?:做|用|进行|搞|弄)?(?:因果|结构)(?:分析|判断|诊断)?/u,
      /(?:别|不要|不用|不必)(?:再)?(?:诊断|归因|复盘|分析原因)/u,
    ],
  },
  {
    situation: SITUATIONS.recall,
    patterns: [/(?:别|不要|不用|不必|无需)(?:再)?(?:查|翻|看|用)(?:记忆|回忆|历史记录)/u],
  },
  {
    situation: SITUATIONS.retrieve,
    patterns: [/(?:别|不要|不用|不必|无需)(?:再)?(?:搜|查|检索|找)(?:网|资料|文档|论文|外网)/u],
  },
  {
    situation: SITUATIONS.execute,
    patterns: [
      // 「别动代码」「不要改任何东西」—— 只排斥"动手"，不排斥判断。
      /(?:别|不要|不用|不必|禁止)(?:再)?(?:动|碰)(?:代码|文件|工程)/u,
      /(?:别|不要|不用|不必|禁止)(?:再)?(?:改|修改|动)(?:任何|别的|其它|其他)?(?:代码|文件|东西|地方)/u,
    ],
  },
];

/**
 * 引号与代码跨度 —— 被引用的文字是**提及**，不是**指令**。
 *
 * 实测反例：「这个函数的注释写着"修复登录超时"，请解释它的作用」
 * 旧判定把"修复"当成了要执行的动作 → execute，而用户只是**在问注释**。
 *
 * 覆盖：成对中文引号、成对英文引号、成对反引号、独立成行的代码围栏。
 * 只处理**成对**的：单个引号无法判断边界，宁可不动也不误剥。
 */
const QUOTED_SPANS = [
  /```[\s\S]*?```/gu, // 代码围栏
  /`[^`\n]*`/gu, // 行内代码
  /「[^」\n]*」/gu,
  /『[^』\n]*』/gu,
  /“[^”\n]*”/gu,
  /‘[^’\n]*’/gu,
  /"[^"\n]{1,80}"/gu, // 英文双引号：限长，避免把整句当引用
  /'[^'\n]{1,80}'/gu,
];

/**
 * 假设从句 —— 「如果…的话」里的条件不是请求。
 *
 * 只剥带 `的话` 收尾的那种：这是汉语里边界最清楚的假设标记。
 * 不带 `的话` 的条件句（「如果要改就改这里」）**不剥** —— 那里的请求
 * 恰恰在从句里，剥掉就把用户要的事弄丢了。宁可少做，不要做错。
 */
const CONDITIONAL_SPANS = [/(?:如果|假如|要是|倘若|万一)[^，。；！？\n]{0,40}?的话/gu];

/**
 * 「软意图」—— 表达的是"我要看"，但常常只是**手段**，不是目的。
 *
 * ## 为什么必须和"硬症状"分开（2026-11-03 实测发现）
 *
 * 真实使用采样里 `diagnose` 占了 **70%**（456/654），其中 **432 条（95%）
 * 只靠 intent-review / intent-question 判定**，一条症状词都没有。
 * 逐条看，被误判的都是这种：
 *
 * ```
 * 检查并修复 login.js 的超时问题        → diagnose（而用户要的是修好）
 * 核对一下这两个数字，不对就修正         → diagnose（同上）
 * 是否可以把端口改成 8080               → diagnose（这是个执行请求）
 * 看看这段代码有没有语法错误，有就改掉    → diagnose（同上）
 * ```
 *
 * 根因：`检查 / 核对 / 评估 / 是否` 在中文里既是"请给判断"，也常是
 * "顺便看一眼再动手"的**前缀动作**。它们证据力弱，却权重 2 ——
 * 压过了权重 1 的 `do-it`。
 *
 * 所以把它们标成软意图：**同时有明确动作意图时，动作赢**。
 *
 * ## 但硬症状仍然赢
 *
 * 「改了没效果」「反复震荡」这类是**事实陈述**（no-effect，权重 3），
 * 说明用户已经试过动作而失败了。这时要的确实是先诊断，不能被动作盖掉。
 * 判据是"用户是不是已经动过手并失败了"——软意图不看这个，硬症状看。
 */
const SOFT_INTENTS = new Set(['intent-review', 'intent-question', 'intent-design', 'intent-hesitate']);

/**
 * 「判断式否定」—— 含否定字，但它**不是在否定后面的动作**。
 *
 * ## 实测缺陷（2026-11-03）
 *
 * ```
 * 核对一下这两个数字，不对就修正
 *   → 归一化后只剩「核对一下这两个数字，」，「修正」被剥掉了
 * ```
 *
 * 原因：单字 `不` 在否定表里，它把辖域一路伸到「修正」。
 * 但「不对」在这里是**条件判断**（"如果不对"），意思是"错了就改" ——
 * 恰恰**要求**动手。把它当否定词，语义正好反了。
 *
 * 同类还有「不行/不对/不通/不好/有问题就…」这些**前件**：
 * 它们描述的是"什么情况下要动作"，不是"不要动作"。
 *
 * ## 判据
 *
 * 否定辖域只在候选动作前面**没有**这些判断式否定词时成立。
 * 换句话说：`不对就修正` 里的「修正」不该被剥。
 *
 * ## 为什么不做成"遇到就整体跳过否定"
 *
 * 那会让「不要修改不对的地方」也失去否定（那里的"不要"是真的否定）。
 * 所以只精确豁免**紧邻**判断式否定的那个动作。
 */
const JUDGMENT_NEGATIVES = [
  '不对', '不行', '不通', '不好', '不准确', '不一致', '不符合', '不匹配',
  '有问题', '有误', '错了', '缺失', '缺了', '少',
];

/** 可注册信号（模块级）。 */
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
 * 列出用户明确排除处境的否决规则（只读，供诊断展示）。
 *
 * @returns 否决规则清单。
 */
export function listVetoes() {
  return SITUATION_VETOES.map((v) => ({ situation: v.situation, count: v.patterns.length }));
}

/**
 * 把输入归一化成**可用于匹配的文本**，并记录每条规则剥掉了什么。
 *
 * ## 为什么单独成函数、且返回计数
 *
 * 判断出错时，维护者要能回答"是词表不对，还是这里的归一化把它剥掉了"。
 * 如果剥离发生在匹配内部、不留下痕迹，这个问题就无法回答 ——
 * 又一个"看起来正常，其实没人检查"的形态。
 *
 * 返回的 `counts` **只有数字，不含任何原始片段**：诊断要能说清
 * "剥了 2 处否定"，不需要也不需要保存用户说了什么。
 *
 * @param text 原始输入。
 * @returns {{text: string, counts: {quoted: number, negated: number, conditional: number, chars: number}, vetoed: string[]}}
 */
export function normalizeForMatching(text) {
  const raw = String(text ?? '');
  const counts = { quoted: 0, negated: 0, conditional: 0, chars: 0 };

  // 1) 引用剥离
  let working = raw;
  for (const re of QUOTED_SPANS) {
    working = working.replace(re, () => {
      counts.quoted += 1;
      return ' ';
    });
  }

  // 2) 假设从句剥离（在否定之前：假设从句里常含否定，先剥更干净）
  for (const re of CONDITIONAL_SPANS) {
    working = working.replace(re, () => {
      counts.conditional += 1;
      return ' ';
    });
  }

  // 3) 否定辖域剥离
  const lowered = working.toLowerCase();
  const removals = negationSpans(lowered);
  if (removals.length > 0) {
    counts.negated = removals.length;
    const chars = [...working];
    for (const [start, end] of removals) {
      for (let i = start; i < end && i < chars.length; i += 1) chars[i] = ' ';
    }
    working = chars.join('');
  }

  // 4) 用户明确排除的处境
  const vetoed = [];
  for (const veto of SITUATION_VETOES) {
    if (veto.patterns.some((re) => re.test(lowered))) vetoed.push(veto.situation);
  }

  const normalized = working.replace(/\s+/gu, ' ').trim();
  counts.chars = [...normalized].length;
  return { text: normalized, counts, vetoed };
}

/**
 * 找出「否定词 + 可请求动作」的跨度。
 *
 * ## 两条边界
 *
 * - **最长动作优先**：`修一下` 要先于 `修改` 试，否则「不要修一下」会
 *   只剥到 `修`，留下"一下"这种残渣（无害，但会让"剥了几处"的计数失真）。
 * - **窗口有上限**：否定词与动作之间最多隔 `NEGATION_WINDOW` 个字符。
 *   不限窗口的话，「不要动它，明天再修改吧」会把后半句的"修改"也吞掉。
 *
 * @param text 已小写的文本。
 * @returns {Array<[number, number]>} 要清空的 `[起始, 结束)` 区间，已按起点排序。
 */
function negationSpans(text) {
  const NEGATION_WINDOW = 12;
  const triggers = [...NEGATION_TRIGGERS].sort((a, b) => b.length - a.length);
  const actions = [...REQUESTABLE_ACTIONS].sort((a, b) => b.length - a.length);
  const spans = [];

  /**
   * 该位置的否定词是否其实是**判断式否定**的一部分（见 JUDGMENT_NEGATIVES）。
   *
   * 只在单字否定（不/没/别）上判：多字否定（不要/禁止）证据更硬，
   * 不该被"不对"之类的字面重叠豁免掉。
   *
   * 判法是"起点向前看"：如果这个位置是某个判断式否定的**起点或内部**，
   * 那它不是否定动作的词。
   */
  const isJudgmentNegative = (at, trigger) => {
    if (trigger.length > 1) return false;
    for (const phrase of JUDGMENT_NEGATIVES) {
      const from = text.lastIndexOf(phrase, at + phrase.length);
      if (from >= 0 && from <= at && at < from + phrase.length) return true;
    }
    return false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const trigger = triggers.find((t) => text.startsWith(t, i));
    if (trigger === undefined) continue;
    // 「不对就修正」里的"不"是条件前件，不是"不要修正" —— 跳过它。
    if (isJudgmentNegative(i, trigger)) continue;

    const windowStart = i + trigger.length;
    const windowEnd = Math.min(text.length, windowStart + NEGATION_WINDOW);
    // 遇到标点即止：跨句的否定不该管到下一句。
    const stop = text.slice(windowStart, windowEnd).search(/[，。；！？、,.;!?\n]/u);
    const limit = stop >= 0 ? windowStart + stop : windowEnd;

    let best;
    for (const action of actions) {
      const at = text.indexOf(action, windowStart);
      if (at < 0 || at >= limit) continue;
      if (best === undefined || at < best.at || (at === best.at && action.length > best.action.length)) {
        best = { at, action };
      }
    }
    if (best !== undefined) {
      spans.push([i, best.at + best.action.length]);
      i = best.at + best.action.length - 1;
    }
  }

  return spans;
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
 * ## 2026-11-03：判不出要分四种，且势均力敌时要标记
 *
 * `reason` 区分 `nothing-actionable` / `no-signal` / `ambiguous` / `matched`。
 * 前两者混成一个是维护事故：拿"本来就没法判的输入"去扩词表，越扩越松。
 *
 * `ambiguous` **不改 `situation`**（同分规则照旧），只把"两类势均力敌"
 * 这个事实标出来 —— 由上层决定是否据此引导。判定与引导是两件事，
 * 混在一起就没法说清"判了但没引导"到底是谁的选择。
 *
 * @param text 本轮输入文本。
 * @returns {DispatchDecision} 判定结果（含命中、落选与证据计数）。
 */
export function explainSituation(text) {
  const normalized = normalizeForMatching(text);
  const haystack = normalized.text.toLowerCase();
  const vetoed = normalized.vetoed;

  const signals = [...BUILTIN_SIGNALS, ...registry.values()];
  const allNames = signals.map((s) => s.name);

  /**
   * 归一化后**没有可判内容**（空、或整句都被引用/否定剥光）。
   *
   * ⚠️ 它**不阻止匹配**，只用于判不出时归因（见下）。
   */
  const nothingActionable = normalized.counts.chars < MIN_MATCH_LENGTH;

  const evidence = {};
  const hits = [];
  const misses = [];
  let best = null;
  let bestScore = 0;
  /** 每个处境的总分（用于多意图与势均力敌判断）。 */
  const bySituation = new Map();

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
    // 用户明确排除的处境 → 整类作废，但仍记进 misses（它确实没被采用）。
    if (vetoed.includes(signal.situation)) {
      misses.push(signal.name);
      continue;
    }
    const score = scoreOf(signal, count);
    evidence[signal.name] = count;
    hits.push(signal.name);
    const bucket = bySituation.get(signal.situation) ?? { score: 0, signals: [] };
    bucket.score += score;
    bucket.signals.push(signal.name);
    bySituation.set(signal.situation, bucket);
    // `>=` 而非 `>`：同分时**后遍历到的胜出**。遍历顺序是"内置在前、注册在后"，
    // 所以同分时外部（后注册、更具体）信号赢 —— 与文档一致。
    if (score >= bestScore) {
      bestScore = score;
      best = signal;
    }
  }

  const intents = [...bySituation.entries()]
    .map(([situation, bucket]) => ({ situation, score: bucket.score, signals: bucket.signals }))
    .sort((a, b) => b.score - a.score);

  /**
   * 判不出时，用**两条事实**决定该报哪一种，而不是只看一个布尔值。
   *
   * ⚠️ 为什么不能"文本短就一律报 nothing-actionable"（2026-11-03 修）：
   * 单字信号（外部单元注册的 `'环'` 之类）在短输入上是**有效证据**。
   * 一刀切会把"这个词真的命中了一条信号"报成"输入没内容"，
   * 于是维护者会去改输入侧，而真正要改的是别的地方。
   *
   * 所以：**过短不阻止匹配，只改变判不出时的归因**。
   *   - 匹配过了却一条未中 → 过短算 `nothing-actionable`，否则算 `no-signal`
   *   - 根本没匹配（剥光了）→ 恒 `nothing-actionable`
   */
  if (best === null) {
    return {
      situation: SITUATIONS.unknown,
      hits: [],
      misses,
      evidence: {},
      unknown: true,
      reason: nothingActionable ? DECISION_REASONS.nothingActionable : DECISION_REASONS.noSignal,
      ambiguous: false,
      intents: [],
      vetoed,
      normalization: { ...normalized.counts },
    };
  }

  // 势均力敌：存在**另一个**处境，得分达到最高分的 85% 以上。
  // 阈值不是拍出来的：低于它，两类差一档权重就足以区分（意图族权重 2
  // 对执行族 1 是 50% 差）；达到它，说明两族证据强度相当，此时引导
  // 等于赌，而赌错的代价是模型被推向错误的工具族。
  const AMBIGUITY_RATIO = 0.85;
  let runnerUp = intents.find((i) => i.situation !== best.situation);
  let ambiguous = runnerUp !== undefined && runnerUp.score >= bestScore * AMBIGUITY_RATIO;

  /**
   * 「先查再做」的处置顺序（2026-11-03 实测补）。
   *
   * ## 缺陷
   *
   * ```
   * 「按那个约定来，把 src/limit.js 里的越界判断修好」 → recall（错）
   * ```
   *
   * 用户明确要求**修改代码**，插件却把记忆工具推到最前、动手工具排后。
   * 根因是 `need-prior` 权重 2 压过 `do-it` 权重 1 —— 但这两个处境
   * **不是同一维度上的竞争**：
   *
   * - `recall` 是**前置步骤**（先查清约定）
   * - `execute` 是**最终动作**（按约定改）
   *
   * 判"该优先哪族工具"时，用户要的**结果**是改完，所以这一轮的主处境
   * 应该是 execute；召唤记忆是它的一步，会由模型自己顺手做
   * （`need-prior` 仍在 `intents` 与 `hits` 里可见，诊断不丢这个事实）。
   *
   * ## 边界
   *
   * 只在**同时命中**时才这样处置；单纯问"以前怎么约定的"仍是 recall。
   * 且这不算 ambiguous —— 我们有明确规则，不是势均力敌。
   */
  const RECALL_PRECEDES_EXECUTE = 'recall-precedes-execute';
  let situation = best.situation;
  let override;
  if (situation === SITUATIONS.recall && bySituation.has(SITUATIONS.execute)) {
    situation = SITUATIONS.execute;
    bestScore = bySituation.get(SITUATIONS.execute).score;
    ambiguous = false;
    runnerUp = intents.find((i) => i.situation === SITUATIONS.recall);
    override = RECALL_PRECEDES_EXECUTE;
  }

  /**
   * 软意图让位给明确动作（2026-11-03 实测补，见 SOFT_INTENTS 的说明）。
   *
   * ## 判据
   *
   * 同时满足三条才改判：
   *
   * 1. 当前主处境是 `diagnose`
   * 2. 判成它靠的是**软意图**（不是硬症状）
   * 3. 存在明确的动作意图（execute 有分）
   *
   * ## 为什么第 2 条只查 `best.name`
   *
   * `best` 是**赢得判定的那条信号**。如果它本身是硬症状（no-effect /
   * clis-causal），说明用户是在说"我试过了，没用" —— 这时不能改判。
   * 只查 best 而不查全部 hits，是因为"同时命中软意图与硬症状"时
   * 硬症状已经赢了，走不到这里。
   *
   * ## 代价（诚实记录）
   *
   * 「检查一下有没有问题」这种**真·只读审阅**会被判成 execute，
   * 于是动手类工具被提前。这是权衡：真实使用里 95% 的 diagnose 来自软意图，
   * 而其中绝大多数（如「检查并修复」）用户是要动手的 —— 两者不可兼得时，
   * 按多数派修正。反例在 README 的「已知限制」里写明。
   */
  const SOFT_INTENT_YIELDS = 'soft-intent-yields-to-action';
  if (
    situation === SITUATIONS.diagnose
    && SOFT_INTENTS.has(best.name)
    && bySituation.has(SITUATIONS.execute)
  ) {
    situation = SITUATIONS.execute;
    bestScore = bySituation.get(SITUATIONS.execute).score;
    ambiguous = false;
    runnerUp = intents.find((i) => i.situation === SITUATIONS.diagnose);
    override = SOFT_INTENT_YIELDS;
  }

  return {
    situation,
    hits: hits.sort((a, b) => (evidence[b] ?? 0) - (evidence[a] ?? 0)),
    misses,
    evidence,
    unknown: false,
    reason: ambiguous ? DECISION_REASONS.ambiguous : DECISION_REASONS.matched,
    ambiguous,
    ...(override !== undefined ? { override } : {}),
    intents,
    vetoed,
    normalization: { ...normalized.counts },
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
 * @returns {得分} 得分。
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

/** 供诊断展示：归一化规则与可请求动作清单（只读快照）。 */
export function listNormalizationRules() {
  return {
    rules: [...NORMALIZATION_RULES],
    negationTriggers: [...NEGATION_TRIGGERS],
    requestableActions: [...REQUESTABLE_ACTIONS],
    quotedSpanPatterns: QUOTED_SPANS.length,
    conditionalPatterns: CONDITIONAL_SPANS.length,
    minMatchLength: MIN_MATCH_LENGTH,
  };
}
