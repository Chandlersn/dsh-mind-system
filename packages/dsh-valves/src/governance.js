/**
 * 外层治理循环 —— 说明书 §4.1 的最小体（阶段 III-1 / III-2）。
 *
 * ## 循环体与边界
 *
 * 输入：阀门账本 + 原则引用记录 + 规则版本。
 * 动作：归类（提名+代码校验）→ checkPrinciple → 改定义提议。
 * 终止：归类稳定且原则通过 / 原则失效出提议 / 置信度不足转人工。
 * 本模块**不执行任务、不直接修改规则库**——输出是提议，生效走人工闸门。
 *
 * ## III-2 覆盖率口径（P1-3 的裁决，写死在这里作为单一真值源）
 *
 * "该原则能解释的 trace 占比"有两种判法，混用会让读数不可比：
 *
 * 1. **引用覆盖率（可代码算，本模块默认）**：
 *    Coverage is computed only when every eligible decision explicitly declares
 *    a principle_refs array. An empty array declares no references; a missing or
 *    malformed field is unknown and makes the window's coverage unavailable.
 *
 * 2. **语义覆盖率（只能人工输入）**：人读完 trace 后声明"这条原则解释了
 *    其中多少"。走 stats.coverage_rate 显式传入，本模块不代算。
 *
 * 分母保护：窗口内总判定数 < minSampleSize（默认 10）时覆盖率**不出数**
 * （返回 null）——3 条判定里 1 条引用算出 0.33 然后触发"覆盖率<0.5 失效"
 * 是小样本噪声，不是原则失效。此时 checkPrinciple 收到 null 会走
 * uncertain（没测过 ≠ 通过），正是该走的路径。
 *
 * ## 归类：提名与校验分离
 *
 * classifyLayer 是纯校验器：LLM/调用方提名 {layer, confidence, evidence}，
 * 代码只判形态合规与置信度门槛（<0.7 → human_gate_required）。
 * 它不自己猜层——猜层是提名的事，校验器猜层就越过了生成/判断分离。
 */
import { checkPrinciple } from './predicates.js';
import { DEFAULT_THRESHOLDS, DEFAULT_LAYERS } from './thresholds.js';

/** 覆盖率最小样本数（暂定）：低于它不出覆盖率，防小样本噪声触发失效。 */
export const COVERAGE_MIN_SAMPLE = 10;

/**
 * III-2：从账本算某原则的引用覆盖率。
 *
 * @param entries 账本行数组（readDecisions 输出）。
 * @param principleId 原则标识（与账本行 principle_refs 里的字符串精确匹配）。
 * @param options { windowDays?, minSampleSize?, origins? }
 *   origins 缺省 ['daily', 'untagged']——治理判定用日常样本；
 *   verification/drill/nomination 默认不进分母（校准口径与 I-1 一致）。
 * @returns { coverage: number|null, cited: number, total: number,
 *            declared: number, undeclared: number,
 *            window_days: number|null, basis: 'explicit_refs' }
 */
function eligibleCoverageEntries(entries, options) {
	const origins = new Set(options.origins ?? ['daily', 'untagged']);
	const cutoff = options.windowDays ? Date.now() - options.windowDays * 86400_000 : undefined;
	return (entries ?? []).filter((e) => {
		// Governance records its own verdicts, which are not independent samples.
		if (e?.gate === 'governance' || e?.gate === 'patrol' || (e?.outcome !== 'admitted' && e?.outcome !== 'skipped')) return false;
		const origin = typeof e.origin === 'string' && e.origin ? e.origin : 'untagged';
		if (!origins.has(origin)) return false;
		if (cutoff !== undefined) {
			const ms = Date.parse(e.t);
			if (!Number.isFinite(ms) || ms < cutoff) return false;
		}
		return true;
	});
}

function coverageForEligible(entries, principleId, options) {
	const minSample = options.minSampleSize ?? COVERAGE_MIN_SAMPLE;
	const total = entries.length;
	const declared = entries.filter((e) => Array.isArray(e.principle_refs) && e.principle_refs.every((ref) => typeof ref === 'string' && ref.trim()));
	const cited = declared.filter((e) => e.principle_refs.includes(principleId)).length;
	return {
		coverage: total >= minSample && total > 0 && declared.length === total ? Number((cited / total).toFixed(3)) : null,
		cited,
		total,
		declared: declared.length,
		undeclared: total - declared.length,
		window_days: options.windowDays ?? null,
		basis: 'explicit_refs',
	};
}

export function referenceCoverage(entries, principleId, options = {}) {
	return coverageForEligible(eligibleCoverageEntries(entries, options), principleId, options);
}

/**
 * 归类校验（提名由调用方/LLM 给，这里只裁决形态）。
 *
 * @param nomination { layer, confidence, evidence: string[] }
 * @param options { layers?, minConfidence? }
 * @returns { ok, layer?, human_gate_required, reason }
 */
export function validateClassification(nomination, options = {}) {
	const layers = options.layers ?? DEFAULT_LAYERS;
	const minConfidence = options.minConfidence ?? 0.7;
	if (!layers.includes(nomination?.layer)) {
		return { ok: false, human_gate_required: true, reason: 'unknown_layer_nomination' };
	}
	if (!Number.isFinite(nomination?.confidence) || nomination.confidence < 0 || nomination.confidence > 1) {
		return { ok: false, human_gate_required: true, reason: 'malformed_confidence' };
	}
	if (!Array.isArray(nomination?.evidence) || nomination.evidence.length === 0) {
		return { ok: false, human_gate_required: true, reason: 'no_classification_evidence' };
	}
	if (nomination.confidence < minConfidence) {
		return { ok: true, layer: nomination.layer, human_gate_required: true, reason: 'low_confidence' };
	}
	return { ok: true, layer: nomination.layer, human_gate_required: false, reason: 'classified' };
}

/**
 * 治理循环单轮：账本 → 原则体检 → 提议。
 *
 * @param input {
 *   entries: 账本行[],
 *   principles: [{ principle_id, statement, anti_examples?: [{source, trace_ref}],
 *                  conflict_with_upper?: boolean, semantic_coverage?: number }],
 *   classification?: LLM 归类提名（可选；给了就校验）,
 *   rule_versions?: Record<string,string>,
 * }
 * @param options { thresholds?, windowDays?, minSampleSize? }
 * @returns {
 *   classification?: 归类校验结果,
 *   principle_reports: [{ principle_id, status, triggered, coverage, anti_example_count, source_diversity }],
 *   redefinition_proposals: [{ principle_id, statement, reason, evidence }],
 *   human_gate_required: boolean,
 *   terminated_by: 'principles_valid' | 'principles_uncertain' | 'redefinition_proposed' | 'human_gate',
 * }
 */
export function governanceRound(input, options = {}) {
	const t = options.thresholds ?? DEFAULT_THRESHOLDS;
	const reports = [];
	const proposals = [];
	let humanGate = false;

	let classification;
	if (input?.classification !== undefined) {
		classification = validateClassification(input.classification, { layers: options.layers, minConfidence: options.minConfidence });
		if (classification.human_gate_required) humanGate = true;
	}

	const coverageOptions = { windowDays: options.windowDays, minSampleSize: options.minSampleSize };
	const eligibleEntries = eligibleCoverageEntries(input?.entries, coverageOptions);

	for (const p of input?.principles ?? []) {
		const id = String(p?.principle_id ?? '').trim();
		if (!id) continue;
		const cov = coverageForEligible(eligibleEntries, id, coverageOptions);
		// References remain caller declarations, but replay cannot manufacture samples.
		const byTrace = new Map();
		const conflicts = new Set();
		let duplicates = 0;
		for (const item of Array.isArray(p.anti_examples) ? p.anti_examples : []) {
			const trace = typeof item?.trace_ref === 'string' ? item.trace_ref.trim() : '';
			if (!trace) continue;
			const source = typeof item.source === 'string' ? item.source.trim() || null : null;
			if (byTrace.has(trace)) {
				duplicates += 1;
				if (byTrace.get(trace).source !== source) conflicts.add(trace);
			} else byTrace.set(trace, { trace_ref: trace, source });
		}
		const antiExamples = [...byTrace.values()].filter((item) => !conflicts.has(item.trace_ref));
		const sources = new Set(antiExamples.map((a) => a.source).filter((source) => source !== null));
		// A human semantic assessment is independent of reference declarations.
		const effectiveCoverage = Number.isFinite(p.semantic_coverage) ? p.semantic_coverage : cov.coverage;
		const stats = {
			anti_example_count: antiExamples.length,
			source_diversity: sources.size,
			coverage_rate: effectiveCoverage,
			conflict_with_upper: p.conflict_with_upper === true,
			// 窗口轮数以窗口内日常判定数近似（单用户系统一判定≈一轮）。
			window_rounds: cov.total,
		};
		const verdict = checkPrinciple(stats, { thresholds: t });
		reports.push({
			principle_id: id,
			status: verdict.status,
			triggered: verdict.triggered,
			coverage: cov.coverage,
			coverage_basis: Number.isFinite(p.semantic_coverage) ? 'human_semantic' : cov.undeclared > 0 ? 'incomplete_refs' : cov.basis,
			sample_total: cov.total,
			sample_declared: cov.declared,
			sample_undeclared: cov.undeclared,
			anti_example_count: antiExamples.length,
			anti_example_duplicates: duplicates,
			anti_example_conflicts: conflicts.size,
			source_diversity: sources.size,
			...(cov.undeclared > 0 && !Number.isFinite(p.semantic_coverage) ? { note: 'Some eligible decisions do not declare principle_refs; reference coverage is unavailable.' } : {}),
		});
		if (verdict.status === 'invalid') {
			proposals.push({
				principle_id: id,
				statement: String(p.statement ?? ''),
				reason: verdict.triggered.join('+'),
				evidence: antiExamples.map((a) => a.trace_ref),
			});
		}
	}

	const terminatedBy = humanGate
		? 'human_gate'
		: proposals.length > 0
			? 'redefinition_proposed'
			: reports.length > 0 && reports.length === (input?.principles?.length ?? 0) && reports.every((report) => report.status === 'valid')
				? 'principles_valid' : 'principles_uncertain';
	return {
		...(classification === undefined ? {} : { classification }),
		principle_reports: reports,
		redefinition_proposals: proposals,
		human_gate_required: humanGate || proposals.length > 0,
		terminated_by: terminatedBy,
		rule_versions: input?.rule_versions ?? {},
	};
}