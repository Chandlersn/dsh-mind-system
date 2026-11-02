/**
 * 处境判定与记账 —— 把"何时判、在哪判、算什么"从索引文件里拆出来。
 *
 * ## 为什么拆出来（2026-11-02 对抗式审查的结论）
 *
 * 原来的做法是：在 `agent/pre-step` 里判处境、在 `system-prompt/assemble` 里
 * 用它重排工具面。这两件事在宿主里的次序是**反的**：
 *
 * ```
 * dsh-agent-loop/lib/index.js:906   const claimed = this.inbox.claim(...)   ← 拿到本轮输入
 * dsh-agent-loop/lib/index.js:907   const assembly = await ...assemble(...)  ← 工具面在此定稿
 * dsh-agent-loop/lib/index.js:909   await waterfall("agent/pre-step", ...)   ← 处境在此才判出
 * ```
 *
 * 后果是"重排永远晚一步"：
 *
 * - 第 1 步（模型第一次回应用户、决定用哪个工具的那一步）用的还是默认顺序
 * - 第 2 步用上了第 1 步判出的处境 —— 但此时模型已经在干活了
 * - 第 2 步起 inbox 为空，处境被重置成 unknown → 第 3 步又变回默认顺序
 *
 * 于是一个 turn 内工具面**变动两次**。而宿主的 `headerEquals` 是**按顺序**
 * 比较工具面的（dsh-session/lib/types/request-header.js:44），顺序一变就判
 * "工具面变了" → `startsSeries=true` → `project()` 替换全部系统提示节点 →
 * **请求序列重启、提示缓存前缀作废**。
 *
 * 也就是说：收益在第 1 步（没有），代价在第 2 步（全付）。
 *
 * ## 修法：换一条更早的信号
 *
 * `inbox.claim()` 在 `assemble()` **之前**发出 `agent/inbox/claimed`：
 *
 * ```
 * dsh-agent-loop/lib/index.js:103-111
 *   claim(target, turn) {
 *     ...
 *     for (const message of claimed) this.dispatch.emit("agent/inbox/claimed", { message, turn });
 *     return claimed;
 *   }
 * ```
 *
 * 这个事件携带用户消息本身，且发生在装配之前。所以改成：
 *
 * - **在 `agent/inbox/claimed` 里判处境** → 工具面定稿时处境已经就位
 * - **保留 `agent/pre-step` 作为兜底** → 老宿主没有 `inbox/claimed` 时仍能工作
 *
 * 两条信号源的判定结果一致时不会有任何额外代价；不一致时以先到的为准
 * （`inbox/claimed` 更早也更权威）。
 *
 * ## 为什么采样只记"有用户文本"的判定
 *
 * 原来的采样在**每个 step** 记一次。但宿主一个 turn 里，第 2 步起 inbox 已经
 * 被 claim 干净 —— `claimed` 是空数组，判出来必然是 unknown。
 *
 * 实测采样文件 362 行里 351 行是空输入（哈希 = sha256(空串)），空/非空严格
 * 交替呈轮次结构。把这些算进分母，"无信号率"就成了**空输入率**：
 *
 * ```
 * 步骤口径：351/362 = 97% 无信号 → "调度基本失灵"
 * 轮次口径：  4/14 = 27% 无信号 → 命中率 73.3%
 * ```
 *
 * 同一份数据，两个口径给出相反的结论。而探针还把它归因为"词表跟不上真实
 * 说法"——把一个**分母错误**说成了**词表问题**。
 *
 * 判据：只有**判出过内容的判定**才进采样。空输入的判定不记。
 * 这样"命中率"的单位回到"一次用户输入"，而不是"一个 step"。
 *
 * @module src/situation
 */

import { explainSituation, recordDecision } from './dispatch.js';
import { SITUATIONS } from './orchestrate.js';

/**
 * 最近一次判定的可解释记录（模块级）。
 *
 * @type {{situation: string, unknown: boolean, hits: string[], misses: string[], evidence: Record<string, number>, text: string}|null}
 */
let lastDecision = null;

/**
 * 当前处境（模块级）。
 *
 * 初始值刻意是 unknown：还没看到任何输入时不该假装知道该优先什么。
 *
 * @type {string}
 */
let currentSituation = SITUATIONS.unknown;

/**
 * 记一次判定并更新当前处境。
 *
 * ## 为什么"空输入"要显式区分
 *
 * 空输入的判定**不覆盖**已有处境。理由：宿主第 2 步起 inbox 为空，
 * 那是"这一轮没有新输入"，不是"用户没有表达任何处境"。若让它把处境重置成
 * unknown，工具面就会在 turn 中途变回默认顺序 —— 那正是本次要修的抖动。
 *
 * @param {string} text 本轮输入文本。
 * @returns {object} 判定结果。
 */
export function judge(text) {
  const decision = explainSituation(text);
  decision.text = text;
  recordDecision(decision);
  lastDecision = decision;

  // 空输入（没有用户文本）→ 不动处境，但仍然记账：
  // "这一轮没信号"必须可查，否则它与"调度没生效"在观察上同形。
  if (text.length > 0) {
    currentSituation = decision.unknown ? SITUATIONS.unknown : decision.situation;
  }
  return decision;
}

/**
 * 读当前处境（只读）。
 *
 * @returns {string} 处境代号。
 */
export function currentSituationOf() {
  return currentSituation;
}

/**
 * 读最近一次判定（只读）。
 *
 * @returns {object|null} 判定记录；还没有过则 null。
 */
export function lastDecisionOf() {
  return lastDecision;
}

/**
 * 重置模块级状态（仅测试用）。
 *
 * @internal
 */
export function __resetSituationForTest() {
  lastDecision = null;
  currentSituation = SITUATIONS.unknown;
}

/**
 * 直接设定当前处境（仅测试用）。
 *
 * 存在的理由：真实处境只能由 `judge()` 从输入推出，而 `judge()` 判出
 * unknown 时**不覆盖**已有处境（见上）。测试要构造"处境已知"的状态，
 * 需要一个不经过输入的入口。
 *
 * @param {string} situation 处境代号。
 * @internal
 */
export function __forceSituationForTest(situation) {
  currentSituation = situation;
}
