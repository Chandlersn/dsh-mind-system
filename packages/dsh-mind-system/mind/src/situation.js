/** Agent-scoped situation state. An instance belongs to one plugin context. */
import { explainSituation, recordDecision } from './dispatch.js';
import { SITUATIONS } from './orchestrate.js';

// Diagnostic summary only; never used to arrange an agent's tools.
let latestDecision = null;

/**
 * 每个 agent 的处境状态。
 *
 * ## 三件事必须分开存（2026-11-03）
 *
 * 上一版把"处境"当成一个字符串塞进 WeakMap，于是下面三件事无法区分：
 *
 * 1. 插件**判出了**什么（`decision`）
 * 2. 插件**提供了**哪条引导（`guidance` —— 是否真的据此重排了工具面）
 * 3. 模型**照做了**没有（`followed` —— 由 tools/result 观察得到）
 *
 * 这三件事在旧实现里同形："工具面没变化"既可能是判成 unknown，
 * 也可能是判出了但被克制闸门拦下，还可能是判出了、也重排了，
 * 而模型压根没用那个工具族。三者对维护者的含义完全不同。
 *
 * 因此状态里同时留 `decision`（判断）、`guidance`（提供的引导）、
 * `outcome`（模型行为），探针与工具分别读各自那一段。
 */
export function createSituationStore() {
  let states = new WeakMap();
  let unscoped = {};
  const keyOf = (agent) => (agent !== null && (typeof agent === 'object' || typeof agent === 'function')) ? agent : unscoped;
  const stateOf = (agent) => states.get(keyOf(agent));

  /** 取（或建）一个 agent 的状态槽。 */
  const ensure = (agent) => {
    const key = keyOf(agent);
    let state = states.get(key);
    if (state === undefined) {
      state = {
        /** 当前处境的代号（工具面按它排序）。 */
        situation: SITUATIONS.unknown,
        /** 最近一次判定结果（完整可解释记录）。 */
        decision: null,
        /** 最近一次**实际提供给 DSH 的引导**；null = 没提供。 */
        guidance: null,
        /** 由 tools/result 观察到的模型行为（不是推断）。 */
        outcome: { calls: [], matched: null },
      };
      states.set(key, state);
    }
    return state;
  };

  return {
    judge(text, agent) {
      const decision = explainSituation(text);
      // The raw text is needed only for this call's optional sampling.
      const snapshot = { ...decision };
      latestDecision = snapshot;
      recordDecision(snapshot);
      if (String(text).length > 0) {
        const state = ensure(agent);
        state.decision = snapshot;
        // ⚠️ 克制闸门：判出但势均力敌（ambiguous）时，处境保持 unknown ——
        // 于是工具面不动。判断照常记录，**引导不发出**。
        // 宁可不动，也不要在"两类势均力敌"时把模型推向其中一族。
        state.situation = decision.unknown || decision.ambiguous ? SITUATIONS.unknown : decision.situation;
        // 新一轮输入到来 → 上一轮的引导与观察作废（它们是"上一轮"的事实）。
        state.guidance = null;
        state.outcome = { calls: [], matched: null };
      }
      return { ...decision, text };
    },

    currentSituationOf(agent) { return stateOf(agent)?.situation ?? SITUATIONS.unknown; },

    lastDecisionOf(agent) { return stateOf(agent)?.decision ?? null; },

    /**
     * 记账：本轮**实际提供**给 DSH 的引导。
     *
     * 由 assemble 监听器在真正重排工具面后调用 —— 注意是"重排之后"，
     * 不是"判定之后"。判定与提供是两件事：判出了但没重排（unknown /
     * ambiguous / assemble 事件缺失）时，这里不该有记录。
     *
     * @param agent agent 身份。
     * @param guidance `{situation, arranged, at}`。
     */
    recordGuidance(agent, guidance) {
      const state = ensure(agent);
      state.guidance = guidance;
    },

    /** 读本轮实际提供的引导；没提供则为 null。 */
    guidanceOf(agent) { return stateOf(agent)?.guidance ?? null; },

    /**
     * 记账：观察到一个工具调用（来自 tools/result）。
     *
     * 只记名字，不记参数 —— 参数里可能有路径、密钥、用户数据。
     *
     * @param agent agent 身份。
     * @param toolName 被调用的工具名。
     */
    recordToolCall(agent, toolName) {
      const state = ensure(agent);
      if (typeof toolName !== 'string' || toolName.length === 0) return;
      // 有上限：长会话里工具调用会很多，这里只留最近的若干个。
      state.outcome.calls.push(toolName);
      if (state.outcome.calls.length > 50) state.outcome.calls.shift();
      state.outcome.matched = null; // 有新的调用 → 上一轮的比对结论作废
    },

    /**
     * 读模型行为观察：`{calls, matched}`。
     *
     * `matched` 是 null 表示**还没比对**（或无法比对），不是"没照做"。
     * 这个区分很重要：把"没观察"报成"没照做"，等于用缺失当阴性证据。
     */
    outcomeOf(agent) { return stateOf(agent)?.outcome ?? { calls: [], matched: null }; },

    /** 记一次"引导是否被照做"的比对结论。 */
    recordFollowed(agent, followed) {
      const state = ensure(agent);
      state.outcome.matched = followed;
    },

    reset() { states = new WeakMap(); unscoped = {}; },
    force(situation, agent) { ensure(agent).situation = situation; },
  };
}

// Compatibility helpers for direct consumers; plugin instances use their own store.
const defaultStore = createSituationStore();
export const judge = (text, agent) => defaultStore.judge(text, agent);
export const lastDecisionOf = () => latestDecision;

// 2026-11-05（审查发现 #4，实测复现）：`apply()` 判进自己私有的 situations
// store，而对外导出的 `currentSituationOf` 曾固定读 defaultStore —— 发布接口
// 永远返回 unknown，看起来能用、实际是扇假门。这里让插件实例把自己的 store
// 登记为 active，导出接口优先读它；没有实例时回落 defaultStore，保证
// interfaces/regressions 那批直接使用兼容层的测试不受影响。
let activeStore = null;
export function setActiveStore(store) { activeStore = store ?? null; }
export const currentSituationOf = (agent) =>
	(activeStore ?? defaultStore).currentSituationOf(agent);
export function __resetSituationForTest() {
	defaultStore.reset();
	if (activeStore && activeStore !== defaultStore) activeStore.reset();
	activeStore = null;
	latestDecision = null;
}
export function __forceSituationForTest(situation) { defaultStore.force(situation); }
