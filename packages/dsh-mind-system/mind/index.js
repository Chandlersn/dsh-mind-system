/**
 * dsh-agent-mind —— 把"判断顺序"装进系统提示。
 *
 * 本插件很克制：**不注册工具、不持状态、不读写文件**。
 * 它只往系统提示里注入一段常驻文本，内容是"遇到问题先问什么"。
 *
 * ## 为什么值得单独成一个插件
 *
 * 因为这段内容**不属于任何一个已有插件**。把它塞进 clis，它会变成
 * clis 的广告；塞进 memory-manager，它会偏向记忆。而它要表达的恰恰是
 * "在这些插件之间怎么选" —— 归属任何一方都会让天平歪掉。
 *
 * 独立成包还有个实际好处：它可以单独装、单独关。判断顺序若不合用，
 * 关掉它不影响任何工具的存在。
 *
 * ## 失败模式与降级
 *
 * 唯一依赖是 `systemPrompt` 服务。它由 dsh-base 提供，几乎必然存在，
 * 但仍然显式判空 —— 缺了它本插件什么也做不了，而"插件装载了但没做事"
 * 是最难查的状态，所以这里宁可记一条日志也不要静默。
 */

import { registerMindSection, SECTION_NAME, SECTION_ORDER } from './src/mind.js';
import { arrangeTools, SITUATIONS } from './src/orchestrate.js';
import { listSignals, registerSignal } from './src/dispatch.js';
import { recordSample, readTrend, readTrendSync } from './src/sampling.js';
import { benchmarkFromDailyLogs } from './src/hitrate.js';
import { judge, currentSituationOf, lastDecisionOf, __resetSituationForTest, __forceSituationForTest } from './src/situation.js';
import { getDefineTool } from './src/host.js';
import { join } from 'node:path';

/** 插件名。必须与 cordis.patch.yml 里的 id 一致。 */
export const name = 'mind';

/**
 * 服务依赖：只声明 `systemPrompt`。
 *
 * 按 Cordis 规则，**访问任何服务属性都必须先在 inject 里声明**，
 * 哪怕它一定存在 —— `ctx.systemPrompt` 走 Proxy get，未声明就抛
 * `cannot get property "systemPrompt" without inject`，后果是整个插件
 * 不激活（宿主只报一句 "1 entry did not activate"）。
 *
 * 为什么不用 `ctx.get('systemPrompt')`（那样可以不声明）：本插件**必然**
 * 需要它，不是可选增强。声明成硬依赖，装载顺序由宿主保证，
 * 比"运行时探测 + 静默降级"更符合它的定位。
 */
export const inject = ['systemPrompt', 'tools'];

/**
 * 最近一次判出的处境（模块级）。
 *
 * 为什么需要它：装配器（`systemPrompt/assemble`）拿不到本轮消息，
 * 唯一能看到消息的是处境采集点。所以后者写、前者读 —— 这也是
 * memory-manager 召回注入用的同一条时序。
 *
 * 那个 "unknown" 初值是**刻意**的：还没看到任何输入时不该假装知道
 * 该优先什么，保持默认工具顺序最安全。
 *
 * @deprecated 状态现由 `src/situation.js` 持有；此处保留导出以兼容旧调用方。
 */
export { currentSituationOf };

/**
 * 是否给异族工具打 `deferLoading`（缺省关）。
 *
 * 缺省关的理由：重排是纯顺序、零风险；打 deferLoading 会让工具的声明
 * 不常驻，效果依模型适配器而异。把有风险的那半做成显式开关，
 * 默认只交付无风险的那半。
 */
const PARK_ENABLED = process.env.DSH_MIND_PARK === '1';

/**
 * 装载：注册心智索引分节，并接入"按处境收放工具面"。
 *
 * @param ctx — Cordis 上下文。
 */
export function apply(ctx) {
  const dispose = registerMindSection(ctx);

  // 没注册成功说明 systemPrompt 服务不在（理论上 inject 已挡住）。
  // 这不是"正常降级"，而是本插件唯一的职责没有履行，必须留下痕迹。
  if (dispose === undefined) {
    record('section-missing');
    ctx.logger?.('mind')?.error?.(
      `心智索引未注册：systemPrompt 服务不可用。${SECTION_NAME} 分节不会出现在提示里。`,
    );
    return;
  }

  // 只读工具：看调度覆盖了哪些词、谁贡献的、上次判定命中了什么。
  // 没有它，"生态为空"与"生态已长出来"在观察上完全同形。
  registerSignalsTool(ctx);

  // —— 处境采集：在**工具面定稿之前**判出处境 ——
  //
  // ⚠️ 2026-11-02 对抗式审查发现并修：原来在 `agent/pre-step` 里判处境。
  // 但宿主次序是反的：
  //
  //   dsh-agent-loop/lib/index.js:906  claim()      ← 拿到本轮输入
  //   dsh-agent-loop/lib/index.js:907  assemble()   ← 工具面在此定稿
  //   dsh-agent-loop/lib/index.js:909  pre-step     ← 处境在此才判出
  //
  // 于是重排永远晚一步：第 1 步（模型首次回应用户、决定用哪个工具的那一步）
  // 用默认顺序；第 2 步用上了第 1 步判的处境；第 2 步起 inbox 为空 → 处境被
  // 重置 → 第 3 步又变回默认顺序。一个 turn 内工具面**变动两次**。
  //
  // 而宿主的 `headerEquals` 按**顺序**比较工具面（dsh-session/lib/types/
  // request-header.js:44），顺序一变就判"工具面变了" → 请求序列重启、
  // 提示缓存前缀作废。收益在第 1 步（没有），代价在第 2 步（全付）。
  //
  // 修法：改用 `agent/inbox/claimed`。它在 claim() 里发出，**早于** assemble()，
  // 且携带用户消息本身 → 工具面定稿时处境已经就位，重排能作用于第 1 步。
  //
  // 保留 `agent/pre-step` 作为兜底：老宿主没有 `inbox/claimed` 时仍能工作。
  let claimedOk = false;
  let preStepOk = false;
  let assembleOk = false;

  /** 判一次处境并记账（两条信号源共用）。 */
  const judgeAndSample = (text) => {
    const decision = judge(text);
    // 采样：把这次判定落盘，命中率成为**长期趋势**而不是一次性测量。
    // 只存输入哈希（不含原文）与判定结果 —— 够算趋势，且不可反推内容。
    // 空输入不采样（分母口径见 src/sampling.js）。
    void recordSample(dshHomeOf(), decision);
    return decision;
  };

  // —— 主路径：`agent/inbox/claimed`（早于 assemble）——
  try {
    ctx.on?.('agent/inbox/claimed', (payload) => {
      try {
        const text = textOfMessage(payload?.message);
        if (text.length === 0) return; // 空输入不判（见 src/situation.js）
        judgeAndSample(text);
      } catch {
        /* 采集失败绝不能拖垮主链路 */
      }
    });
    claimedOk = typeof ctx.on === 'function';
  } catch {
    /* 宿主没有该事件 → 退到 pre-step */
  }

  // —— 兜底：`agent/pre-step`（老宿主）——
  //
  // ⚠️ pre-step 的 waterfall **没有 catch**：监听器抛错会中断整个 turn。
  // 所以整段包在 try 里，增强的失败绝不能拖垮主链路。
  try {
    ctx.on?.('agent/pre-step', async (payload, next) => {
      try {
        const text = lastUserText(payload?.messages);
        // 已经有 inbox/claimed 判过 → 不重复采样（否则同一输入记两次）。
        if (text.length > 0 && !claimedOk) {
          judgeAndSample(text);
        } else if (text.length > 0) {
          judge(text);
        }
      } catch {
        /* 判定失败 → 处境保持不变 */
      }
      return next();
    });
    preStepOk = typeof ctx.on === 'function';
  } catch {
    /* 宿主没有该事件（旧宿主/单测）→ 处境恒 unknown，等价于不做重排 */
  }

  // —— 接收外部单元贡献的处境信号（零配合的另一半）——
  //
  // 探针注册是 mind → CLIS（mind 主动广播自己）；信号注册方向相反：
  // **CLIS / memory 主动广播自己的领域词汇**，mind 收下。
  //
  // 为什么用广播而不是直接 import：直接 import 会让 CLIS 反向依赖 mind，
  // 于是"缺 mind 就装不上 CLIS"——破坏了"缺谁都能跑"。广播没有这个方向性。
  //
  // 载荷形状与探针登记一致（单个对象），但字段是信号定义。
  try {
    ctx.on?.('mind/register-signal', (payload) => {
      try {
        if (payload === null || typeof payload !== 'object') return;
        const { name, situation, words, weight, counterWords, owner } = payload;
        if (typeof name !== 'string' || !Array.isArray(words)) return;
        registerSignal({ name, situation, words, weight, counterWords, owner });
      } catch {
        /* 外部信号不合法 → 忽略它自己的事，不影响调度 */
      }
    });
  } catch {
    /* 宿主没有该事件 → 只能用内置信号，其他单元的词汇进不来 */
  }

  // —— 工具面编排：装配 waterfall 的返回值对 tools 是权威的 ——
  try {
    ctx.on?.('system-prompt/assemble', async (assembly, _context, next) => {
      const result = await next();
      const situation = currentSituationOf();
      // 处境未知 → 原样返回。宁可不动，也不要凭空猜一个顺序。
      if (situation === SITUATIONS.unknown) return result;
      try {
        return { ...result, tools: arrangeTools(result.tools, situation, { park: PARK_ENABLED }) };
      } catch {
        // 编排失败退回原装配 —— 工具面是主干道，这里绝不中断它。
        return result;
      }
    });
    assembleOk = typeof ctx.on === 'function';
  } catch {
    /* 同上：没有该事件就不做编排 */
  }

  // 注册成功也要记账 —— 探针唯一的事实来源就是这一行。
  // 漏了这一步，探针会永远报 not-applied（写了 record 却没调用，
  // 属于"看起来有探针但结论恒假"的那类缺陷）。
  //
  // 编排就绪的判据：assemble 监听器在，且**至少有一个**处境采集点可用
  // （inbox/claimed 或 pre-step）。两个都没有 → 处境恒 unknown → 重排永不发生。
  record('ok', assembleOk && (claimedOk || preStepOk));
  ctx.logger?.('mind')?.info?.(
    `心智索引已注册：${SECTION_NAME}（order ${SECTION_ORDER}）。` +
      `处境采集：${claimedOk ? 'agent/inbox/claimed' : ''}${claimedOk && preStepOk ? '+' : ''}${preStepOk && !claimedOk ? 'agent/pre-step' : ''}。`,
  );

  // —— 向监督层登记探针（零配合通道）——
  //
  // CLIS 的 `KNOWN_PROBE_KEYS` 是**硬编码白名单**，只有 clis 与 memory。
  // 靠它被发现，就意味着每个新插件都得改 CLIS 的代码才能进覆盖范围 ——
  // 那是"能力随组件增长而退化"的形态。CLIS 另有 `clis/register-probe`
  // 事件：任何插件主动广播自己的探针即可被收集，不需要谁改代码。
  //
  // 这里主动登记，所以**别人不必为 mind 改一行代码**。
  try {
    // 载荷是**单个对象** `{plugin, probe}`（CLIS 的 ProbeRegistry.listen
    // 按 payload.plugin / payload.probe 取值）——不是两个位置参数。
    ctx.emit?.('clis/register-probe', { plugin: 'mind', probe: healthProbe });
  } catch {
    /* 没有该事件（旧宿主/未装 CLIS）→ 探针只能靠白名单被发现，不影响其他功能 */
  }
}

/**
 * 取数据根目录（采样文件所在处）。
 *
 * 与记忆层同区：都在 `~/.dsh` 下，便于一起备份与清理。
 *
 * @returns {string} 数据根。
 */
function dshHomeOf() {
	return process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
}

/**
 * 取记忆根目录（每日记录所在处）。
 *
 * 与数据根同在 `~/.dsh` 下：`memory/` 是记忆根，`storages/` 是采样。
 * DSH_HOME 覆盖时两者一起跟着走。
 *
 * @returns {string} 记忆根绝对路径。
 */
function memoryRootOf() {
	return join(dshHomeOf(), 'memory');
}

/**
 * 取一条消息的文本。
 *
 * 用于 `agent/inbox/claimed` —— 该事件每次携带**一条**消息。
 *
 * @param message 单条消息。
 * @returns 文本；没有文本时返回空串。
 */
function textOfMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/**
 * 取最后一条 user 消息的文本。
 *
 * **只取最后一条**：往前的历史带着早已解决的老问题，用它判处境等于让
 * 几十步之前的状态决定现在看得到什么。
 *
 * @param messages 本步的入站消息。
 * @returns 文本；没有 user 文本时返回空串。
 */
function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const text = textOfMessage(m);
    if (text.length > 0) return text;
  }
  return '';
}

/**
 * 健康探针（供 dsh-clis 的监督层按导出名自动发现）。
 *
 * ## 为什么这个插件也需要探针
 *
 * 它的失败是**完全静默**的：分节没注册，系统提示里就少一段文字，
 * 而这与"注册了但没人遵守"在行为上看不出区别 —— 两者都不会报错。
 * 没有探针，这种状态会一直存在而无人知晓。
 *
 * ## 探针收不到 ctx
 *
 * 监督层是零参数调用 `exported.healthProbe.probe()`。所以 context 与
 * 注册结果都记在模块级变量里，由 `apply()` 写入，探针只读。
 *
 * ## 三条约束
 *
 * - 只读：只查，不改任何状态
 * - 不抛错：探针自己抛错比没探针更糟（会让监督层一起挂）
 * - code 稳定：代号会被人按名字检索，不能随文案改
 */
export const PROBE_CODES = {
  /** 插件没跑到 apply()（inject 未满足 / 模块加载失败）。 */
  notLoaded: 'mind.not-loaded',
  /** apply() 跑过，但 systemPrompt 服务不在，分节没注册。 */
  sectionMissing: 'mind.section-missing',
  /** 分节在，但工具面编排的事件源不可用 —— 编排静默不生效。 */
  orchestrationMissing: 'mind.orchestration-missing',
  /** 调度已接上，本轮命中处境信号。 */
  dispatched: 'mind.dispatched',
  /** 调度已接上，本轮无信号命中（工具面保持默认顺序，正常状态）。 */
  noSignal: 'mind.no-signal',
  /** 采样趋势（长期命中率）—— 词表是否跟得上真实说法的持续读数。 */
  trend: 'mind.trend',
  /** 留出基准命中率 —— 拿未参与修词表的真实用户原话测泛化性。 */
  benchmark: 'mind.benchmark',
  /** 信号清单（内置 / 外部贡献各多少条）—— 生态是否长出来的唯一可见证据。 */
  signals: 'mind.signals',
  /** 一切正常。 */
  ok: 'mind.ok',
};

/** `apply()` 的实测结果 —— 探针唯一的事实来源（不推断）。 */
let registration = { stage: 'not-applied' };

/** 编排事件源的实测结果（同样只读，不推断）。 */
let orchestration = { listeners: 'not-registered' };

/**
 * 记录 apply 的实测结果（由 apply() 调用，探针只读）。
 *
 * @param stage — 装载阶段结果。
 * @param listenersOk — 两个编排事件是否都注册上了。
 */
function record(stage, listenersOk) {
  registration = { stage };
  if (listenersOk !== undefined) {
    orchestration = { listeners: listenersOk ? 'ok' : 'unavailable' };
  }
}

/**
 * 登记一个处境信号 —— **让别的单元也能参与调度**。
 *
 * ## 为什么这是"固化"的关键
 *
 * 调度层若只认自己写死的词汇，它就只是把"每个插件各自说该用我"换成
 * "一个插件说该用谁"。真正的调度必须允许**被调度者贡献信号**：
 * CLIS 可以登记"因果信号"、memory 可以登记"记忆信号"，各自带自己的
 * 词表与反例，调度层不需要知道它们的存在。
 *
 * 登记不要求对方改任何代码，也不要求调度层改 —— 这就是零配合层。
 *
 * @param signal 信号定义（见 dispatch.js 的 SituationSignal）。
 * @returns 注销函数。
 */
export function registerSituationSignal(signal) {
  return registerSignal(signal);
}

/**
 * 列出全部已注册信号（内置 + 外部贡献）。
 *
 * @returns 信号列表。
 */
export function situationSignals() {
  return listSignals();
}

/**
 * 读最近一次判定的**可解释记录**（命中了哪些信号、落选哪些）。
 *
 * @returns 判定记录；还没有过则 null。
 */
export function lastDispatchDecision() {
  return lastDecisionOf();
}

/**
 * 只读工具：`mind_signals` —— 看调度当前覆盖了哪些词、谁贡献的。
 *
 * ## 为什么需要这个工具
 *
 * "外部单元到底贡献了没有"原本**看不出来**：
 *
 * - 探针 message 被 CLIS 的监督层压缩成代号，看不到正文
 * - 进程外的脚本读不到运行时注册的信号（模块级状态在宿主进程里）
 *
 * 结果是"机制可用但生态为空"与"生态已长出来"在观察上完全同形 ——
 * 又一次"绿灯不携带信息"。这个工具把那个区分变成一条命令。
 *
 * @param ctx 插件上下文。
 * @returns 注销函数；未注册时返回 undefined。
 */
export function registerSignalsTool(ctx) {
  let tool;
  try {
    tool = getDefineTool()({
      name: 'mind_signals',      description:
        'List the situation signals the dispatcher currently uses: built-in words plus what other plugins contributed. ' +
        'Each entry shows the signal name, its owner (which plugin registered it), the situation it points to, and its trigger words. ' +
        'Also reports the last dispatch decision (which signals hit, which missed) so "why this tool order" is answerable. ' +
        'Read-only.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute() {
        const signals = listSignals();
        const external = signals.filter((s) => s.owner && s.owner !== 'mind');
        const decision = lastDecisionOf();
        return {
          total: signals.length,
          builtin: signals.length - external.length,
          external: external.length,
          signals: signals.map((s) => ({
            name: s.name,
            owner: s.owner ?? 'mind',
            situation: s.situation,
            weight: s.weight ?? 1,
            words: s.words,
            ...(s.counterWords ? { counterWords: s.counterWords } : {}),
          })),
          external_owners: external.map((s) => s.owner),
          last_decision: decision
            ? {
                situation: decision.situation,
                unknown: decision.unknown,
                hits: decision.hits,
                misses: decision.misses,
                evidence: decision.evidence,
              }
            : null,
          current_situation: currentSituationOf(),
          trend: await readTrend(dshHomeOf()),
          // 留出基准：拿**从未参与修词表**的真实用户原话去测泛化性。
          // 与 trend 是两个指标：trend 看"真实使用里有多少判不出"，
          // benchmark 看"词表是不是只认见过的说法"。
          benchmark: benchmarkFromDailyLogs(memoryRootOf()),
        };
      },
    });
    // 注册走宿主的 tools 服务（与 memory-manager 同一形状）。
    const dispose = ctx.tools?.register?.(tool);
    ctx.logger?.('mind')?.info?.(
      `mind_signals 已注册（disposer=${typeof dispose}），信号 ${listSignals().length} 条` +
        `（外部 ${listSignals().filter((s) => s.owner && s.owner !== 'mind').length} 条）。`,
    );
    return typeof dispose === 'function' ? dispose : () => {};
  } catch (error) {
    // 拿不到 defineTool（宿主没有 dsh-tools）→ 本工具不注册，其它功能不受影响。
    //
    // ⚠️ 必须留痕：静默降级过一次（宿主定位失败 → 工具始终没注册，
    // 而探针只报 mind.ok，看起来一切正常）。**"降级要留痕"的第一条反例**。
    const reason = error instanceof Error ? error.message : String(error);
    ctx.logger?.('mind')?.warn?.(`mind_signals 工具未注册：${reason}`);
    return undefined;
  }
}

/** 供测试重置模块级状态（生产不用）。 */
export function __setSituationForTest(situation) {
  __resetSituationForTest();
  if (situation !== undefined && situation !== SITUATIONS.unknown) {
    __forceSituationForTest(situation);
  }
}

/**
 * 探针。零参数、只读、不抛错。
 *
 * @returns 探针结果。
 */
function probe() {
  const findings = [];
  const { stage } = registration;

  if (stage === 'not-applied') {
    findings.push({
      code: PROBE_CODES.notLoaded,
      severity: 'error',
      message: '插件尚未跑到 apply()，心智索引未注册。',
      hint: '查宿主启动日志里的 "did not activate"；常见原因是 inject 未满足。',
    });
  } else if (stage === 'section-missing') {
    findings.push({
      code: PROBE_CODES.sectionMissing,
      severity: 'error',
      message: 'systemPrompt 服务不可用，心智索引分节未注册 —— 提示里不会出现判断顺序。',
      hint: '确认 @deepseek-ai/dsh-base 正常装载（它提供 systemPrompt 服务）。',
    });
  } else {
    findings.push({
      code: PROBE_CODES.ok,
      severity: 'info',
      message: '心智索引分节已注册。',
    });
  }

  // 编排不可用**不拉红灯**：它是平铺工具面上的增强，缺了工具照常可用。
  // 但必须报出来 —— 否则"编排没生效"与"编排生效了但这一轮处境是 unknown"
  // 在观察上完全同形（都是工具面没变化），谁都看不出。
  if (stage === 'ok' && orchestration.listeners === 'unavailable') {
    findings.push({
      code: PROBE_CODES.orchestrationMissing,
      severity: 'info',
      message: '工具面编排未接入：宿主不提供 agent/pre-step 或 system-prompt/assemble 事件。工具照常可用，但不会按处境重排。',
      hint: '确认宿主版本支持这两个 waterfall 事件（cordis 4.0.5 起有）。',
    });
  }

  // 调度"有没有生效"与"这一轮有没有信号"必须可区分 ——
  // 两者在观察上同形（工具面都没变），所以把判定记账报出来。
  const decision = lastDecisionOf();
  if (stage === 'ok' && decision !== null) {
    if (decision.unknown) {
      findings.push({
        code: PROBE_CODES.noSignal,
        severity: 'info',
        message: '调度已接上，但本轮没有命中任何处境信号（工具面保持默认顺序 —— 正常状态，不是故障）。',
        hint: `已注册信号 ${listSignals().length} 条；若本该命中却没命中，查信号词表是否覆盖本轮的表述。`,
      });
    } else {
      findings.push({
        code: PROBE_CODES.dispatched,
        severity: 'info',
        message: `调度命中：处境「${decision.situation}」，信号 ${decision.hits.join('、') || '无'}。`,
      });
    }
  }

  // 信号清单要可见：**外部单元贡献了没有**，这是"机制可用但生态为空"
  // 与"生态已长出来"的唯一区别 —— 前者看不出来，后者一眼可见。
  //
  // ⚠️ 为什么按 owner 发**不同的 code**、而不把数字写进 message：
  // CLIS 的 clis_probe 只输出 code/count/plugins（message 属噪音、不转发），
  // 所以"外部贡献了几条"必须**编码进 code 本身**才在监督面可见。
  // code 要稳定，所以用"每个 owner 一个 code"而不是"数量进 code"（数量会变）。
  if (stage === 'ok') {
    const signals = listSignals();
    const external = signals.filter((s) => s.owner && s.owner !== 'mind');
    for (const owner of new Set(external.map((s) => s.owner))) {
      const owned = external.filter((s) => s.owner === owner);
      findings.push({
        code: `mind.signal-from-${owner}`,
        severity: 'info',
        message: `${owner} 贡献了 ${owned.length} 条处境信号：${owned.map((s) => s.name).join('、')}。`,
      });
    }
    findings.push({
      code: PROBE_CODES.signals,
      severity: 'info',
      message:
        `处境信号 ${signals.length} 条（内置 ${signals.length - external.length}，外部贡献 ${external.length}` +
        `${external.length > 0 ? '：' + external.map((s) => `${s.name}(${s.owner})`).join('、') : ''}）。`,
      hint:
        external.length === 0
          ? '尚无外部单元贡献信号 —— 各插件自己的领域词汇仍是盲区（机制可用但生态为空）'
          : '外部单元已贡献信号，调度覆盖到它们各自的领域。',
    });
  }

  // 采样趋势：无信号率是**长期**指标（词表跟不上真实说法时它先涨）。
  // 放在探针里，是因为它是"调度还灵不灵"的唯一持续读数 ——
  // 单轮的 no-signal 只是瞬时，趋势才是判断依据。
  //
  // ⚠️ 必须**同步**读（2026-11-02 对抗式审查修）。
  //
  // 旧写法在 `readTrend().then()` 里 push finding，而 `probe()` 早已在函数
  // 末尾 `return findings` —— 监督层拿到的是**定型快照**，那条 finding 永远
  // 不在里面。实测：同步返回只有 `mind.ok, mind.signals`；等 1 秒后同一个
  // 数组才多出 `mind.trend`，但监督层早就拿走了。
  //
  // 而 `mind.trend` 恰好是唯一上报"命中率趋势"的读数 —— 修好分母之后，
  // 它是判断"词表还跟不跟得上真实说法"的唯一依据。
  //
  // 同步读用 `readFileSync`：采样文件是本地小文件（每行几十字节），
  // 探针调用频率低，同步读的代价可接受；而异步读会让这条读数**根本不存在**。
  //
  // 不按 stage 门控：趋势是**历史**读数 —— 插件刚装载、或上一轮失败时，
  // 它依然是对"词表跟不跟得上"的唯一线索。把它藏在 stage==='ok' 后面，
  // 等于在最需要它的时候（出问题了）把它关掉。
  const trend = readTrendSync(dshHomeOf());
  if (trend.overall !== null) {
    const rate = Math.round((1 - trend.overall.unknownRate) * 100);
    findings.push({
      code: PROBE_CODES.trend,
      severity: 'info',
      message:
        `调度采样 ${trend.overall.total} 次：无信号率 ${Math.round(trend.overall.unknownRate * 100)}%` +
        `（命中率 ${rate}%）。无信号率走高 = 词表跟不上真实说法。`,
    });
  }

  // 留出基准命中率：拿**从未参与修词表**的真实用户原话去测。
  //
  // ⚠️ 这与上面的 trend 是**两个指标**，不能互相替代：
  // trend 看"真实使用里有多少判不出"，benchmark 看"词表是不是只认见过的说法"。
  // 只报一个就等于只回答了问题的一半。
  //
  // 基准缺失时不报 —— "没有可测的样本"是事实，不该编一个数出来。
  const benchmark = benchmarkFromDailyLogs(memoryRootOf());
  if (benchmark !== null) {
    findings.push({
      code: PROBE_CODES.benchmark,
      severity: 'info',
      message:
        `留出基准 ${benchmark.total} 条真实用户原话：命中率 ${Math.round((benchmark.rate ?? 0) * 100)}%` +
        `（命中 ${benchmark.hit}，判错 ${benchmark.missed}，无信号 ${benchmark.unknown}）。` +
        `基准样本不参与修词表 —— 它测的是泛化性，不是拟合度。`,
    });
  }

  const status = findings.some((f) => f.severity === 'error')
    ? 'failing'
    : findings.some((f) => f.severity === 'warn')
      ? 'degraded'
      : 'ok';

  return { plugin: 'dsh-agent-mind', status, findings };
}

/** 探针对象形态（监督层接受 `ns.healthProbe` 为对象含 `probe()`）。 */
export const healthProbe = { probe };
