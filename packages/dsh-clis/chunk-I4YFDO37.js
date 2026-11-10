import {
  CAUSAL_CLASSIFIER_SERVICE,
  CAUSAL_FEEDBACK_SERVICE,
  CAUSAL_ORCHESTRATOR_SERVICE,
  CAUSAL_STRATEGY_SERVICE,
  ClisContractError,
  ROLLBACK_LIMIT,
  Service,
  TYPE_LOCK_ROUNDS,
  initialState
} from "./chunk-I67UV77L.js";

// packages/clis-orchestrator/src/decide.ts
var ROLLBACK_LIMIT_DEFAULT = ROLLBACK_LIMIT;
var TYPE_LOCK_ROUNDS_DEFAULT = TYPE_LOCK_ROUNDS;
var LOCK_TRIGGER_THRESHOLD = 2;
var UNRESOLVED_SIGNALS = ["type_misjudged", "ineffective", "boundary_invalid"];
function fail(code, message, details) {
  throw new ClisContractError(code, message, details);
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function describeReceived(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  const kind = typeof value;
  if (kind === "string") {
    const text = value;
    return `string(${text.length <= 40 ? JSON.stringify(text) : `${JSON.stringify(text.slice(0, 40))}\u2026`})`;
  }
  if (kind === "object") return "object";
  return `${kind}(${String(value)})`;
}
function assertState(value, path) {
  const details = [];
  if (!isPlainObject(value)) {
    fail("INVALID_STATE", `${path} \u5FC5\u987B\u662F\u5BF9\u8C61`, [
      { path, expected: "object", received: describeReceived(value) }
    ]);
  }
  if (typeof value.round !== "number" || !Number.isInteger(value.round) || value.round < 0) {
    details.push({
      path: `${path}.round`,
      expected: "non-negative integer",
      received: describeReceived(value.round)
    });
  }
  if (typeof value.rollback_count !== "number" || !Number.isInteger(value.rollback_count) || value.rollback_count < 0) {
    details.push({
      path: `${path}.rollback_count`,
      expected: "non-negative integer",
      received: describeReceived(value.rollback_count)
    });
  }
  if (!Array.isArray(value.traces)) {
    details.push({
      path: `${path}.traces`,
      expected: "array",
      received: describeReceived(value.traces)
    });
  }
  if (!isPlainObject(value.oscillation)) {
    details.push({
      path: `${path}.oscillation`,
      expected: "object",
      received: describeReceived(value.oscillation)
    });
  }
  if (details.length > 0) fail("INVALID_STATE", `${path} \u4E0D\u662F\u5408\u6CD5\u7684\u7F16\u6392\u72B6\u6001`, details);
}
function assertRound(value, path) {
  const details = [];
  if (!isPlainObject(value)) {
    fail("INVALID_RESULT", `${path} \u5FC5\u987B\u662F\u5BF9\u8C61`, [
      { path, expected: "object", received: describeReceived(value) }
    ]);
  }
  if (!isPlainObject(value.execution)) {
    details.push({
      path: `${path}.execution`,
      expected: "object",
      received: describeReceived(value.execution)
    });
  }
  if (!isPlainObject(value.signal)) {
    details.push({
      path: `${path}.signal`,
      expected: "object",
      received: describeReceived(value.signal)
    });
  }
  if (!isPlainObject(value.path)) {
    details.push({
      path: `${path}.path`,
      expected: "object",
      received: describeReceived(value.path)
    });
  }
  if (details.length > 0) fail("INVALID_RESULT", `${path} \u4E0D\u662F\u5408\u6CD5\u7684\u4E00\u8F6E\u8F93\u5165`, details);
}
function resolveOptions(options) {
  if (options === void 0) {
    return { rollbackLimit: ROLLBACK_LIMIT_DEFAULT, lockRounds: TYPE_LOCK_ROUNDS_DEFAULT };
  }
  if (!isPlainObject(options)) {
    fail("INVALID_OPTIONS", "options \u5FC5\u987B\u662F\u5BF9\u8C61", [
      { path: "options", expected: "object", received: describeReceived(options) }
    ]);
  }
  const limit = options.rollback_limit;
  if (limit !== void 0 && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) {
    fail("INVALID_OPTIONS", "options.rollback_limit \u5FC5\u987B\u662F\u6B63\u6574\u6570", [
      {
        path: "options.rollback_limit",
        expected: "positive integer | undefined",
        received: describeReceived(limit)
      }
    ]);
  }
  const lock = options.lock_rounds;
  if (lock !== void 0 && (typeof lock !== "number" || !Number.isInteger(lock) || lock < 0)) {
    fail("INVALID_OPTIONS", "options.lock_rounds \u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570", [
      {
        path: "options.lock_rounds",
        expected: "non-negative integer | undefined",
        received: describeReceived(lock)
      }
    ]);
  }
  return {
    rollbackLimit: limit ?? ROLLBACK_LIMIT_DEFAULT,
    lockRounds: lock ?? TYPE_LOCK_ROUNDS_DEFAULT
  };
}
function bumpCounts(counts, causalType) {
  return { ...counts, [causalType]: (counts[causalType] ?? 0) + 1 };
}
function resetCount(counts, causalType) {
  const next = { ...counts };
  delete next[causalType];
  return next;
}
function buildTrace(round, roundNumber, action, rollbackCount, note) {
  return {
    round: roundNumber,
    causal_type: round.causal_type,
    path_id: round.path.path_id,
    execution_status: round.execution.status,
    signal_type: round.signal.signal_type,
    action,
    rollback_count: rollbackCount,
    note
  };
}
function decide(round, state, options) {
  assertRound(round, "round");
  assertState(state, "state");
  const { rollbackLimit, lockRounds } = resolveOptions(options);
  const signalType = round.signal.signal_type;
  const causalType = round.causal_type;
  const roundNumber = state.round + 1;
  const consecutive = state.oscillation.consecutive_rollbacks;
  const unresolved = UNRESOLVED_SIGNALS.includes(signalType);
  let draft;
  if (state.rollback_count >= rollbackLimit && unresolved) {
    draft = {
      action: "manual_intervention",
      reason: `\u56DE\u9000\u6B21\u6570\u5DF2\u8FBE\u4E0A\u9650 ${rollbackLimit} \u6B21\u4E14\u672C\u8F6E\u4ECD\u672A\u89E3\u51B3\uFF08${signalType}\uFF09\uFF1A\u9700\u4EBA\u5DE5\u4ECB\u5165\uFF0C\u5E76\u5DF2\u4FDD\u7559\u5B8C\u6574 trace`,
      rollbackCount: state.rollback_count,
      lockRemaining: state.oscillation.lock_remaining,
      consecutive: { ...consecutive }
    };
  } else if (state.oscillation.lock_remaining > 0 && signalType !== "effective") {
    draft = {
      action: "lock_and_continue",
      reason: `\u7C7B\u578B ${String(state.oscillation.locked_type)} \u5904\u4E8E\u9707\u8361\u9501\u5B9A\uFF0C\u8FD8\u5269 ${state.oscillation.lock_remaining} \u8F6E\uFF1A\u672C\u8F6E\u9501\u5B9A\u7EE7\u7EED\uFF0C\u4E0D\u6267\u884C\u56DE\u9000`,
      rollbackCount: state.rollback_count,
      lockedType: state.oscillation.locked_type,
      lockRemaining: state.oscillation.lock_remaining - 1,
      consecutive: { ...consecutive }
    };
  } else if (signalType === "boundary_invalid") {
    draft = {
      action: "rollback_to_boundary",
      reason: "\u4F18\u5316\u5DF2\u8D8A\u51FA\u9884\u8BBE\u8FB9\u754C\uFF1A\u56DE\u9000\u5230\u8FB9\u754C\u8BBE\u5B9A\uFF0C\u91CD\u65B0\u754C\u5B9A\u53EF\u884C\u52A8\u4F5C\u8303\u56F4",
      rollbackCount: state.rollback_count + 1,
      lockRemaining: state.oscillation.lock_remaining,
      consecutive: { ...consecutive }
    };
  } else if (signalType === "type_misjudged") {
    const nextConsecutive = bumpCounts(consecutive, causalType);
    const reached = (nextConsecutive[causalType] ?? 0) >= LOCK_TRIGGER_THRESHOLD;
    draft = {
      action: "rollback_to_classifier",
      reason: `\u7C7B\u578B\u5047\u8BBE ${causalType} \u88AB\u5224\u5B9A\u8BEF\u5224\uFF1A\u56DE\u9000\u5230\u5206\u7C7B\u5668\u91CD\u65B0\u5224\u65AD${reached ? `\uFF0C\u5E76\u9501\u5B9A\u8BE5\u7C7B\u578B ${lockRounds} \u8F6E\u4EE5\u6291\u5236\u9707\u8361` : ""}`,
      rollbackCount: state.rollback_count + 1,
      lockRemaining: reached ? lockRounds : state.oscillation.lock_remaining,
      consecutive: nextConsecutive
    };
    const retry = round.signal.suggested_rollback?.target_type;
    if (retry !== void 0) draft.retryType = retry;
    const retryKind = round.signal.suggested_rollback?.kind;
    if (retryKind !== void 0) draft.retryKind = retryKind;
    if (reached) draft.lockedType = causalType;
  } else if (signalType === "ineffective") {
    draft = {
      action: "switch_path",
      reason: `\u7ED3\u679C\u504F\u79BB\u4F46\u7C7B\u578B\u5047\u8BBE\u4ECD\u6210\u7ACB\uFF1A\u6362\u4E00\u6761\u5019\u9009\u8DEF\u5F84\u91CD\u8BD5`,
      rollbackCount: state.rollback_count,
      lockRemaining: state.oscillation.lock_remaining,
      consecutive: { ...consecutive }
    };
    const nextPath = round.next_path_id;
    if (nextPath !== void 0) draft.nextPathId = nextPath;
  } else if (signalType === "effective") {
    draft = {
      action: "continue",
      reason: "\u672C\u8F6E\u6709\u6548\uFF1A\u4FDD\u6301\u5F53\u524D\u7C7B\u578B\u4E0E\u8DEF\u5F84\u7EE7\u7EED\u63A8\u8FDB\uFF0C\u5E76\u6E05\u96F6\u9707\u8361\u8BA1\u6570",
      rollbackCount: state.rollback_count,
      lockRemaining: 0,
      consecutive: resetCount(consecutive, causalType)
    };
  } else {
    draft = {
      action: "continue",
      reason: `\u4FE1\u53F7\u7C7B\u578B ${String(signalType)} \u672A\u547D\u4E2D\u4EFB\u4F55\u7F16\u6392\u89C4\u5219\uFF1A\u515C\u5E95\u4E3A\u7EE7\u7EED`,
      rollbackCount: state.rollback_count,
      lockRemaining: state.oscillation.lock_remaining,
      consecutive: { ...consecutive }
    };
  }
  const decision = {
    action: draft.action,
    reason: draft.reason,
    rollback_count: draft.rollbackCount
  };
  if (draft.retryType !== void 0) decision.retry_type = draft.retryType;
  if (draft.retryKind !== void 0) decision.retry_kind = draft.retryKind;
  if (draft.nextPathId !== void 0) decision.next_path_id = draft.nextPathId;
  if (draft.lockedType !== void 0) decision.locked_type = draft.lockedType;
  const trace = buildTrace(round, roundNumber, draft.action, draft.rollbackCount, draft.reason);
  const nextState = {
    round: roundNumber,
    rollback_count: draft.rollbackCount,
    oscillation: {
      consecutive_rollbacks: draft.consecutive,
      lock_remaining: draft.lockRemaining,
      ...draft.lockedType !== void 0 ? { locked_type: draft.lockedType } : {}
    },
    traces: [...state.traces, trace]
  };
  return { decision, nextState };
}

// packages/clis-orchestrator/src/service.ts
var DEFAULT_MAX_ROUNDS = 32;
function orderByExecutable(paths) {
  return [...paths].sort((left, right) => {
    if (left.executable === right.executable) return 0;
    return left.executable ? -1 : 1;
  });
}
var OrchestratorServiceImpl = class extends Service {
  constructor(ctx) {
    super(ctx, CAUSAL_ORCHESTRATOR_SERVICE);
  }
  /** 与纯函数 decide 结论完全一致的异步包装。 */
  async decide(round, state, options) {
    return decide(round, state, options);
  }
  /**
   * 跑完整闭环：分类 → 匹配 → 执行 → 反馈 → 继续/换路径/回退/锁定，
   * 直到拿到有效结果、或回退耗尽转人工介入、或无可用路径。
   *
   * 这里只有"编排"：所有判断、匹配、反馈都委托给注入的服务。
   */
  async run(problem, options = {}) {
    const classifier = this.ctx[CAUSAL_CLASSIFIER_SERVICE];
    const strategy = this.ctx[CAUSAL_STRATEGY_SERVICE];
    const feedback = this.ctx[CAUSAL_FEEDBACK_SERVICE];
    const boundary = options.boundary ?? { forbidden_actions: [] };
    const executor = options.executor ?? { execute: async () => ({ status: "ok", detail: "\u9ED8\u8BA4\u6267\u884C\u5668\uFF1A\u89C6\u4E3A\u6210\u529F" }) };
    const maxRounds = options.max_rounds ?? DEFAULT_MAX_ROUNDS;
    let state = options.state ?? initialState();
    let classification = await classifier.classify(problem);
    let paths = orderByExecutable(await strategy.match(classification, boundary));
    let pathIndex = 0;
    let execution;
    let signal;
    let decision = {
      action: "continue",
      reason: "\u5C1A\u672A\u5F00\u59CB",
      rollback_count: state.rollback_count
    };
    for (let guard = 0; guard < maxRounds; guard += 1) {
      const candidate = paths[pathIndex];
      if (candidate === void 0) {
        return {
          outcome: "exhausted",
          state,
          classification,
          decision,
          reason: `\u5019\u9009\u8DEF\u5F84\u5DF2\u7528\u5C3D\uFF08\u7C7B\u578B ${classification.causal_type}\uFF09\uFF0C\u65E0\u53EF\u7528\u8DEF\u5F84\u53EF\u7EE7\u7EED`,
          ...execution !== void 0 ? { execution } : {},
          ...signal !== void 0 ? { signal } : {}
        };
      }
      execution = await strategy.execute(candidate, { boundary, executor });
      signal = await feedback.detect(
        {
          result: execution,
          classification: {
            causal_type: classification.causal_type,
            confidence: classification.confidence
          },
          boundary: { forbidden_actions: boundary.forbidden_actions }
        },
        options.history !== void 0 ? { history: options.history } : void 0
      );
      const stepSignals = execution.signals.filter((item) => item.step_index >= 0);
      const producedChange = stepSignals.some((item) => item.kind === "observed");
      const observedOnly = stepSignals.filter((item) => item.kind === "observed_only").length;
      const blockedSteps = stepSignals.filter((item) => item.kind === "failed").length;
      const noChangeAtAll = !producedChange && observedOnly > 0;
      if (noChangeAtAll) {
        const blocked = execution.blocked_actions.map((item) => item.action);
        const blockedHint = blocked.length > 0 ? `\uFF08${[...new Set(blocked)].join(", ")}\uFF09` : "";
        const writesBlocked = blockedSteps > 0;
        return {
          outcome: "manual_intervention",
          state: {
            ...state,
            round: state.round + 1,
            traces: [
              ...state.traces,
              {
                round: state.round + 1,
                causal_type: classification.causal_type,
                path_id: candidate.path_id,
                execution_status: execution.status,
                signal_type: signal.signal_type,
                action: "manual_intervention",
                rollback_count: state.rollback_count,
                note: writesBlocked ? `\u8DEF\u5F84 ${candidate.path_id} \u5168\u90E8\u6B65\u9AA4\u4EC5\u4E3A\u53EA\u8BFB\u89C2\u6D4B\uFF0C\u672A\u4EA7\u751F\u4EFB\u4F55\u6539\u52A8\uFF1A\u9700\u6388\u6743\u5199\u52A8\u4F5C` : `\u8DEF\u5F84 ${candidate.path_id} \u662F\u7EAF\u53EA\u8BFB\u89C2\u6D4B\u8DEF\u5F84\uFF08${observedOnly} \u6B65\uFF09\uFF0C\u672C\u8DEF\u5F84\u4E0D\u542B\u5199\u52A8\u4F5C\uFF1A\u9700\u6309\u89C2\u6D4B\u8BA1\u5212\u91C7\u96C6\u6570\u636E`
              }
            ]
          },
          classification,
          execution,
          signal,
          decision: {
            action: "manual_intervention",
            reason: writesBlocked ? "\u672C\u8DEF\u5F84\u5728\u53EA\u8BFB\u6A21\u5F0F\u4E0B\u65E0\u5B9E\u8D28\u6539\u52A8\uFF1A\u8981\u7EE7\u7EED\u5FC5\u987B\u663E\u5F0F\u6388\u6743\u5199\u52A8\u4F5C\uFF08allow_writes\uFF09\uFF0C\u6362\u8DEF\u5F84\u4E0D\u4F1A\u6709\u4E0D\u540C\u7ED3\u679C" : "\u672C\u8DEF\u5F84\u5168\u90E8\u4E3A\u53EA\u8BFB\u89C2\u6D4B\u3001\u4E0D\u542B\u5199\u52A8\u4F5C\uFF1A\u8BF7\u6309\u89C2\u6D4B\u8BA1\u5212\u91C7\u96C6\u6570\u636E\uFF0C\u56DE\u586B last_outcome \u540E\u518D\u8C03\u7528\uFF1B\u6362\u8DEF\u5F84\u540C\u6837\u53EA\u662F\u53E6\u4E00\u4EFD\u89C2\u6D4B\u8BA1\u5212",
            rollback_count: state.rollback_count
          },
          reason: writesBlocked ? `\u9700\u8981\u6388\u6743\u624D\u80FD\u63A8\u8FDB\uFF1A${observedOnly} \u6B65\u53EA\u8BFB\u5B8C\u3001${blockedSteps} \u6B65\u5199\u52A8\u4F5C\u88AB\u62E6\u4E0B${blockedHint}\uFF0C\u7EE7\u7EED\u6362\u8DEF\u5F84\u4E0D\u4F1A\u6709\u4E0D\u540C\u7ED3\u679C` : `\u672C\u8DEF\u5F84\u662F\u7EAF\u53EA\u8BFB\u89C2\u6D4B\uFF08${observedOnly} \u6B65\uFF0C\u65E0\u5199\u52A8\u4F5C\uFF09\uFF1A\u89C2\u6D4B\u8BA1\u5212\u5DF2\u7ED9\u51FA\uFF0C\u91C7\u96C6\u6570\u636E\u540E\u56DE\u586B last_outcome \u5373\u53EF\u63A8\u8FDB`
        };
      }
      const outcome = decide(
        {
          problem,
          boundary,
          path: candidate,
          execution,
          signal,
          causal_type: classification.causal_type
        },
        state,
        options
      );
      decision = outcome.decision;
      state = outcome.nextState;
      if (decision.action === "continue" || decision.action === "lock_and_continue") {
        return {
          outcome: "effective",
          state,
          classification,
          execution,
          signal,
          decision,
          reason: decision.action === "continue" ? "\u95ED\u73AF\u5B8C\u6210\uFF1A\u7ED3\u679C\u6709\u6548" : "\u95ED\u73AF\u5B8C\u6210\uFF1A\u9707\u8361\u9501\u5B9A\u671F\u5185\u6309\u5F53\u524D\u7C7B\u578B\u7EE7\u7EED\uFF0C\u672A\u89E6\u53D1\u56DE\u9000"
        };
      }
      if (decision.action === "manual_intervention") {
        return {
          outcome: "manual_intervention",
          state,
          classification,
          execution,
          signal,
          decision,
          reason: `\u56DE\u9000\u6B21\u6570\u5DF2\u8FBE\u4E0A\u9650\uFF08${state.rollback_count}/${options.rollback_limit ?? ROLLBACK_LIMIT_DEFAULT}\uFF09\uFF1A\u9700\u4EBA\u5DE5\u4ECB\u5165\uFF0C\u5B8C\u6574 trace \u5DF2\u4FDD\u7559`
        };
      }
      if (decision.action === "switch_path") {
        if (pathIndex + 1 < paths.length) {
          pathIndex += 1;
          continue;
        }
        if (state.rollback_count < (options.rollback_limit ?? ROLLBACK_LIMIT_DEFAULT)) {
          classification = await classifier.classify(problem);
          paths = orderByExecutable(await strategy.match(classification, boundary));
          pathIndex = 0;
          state = {
            ...state,
            rollback_count: state.rollback_count + 1
          };
          continue;
        }
        return {
          outcome: "manual_intervention",
          state,
          classification,
          decision: {
            action: "manual_intervention",
            reason: `\u5019\u9009\u8DEF\u5F84\u5DF2\u7528\u5C3D\u4E14\u56DE\u9000\u6B21\u6570\u5DF2\u8FBE\u4E0A\u9650\uFF1A\u9700\u4EBA\u5DE5\u4ECB\u5165`,
            rollback_count: state.rollback_count
          },
          execution,
          signal,
          reason: "\u5019\u9009\u8DEF\u5F84\u5DF2\u7528\u5C3D\u4E14\u56DE\u9000\u6B21\u6570\u5DF2\u8FBE\u4E0A\u9650\uFF1A\u9700\u4EBA\u5DE5\u4ECB\u5165"
        };
      }
      if (decision.action === "rollback_to_classifier") {
        classification = await classifier.classify(problem);
        paths = orderByExecutable(await strategy.match(classification, boundary));
        pathIndex = 0;
        continue;
      }
      if (decision.action === "rollback_to_boundary") {
        paths = orderByExecutable(await strategy.match(classification, boundary));
        pathIndex = 0;
        continue;
      }
    }
    return {
      outcome: "manual_intervention",
      state,
      classification,
      decision,
      reason: `\u5DF2\u8FBE\u6700\u5927\u8F6E\u6570\u4FDD\u62A4\u4E0A\u9650 ${maxRounds}\uFF1A\u505C\u6B62\u95ED\u73AF\uFF0C\u9700\u4EBA\u5DE5\u4ECB\u5165`,
      ...execution !== void 0 ? { execution } : {},
      ...signal !== void 0 ? { signal } : {}
    };
  }
  /**
   * 串起一轮闭环：分类 → 生成路径 → 执行 → 反馈 → 决策。
   * 四个环节全部委托给注入的服务，本方法只做编排。
   */
  async runRound(problem, boundary, options) {
    const classifier = this.ctx[CAUSAL_CLASSIFIER_SERVICE];
    const strategy = this.ctx[CAUSAL_STRATEGY_SERVICE];
    const feedback = this.ctx[CAUSAL_FEEDBACK_SERVICE];
    const classification = await classifier.classify(problem);
    let path = options.path;
    if (path === void 0) {
      const candidates = await strategy.match(classification, boundary);
      path = candidates.find((candidate) => candidate.executable) ?? candidates[0];
    }
    if (path === void 0) {
      throw new Error("\u7B56\u7565\u672A\u751F\u6210\u4EFB\u4F55\u5019\u9009\u8DEF\u5F84\uFF0C\u65E0\u6CD5\u7F16\u6392\u672C\u8F6E");
    }
    const execution = await strategy.execute(path, {
      boundary,
      executor: options.executor
    });
    const signal = await feedback.detect(
      {
        result: execution,
        classification: {
          causal_type: classification.causal_type,
          confidence: classification.confidence
        },
        boundary: { forbidden_actions: boundary.forbidden_actions }
      },
      options.history !== void 0 ? { history: options.history } : void 0
    );
    const state = options.state ?? initialState();
    const { decision, nextState } = decide(
      {
        problem,
        boundary,
        path,
        execution,
        signal,
        causal_type: classification.causal_type
      },
      state,
      options
    );
    const trace = nextState.traces[nextState.traces.length - 1];
    if (trace === void 0) {
      throw new Error("\u51B3\u7B56\u672A\u4EA7\u751F trace \u2014\u2014 \u8FDD\u53CD\u300C\u5B8C\u6574 trace\u300D\u786C\u7EA6\u675F");
    }
    return { trace, decision, state: nextState };
  }
};

// packages/clis-orchestrator/src/index.ts
var name = "clis-orchestrator";
var inject = [
  CAUSAL_CLASSIFIER_SERVICE,
  CAUSAL_STRATEGY_SERVICE,
  CAUSAL_FEEDBACK_SERVICE
];
function apply(ctx) {
  ctx.plugin(OrchestratorServiceImpl);
}

export {
  ROLLBACK_LIMIT_DEFAULT,
  TYPE_LOCK_ROUNDS_DEFAULT,
  decide,
  OrchestratorServiceImpl,
  name,
  inject,
  apply
};
