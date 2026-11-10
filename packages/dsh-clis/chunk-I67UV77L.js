// packages/clis-contracts/src/orchestrator.ts
function initialState() {
  return {
    round: 0,
    rollback_count: 0,
    oscillation: { consecutive_rollbacks: {}, lock_remaining: 0 },
    traces: []
  };
}

// packages/clis-contracts/src/service.ts
var CAUSAL_CLASSIFIER_SERVICE = "clis.causalClassifier";
var CAUSAL_STRATEGY_SERVICE = "clis.causalStrategy";
var CAUSAL_FEEDBACK_SERVICE = "clis.causalFeedback";
var CAUSAL_ORCHESTRATOR_SERVICE = "clis.causalOrchestrator";

// packages/clis-contracts/src/causal-type.ts
var CAUSAL_TYPES = [
  "structural_duality",
  "cyclic",
  "unidirectional",
  "nested",
  "unknown"
];
var KNOWN_CAUSAL_TYPES = [
  "structural_duality",
  "cyclic",
  "unidirectional",
  "nested"
];
function isCausalType(value) {
  return typeof value === "string" && CAUSAL_TYPES.includes(value);
}

// packages/clis-contracts/src/questions.ts
var TRI_STATES = ["yes", "no", "unknown"];
var FOUR_QUESTIONS = [
  {
    id: "Q1",
    answer_key: "q1_simultaneous_mutual_definition",
    resolves_to: "structural_duality",
    text: "A \u4E0E B \u662F\u5426\u540C\u65F6\u6210\u7ACB\u3001\u5F7C\u6B64\u5B9A\u4E49\u3001\u4E14\u65E0\u65F6\u95F4\u5148\u540E\uFF1F"
  },
  {
    id: "Q2",
    answer_key: "q2_delayed_mutual_influence",
    resolves_to: "cyclic",
    text: "\u662F\u5426\u5B58\u5728\u5E26\u65F6\u95F4\u5EF6\u8FDF\u7684\u76F8\u4E92\u5F71\u54CD\uFF08A\u2192B\u2192A\uFF09\uFF1F"
  },
  {
    id: "Q3",
    answer_key: "q3_strict_irreversible_order",
    resolves_to: "unidirectional",
    text: "\u662F\u5426 A\u2192B \u4E25\u683C\u5148\u540E\u4E14\u4E0D\u53EF\u9006\uFF1F"
  },
  {
    id: "Q4",
    answer_key: "q4_coexisting_causal_structures",
    resolves_to: "nested",
    text: "\u7CFB\u7EDF\u4E2D\u662F\u5426\u540C\u65F6\u5B58\u5728\u591A\u79CD\u56E0\u679C\u7ED3\u6784\uFF08\u9700\u62C6\u5B50\u6A21\u5757\uFF09\uFF1F"
  }
];
var ANSWER_KEYS = FOUR_QUESTIONS.map((question) => question.answer_key);
function isTriState(value) {
  return typeof value === "string" && TRI_STATES.includes(value);
}

// packages/clis-contracts/src/limits.ts
var CONFIDENCE_CEILING = 0.9;
var EXPLORATION_THRESHOLD = 0.7;
var DEFAULT_MAX_DEPTH = 3;
var MAX_DEPTH_LIMIT = 8;
var ROLLBACK_LIMIT = 3;
var TYPE_LOCK_ROUNDS = 1;
function roundTo2(value, min, max) {
  const bounded = Math.min(Math.max(value, min), max);
  return Math.round(bounded * 100 + 1e-9) / 100;
}
function normalizeConfidence(value) {
  return roundTo2(value, 0, CONFIDENCE_CEILING);
}
function normalizeScore(value) {
  return roundTo2(value, 0, 1);
}

// packages/clis-contracts/src/boundary.ts
function blockedReason(action, boundary) {
  if (boundary.forbidden_actions.includes(action)) return "forbidden";
  if (boundary.allowed_actions !== void 0 && !boundary.allowed_actions.includes(action)) {
    return "not_in_allowlist";
  }
  return null;
}

// packages/clis-contracts/src/strategy.ts
var FAMILY_BY_TYPE = {
  structural_duality: "duality_pairing",
  cyclic: "loop_damping",
  unidirectional: "single_lever",
  nested: "decompose"
};
var PROBE_FAMILY = "probe_and_observe";
var PATH_VARIANTS = [
  // structural_duality
  "duality.symmetric_mapping",
  "duality.relation_tuning",
  "duality.definition_clarification",
  // cyclic
  "loop.leverage_point",
  "loop.delay_tuning",
  "loop.gain_control",
  "loop.damping_injection",
  // unidirectional
  "lever.upstream_trace",
  "lever.necessary_condition",
  "lever.new_causal_overlay",
  "lever.irreversibility_acceptance",
  // nested
  "decompose.compose_sub",
  // unknown / 探索
  "probe.minimal",
  "probe.broad"
];
var PATH_SCORE_WEIGHTS = {
  /** 类型匹配度：该路径的做法是否正对该类型。 */
  type_fit: 0.4,
  /** 预期效果。 */
  expected_effect: 0.3,
  /** 副作用风险（以安全性 1-risk 进入）。 */
  side_effect_risk: 0.2,
  /** 执行成本（以效率 1-cost 进入）。 */
  execution_cost: 0.1
};
function scorePath(components) {
  const raw = PATH_SCORE_WEIGHTS.type_fit * components.type_fit + PATH_SCORE_WEIGHTS.expected_effect * components.expected_effect + PATH_SCORE_WEIGHTS.side_effect_risk * (1 - components.side_effect_risk) + PATH_SCORE_WEIGHTS.execution_cost * (1 - components.execution_cost);
  return normalizeScore(raw);
}

// packages/clis-contracts/src/feedback.ts
var FEEDBACK_SIGNAL_TYPES = [
  "effective",
  "ineffective",
  "type_misjudged",
  "boundary_invalid"
];

// packages/clis-contracts/src/errors.ts
var ClisContractError = class extends Error {
  code;
  details;
  constructor(code, message, details = []) {
    super(message);
    this.name = "ClisContractError";
    this.code = code;
    this.details = details;
  }
};

// packages/clis-contracts/src/health.ts
function deriveStatus(findings) {
  if (findings.some((item) => item.severity === "error")) return "failing";
  if (findings.some((item) => item.severity === "warn")) return "degraded";
  return "ok";
}

// packages/clis-plugin/src/cordis-shim.ts
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
var MARKER = join("node_modules", "@deepseek-ai", "cordis", "package.json");
function probe(dir) {
  if (dir === void 0 || dir === null || dir === "") return void 0;
  try {
    return existsSync(join(dir, MARKER)) ? dir : void 0;
  } catch {
    return void 0;
  }
}
function ascend(start) {
  if (start === void 0 || start === null || start === "") return void 0;
  let current;
  try {
    current = resolve(start);
  } catch {
    return void 0;
  }
  for (let depth = 0; depth < 12; depth += 1) {
    const hit = probe(current);
    if (hit !== void 0) return hit;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return void 0;
}
function getRequireCache() {
  try {
    return createRequire(import.meta.url).cache;
  } catch {
    return void 0;
  }
}
function probeFromLoadedModules() {
  const cache = getRequireCache();
  if (cache === void 0) return void 0;
  const marker = join("node_modules", "@deepseek-ai");
  for (const filename of Object.keys(cache)) {
    if (!filename.includes(marker)) continue;
    const hit = ascend(dirname(filename));
    if (hit !== void 0) return hit;
  }
  return void 0;
}
function resolveDshRoot() {
  const fromEnv = probe(process.env.DSH_INSTALL_DIR) ?? probe(process.env.DSH_ROOT) ?? probe(process.env.DSH_HOME);
  if (fromEnv !== void 0) return fromEnv;
  const fromArgv = ascend(process.argv[1]);
  if (fromArgv !== void 0) return fromArgv;
  const fromLoaded = probeFromLoadedModules();
  if (fromLoaded !== void 0) return fromLoaded;
  const fromProfile = ascend(process.env.DSH_PROFILE_DIR);
  if (fromProfile !== void 0) return fromProfile;
  const fromCwd = ascend(process.cwd());
  if (fromCwd !== void 0) return fromCwd;
  throw new Error(
    "CLIS \u65E0\u6CD5\u5B9A\u4F4D DSH \u5B89\u88C5\u76EE\u5F55\uFF08\u672A\u627E\u5230 node_modules/@deepseek-ai/cordis\uFF09\u3002\u8BF7\u8BBE\u7F6E\u73AF\u5883\u53D8\u91CF DSH_INSTALL_DIR \u6307\u5411 DSH \u5B89\u88C5\u76EE\u5F55\u3002"
  );
}
var hostRequire;
function loadHost(specifier) {
  if (hostRequire === void 0) {
    const root = resolveDshRoot();
    hostRequire = createRequire(join(root, "node_modules", "noop.cjs"));
  }
  return hostRequire(specifier);
}
var host = loadHost("@deepseek-ai/cordis");
var Service = host.Service;
var Context = host.Context;
var symbols = host.symbols;
var Fiber = host.Fiber;
var RegistryService = host.RegistryService;
var Inject = host.Inject;
function getDefineTool() {
  return loadHost("@deepseek-ai/dsh-tools").defineTool;
}
function getCreateUserMessage() {
  return loadHost("@deepseek-ai/dsh-llm").createUserMessage;
}

export {
  KNOWN_CAUSAL_TYPES,
  isCausalType,
  FOUR_QUESTIONS,
  ANSWER_KEYS,
  isTriState,
  CONFIDENCE_CEILING,
  EXPLORATION_THRESHOLD,
  DEFAULT_MAX_DEPTH,
  MAX_DEPTH_LIMIT,
  ROLLBACK_LIMIT,
  TYPE_LOCK_ROUNDS,
  normalizeConfidence,
  blockedReason,
  FAMILY_BY_TYPE,
  PROBE_FAMILY,
  PATH_VARIANTS,
  scorePath,
  FEEDBACK_SIGNAL_TYPES,
  initialState,
  ClisContractError,
  CAUSAL_CLASSIFIER_SERVICE,
  CAUSAL_STRATEGY_SERVICE,
  CAUSAL_FEEDBACK_SERVICE,
  CAUSAL_ORCHESTRATOR_SERVICE,
  deriveStatus,
  loadHost,
  Service,
  getDefineTool,
  getCreateUserMessage
};
