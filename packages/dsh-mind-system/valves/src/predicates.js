/**
 * 两类阀门的判据 —— 纯函数，一处实现，穷举可测。
 *
 * ## 与说明书的对应
 *
 * - 下行准入（§4.2.1）：原则是否已具体化到可执行 + 负向黑名单拦截。
 * - 上行准入（§4.2.2）：反例是否够格改上层 + J1 防伪 + 逐层不跳。
 * - 原则失效（§4.1）：四判据任一触发即 invalid。
 *
 * ## 两条不动摇的纪律
 *
 * 1. **成败只认外部证据**（P0 分析结论；「原生命令退出码判据」）：
 *    success_rate 必须附带 evidence_type=external（退出码/断言/可检验结果）。
 *    agent 自报的成功率一律不采信——否则蒸馏会把失败提炼成"成功技能"。
 * 2. **每个判定都返回 reason + 缺口**，调用方（账本）双侧记账：
 *    通过的记 admitted，拒绝的记 skipped + reason。只有分子没有分母的
 *    指标回答不了"该拦而没拦的有多少"（「闸门指标须成对报」）。
 *
 * 本模块不做 I/O、不碰 ctx、不抛业务错——输入不合法就返回 reject，
 * 理由里说清缺什么。抛错只留给编程错误（阈值表形状坏）。
 */
import { DEFAULT_LAYERS, DEFAULT_THRESHOLDS } from './thresholds.js';

/** 层序表：跳层判断的唯一依据。层可修改，所以作为参数传入。 */
function layerIndex(layers, layer) {
	return layers.indexOf(layer);
}

const isCount = (n) => Number.isInteger(n) && n >= 0;
const isRate = (n) => Number.isFinite(n) && n >= 0 && n <= 1;

/**
 * J1 防伪：一条证据是否**可外部检验**。
 *
 * 判据（说明书 §4.2.2 + 分析 P0-1 的最小落地）：
 * - evidence 是非空字符串数组（检索记录/trace 引用）；
 * - verifiable_by 非空——说清"用什么外部手段能推翻它"。
 *
 * 刻意**不**判断证据内容为真：真伪是人工闸门的事，这里只判"可否被检验"。
 * 一条没有可证伪路径的证据不是弱证据，是没有证据。
 */
export function isExternallyVerifiable(candidate) {
	const ev = candidate?.evidence;
	const by = candidate?.verifiable_by;
	return (
		Array.isArray(ev) &&
		ev.length > 0 &&
		ev.every((e) => typeof e === 'string' && e.trim().length > 0) &&
		typeof by === 'string' &&
		by.trim().length > 0
	);
}

/**
 * 下行准入：上一层原则是否已具体化到下一层可执行。
 *
 * @param from 源层。
 * @param to 目标层。
 * @param data 待下行的具体化产物：
 *   { constraints?: string[], negative_rule_hits?: string[], touches_axiom?: boolean }
 *   constraints 是已具体化的可执行约束（空 = 还没具体化）。
 *   negative_rule_hits 由调用方查黑名单后传入（判定与检索分离：
 *   本函数不读库，命中名单是可测输入）。
 * @param options { layers?, thresholds? }。
 * @returns { action: 'allow'|'deny'|'human_gate', reason, missing_fields, negative_rule_hits }
 */
export function admitDownward(from, to, data, options = {}) {
	const layers = options.layers ?? DEFAULT_LAYERS;
	const fi = layerIndex(layers, from);
	const ti = layerIndex(layers, to);
	const hits = Array.isArray(data?.negative_rule_hits) ? data.negative_rule_hits.filter((h) => typeof h === 'string' && h) : [];

	// 负向黑名单最先查：命中即拒，不再看具体化程度（拒绝理由要指向黑名单，
	// 不是"顺便也没具体化"——调用方据此走负向规则的申诉/沉底流程）。
	if (hits.length > 0) {
		return { action: 'deny', reason: 'negative_rule_hit', missing_fields: [], negative_rule_hits: hits };
	}
	if (fi === -1 || ti === -1) {
		return { action: 'deny', reason: 'unknown_layer', missing_fields: [], negative_rule_hits: [] };
	}
	// 下行只能相邻逐层：L0→L2 意味着 L1 的原则被绕过了。
	if (ti !== fi + 1) {
		return { action: 'deny', reason: 'non_adjacent_descent', missing_fields: [], negative_rule_hits: [] };
	}
	// 公理不可自动修改（§9.2）：向下具体化若声称动了公理语义，转人工。
	if (data?.touches_axiom === true) {
		return { action: 'human_gate', reason: 'axiom_semantics_touched', missing_fields: [], negative_rule_hits: [] };
	}
	const constraints = Array.isArray(data?.constraints) ? data.constraints.filter((c) => typeof c === 'string' && c.trim()) : [];
	if (constraints.length === 0) {
		return { action: 'deny', reason: 'not_concretized', missing_fields: ['constraints'], negative_rule_hits: [] };
	}
	return { action: 'allow', reason: 'concretized', missing_fields: [], negative_rule_hits: [] };
}

/**
 * 上行准入：反例/证据是否够格修改上层定义。
 *
 * @param from 源层（经验所在层）。
 * @param to 目标层（要修改的层）。
 * @param candidate 候选规则：
 *   正向 { kind: 'positive', rule_type: 'skill'|'criterion'|'axiom',
 *          repeats, success_rate, success_evidence: 'external'|'self_report',
 *          evidence: string[], verifiable_by,
 *          skill_coverage?, scenario_coverage?, anti_example_count?,
 *          predict_rate?, overlap?, confidence? }
 *   负向 { kind: 'negative', negative_type: 'forbidden_skill'|'invalidated_criterion'|'out_of_scope_scenario'|'weakened_axiom',
 *          failure_count?|anti_example_count?|out_of_scope_hits?, evidence, verifiable_by }
 * @param options { layers?, thresholds? }。
 * @returns { action: 'accept'|'reject'|'downgrade'|'human_gate', reason, coverage, confidence_cap? }
 *   accept/human_gate ≠ 生效：正向 accept 后仍需人工闸门（法→道永远 human_gate）。
 */
export function admitUpward(from, to, candidate, options = {}) {
	const layers = options.layers ?? DEFAULT_LAYERS;
	const t = options.thresholds ?? DEFAULT_THRESHOLDS;
	const fi = layerIndex(layers, from);
	const ti = layerIndex(layers, to);
	const reject = (reason, coverage = 'insufficient') => ({ action: 'reject', reason, coverage });

	if (fi === -1 || ti === -1) return reject('unknown_layer');
	// 上行只能相邻逐层：器直接提法 = 跳层，说明书 §9.2 判无效。
	if (ti !== fi - 1) return reject('non_adjacent_ascent');

	// 反例/证据检索记录强制（F12）：无记录拒绝入库，正向负向同规。
	if (!Array.isArray(candidate?.evidence) || candidate.evidence.length === 0) {
		return reject('no_evidence_record');
	}

	const negative = candidate.kind === 'negative';

	// J1 防伪：不可外部检验 → 正向降级候选（保留线索），负向直接拒——
	// 负向规则会拦截路径，一条检验不了的禁令误杀成本高于漏拦。
	const verifiable = isExternallyVerifiable(candidate);
	if (!verifiable) {
		if (negative) return reject('not_externally_verifiable');
		return { action: 'downgrade', reason: 'not_externally_verifiable', coverage: 'insufficient', confidence_cap: t.downgradedMaxConfidence };
	}

	if (negative) return admitNegativeUpward(candidate, t);
	return admitPositiveUpward(candidate, t);
}

/** 正向候选：按 rule_type 走各自的量化判据。 */
function admitPositiveUpward(c, t) {
	const reject = (reason, coverage = 'insufficient') => ({ action: 'reject', reason, coverage });

	if (c.rule_type === 'skill') {
		if (!isCount(c.repeats) || !isRate(c.success_rate)) return reject('malformed_skill_evidence');
		// 成败判据只认外部（P0-1）：self_report 的成功率不进闸门。
		if (c.success_evidence !== 'external') return reject('success_not_external');
		if (c.repeats < t.skillMinRepeats) return reject('insufficient_repeats');
		if (c.success_rate < t.skillMinSuccessRate) return reject('success_rate_below_threshold');
		// 技能闸门可分级自动（§4.9）——但 v1 保守：全部转人工确认，
		// 快速通道等真实分布出来再开（先跑起来 ≠ 先放开）。
		return { action: 'human_gate', reason: 'skill_thresholds_met', coverage: 'sufficient' };
	}

	if (c.rule_type === 'criterion') {
		if (!isCount(c.skill_coverage) || !isCount(c.scenario_coverage)) return reject('malformed_criterion_evidence');
		if (c.skill_coverage < t.criterionMinSkills) return reject('insufficient_skill_coverage');
		if (c.scenario_coverage < t.criterionMinScenarios) return reject('insufficient_scenario_coverage');
		// 反例与预测率：不足降级不拒绝（§4.5 检验流程），置信度封顶。
		const antiOk = isCount(c.anti_example_count) && c.anti_example_count >= t.criterionMinAntiExamples;
		const predictOk = isRate(c.predict_rate) && c.predict_rate >= t.criterionMinPredictRate;
		if (!antiOk || !predictOk) {
			return {
				action: 'downgrade',
				reason: !antiOk ? 'insufficient_anti_examples' : 'predict_rate_below_threshold',
				coverage: 'insufficient',
				confidence_cap: t.downgradedMaxConfidence,
			};
		}
		// 重叠度只在提供了才判（没有已有判据可比时不算冗余）。
		if (isRate(c.overlap) && c.overlap > t.criterionMaxOverlap) return reject('redundant_with_existing', 'sufficient');
		return { action: 'human_gate', reason: 'criterion_thresholds_met', coverage: 'sufficient' };
	}

	if (c.rule_type === 'axiom') {
		// 法→道不强行量化（§4.5）：够了证据记录就直接给人工，附辅助信息。
		return { action: 'human_gate', reason: 'axiom_human_only', coverage: 'sufficient' };
	}

	return reject('unknown_rule_type');
}

/** 负向候选：阈值低于正向（负向收敛，§1.2），但同样要过 J1。 */
function admitNegativeUpward(c, t) {
	const reject = (reason) => ({ action: 'reject', reason, coverage: 'insufficient' });
	switch (c.negative_type) {
		case 'forbidden_skill':
			if (!isCount(c.failure_count)) return reject('malformed_negative_evidence');
			if (c.failure_count < t.forbiddenMinFailures) return reject('insufficient_failures');
			return { action: 'human_gate', reason: 'forbidden_skill_thresholds_met', coverage: 'sufficient' };
		case 'invalidated_criterion':
			if (!isCount(c.anti_example_count)) return reject('malformed_negative_evidence');
			if (c.anti_example_count < t.invalidateMinAntiExamples) return reject('insufficient_anti_examples');
			return { action: 'human_gate', reason: 'criterion_falsified', coverage: 'sufficient' };
		case 'out_of_scope_scenario':
			if (!isCount(c.out_of_scope_hits)) return reject('malformed_negative_evidence');
			if (c.out_of_scope_hits < t.outOfScopeMinHits) return reject('insufficient_out_of_scope_hits');
			return { action: 'human_gate', reason: 'out_of_scope_confirmed', coverage: 'sufficient' };
		case 'weakened_axiom':
			// 无效公理要 ≥2 个反例且来自不同判据（§4.5 负向规则表）。
			if (!isCount(c.anti_example_count) || !isCount(c.distinct_criteria)) return reject('malformed_negative_evidence');
			if (c.anti_example_count < 2 || c.distinct_criteria < 2) return reject('insufficient_axiom_counterexamples');
			return { action: 'human_gate', reason: 'axiom_weakened_proposal', coverage: 'sufficient' };
		default:
			return reject('unknown_negative_type');
	}
}

/**
 * 原则失效判定（外层治理循环的判据核，§4.1）。
 *
 * 四判据**任一触发**即 invalid；都不触发但数据不全时 uncertain（不是 valid——
 * 没测过 ≠ 通过，与 constraints.js 的 no-constraint 同一纪律）。
 *
 * @param stats { anti_example_count, source_diversity, coverage_rate, conflict_with_upper,
 *                window_rounds } —— window_rounds 是统计覆盖的轮数。
 * @param options { thresholds? }。
 * @returns { status: 'valid'|'invalid'|'uncertain', triggered: string[] }
 */
export function checkPrinciple(stats, options = {}) {
	const t = options.thresholds ?? DEFAULT_THRESHOLDS;
	const triggered = [];
	if (isCount(stats?.anti_example_count) && stats.anti_example_count >= t.principleInvalidAntiExamples) {
		triggered.push('anti_example_count');
	}
	// 来源多样性单独不构成失效（2 个来源 1 个反例不算失效），
	// 它修饰反例数判据：≥3 反例但全部同源时只算 uncertain 的警示。
	if (
		isCount(stats?.anti_example_count) &&
		stats.anti_example_count >= t.principleInvalidAntiExamples &&
		isCount(stats?.source_diversity) &&
		stats.source_diversity >= t.principleInvalidMinSources
	) {
		triggered.push('diverse_anti_examples');
	}
	if (isRate(stats?.coverage_rate) && stats.coverage_rate < t.principleInvalidCoverageBelow) {
		triggered.push('coverage_below');
	}
	if (stats?.conflict_with_upper === true) triggered.push('conflict_with_upper');

	if (triggered.length > 0) return { status: 'invalid', triggered };

	const measurable =
		isCount(stats?.anti_example_count) &&
		isCount(stats?.source_diversity) &&
		isRate(stats?.coverage_rate) &&
		typeof stats?.conflict_with_upper === 'boolean' &&
		isCount(stats?.window_rounds) &&
		stats.window_rounds >= t.principleWindowRounds;
	return measurable ? { status: 'valid', triggered: [] } : { status: 'uncertain', triggered: [] };
}