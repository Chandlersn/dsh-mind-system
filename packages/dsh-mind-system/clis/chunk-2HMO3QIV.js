import {
  ANSWER_KEYS,
  CAUSAL_CLASSIFIER_SERVICE,
  CONFIDENCE_CEILING,
  ClisContractError,
  DEFAULT_MAX_DEPTH,
  EXPLORATION_THRESHOLD,
  FOUR_QUESTIONS,
  KNOWN_CAUSAL_TYPES,
  MAX_DEPTH_LIMIT,
  Service,
  isTriState,
  normalizeConfidence
} from "./chunk-DC3YUXV4.js";

// packages/clis-classifier/src/rules.ts
var RULES = {
  R1: { rule_id: "R1", description: "Q4=yes\uFF1A\u76F4\u63A5\u5224\u4E3A nested" },
  R2: { rule_id: "R2", description: "Q4 \u975E yes \u4E14 Q1..Q3 \u6070\u597D\u4E00\u4E2A yes\uFF1A\u5224\u4E3A\u8BE5\u552F\u4E00\u7C7B\u578B" },
  R3: { rule_id: "R3", description: "Q4 \u975E yes \u4E14 Q1..Q3 \u4E24\u4E2A\u4EE5\u4E0A yes\uFF1A\u7ED3\u6784\u51B2\u7A81\uFF0C\u5224\u4E3A nested" },
  R4: { rule_id: "R4", description: "\u65E0\u4EFB\u4F55 yes \u4E14 Q4 \u975E yes\uFF1A\u5224\u4E3A unknown\uFF0C\u4E0D\u5F3A\u884C\u5F52\u7C7B" },
  R5: { rule_id: "R5", description: "\u6BCF\u4E2A unknown \u4F5C\u7B54\u6263 0.08" },
  R6: { rule_id: "R6", description: "R3 \u89E6\u53D1\u65F6\u989D\u5916\u6263 0.15" },
  R7: { rule_id: "R7", description: "confidence < 0.7\uFF1A\u6807\u8BB0 needs_exploration" },
  R8: { rule_id: "R8", description: `confidence \u9650\u5236\u5728 [0, ${CONFIDENCE_CEILING}]` },
  R9: { rule_id: "R9", description: "nested \u4E14\u6709 sub_problems \u4E14\u672A\u8FBE\u6DF1\u5EA6\u4E0A\u9650\uFF1A\u9012\u5F52\u751F\u6210 sub_modules" },
  R10: { rule_id: "R10", description: "nested \u4F46\u65E0 sub_problems \u6216\u5DF2\u8FBE\u6DF1\u5EA6\u4E0A\u9650\uFF1Asub_modules \u4E3A\u7A7A\u6570\u7EC4" },
  R11: { rule_id: "R11", description: "unknown\uFF1A\u8F93\u51FA\u5019\u9009\u5047\u8BBE\uFF08\u964D\u5E8F\uFF0C\u540C\u5206\u6309\u7C7B\u578B\u8868\u987A\u5E8F\uFF09" }
};
var TYPE_LABELS = {
  structural_duality: "\u7ED3\u6784\u5BF9\u5076",
  cyclic: "\u5FAA\u73AF\u56E0\u679C",
  unidirectional: "\u5355\u5411\u56E0\u679C",
  nested: "\u5D4C\u5957",
  unknown: "\u672A\u77E5"
};
var TRI_LABELS = {
  yes: "\u662F",
  no: "\u5426",
  unknown: "\u672A\u5B9A"
};
var UNKNOWN_PENALTY = 0.08;
var CONFLICT_PENALTY = 0.15;
var UNKNOWN_ALL_NO_CONFIDENCE = 0.4;
var UNKNOWN_INCOMPLETE_CONFIDENCE = 0.25;
var CANDIDATE_CONFIDENCE_ALL_NO = 0.3;
var CANDIDATE_CONFIDENCE_INCOMPLETE = 0.2;
var DESCRIPTION_EVIDENCE_LIMIT = 120;
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
function fail(code, message, details) {
  throw new ClisContractError(code, message, details);
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertProblem(value, path) {
  if (!isPlainObject(value)) {
    fail("INVALID_PROBLEM", `${path} \u5FC5\u987B\u662F\u5BF9\u8C61`, [
      { path, expected: "object", received: describeReceived(value) }
    ]);
  }
  if (typeof value.description !== "string") {
    fail("INVALID_PROBLEM", `${path}.description \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`, [
      {
        path: `${path}.description`,
        expected: "string",
        received: describeReceived(value.description)
      }
    ]);
  }
  if (value.label !== void 0 && typeof value.label !== "string") {
    fail("INVALID_PROBLEM", `${path}.label \u5B58\u5728\u65F6\u5FC5\u987B\u662F\u5B57\u7B26\u4E32`, [
      { path: `${path}.label`, expected: "string | undefined", received: describeReceived(value.label) }
    ]);
  }
  assertAnswers(value.answers, `${path}.answers`);
  const subProblems = value.sub_problems;
  if (subProblems !== void 0) {
    if (!Array.isArray(subProblems)) {
      fail("INVALID_PROBLEM", `${path}.sub_problems \u5B58\u5728\u65F6\u5FC5\u987B\u662F\u6570\u7EC4`, [
        {
          path: `${path}.sub_problems`,
          expected: "array",
          received: describeReceived(subProblems)
        }
      ]);
    }
    subProblems.forEach((sub, index) => {
      assertProblem(sub, `${path}.sub_problems[${index}]`);
    });
  }
}
function assertAnswers(value, path) {
  if (!isPlainObject(value)) {
    fail("INVALID_ANSWERS", `${path} \u5FC5\u987B\u662F\u5BF9\u8C61`, [
      { path, expected: "object", received: describeReceived(value) }
    ]);
  }
  const details = [];
  for (const key of ANSWER_KEYS) {
    const answer = value[key];
    if (!isTriState(answer)) {
      details.push({
        path: `${path}.${key}`,
        expected: "'yes' | 'no' | 'unknown'",
        received: describeReceived(answer)
      });
    }
  }
  if (details.length > 0) {
    fail("INVALID_ANSWERS", `${path} \u5B58\u5728\u7F3A\u5931\u6216\u975E\u6CD5\u7684\u4F5C\u7B54\u5B57\u6BB5`, details);
  }
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
function evaluate(answers) {
  const pick = (id) => {
    const spec = FOUR_QUESTIONS.find((question) => question.id === id);
    if (spec === void 0) {
      throw new ClisContractError("INVALID_PROBLEM", `\u5951\u7EA6\u7F3A\u5C11\u95EE\u9898\u5B9A\u4E49 ${id}`);
    }
    return { spec, answer: answers[spec.answer_key] };
  };
  const q1 = pick("Q1");
  const q2 = pick("Q2");
  const q3 = pick("Q3");
  const q4 = pick("Q4");
  const all = [q1, q2, q3, q4];
  return {
    all,
    q4,
    positive: [q1, q2, q3].filter((state) => state.answer === "yes").map((state) => state.spec.resolves_to),
    unknownCount: all.filter((state) => state.answer === "unknown").length
  };
}
function decide(evaluated) {
  const distinctPositive = evaluated.positive.length;
  if (evaluated.q4.answer === "yes") return { kind: "r1" };
  if (distinctPositive === 1) {
    const only = evaluated.positive[0];
    if (only !== void 0) return { kind: "r2", type: only };
  }
  if (distinctPositive >= 2) return { kind: "r3" };
  return { kind: "r4" };
}
function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\u2026`;
}
function yesEvidence(state) {
  return {
    source: state.spec.id,
    rule_id: `E-${state.spec.id}-YES`,
    statement: `${state.spec.id} \u4F5C\u7B54\u4E3A\u300C\u662F\u300D\uFF1A${state.spec.text}`,
    supports: state.spec.resolves_to,
    weight: 1
  };
}
function answerStateEvidence(state) {
  return {
    source: state.spec.id,
    rule_id: "R4",
    statement: `${state.spec.id} \u4F5C\u7B54\u4E3A\u300C${TRI_LABELS[state.answer]}\u300D\uFF1A${state.spec.text}`,
    supports: "unknown",
    weight: 0
  };
}
function ruleEvidence(ruleId, statement, supports, weight) {
  return {
    source: "RULE",
    rule_id: ruleId,
    statement,
    supports,
    weight
  };
}
function buildCandidates(unknownCount) {
  const confidence = unknownCount === 0 ? CANDIDATE_CONFIDENCE_ALL_NO : CANDIDATE_CONFIDENCE_INCOMPLETE;
  const rationale = unknownCount === 0 ? "\u56DB\u95EE\u5747\u660E\u786E\u4E3A\u5426\uFF1A\u4EC5\u4F5C\u4E3A\u5F85\u63A2\u7D22\u7684\u5907\u9009\u5047\u8BBE" : "\u4F5C\u7B54\u4E0D\u5B8C\u6574\uFF0C\u65E0\u6CD5\u6392\u9664\u8BE5\u7C7B\u578B";
  return KNOWN_CAUSAL_TYPES.map((causalType) => ({
    causal_type: causalType,
    confidence,
    rationale
  })).sort((left, right) => right.confidence - left.confidence);
}
function basis(ruleId, fired, effect) {
  const entry = {
    rule_id: RULES[ruleId].rule_id,
    description: RULES[ruleId].description,
    fired
  };
  if (fired) entry.effect = effect;
  return entry;
}
function classifyValidated(problem, maxDepth, depth) {
  const evaluated = evaluate(problem.answers);
  const decision = decide(evaluated);
  const unknownCount = evaluated.unknownCount;
  const conflictPenalty = decision.kind === "r3" ? CONFLICT_PENALTY : 0;
  const rawConfidence = decision.kind === "r4" ? unknownCount === 0 ? UNKNOWN_ALL_NO_CONFIDENCE : UNKNOWN_INCOMPLETE_CONFIDENCE : CONFIDENCE_CEILING - UNKNOWN_PENALTY * unknownCount - conflictPenalty;
  const confidence = normalizeConfidence(rawConfidence);
  const causalType = decision.kind === "r1" || decision.kind === "r3" ? "nested" : decision.kind === "r2" ? decision.type : "unknown";
  const needsExploration = confidence < EXPLORATION_THRESHOLD;
  const evidence = [];
  for (const state of evaluated.all) {
    if (state.answer === "yes") evidence.push(yesEvidence(state));
  }
  if (decision.kind === "r3") {
    const coexisting = evaluated.positive.map((type) => TYPE_LABELS[type]).join("\u3001");
    evidence.push(
      ruleEvidence(
        "R3",
        `Q4 \u672A\u786E\u8BA4\u4E3A\u5D4C\u5957\uFF0C\u4F46 Q1..Q3 \u4E2D\u540C\u65F6\u6709\u300C\u662F\u300D\uFF1A${coexisting} \u5E76\u5B58\uFF0C\u5C5E\u7ED3\u6784\u51B2\u7A81\uFF0C\u6309 nested \u5904\u7406`,
        "nested",
        1
      )
    );
  }
  if (decision.kind === "r4") {
    for (const state of evaluated.all) evidence.push(answerStateEvidence(state));
    if (problem.description.trim().length > 0) {
      evidence.push({
        source: "DESCRIPTION",
        rule_id: "R4",
        statement: `\u95EE\u9898\u63CF\u8FF0\uFF1A${truncate(problem.description, DESCRIPTION_EVIDENCE_LIMIT)}`,
        supports: "unknown",
        weight: 0
      });
    }
  }
  const subProblems = causalType === "nested" ? problem.sub_problems ?? [] : [];
  const subModules = [];
  const depthExceeded = subProblems.length > 0 && depth + 1 > maxDepth;
  if (subProblems.length > 0 && !depthExceeded) {
    for (const [index, subProblem] of subProblems.entries()) {
      subModules.push({
        name: subProblem.label ?? `sub-${index + 1}`,
        classification: classifyValidated(subProblem, maxDepth, depth + 1)
      });
    }
  }
  if (subModules.length > 0) {
    evidence.push({
      source: "SUBMODULE",
      rule_id: "R9",
      statement: `\u5DF2\u62C6\u5206\u4E3A ${subModules.length} \u4E2A\u5B50\u6A21\u5757\uFF1A${subModules.map((module) => module.name).join("\u3001")}`,
      supports: "nested",
      weight: 1
    });
  }
  for (const state of evaluated.all) {
    if (state.answer === "unknown") {
      evidence.push(
        ruleEvidence(
          "R5",
          `${state.spec.id} \u4F5C\u7B54\u4E3A\u300C\u672A\u5B9A\u300D\uFF1A${state.spec.text}\uFF08\u4E0D\u6307\u5411\u4EFB\u4F55\u7C7B\u578B\uFF0C\u6263 ${UNKNOWN_PENALTY}\uFF09`,
          causalType,
          UNKNOWN_PENALTY
        )
      );
    }
  }
  const candidates = decision.kind === "r4" ? buildCandidates(unknownCount) : void 0;
  const primaryRule = decision.kind === "r1" ? "R1" : decision.kind === "r2" ? "R2" : decision.kind === "r3" ? "R3" : "R4";
  evidence.push(
    ruleEvidence(
      primaryRule,
      `\u4E3B\u5224\u636E ${primaryRule}\uFF1A${RULES[primaryRule].description}\uFF1B\u7ED3\u8BBA ${TYPE_LABELS[causalType]}\uFF0C\u7F6E\u4FE1\u5EA6 ${confidence}`,
      causalType,
      confidence
    )
  );
  const judgmentBasis = [
    basis("R1", decision.kind === "r1", `\u5224\u4E3A nested\uFF0Cconfidence=${confidence}`),
    basis(
      "R2",
      decision.kind === "r2",
      `\u5224\u4E3A ${TYPE_LABELS[causalType]}\uFF0Cconfidence=${confidence}`
    ),
    basis("R3", decision.kind === "r3", `\u7ED3\u6784\u51B2\u7A81\uFF0C\u5224\u4E3A nested\uFF0Cconfidence=${confidence}`),
    basis("R4", decision.kind === "r4", `\u5224\u4E3A unknown\uFF0Cconfidence=${confidence}`),
    basis("R5", unknownCount > 0, `\u6263 ${UNKNOWN_PENALTY * unknownCount}\uFF08${unknownCount} \u9879\u672A\u5B9A\uFF09`),
    basis("R6", decision.kind === "r3", `\u989D\u5916\u6263 ${CONFLICT_PENALTY}`),
    basis(
      "R7",
      needsExploration,
      `confidence=${confidence} < ${EXPLORATION_THRESHOLD}\uFF0Cneeds_exploration=true`
    ),
    basis("R8", true, `confidence \u5DF2\u9650\u5236\u5728 [0, ${CONFIDENCE_CEILING}]`),
    basis("R9", subModules.length > 0, `\u751F\u6210 ${subModules.length} \u4E2A\u5B50\u6A21\u5757`),
    basis(
      "R10",
      causalType === "nested" && subModules.length === 0,
      subProblems.length === 0 ? "\u65E0 sub_problems\uFF0Csub_modules \u4E3A\u7A7A\u6570\u7EC4" : `\u5DF2\u8FBE\u6DF1\u5EA6\u4E0A\u9650 max_depth=${maxDepth}\uFF0Csub_modules \u4E3A\u7A7A\u6570\u7EC4`
    ),
    basis("R11", decision.kind === "r4", `\u8F93\u51FA ${candidates?.length ?? 0} \u6761\u5019\u9009\u5047\u8BBE`)
  ];
  const draft = {
    causal_type: causalType,
    confidence,
    evidence,
    judgment_basis: judgmentBasis,
    needs_exploration: needsExploration
  };
  if (causalType === "nested") draft.sub_modules = subModules;
  if (candidates !== void 0) draft.candidate_hypotheses = candidates;
  if (needsExploration) {
    draft.exploration_reason = decision.kind === "r4" ? unknownCount === 0 ? "\u56DB\u95EE\u5747\u660E\u786E\u4E3A\u5426\uFF1A\u5DF2\u6392\u9664\u56DB\u79CD\u5DF2\u77E5\u7C7B\u578B\uFF0C\u4F46\u65E0\u6CD5\u7ED9\u51FA\u7C7B\u578B\uFF0C\u7981\u6B62\u5F3A\u884C\u5F52\u7C7B" : `\u56DB\u95EE\u4F5C\u7B54\u4E0D\u8DB3\uFF08${unknownCount} \u9879\u672A\u5B9A\uFF09\uFF1A\u4FE1\u606F\u4E0D\u8DB3\u4EE5\u5224\u65AD\u7C7B\u578B` : `confidence=${confidence} \u4F4E\u4E8E ${EXPLORATION_THRESHOLD}\uFF1A\u4F5C\u7B54\u4E0D\u5B8C\u6574\u6216\u5B58\u5728\u7ED3\u6784\u51B2\u7A81\uFF0C\u9700\u8FDB\u5165\u63A2\u7D22\u6A21\u5F0F`;
  }
  return draft;
}
function classifyProblem(problem, options) {
  const maxDepth = resolveMaxDepth(options);
  assertProblem(problem, "problem");
  return classifyValidated(problem, maxDepth, 0);
}

// packages/clis-classifier/src/service.ts
var ClassifierService = class extends Service {
  constructor(ctx) {
    super(ctx, CAUSAL_CLASSIFIER_SERVICE);
  }
  /** 与纯函数 classifyProblem 结论完全一致的异步包装。 */
  async classify(problem, options) {
    return classifyProblem(problem, options);
  }
};

// packages/clis-classifier/src/index.ts
var name = "clis-classifier";
var inject = [];
function apply(ctx) {
  ctx.plugin(ClassifierService);
}

export {
  classifyProblem,
  ClassifierService,
  name,
  inject,
  apply
};
