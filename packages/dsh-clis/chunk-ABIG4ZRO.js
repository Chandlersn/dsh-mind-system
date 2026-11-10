import {
  CAUSAL_FEEDBACK_SERVICE,
  ClisContractError,
  FEEDBACK_SIGNAL_TYPES,
  Service,
  isCausalType
} from "./chunk-I67UV77L.js";

// packages/clis-feedback/src/detect.ts
var FEEDBACK_RULES_VERSION = "1.0.0";
var DEFAULT_MAX_ROUNDS = 3;
var PATTERN_UNILATERAL = "unilateral_definition_change";
var PATTERN_FEEDBACK_INTRODUCED = "feedback_introduced";
var PATTERN_WORSENED = "worsened";
var REPEATED_DEVIATION_THRESHOLD = 1;
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
function assertResult(value, path) {
  const details = [];
  if (!isPlainObject(value)) {
    fail("INVALID_RESULT", `${path} \u5FC5\u987B\u662F\u5BF9\u8C61`, [
      { path, expected: "object", received: describeReceived(value) }
    ]);
  }
  if (value.status !== "succeeded" && value.status !== "failed" && value.status !== "blocked") {
    details.push({
      path: `${path}.status`,
      expected: "'succeeded' | 'failed' | 'blocked'",
      received: describeReceived(value.status)
    });
  }
  if (!Array.isArray(value.signals)) {
    details.push({
      path: `${path}.signals`,
      expected: "array",
      received: describeReceived(value.signals)
    });
  } else {
    value.signals.forEach((item, index) => {
      if (!isPlainObject(item)) {
        details.push({
          path: `${path}.signals[${index}]`,
          expected: "object",
          received: describeReceived(item)
        });
        return;
      }
      if (typeof item.kind !== "string") {
        details.push({
          path: `${path}.signals[${index}].kind`,
          expected: "string",
          received: describeReceived(item.kind)
        });
      }
      if (typeof item.detail !== "string") {
        details.push({
          path: `${path}.signals[${index}].detail`,
          expected: "string",
          received: describeReceived(item.detail)
        });
      }
    });
  }
  if (value.blocked_actions !== void 0 && !Array.isArray(value.blocked_actions)) {
    details.push({
      path: `${path}.blocked_actions`,
      expected: "array | undefined",
      received: describeReceived(value.blocked_actions)
    });
  }
  if (details.length > 0) fail("INVALID_RESULT", `${path} \u4E0D\u662F\u5408\u6CD5\u7684\u6267\u884C\u7ED3\u679C`, details);
}
function assertClassificationRef(value, path) {
  const details = [];
  if (!isPlainObject(value)) {
    fail("INVALID_CLASSIFICATION", `${path} \u5FC5\u987B\u662F\u5BF9\u8C61`, [
      { path, expected: "object", received: describeReceived(value) }
    ]);
  }
  if (!isCausalType(value.causal_type)) {
    details.push({
      path: `${path}.causal_type`,
      expected: "CausalType",
      received: describeReceived(value.causal_type)
    });
  }
  if (details.length > 0) fail("INVALID_CLASSIFICATION", `${path} \u4E0D\u662F\u5408\u6CD5\u7684\u7C7B\u578B\u5047\u8BBE`, details);
}
function assertBoundary(value, path) {
  const details = [];
  if (!isPlainObject(value)) {
    fail("INVALID_BOUNDARY", `${path} \u5FC5\u987B\u662F\u5BF9\u8C61`, [
      { path, expected: "object", received: describeReceived(value) }
    ]);
  }
  if (!Array.isArray(value.forbidden_actions)) {
    details.push({
      path: `${path}.forbidden_actions`,
      expected: "string[]",
      received: describeReceived(value.forbidden_actions)
    });
  }
  const maxRounds = value.max_rounds;
  if (maxRounds !== void 0 && (typeof maxRounds !== "number" || !Number.isInteger(maxRounds) || maxRounds < 0)) {
    details.push({
      path: `${path}.max_rounds`,
      expected: "non-negative integer | undefined",
      received: describeReceived(maxRounds)
    });
  }
  if (details.length > 0) fail("INVALID_BOUNDARY", `${path} \u4E0D\u662F\u5408\u6CD5\u7684\u8FB9\u754C`, details);
}
function resolveHistory(options) {
  if (options === void 0) return { previous_signals: [] };
  if (!isPlainObject(options)) {
    fail("INVALID_OPTIONS", "options \u5FC5\u987B\u662F\u5BF9\u8C61", [
      { path: "options", expected: "object", received: describeReceived(options) }
    ]);
  }
  const history = options.history;
  if (history === void 0) return { previous_signals: [] };
  if (!isPlainObject(history)) {
    fail("INVALID_OPTIONS", "options.history \u5FC5\u987B\u662F\u5BF9\u8C61", [
      { path: "options.history", expected: "object", received: describeReceived(history) }
    ]);
  }
  const previous = history.previous_signals;
  const details = [];
  if (previous !== void 0) {
    if (!Array.isArray(previous)) {
      details.push({
        path: "options.history.previous_signals",
        expected: "FeedbackSignalType[] | undefined",
        received: describeReceived(previous)
      });
    } else {
      previous.forEach((item, index) => {
        if (!FEEDBACK_SIGNAL_TYPES.includes(item)) {
          details.push({
            path: `options.history.previous_signals[${index}]`,
            expected: "FeedbackSignalType",
            received: describeReceived(item)
          });
        }
      });
    }
  }
  if (details.length > 0) fail("INVALID_OPTIONS", "options.history \u4E0D\u5408\u6CD5", details);
  const rollbackCount = history.rollback_count;
  if (rollbackCount !== void 0 && (typeof rollbackCount !== "number" || !Number.isInteger(rollbackCount) || rollbackCount < 0)) {
    fail("INVALID_OPTIONS", "options.history.rollback_count \u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570", [
      {
        path: "options.history.rollback_count",
        expected: "non-negative integer | undefined",
        received: describeReceived(rollbackCount)
      }
    ]);
  }
  const base = {
    previous_signals: previous ?? []
  };
  return rollbackCount === void 0 ? base : { ...base, rollback_count: rollbackCount };
}
function signalDetails(result) {
  return result.signals.map((item) => item.detail);
}
function hasPattern(result, marker) {
  return signalDetails(result).some((detail) => detail.includes(marker));
}
function repeatedDeviation(history) {
  const count = history.previous_signals.filter(
    (item) => item === "ineffective" || item === "type_misjudged"
  ).length;
  return count >= REPEATED_DEVIATION_THRESHOLD;
}
function rollback(kind, target, rationale) {
  return { kind, target_type: target, rationale };
}
function evidence(ruleId, statement) {
  return { rule_id: ruleId, statement };
}
function detectBoundaryInvalid(request, history) {
  const { result, boundary } = request;
  const maxRounds = boundary.max_rounds ?? DEFAULT_MAX_ROUNDS;
  const ineffectiveCount = history.previous_signals.filter((item) => item === "ineffective").length;
  if (ineffectiveCount >= maxRounds) {
    return {
      signal_type: "boundary_invalid",
      reason: `\u8FDE\u7EED\u65E0\u6548\u5E72\u9884\u5DF2\u8FBE ${ineffectiveCount} \u6B21\uFF0C\u8D85\u8FC7\u9884\u8BBE\u4E0A\u9650 ${maxRounds} \u6B21\uFF0C\u7EE7\u7EED\u52A0\u7801\u5DF2\u8D8A\u754C`,
      evidence: [
        evidence(
          "B1",
          `\u5386\u53F2 ineffective \u8BA1\u6570 ${ineffectiveCount} \u2265 max_rounds ${maxRounds}`
        )
      ]
    };
  }
  const blocked = result.blocked_actions ?? [];
  if (blocked.length > 0) {
    return {
      signal_type: "boundary_invalid",
      reason: `\u6267\u884C\u671F\u53D1\u751F ${blocked.length} \u6B21\u8FB9\u754C\u62E6\u622A\uFF0C\u4F18\u5316\u5DF2\u8D8A\u51FA\u9884\u8BBE\u8FB9\u754C`,
      evidence: [
        evidence("B2", `blocked_actions \u975E\u7A7A\uFF1A${blocked.map((item) => item.action).join("\u3001")}`)
      ]
    };
  }
  if (result.status === "blocked") {
    return {
      signal_type: "boundary_invalid",
      reason: "\u6574\u6761\u8DEF\u5F84\u56E0\u8D8A\u754C\u88AB\u963B\u65AD\uFF0C\u672A\u6267\u884C\u4EFB\u4F55\u6B65\u9AA4",
      evidence: [evidence("B3", 'result.status === "blocked"')]
    };
  }
  return null;
}
function detectTypeMisjudged(request, history) {
  const { result, classification } = request;
  const assumed = classification.causal_type;
  if (!repeatedDeviation(history)) return null;
  const repeatedNote = `\u5386\u53F2\u5DF2\u51FA\u73B0\u53CD\u590D\u504F\u79BB\uFF08${history.previous_signals.join("\u3001")}\uFF09`;
  if (assumed === "unidirectional" && result.status !== "succeeded") {
    return {
      signal_type: "type_misjudged",
      reason: '\u5047\u8BBE\u4E3A\u5355\u5411\u56E0\u679C\uFF0C\u4F46\u5E72\u9884\u65E0\u6548\u4E14\u95EE\u9898\u53CD\u590D\uFF1A\u5355\u5411\u56E0\u679C\u4E0B\u5E72\u9884\u5E94\u4EA7\u751F\u65B9\u5411\u660E\u786E\u7684\u4E00\u6B21\u6027\u6548\u679C\uFF0C\u53CD\u590D\u65E0\u6548\u4E0E"\u4E25\u683C\u5148\u540E"\u5047\u8BBE\u77DB\u76FE',
      evidence: [
        evidence("M1", `assumed=unidirectional\uFF0Cstatus=${result.status}`),
        evidence("M1", repeatedNote)
      ],
      rollback: rollback(
        "recheck_type",
        "cyclic",
        "\u53CD\u590D\u65E0\u6548\u66F4\u50CF\u5B58\u5728\u56DE\u8DEF\uFF1A\u5EFA\u8BAE\u56DE\u9000\u68C0\u67E5\u5FAA\u73AF\u56E0\u679C"
      )
    };
  }
  if (assumed === "cyclic" && result.status === "failed") {
    return {
      signal_type: "type_misjudged",
      reason: "\u5047\u8BBE\u4E3A\u5FAA\u73AF\u56E0\u679C\uFF0C\u4F46\u8D8A\u5E72\u9884\u8D8A\u7CDF\uFF1A\u56DE\u8DEF\u5E72\u9884\u901A\u5E38\u4F1A\u5148\u632F\u8361\u540E\u6536\u655B\uFF0C\u5355\u5411\u6076\u5316\u66F4\u7B26\u5408\u5355\u5411\u56E0\u679C\u7684\u4E0D\u53EF\u9006\u7279\u6027",
      evidence: [
        evidence("M2", `assumed=cyclic\uFF0Cstatus=failed`),
        evidence("M2", hasPattern(result, PATTERN_WORSENED) ? `\u547D\u4E2D\u6807\u8BB0 ${PATTERN_WORSENED}` : repeatedNote)
      ],
      rollback: rollback(
        "recheck_type",
        "unidirectional",
        "\u5355\u5411\u6076\u5316\u66F4\u50CF\u4E0D\u53EF\u9006\u7684\u5355\u5411\u56E0\u679C\uFF1A\u5EFA\u8BAE\u56DE\u9000\u68C0\u67E5\u5355\u5411\u56E0\u679C"
      )
    };
  }
  if (assumed === "structural_duality" && hasPattern(result, PATTERN_UNILATERAL)) {
    return {
      signal_type: "type_misjudged",
      reason: "\u5047\u8BBE\u4E3A\u7ED3\u6784\u5BF9\u5076\uFF0C\u4F46\u68C0\u6D4B\u5230\u4E00\u65B9\u5355\u65B9\u9762\u6539\u5B9A\u4E49\uFF1A\u5BF9\u5076\u8981\u6C42\u4E24\u6781\u540C\u65F6\u6210\u7ACB\u3001\u5F7C\u6B64\u5B9A\u4E49\uFF0C\u5355\u8FB9\u6539\u52A8\u5DF2\u7834\u574F\u8BE5\u524D\u63D0",
      evidence: [
        evidence("M3", `assumed=structural_duality\uFF0C\u547D\u4E2D\u6807\u8BB0 ${PATTERN_UNILATERAL}`),
        evidence("M3", repeatedNote)
      ],
      rollback: rollback(
        "recheck_type",
        "unidirectional",
        "\u5355\u8FB9\u6539\u5B9A\u4E49\u66F4\u50CF\u6709\u5148\u540E\u7684\u5355\u5411\u4F5C\u7528\uFF1A\u5EFA\u8BAE\u56DE\u9000\u68C0\u67E5\u5355\u5411\u56E0\u679C"
      )
    };
  }
  if (assumed === "structural_duality" && hasPattern(result, PATTERN_FEEDBACK_INTRODUCED) && result.status === "failed") {
    return {
      signal_type: "type_misjudged",
      reason: "\u5047\u8BBE\u4E3A\u7ED3\u6784\u5BF9\u5076\uFF0C\u4F46\u5F3A\u884C\u5F15\u5165\u53CD\u9988\u540E\u5931\u7A33\uFF1A\u5BF9\u5076\u672C\u8EAB\u65E0\u65F6\u95F4\u5148\u540E\uFF0C\u5F15\u5165\u53CD\u9988\u7B49\u4E8E\u9519\u8BEF\u5730\u52A0\u4E86\u56DE\u8DEF",
      evidence: [
        evidence("M4", `assumed=structural_duality\uFF0C\u547D\u4E2D\u6807\u8BB0 ${PATTERN_FEEDBACK_INTRODUCED}`),
        evidence("M4", `status=failed`)
      ],
      rollback: rollback(
        "restore_type",
        "structural_duality",
        "\u64A4\u9500\u8FD9\u6B21\u8BEF\u52A0\u7684\u53CD\u9988\uFF0C\u56DE\u5230\u7ED3\u6784\u5BF9\u5076\u5047\u8BBE"
      )
    };
  }
  return null;
}
function detectEffective(request) {
  const { result, boundary } = request;
  if (result.status !== "succeeded") return null;
  const requireAllOk = boundary.require_all_ok !== false;
  if (requireAllOk) {
    const stepSignals = result.signals.filter((item) => item.step_index >= 0);
    const notOk = stepSignals.filter((item) => item.kind !== "observed");
    if (notOk.length > 0) {
      return null;
    }
    return {
      signal_type: "effective",
      reason: "\u7ED3\u679C\u7B26\u5408\u6210\u529F\u6807\u51C6\uFF1A\u5168\u90E8\u6B65\u9AA4\u5747\u6210\u529F\u6267\u884C",
      evidence: [
        evidence("E1", `status=succeeded\uFF0C${stepSignals.length} \u4E2A\u6B65\u9AA4\u5168\u90E8 observed`)
      ]
    };
  }
  return {
    signal_type: "effective",
    reason: "\u7ED3\u679C\u7B26\u5408\u6210\u529F\u6807\u51C6\uFF1A\u6267\u884C\u72B6\u6001\u4E3A succeeded\uFF08\u8C03\u7528\u65B9\u5DF2\u653E\u5BBD\u9010\u6B65\u6821\u9A8C\uFF09",
    evidence: [evidence("E2", "status=succeeded \u4E14 require_all_ok=false")]
  };
}
function detectSignal(request, options) {
  if (!isPlainObject(request)) {
    fail("INVALID_RESULT", "request \u5FC5\u987B\u662F\u5BF9\u8C61", [
      { path: "request", expected: "object", received: describeReceived(request) }
    ]);
  }
  assertResult(request.result, "request.result");
  assertClassificationRef(request.classification, "request.classification");
  assertBoundary(request.boundary, "request.boundary");
  const history = resolveHistory(options);
  const outcome = detectBoundaryInvalid(request, history) ?? detectTypeMisjudged(request, history) ?? detectEffective(request) ?? {
    signal_type: "ineffective",
    reason: `\u7ED3\u679C\u504F\u79BB\u4F46\u7C7B\u578B\u5047\u8BBE\u4ECD\u6210\u7ACB\uFF1Astatus=${request.result.status}`,
    evidence: [
      evidence(
        "I1",
        `status=${request.result.status}\uFF1B\u672A\u547D\u4E2D\u8FB9\u754C\u8D8A\u754C\u6216\u7C7B\u578B\u8BEF\u5224\u89C4\u5219`
      )
    ]
  };
  const draft = {
    signal_type: outcome.signal_type,
    reason: outcome.reason,
    evidence: outcome.evidence,
    assumed_type: request.classification.causal_type
  };
  if (outcome.rollback !== void 0) draft.suggested_rollback = outcome.rollback;
  return draft;
}

// packages/clis-feedback/src/service.ts
var FeedbackServiceImpl = class extends Service {
  constructor(ctx) {
    super(ctx, CAUSAL_FEEDBACK_SERVICE);
  }
  /** 与纯函数 detectSignal 结论完全一致的异步包装。 */
  async detect(request, options) {
    return detectSignal(request, options);
  }
};

// packages/clis-feedback/src/index.ts
var name = "clis-feedback";
var inject = [];
function apply(ctx) {
  ctx.plugin(FeedbackServiceImpl);
}

export {
  FEEDBACK_RULES_VERSION,
  detectSignal,
  FeedbackServiceImpl,
  name,
  inject,
  apply
};
