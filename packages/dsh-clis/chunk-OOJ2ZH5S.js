import {
  CAUSAL_CLASSIFIER_SERVICE,
  CAUSAL_STRATEGY_SERVICE,
  ClisContractError,
  DEFAULT_MAX_DEPTH,
  FAMILY_BY_TYPE,
  MAX_DEPTH_LIMIT,
  PATH_VARIANTS,
  PROBE_FAMILY,
  Service,
  blockedReason,
  isCausalType,
  scorePath
} from "./chunk-DC3YUXV4.js";

// packages/clis-strategy/src/validation.ts
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
function assertBoundary(value, path) {
  const details = [];
  if (!isPlainObject(value)) {
    fail("INVALID_BOUNDARY", `${path} \u5FC5\u987B\u662F\u5BF9\u8C61`, [
      { path, expected: "object", received: describeReceived(value) }
    ]);
  }
  const forbidden = value.forbidden_actions;
  if (!Array.isArray(forbidden)) {
    details.push({
      path: `${path}.forbidden_actions`,
      expected: "string[]",
      received: describeReceived(forbidden)
    });
  } else {
    forbidden.forEach((action, index) => {
      if (typeof action !== "string") {
        details.push({
          path: `${path}.forbidden_actions[${index}]`,
          expected: "string",
          received: describeReceived(action)
        });
      }
    });
  }
  const allowed = value.allowed_actions;
  if (allowed !== void 0) {
    if (!Array.isArray(allowed)) {
      details.push({
        path: `${path}.allowed_actions`,
        expected: "string[] | undefined",
        received: describeReceived(allowed)
      });
    } else {
      allowed.forEach((action, index) => {
        if (typeof action !== "string") {
          details.push({
            path: `${path}.allowed_actions[${index}]`,
            expected: "string",
            received: describeReceived(action)
          });
        }
      });
    }
  }
  if (details.length > 0) fail("INVALID_BOUNDARY", `${path} \u4E0D\u662F\u5408\u6CD5\u7684\u7B56\u7565\u8FB9\u754C`, details);
}
function assertStep(value, path) {
  const details = [];
  if (!isPlainObject(value)) {
    fail("INVALID_PATH", `${path} \u5FC5\u987B\u662F\u5BF9\u8C61`, [
      { path, expected: "object", received: describeReceived(value) }
    ]);
  }
  if (!Number.isInteger(value.index) || value.index < 0) {
    details.push({
      path: `${path}.index`,
      expected: "non-negative integer",
      received: describeReceived(value.index)
    });
  }
  if (typeof value.action !== "string" || value.action.length === 0) {
    details.push({
      path: `${path}.action`,
      expected: "non-empty string",
      received: describeReceived(value.action)
    });
  }
  if (!isPlainObject(value.params)) {
    details.push({
      path: `${path}.params`,
      expected: "object",
      received: describeReceived(value.params)
    });
  }
  if (typeof value.rationale !== "string" || value.rationale.length === 0) {
    details.push({
      path: `${path}.rationale`,
      expected: "non-empty string",
      received: describeReceived(value.rationale)
    });
  }
  if (details.length > 0) fail("INVALID_PATH", `${path} \u4E0D\u662F\u5408\u6CD5\u7684\u8DEF\u5F84\u6B65\u9AA4`, details);
}
function assertPath(value, path) {
  const details = [];
  if (!isPlainObject(value)) {
    fail("INVALID_PATH", `${path} \u5FC5\u987B\u662F\u5BF9\u8C61`, [
      { path, expected: "object", received: describeReceived(value) }
    ]);
  }
  if (typeof value.path_id !== "string" || value.path_id.length === 0) {
    details.push({
      path: `${path}.path_id`,
      expected: "non-empty string",
      received: describeReceived(value.path_id)
    });
  }
  if (!Array.isArray(value.steps)) {
    fail("INVALID_PATH", `${path}.steps \u5FC5\u987B\u662F\u6570\u7EC4`, [
      {
        path: `${path}.steps`,
        expected: "array",
        received: describeReceived(value.steps)
      }
    ]);
  }
  value.steps.forEach((step, index) => {
    if (!isPlainObject(step)) {
      details.push({
        path: `${path}.steps[${index}]`,
        expected: "object",
        received: describeReceived(step)
      });
      return;
    }
    try {
      assertStep(step, `${path}.steps[${index}]`);
    } catch (error) {
      if (error instanceof ClisContractError) details.push(...error.details);
      else throw error;
    }
  });
  const subPaths = value.sub_paths;
  if (subPaths !== void 0) {
    if (!Array.isArray(subPaths)) {
      details.push({
        path: `${path}.sub_paths`,
        expected: "array | undefined",
        received: describeReceived(subPaths)
      });
    } else {
      subPaths.forEach((sub, index) => {
        try {
          assertPath(sub, `${path}.sub_paths[${index}]`);
        } catch (error) {
          if (error instanceof ClisContractError) details.push(...error.details);
          else throw error;
        }
      });
    }
  }
  if (details.length > 0) fail("INVALID_PATH", `${path} \u4E0D\u662F\u5408\u6CD5\u7684\u5019\u9009\u8DEF\u5F84`, details);
}
function assertExecuteOptions(value, path) {
  const details = [];
  if (!isPlainObject(value)) {
    fail("INVALID_OPTIONS", `${path} \u5FC5\u987B\u662F\u5BF9\u8C61`, [
      { path, expected: "object", received: describeReceived(value) }
    ]);
  }
  try {
    assertBoundary(value.boundary, `${path}.boundary`);
  } catch (error) {
    if (error instanceof ClisContractError) details.push(...error.details);
    else throw error;
  }
  const executor = value.executor;
  if (!isPlainObject(executor) || typeof executor.execute !== "function") {
    details.push({
      path: `${path}.executor`,
      expected: "object with execute()",
      received: describeReceived(executor)
    });
  }
  if (details.length > 0) fail("INVALID_OPTIONS", `${path} \u7F3A\u5C11\u53EF\u7528\u7684\u8FB9\u754C\u6216\u6267\u884C\u5668`, details);
}

// packages/clis-strategy/src/execution.ts
function signal(pathId, stepIndex, action, kind, detail) {
  return { path_id: pathId, step_index: stepIndex, action, kind, detail };
}
function describeReason(reason) {
  return reason === "forbidden" ? "\u5728 forbidden_actions \u4E2D" : "\u4E0D\u5728 allowed_actions \u767D\u540D\u5355\u5185";
}
function summarySignal(pathId, detail) {
  return signal(pathId, -1, "summary", "summary", detail);
}
async function executePath(path, options) {
  assertPath(path, "path");
  assertExecuteOptions(options, "options");
  const { boundary, executor } = options;
  const pathId = path.path_id;
  const precheck = [...path.blocked_actions];
  const reasonByAction = /* @__PURE__ */ new Map();
  for (const item of precheck) reasonByAction.set(item.action, item.reason);
  for (const step of path.steps) {
    const reason = blockedReason(step.action, boundary);
    if (reason === null || reasonByAction.has(step.action)) continue;
    reasonByAction.set(step.action, reason);
    precheck.push({ action: step.action, reason });
  }
  const declaredNotExecutable = path.executable === false;
  if (precheck.length > 0 || declaredNotExecutable) {
    const signals2 = path.steps.map((step) => {
      const reason = reasonByAction.get(step.action);
      return reason === void 0 ? signal(
        pathId,
        step.index,
        step.action,
        "not_attempted",
        "\u672C\u8DEF\u5F84\u5DF2\u88AB\u8FB9\u754C\u963B\u65AD\uFF0C\u672A\u6267\u884C\u4EFB\u4F55\u6B65\u9AA4"
      ) : signal(
        pathId,
        step.index,
        step.action,
        "skipped_forbidden",
        `\u52A8\u4F5C ${step.action} \u88AB\u8FB9\u754C\u963B\u65AD\uFF08${describeReason(reason)}\uFF09\uFF0C\u672A\u4EA4\u7ED9\u6267\u884C\u5668`
      );
    });
    signals2.push(
      summarySignal(
        pathId,
        declaredNotExecutable ? `\u8DEF\u5F84\u58F0\u660E\u4E3A\u4E0D\u53EF\u6267\u884C\uFF08\u751F\u6210\u9636\u6BB5\u5DF2\u5254\u9664 ${precheck.length} \u4E2A\u52A8\u4F5C\uFF09\uFF0C\u6574\u6761\u672A\u6267\u884C` : `\u8FB9\u754C\u963B\u65AD ${precheck.length} \u4E2A\u52A8\u4F5C\uFF0C\u6574\u6761\u672A\u6267\u884C`
      )
    );
    return { path_id: pathId, status: "blocked", signals: signals2, blocked_actions: precheck };
  }
  const signals = [];
  let selfFailed = false;
  let producedChange = false;
  let observedOnlyCount = 0;
  for (const step of path.steps) {
    if (selfFailed) {
      signals.push(signal(pathId, step.index, step.action, "not_attempted", "\u524D\u5E8F\u6B65\u9AA4\u5931\u8D25\uFF0C\u672A\u6267\u884C"));
      continue;
    }
    const result = await executor.execute({
      path_id: pathId,
      step_index: step.index,
      action: step.action,
      params: step.params
    });
    if (result.status !== "ok") {
      signals.push(signal(pathId, step.index, step.action, "failed", result.detail));
      selfFailed = true;
      continue;
    }
    if (result.observationOnly === true) {
      observedOnlyCount += 1;
      signals.push(signal(pathId, step.index, step.action, "observed_only", result.detail));
    } else {
      producedChange = true;
      signals.push(signal(pathId, step.index, step.action, "observed", result.detail));
    }
  }
  const subPaths = path.sub_paths ?? [];
  const subResults = [];
  let status;
  if (selfFailed) {
    status = "failed";
  } else if (subPaths.length > 0) {
    for (const sub of subPaths) subResults.push(await executePath(sub, options));
    if (subResults.some((item) => item.status === "failed")) status = "failed";
    else if (subResults.some((item) => item.status === "blocked")) status = "blocked";
    else status = "succeeded";
  } else if (observedOnlyCount > 0 && !producedChange) {
    status = "failed";
  } else {
    status = "succeeded";
  }
  const subSummary = subResults.length === 0 ? "" : `\uFF1B\u5B50\u8DEF\u5F84 ${subResults.length} \u6761\uFF08${subResults.map((item) => item.status).join("/")}\uFF09`;
  const observeNote = observedOnlyCount > 0 && !selfFailed ? `\uFF0C\u5176\u4E2D ${observedOnlyCount} \u6B65\u4EC5\u89C2\u6D4B\u672A\u6539\u52A8` : "";
  signals.push(
    summarySignal(
      pathId,
      `${path.steps.length} \u6B65\uFF0C\u72B6\u6001 ${status}${observeNote}${subSummary}`
    )
  );
  const draft = { path_id: pathId, status, signals, blocked_actions: [] };
  if (subResults.length > 0) draft.sub_results = subResults;
  return draft;
}

// packages/clis-strategy/src/library.ts
var STRATEGY_LIBRARY_VERSION = "1.0.0";
var VARIANT_VERSION = "1.0.0";
var STRATEGY_LIBRARY = [
  // ---- structural_duality：对称映射 / 关系参数调优 / 定义澄清 ----
  {
    variant: "duality.symmetric_mapping",
    variant_version: VARIANT_VERSION,
    family: "duality_pairing",
    components: { type_fit: 1, expected_effect: 0.9, side_effect_risk: 0.2, execution_cost: 0.4 },
    summary: "\u540C\u65F6\u5BF9\u6807\u5B9A\u4E24\u6781\u5E76\u65BD\u52A0\u5BF9\u79F0\u8C03\u6574\uFF0C\u4E0D\u505A\u5148\u540E\u5B89\u6392",
    steps: [
      {
        action: "identify_poles",
        params: { pair: "opposing" },
        rationale: "\u627E\u51FA\u540C\u65F6\u6210\u7ACB\u3001\u5F7C\u6B64\u5B9A\u4E49\u7684\u4E24\u6781"
      },
      {
        action: "apply_symmetric_adjustment",
        params: { magnitude: 1, target: "both_poles" },
        rationale: "\u5BF9\u4E24\u6781\u65BD\u52A0\u7B49\u91CF\u8C03\u6574\u4EE5\u4FDD\u6301\u5B9A\u4E49\u5173\u7CFB"
      }
    ]
  },
  {
    variant: "duality.relation_tuning",
    variant_version: VARIANT_VERSION,
    family: "duality_pairing",
    components: { type_fit: 1, expected_effect: 0.75, side_effect_risk: 0.15, execution_cost: 0.3 },
    summary: "\u6D4B\u91CF\u4E24\u6781\u4E4B\u95F4\u7684\u5173\u7CFB\u53C2\u6570\u5E76\u8C03\u53C2\uFF0C\u4E0D\u6539\u53D8\u7ED3\u6784",
    steps: [
      {
        action: "measure_relation_parameters",
        params: { dimensions: ["ratio", "offset"] },
        rationale: "\u6D4B\u91CF\u5B9A\u4E49\u4E24\u6781\u5173\u7CFB\u7684\u53C2\u6570"
      },
      {
        action: "tune_relation_parameter",
        params: { parameter: "ratio", delta: 0.1 },
        rationale: "\u5FAE\u8C03\u5173\u7CFB\u53C2\u6570"
      }
    ]
  },
  {
    variant: "duality.definition_clarification",
    variant_version: VARIANT_VERSION,
    family: "duality_pairing",
    components: { type_fit: 1, expected_effect: 0.6, side_effect_risk: 0.05, execution_cost: 0.2 },
    summary: "\u62BD\u53D6\u53CC\u65B9\u5B9A\u4E49\u5E76\u6D88\u89E3\u5B9A\u4E49\u51B2\u7A81\uFF0C\u5148\u6C42\u8BED\u4E49\u4E00\u81F4",
    steps: [
      { action: "extract_definitions", params: { sources: ["stated"] }, rationale: "\u62BD\u53D6\u4E24\u6781\u5404\u81EA\u7684\u5B9A\u4E49" },
      {
        action: "resolve_definition_conflict",
        params: { strategy: "prefer_explicit" },
        rationale: "\u6309\u663E\u5F0F\u5B9A\u4E49\u6D88\u89E3\u51B2\u7A81"
      }
    ]
  },
  // ---- cyclic：杠杆点 / 增益控制 / 延迟调节 / 阻尼注入 ----
  {
    variant: "loop.leverage_point",
    variant_version: VARIANT_VERSION,
    family: "loop_damping",
    components: { type_fit: 1, expected_effect: 0.9, side_effect_risk: 0.25, execution_cost: 0.45 },
    summary: "\u5B9A\u4F4D\u53CD\u9988\u73AF\u5E76\u6309\u589E\u76CA/\u5EF6\u8FDF\u6BD4\u6392\u5E8F\u6760\u6746\u70B9\uFF0C\u53EA\u5728\u6760\u6746\u70B9\u5E72\u9884",
    steps: [
      { action: "map_feedback_loop", params: { nodes: ["a", "b"] }, rationale: "\u5B9A\u4F4D\u95ED\u73AF\u4E0A\u7684\u8282\u70B9" },
      {
        action: "rank_leverage_points",
        params: { metric: "gain_over_delay" },
        rationale: "\u6309\u589E\u76CA\u4E0E\u5EF6\u8FDF\u4E4B\u6BD4\u7ED9\u8282\u70B9\u6392\u5E8F"
      },
      {
        action: "intervene_at_leverage_point",
        params: { target: "top1", strength: 1 },
        rationale: "\u53EA\u5728\u6760\u6746\u70B9\u65BD\u52A0\u5E72\u9884"
      }
    ]
  },
  {
    variant: "loop.gain_control",
    variant_version: VARIANT_VERSION,
    family: "loop_damping",
    components: { type_fit: 1, expected_effect: 0.8, side_effect_risk: 0.2, execution_cost: 0.3 },
    summary: "\u6D4B\u91CF\u73AF\u589E\u76CA\u5E76\u9650\u5E45\uFF0C\u6291\u5236\u632F\u8361\u5E45\u5EA6",
    steps: [
      { action: "measure_loop_gain", params: { method: "step_response" }, rationale: "\u6D4B\u91CF\u73AF\u589E\u76CA" },
      { action: "limit_gain", params: { max_gain: 1 }, rationale: "\u9650\u5236\u73AF\u589E\u76CA\u4E0A\u9650" }
    ]
  },
  {
    variant: "loop.delay_tuning",
    variant_version: VARIANT_VERSION,
    family: "loop_damping",
    components: { type_fit: 1, expected_effect: 0.7, side_effect_risk: 0.15, execution_cost: 0.3 },
    summary: "\u6D4B\u91CF\u5E76\u6539\u53D8\u73AF\u4E0A\u7684\u65F6\u95F4\u5EF6\u8FDF\uFF0C\u501F\u76F8\u79FB\u524A\u5F31\u632F\u8361",
    steps: [
      { action: "measure_loop_delay", params: { unit: "ms" }, rationale: "\u6D4B\u91CF\u73AF\u4E0A\u7684\u65F6\u95F4\u5EF6\u8FDF" },
      {
        action: "shift_delay",
        params: { delta: 10, direction: "shorten" },
        rationale: "\u7F29\u77ED\u6216\u5EF6\u957F\u5EF6\u8FDF\u4EE5\u6539\u53D8\u76F8\u4F4D"
      }
    ]
  },
  {
    variant: "loop.damping_injection",
    variant_version: VARIANT_VERSION,
    family: "loop_damping",
    components: { type_fit: 1, expected_effect: 0.65, side_effect_risk: 0.1, execution_cost: 0.35 },
    summary: "\u5728\u73AF\u4E0A\u6CE8\u5165\u963B\u5C3C\u9879\uFF0C\u76F4\u63A5\u6D88\u8017\u632F\u8361\u80FD\u91CF",
    steps: [
      { action: "inject_damping", params: { coefficient: 0.2, at: "loop" }, rationale: "\u6CE8\u5165\u963B\u5C3C\u7CFB\u6570" }
    ]
  },
  // ---- unidirectional：必要条件 / 上游追溯 / 不可逆性接受 / 新因果覆盖 ----
  {
    variant: "lever.necessary_condition",
    variant_version: VARIANT_VERSION,
    family: "single_lever",
    components: { type_fit: 1, expected_effect: 0.75, side_effect_risk: 0.2, execution_cost: 0.3 },
    summary: "\u679A\u4E3E\u5019\u9009\u6761\u4EF6\u3001\u9010\u4E00\u79FB\u9664\u9A8C\u8BC1\u5FC5\u8981\u6027\uFF0C\u518D\u65BD\u52A0\u5FC5\u8981\u6761\u4EF6",
    steps: [
      {
        action: "enumerate_conditions",
        params: { candidates: ["cause"] },
        rationale: "\u679A\u4E3E\u53EF\u80FD\u7684\u539F\u56E0\u6761\u4EF6"
      },
      { action: "test_necessity", params: { method: "remove_one" }, rationale: "\u9010\u4E2A\u79FB\u9664\u4EE5\u68C0\u9A8C\u5FC5\u8981\u6027" },
      { action: "enforce_condition", params: { condition: "cause" }, rationale: "\u65BD\u52A0\u5DF2\u9A8C\u8BC1\u7684\u5FC5\u8981\u6761\u4EF6" }
    ]
  },
  {
    variant: "lever.upstream_trace",
    variant_version: VARIANT_VERSION,
    family: "single_lever",
    components: { type_fit: 1, expected_effect: 0.9, side_effect_risk: 0.3, execution_cost: 0.4 },
    summary: "\u5411\u4E0A\u6E38\u8FFD\u6EAF\u5230\u6700\u65E9\u53EF\u5E72\u9884\u7684\u56E0\uFF0C\u5728\u90A3\u91CC\u52A8\u624B",
    steps: [
      { action: "trace_upstream", params: { max_depth: 3 }, rationale: "\u5411\u4E0A\u6E38\u8FFD\u6EAF\u56E0\u679C\u94FE" },
      {
        action: "select_upstream_intervention",
        params: { chosen: "earliest" },
        rationale: "\u9009\u5B9A\u6700\u65E9\u53EF\u5E72\u9884\u7684\u8282\u70B9"
      },
      { action: "apply_intervention", params: { strength: 1 }, rationale: "\u5728\u8BE5\u8282\u70B9\u65BD\u52A0\u5E72\u9884" }
    ]
  },
  {
    variant: "lever.irreversibility_acceptance",
    variant_version: VARIANT_VERSION,
    family: "single_lever",
    components: { type_fit: 1, expected_effect: 0.5, side_effect_risk: 0.05, execution_cost: 0.1 },
    summary: "\u786E\u8BA4\u4E0D\u53EF\u9006\u6027\u5E76\u63A5\u53D7\u4E4B\uFF0C\u53EA\u505A\u7ED5\u884C\u89C4\u5212",
    steps: [
      {
        action: "confirm_irreversibility",
        params: { evidence: ["no_restore_path"] },
        rationale: "\u786E\u8BA4\u8BE5\u56E0\u679C\u4E0D\u53EF\u9006"
      },
      {
        action: "accept_and_plan_around",
        params: { constraint: "irreversible" },
        rationale: "\u63A5\u53D7\u4E0D\u53EF\u9006\u5E76\u89C4\u5212\u7ED5\u884C"
      }
    ]
  },
  {
    variant: "lever.new_causal_overlay",
    variant_version: VARIANT_VERSION,
    family: "single_lever",
    components: { type_fit: 1, expected_effect: 0.7, side_effect_risk: 0.35, execution_cost: 0.5 },
    summary: "\u8BBE\u8BA1\u4E00\u6761\u65B0\u7684\u56E0\u53BB\u8986\u76D6\u539F\u7ED3\u679C\uFF0C\u7ED5\u5F00\u4E0D\u53EF\u9006\u7684\u65E7\u56E0",
    steps: [
      {
        action: "design_overlay_cause",
        params: { target_effect: "outcome" },
        rationale: "\u8BBE\u8BA1\u80FD\u8986\u76D6\u76EE\u6807\u7ED3\u679C\u7684\u65B0\u56E0"
      },
      { action: "apply_overlay", params: { strength: 1 }, rationale: "\u65BD\u52A0\u65B0\u7684\u56E0" }
    ]
  },
  // ---- nested：组合子模块策略 ----
  {
    variant: "decompose.compose_sub",
    variant_version: VARIANT_VERSION,
    family: "decompose",
    components: { type_fit: 1, expected_effect: 0.8, side_effect_risk: 0.25, execution_cost: 0.55 },
    summary: "\u6309\u5B50\u6A21\u5757\u5207\u5206\uFF0C\u5E76\u5BF9\u6BCF\u4E2A\u5B50\u6A21\u5757\u7EC4\u5408\u5404\u81EA\u5BB6\u65CF\u7684\u7B56\u7565",
    steps: [
      {
        action: "partition_sub_modules",
        params: { count: 0 },
        rationale: "\u6309\u5B50\u6A21\u5757\u5207\u5206\u5E76\u9010\u4E2A\u5904\u7406"
      }
    ]
  },
  // ---- probe_and_observe：探索模式 ----
  {
    variant: "probe.minimal",
    variant_version: VARIANT_VERSION,
    family: "probe_and_observe",
    components: { type_fit: 1, expected_effect: 0.5, side_effect_risk: 0.1, execution_cost: 0.15 },
    summary: "\u6700\u5C0F\u6210\u672C\u63A2\u6D4B\u4E00\u6B21\u5E76\u89C2\u5BDF\u54CD\u5E94\uFF0C\u5148\u62FF\u5230\u4E00\u70B9\u4FE1\u606F",
    steps: [
      {
        action: "probe_environment",
        params: { targets: ["unknown"], sample_size: 1 },
        rationale: "\u6700\u5C0F\u89C4\u6A21\u63A2\u6D4B\u73AF\u5883"
      },
      {
        action: "observe_response",
        params: { window: 1, metrics: ["signal"] },
        rationale: "\u89C2\u5BDF\u6700\u5C0F\u7A97\u53E3\u7684\u54CD\u5E94"
      }
    ]
  },
  {
    variant: "probe.broad",
    variant_version: VARIANT_VERSION,
    family: "probe_and_observe",
    components: { type_fit: 1, expected_effect: 0.7, side_effect_risk: 0.3, execution_cost: 0.45 },
    summary: "\u591A\u76EE\u6807\u3001\u591A\u6307\u6807\u7684\u5E7F\u5EA6\u63A2\u6D4B\uFF0C\u6362\u53D6\u66F4\u5168\u9762\u7684\u89C2\u5BDF",
    steps: [
      {
        action: "probe_environment",
        params: { targets: ["unknown"], sample_size: 5 },
        rationale: "\u591A\u76EE\u6807\u63A2\u6D4B\u73AF\u5883"
      },
      {
        action: "observe_response",
        params: { window: 5, metrics: ["signal", "trend", "noise"] },
        rationale: "\u89C2\u5BDF\u591A\u6307\u6807\u54CD\u5E94"
      }
    ]
  }
];
function libraryVariant(variant) {
  return STRATEGY_LIBRARY.find((entry) => entry.variant === variant);
}

// packages/clis-strategy/src/paths.ts
var EXTRA_PROBE_VARIANT = "probe.minimal";
var EXTRA_PROBE_TYPE_FIT = 0.5;
function assertClassification(value, path) {
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
  if (typeof value.confidence !== "number" || Number.isNaN(value.confidence)) {
    details.push({
      path: `${path}.confidence`,
      expected: "number",
      received: describeReceived(value.confidence)
    });
  }
  if (typeof value.needs_exploration !== "boolean") {
    details.push({
      path: `${path}.needs_exploration`,
      expected: "boolean",
      received: describeReceived(value.needs_exploration)
    });
  }
  const subModules = value.sub_modules;
  if (subModules !== void 0) {
    if (!Array.isArray(subModules)) {
      details.push({
        path: `${path}.sub_modules`,
        expected: "array | undefined",
        received: describeReceived(subModules)
      });
    } else {
      subModules.forEach((sub, index) => {
        if (!isPlainObject(sub)) {
          details.push({
            path: `${path}.sub_modules[${index}]`,
            expected: "object",
            received: describeReceived(sub)
          });
          return;
        }
        if (typeof sub.name !== "string" || sub.name.length === 0) {
          details.push({
            path: `${path}.sub_modules[${index}].name`,
            expected: "non-empty string",
            received: describeReceived(sub.name)
          });
        }
        if (!isPlainObject(sub.classification)) {
          details.push({
            path: `${path}.sub_modules[${index}].classification`,
            expected: "object",
            received: describeReceived(sub.classification)
          });
          return;
        }
        try {
          assertClassification(sub.classification, `${path}.sub_modules[${index}].classification`);
        } catch (error) {
          if (error instanceof ClisContractError) details.push(...error.details);
          else throw error;
        }
      });
    }
  }
  if (details.length > 0) fail("INVALID_CLASSIFICATION", `${path} \u4E0D\u662F\u5408\u6CD5\u7684\u5206\u7C7B\u7ED3\u8BBA`, details);
}
function resolveMaxDepth(options) {
  if (options === void 0) return DEFAULT_MAX_DEPTH;
  if (!isPlainObject(options)) {
    fail("INVALID_OPTIONS", "options \u5FC5\u987B\u662F\u5BF9\u8C61", [
      { path: "options", expected: "object", received: describeReceived(options) }
    ]);
  }
  const raw = options.max_depth;
  if (raw === void 0) return DEFAULT_MAX_DEPTH;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > MAX_DEPTH_LIMIT) {
    fail("INVALID_OPTIONS", `options.max_depth \u5FC5\u987B\u662F [0, ${MAX_DEPTH_LIMIT}] \u5185\u7684\u6574\u6570`, [
      {
        path: "options.max_depth",
        expected: `integer in [0, ${MAX_DEPTH_LIMIT}]`,
        received: describeReceived(raw)
      }
    ]);
  }
  return raw;
}
function buildSteps(variant, boundary) {
  const steps = [];
  const blocked = [];
  const seen = /* @__PURE__ */ new Set();
  for (const spec of variant.steps) {
    const reason = blockedReason(spec.action, boundary);
    if (reason !== null) {
      if (!seen.has(spec.action)) {
        seen.add(spec.action);
        blocked.push({ action: spec.action, reason });
      }
      continue;
    }
    steps.push({
      index: steps.length,
      action: spec.action,
      params: spec.params,
      rationale: spec.rationale
    });
  }
  return { steps, blocked };
}
function rebasePathIds(path, pathId) {
  const next = { ...path, path_id: pathId };
  if (path.sub_paths !== void 0) {
    next.sub_paths = path.sub_paths.map(
      (sub, index) => rebasePathIds(sub, `${pathId}.${index + 1}`)
    );
  }
  return next;
}
function buildPath(variant, pathId, classification, boundary, maxDepth, depth) {
  const built = buildSteps(variant, boundary);
  const subModules = classification.sub_modules ?? [];
  const steps = variant.family === "decompose" ? built.steps.map(
    (step) => step.action === "partition_sub_modules" ? { ...step, params: { count: subModules.length } } : step
  ) : built.steps;
  const blocked = built.blocked;
  const components = variant.components;
  const draft = {
    path_id: pathId,
    variant: variant.variant,
    variant_version: variant.variant_version,
    library_version: STRATEGY_LIBRARY_VERSION,
    family: variant.family,
    causal_type: classification.causal_type,
    steps,
    blocked_actions: blocked,
    executable: blocked.length === 0,
    components,
    score: scorePath(components),
    rank: 0,
    summary: variant.summary
  };
  if (variant.family === "decompose" && subModules.length > 0 && depth + 1 <= maxDepth) {
    const subPaths = [];
    subModules.forEach((sub, index) => {
      const candidates = matchAtDepth(sub.classification, boundary, maxDepth, depth + 1);
      const chosen = candidates.find((candidate) => candidate.executable) ?? candidates[0];
      if (chosen !== void 0) subPaths.push(rebasePathIds(chosen, `${pathId}.${index + 1}`));
    });
    if (subPaths.length > 0) {
      draft.sub_paths = [...subPaths].sort((left, right) => right.score - left.score).map((path, index) => ({ ...path, rank: index + 1 }));
    }
  }
  return draft;
}
function matchAtDepth(classification, boundary, maxDepth, depth) {
  const family = classification.causal_type === "unknown" ? PROBE_FAMILY : FAMILY_BY_TYPE[classification.causal_type];
  const variants = STRATEGY_LIBRARY.filter(
    (entry) => entry.family === family
  );
  const subModules = classification.sub_modules ?? [];
  const wantsExtraProbe = classification.needs_exploration && classification.causal_type !== "unknown" || classification.causal_type === "nested" && subModules.length === 0;
  if (wantsExtraProbe && !variants.some((entry) => entry.variant === EXTRA_PROBE_VARIANT)) {
    const probe = libraryVariant(EXTRA_PROBE_VARIANT);
    if (probe !== void 0) {
      variants.push({
        ...probe,
        components: { ...probe.components, type_fit: EXTRA_PROBE_TYPE_FIT }
      });
    }
  }
  const canonical = [...variants].sort(
    (left, right) => PATH_VARIANTS.indexOf(left.variant) - PATH_VARIANTS.indexOf(right.variant)
  );
  const built = canonical.map(
    (variant, index) => buildPath(variant, `p${index + 1}`, classification, boundary, maxDepth, depth)
  );
  return [...built].sort((left, right) => right.score - left.score).map((path, index) => ({ ...path, rank: index + 1 }));
}
function matchPaths(classification, boundary, options) {
  const maxDepth = resolveMaxDepth(options);
  assertClassification(classification, "classification");
  assertBoundary(boundary, "boundary");
  return matchAtDepth(classification, boundary, maxDepth, 0);
}

// packages/clis-strategy/src/service.ts
var StrategyServiceImpl = class extends Service {
  constructor(ctx) {
    super(ctx, CAUSAL_STRATEGY_SERVICE);
  }
  /** 与纯函数 matchPaths 结论完全一致的异步包装。 */
  async match(classification, boundary, options) {
    return matchPaths(classification, boundary, options);
  }
  /** 先向注入的分类器读取类型，再匹配。 */
  async plan(problem, boundary, options) {
    const classifier = this.ctx[CAUSAL_CLASSIFIER_SERVICE];
    const classification = await classifier.classify(problem, options);
    return matchPaths(classification, boundary);
  }
  /** 与纯函数 executePath 结论完全一致的异步包装。 */
  async execute(path, options) {
    return executePath(path, options);
  }
};

// packages/clis-strategy/src/index.ts
var name = "clis-strategy";
var inject = [CAUSAL_CLASSIFIER_SERVICE];
function apply(ctx) {
  ctx.plugin(StrategyServiceImpl);
}

export {
  executePath,
  STRATEGY_LIBRARY_VERSION,
  STRATEGY_LIBRARY,
  libraryVariant,
  matchPaths,
  StrategyServiceImpl,
  name,
  inject,
  apply
};
