/**
 * 自动提名器 —— 阶段 II 的"器→术"两条通道（II-1 正向 / II-2 负向）。
 *
 * ## 定位：只提名，不生效，不裁决
 *
 * 输入是**已经存在的真实账本**（clis-interventions.jsonl / .usage.jsonl），
 * 输出是 CandidateRule / NegativeCandidate——交给 valve_check 裁决、
 * 交给人工确认生效。本模块不写生效库、不拦截任何路径。
 *
 * ## 为什么从既有账本聚合而不是新建采集
 *
 * 「全系统能力需零配合层」：clis 的失败账本与 memory 的使用账本已经在
 * 零配合地积累（每次失败/每次使用自动落行）。提名器吃现成元数据，
 * 新组件不需要知道提名器存在就已被覆盖。
 *
 * ## 口径的诚实边界
 *
 * - 负向：同一签名的 hinted 记录 ≥ forbiddenMinFailures 才提名。
 *   hinted 本身就是"闸门确认真实重复失败"的产物（clis 已过 worth/window
 *   两道闸），所以计数不虚。泛化签名（pwsh:exit code #）如实标记
 *   degraded_signature——它可能是无关错误攒的假重复（签名塌缩教训），
 *   人工确认时必须先看原始记录。
 * - 正向：复用 memory 的 summarizeUsage 口径（uses=engagement，
 *   recall 不算使用）。**成功率不在 usage 账本里**——所以正向候选
 *   success_rate 缺失、success_evidence 缺失，valve_check 会如实
 *   reject(malformed) 或要求补外部证据。提名器不编造成功率：
 *   它只报"重复够多了，值得人工补证据后提阀"。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_THRESHOLDS } from './thresholds.js';

/** 读 JSONL（坏行跳过；ENOENT → []；其它失败 → undefined，与 store 同纪律）。 */
async function readJsonl(path) {
	let text;
	try {
		text = await readFile(path, 'utf8');
	} catch (err) {
		if (err?.code === 'ENOENT') return [];
		return undefined;
	}
	const out = [];
	for (const line of text.split('\n')) {
		const s = line.trim();
		if (!s) continue;
		try {
			out.push(JSON.parse(s));
		} catch {
			/* skip corrupt line */
		}
	}
	return out;
}

/** 泛化签名的形态：数字归一后只剩工具名+退出码占位（签名塌缩的降级路径）。 */
export function isDegradedSignature(signature) {
	return /^[a-z_]+:exit code #$/i.test(String(signature ?? '').trim());
}

/**
 * II-2 负向提名：从 clis 失败账本聚合重复失败签名 → forbidden_skill 候选。
 *
 * @param interventions clis-interventions.jsonl 的解析行数组。
 * @param options { thresholds?, existingRuleIds?: string[], windowDays? }
 *   existingRuleIds：已生效规则覆盖的签名不再重复提名（幂等）。
 * @returns NegativeCandidate[]（kind:'negative'，带 origin:'nomination'）。
 */
export function nominateForbidden(interventions, options = {}) {
	const t = options.thresholds ?? DEFAULT_THRESHOLDS;
	const existing = new Set(options.existingRuleIds ?? []);
	const cutoff = options.windowDays ? Date.now() - options.windowDays * 86400_000 : undefined;
	const bySig = new Map();
	for (const e of interventions) {
		if (e?.kind !== 'hinted') continue;
		const sig = String(e.signature ?? '').trim();
		if (!sig) continue;
		if (cutoff !== undefined) {
			const ms = Date.parse(e.t);
			if (!Number.isFinite(ms) || ms < cutoff) continue;
		}
		const cur = bySig.get(sig) ?? { count: 0, evidence: [], tools: new Set() };
		cur.count++;
		if (cur.evidence.length < 5) cur.evidence.push(`clis-interventions ${e.t} agent=${String(e.agent ?? '').slice(0, 24)}`);
		if (e.tool) cur.tools.add(String(e.tool));
		bySig.set(sig, cur);
	}
	const out = [];
	for (const [sig, agg] of bySig) {
		if (agg.count < t.forbiddenMinFailures) continue;
		const id = `nom-forbidden-${sig.replace(/[^a-z0-9]+/gi, '-').slice(0, 48).toLowerCase()}`;
		if (existing.has(id)) continue;
		out.push({
			candidate_id: id,
			kind: 'negative',
			negative_type: 'forbidden_skill',
			failure_count: agg.count,
			statement: `反复失败模式（${agg.count} 次，工具 ${[...agg.tools].join('/')}）：${sig}`,
			evidence: agg.evidence,
			// 可检验性如实声明：重放原始记录里的命令看退出码。
			verifiable_by: '按 evidence 时间点回查会话转录中的原始命令与退出码，重放验证失败可复现',
			origin: 'nomination',
			...(isDegradedSignature(sig) ? { degraded_signature: true, warning: '泛化签名可能是无关错误攒的假重复（签名塌缩降级路径），人工确认前必须回查原始记录' } : {}),
		});
	}
	// 失败多的排前面；同数按签名稳定排序（可重复运行结果一致）。
	out.sort((a, b) => b.failure_count - a.failure_count || a.candidate_id.localeCompare(b.candidate_id));
	return out;
}

/**
 * II-1 正向提名：从 memory 使用聚合（summarizeUsage 的输出）提名候选技能。
 *
 * 判据与 memory_skill candidates 同源（uses ≥ skillMinRepeats + 至少一次
 * 确认 + 纠正率低），但**不复制它的实现**——输入就是它的聚合输出，
 * 这里只做"够不够提名"的映射（判据单一实现：engagement 口径归 usage.js）。
 *
 * 输出**不带 success_rate**：usage 账本没有外部成败证据，编一个数
 * 会让 valve_check 的外部证据闸门形同虚设。候选如实标注
 * needs_external_evidence，由人工补证后再提阀。
 *
 * @param usageItems summarizeUsage() 的输出数组。
 * @param options { thresholds?, existingRuleIds?, maxBadRate? }
 * @returns CandidateRule[]（kind:'positive', rule_type:'skill'）。
 */
export function nominateSkills(usageItems, options = {}) {
	const t = options.thresholds ?? DEFAULT_THRESHOLDS;
	const maxBadRate = options.maxBadRate ?? 0.2;
	const existing = new Set(options.existingRuleIds ?? []);
	const out = [];
	for (const it of usageItems ?? []) {
		const href = String(it?.href ?? '');
		// 只提名功能域（术的原料），不提名 insights/dao（那是法/道的原料）。
		if (!href.startsWith('functions/')) continue;
		if ((it.uses ?? 0) < t.skillMinRepeats) continue;
		if ((it.positives ?? 0) < 1) continue;
		if ((it.badRate ?? 0) >= maxBadRate) continue;
		const id = `nom-skill-${href.replace(/^functions\//, '').replace(/\.md$/, '').slice(0, 48)}`;
		if (existing.has(id)) continue;
		out.push({
			candidate_id: id,
			kind: 'positive',
			rule_type: 'skill',
			statement: `高频被使用的功能域「${href}」（engagement ${it.uses} 次、认可 ${it.positives}）值得结晶为可调用技能`,
			repeats: it.uses,
			evidence: [`usage 聚合：uses=${it.uses} positives=${it.positives} badRate=${it.badRate}`],
			verifiable_by: '按 memory_skill 流程结晶后在真实任务照做，看外部结果（退出码/断言）是否达成',
			needs_external_evidence: true,
			success_evidence: 'self_report',
			origin: 'nomination',
		});
	}
	out.sort((a, b) => b.repeats - a.repeats || a.candidate_id.localeCompare(b.candidate_id));
	return out;
}

/**
 * 便捷入口：从磁盘读两份真实账本并产出两侧候选。
 * 读失败的一侧如实返回 undefined（不假装没候选）。
 *
 * @param paths { interventionsPath, usageItems } —— usageItems 由调用方
 *   用 memory 的 summarizeUsage 聚合后传入（避免本包反向 import memory）。
 */
export async function nominateFromDisk(paths, options = {}) {
	const interventions = await readJsonl(paths.interventionsPath ?? join(paths.storageDir, 'clis-interventions.jsonl'));
	return {
		forbidden: interventions === undefined ? undefined : nominateForbidden(interventions, options),
		skills: paths.usageItems === undefined ? undefined : nominateSkills(paths.usageItems, options),
	};
}