/**
 * CLIS 历史消费 —— II-5：提名与裁决成对留痕（零配合）。
 *
 * ## 为什么读历史文件而不是让 clis 发事件
 *
 * clis 每次 clis_run/clis_classify 已经把「四问答案 → 因果类型 → 后续信号」
 * 写进 clis-history.json（fingerprint → entries[]）。这是现成的零配合元数据：
 * 消费它不需要 clis 改一行代码，未来的 clis 版本只要保持这个文件形态就
 * 自动被覆盖。「全系统能力需零配合层」。
 *
 * ## 提名与裁决怎么分
 *
 * - **提名** = 历史条目本身：agent 当时给的四问答案经 clis 规则打分得出
 *   causal_type——那是"LLM 作答 + 规则裁决"的既成事实，本模块不重判因果。
 * - **裁决** = 本模块把每条历史当作 ClisNomination 校验：类型在契约白名单
 *   内？证据（fingerprint+时间）可回查？然后按 signal_type 分流：
 *   - type_misjudged → 误判候选（负向线索：该因果解释被真实结果推翻）
 *   - achieved=false 且非 baseline 且 ineffective → 无效线索（只计数，不提名——
 *     一次无效不够格，聚合同 fingerprint ≥2 才值得提）
 *   - baseline → 只计数（首轮仅判断未动手，不是效果证据）
 *
 * ## 诚实边界
 *
 * achieved=0 的历史（当前真实状态：44 条全 false）不能提炼出"有效的因果
 * 判据"——本模块如实输出 effectiveness 统计，不编造成功率。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 契约承认的因果类型（与 meta/tools.js KNOWN_CAUSAL_TYPES 同一张表的镜像——
 * 那边是工具白名单，这边是历史校验白名单；上游契约变更时两处都要对）。 */
export const CAUSAL_TYPES = ['structural_duality', 'cyclic', 'unidirectional', 'nested', 'unknown'];

/**
 * 读 clis 历史。ENOENT → 空表；解析失败 → undefined（没读成 ≠ 没历史）。
 */
export async function readClisHistory(storageDir) {
	let text;
	try {
		text = await readFile(join(storageDir, 'clis-history.json'), 'utf8');
	} catch (err) {
		if (err?.code === 'ENOENT') return { version: 1, records: {} };
		return undefined;
	}
	try {
		const parsed = JSON.parse(text);
		// typeof null === 'object' 是 JS 老坑：records 为 null 时若不显式挡，
		// 会被当成"空历史"放行——读坏了要说读坏了。
		if (parsed === null || typeof parsed !== 'object' || parsed.records === null || typeof parsed.records !== 'object') return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

/**
 * 消费历史 → 提名/裁决成对记录 + 有效性统计。
 *
 * @param history readClisHistory 的输出。
 * @returns {
 *   nominations: Array<{fingerprint, at, nominated_type, verdict, reason, evidence}>,
 *   misjudged: Array<{fingerprint, at, from_type, evidence}>,   // 误判线索（人工核）
 *   stats: { entries, baseline, achieved, ineffective, off_contract, by_type }
 * }
 */
export function consumeClisHistory(history) {
	const nominations = [];
	const misjudged = [];
	const stats = { entries: 0, baseline: 0, achieved: 0, ineffective: 0, off_contract: 0, by_type: {} };
	if (!history?.records) return { nominations, misjudged, stats, error: 'history_unreadable' };

	for (const [fingerprint, record] of Object.entries(history.records)) {
		for (const entry of record?.entries ?? []) {
			stats.entries++;
			const type = String(entry.causal_type ?? '');
			stats.by_type[type] = (stats.by_type[type] ?? 0) + 1;
			if (entry.baseline === true) stats.baseline++;
			if (entry.achieved === true) stats.achieved++;
			if (entry.signal_type === 'ineffective' && entry.baseline !== true) stats.ineffective++;

			const evidence = [`clis-history.json#${fingerprint} @ ${entry.at}`];
			const inContract = CAUSAL_TYPES.includes(type);
			if (!inContract) stats.off_contract++;
			nominations.push({
				fingerprint,
				at: entry.at,
				nominated_type: type,
				// 裁决只判"提名是否合规"，不重判因果本身（生成/判断分离：
				// 因果结论是 clis 规则打分给的，这里校验它的形态与可回查性）。
				verdict: inContract ? 'accepted' : 'rejected',
				reason: inContract ? 'in_contract_traceable' : 'off_contract_type',
				evidence,
			});
			if (entry.signal_type === 'type_misjudged') {
				misjudged.push({
					fingerprint,
					at: entry.at,
					from_type: type,
					detail: typeof entry.detail === 'string' ? entry.detail : '',
					evidence,
				});
			}
		}
	}
	return { nominations, misjudged, stats };
}

/**
 * II-3 辅助：从 insights 文件的「来源」行聚合真实覆盖数据。
 *
 * 输入是磁盘上的 insights 正文数组（调用方读盘），输出每条原则的
 * criterion 候选量化字段——**只数可数的**：
 * - skill_coverage ← 来源功能域数（functions/ 回链，每个域是一个"术"单元）
 * - scenario_coverage ← 来源域数（同一保守口径：一个域至少一个场景；
 *   不编造"场景"计数，README 里如实声明这是下界）
 * - anti_example_count / predict_rate ← 无数据源，缺省不填（阀门会 downgrade）
 *
 * 「## 阀门证据」节（2026-11-09 II-3 收口）：memory_insight 显式提供的
 * valve_evidence 持久化在该节（可检验路径/量化 JSON/证据引用）。这里读回：
 * - 可检验路径 → verifiable_by（人工写的，不是编的）
 * - 量化 JSON → 白名单字段覆盖（人工声明优先于回链下界）
 * - 证据引用 → 并入 evidence（保留回链，去重）
 * 节不存在 → 行为与旧版一致（downgrade not_externally_verifiable）。
 *
 * 这不替代人工判断——它把"可以从磁盘数出来的"数出来，把数不出来的留空。
 */
export function parseValveEvidenceSection(text) {
	const section = text.split('## 阀门证据')[1]?.split(/\n## /)[0];
	if (!section) return undefined;
	const out = {};
	const by = /^- 可检验路径：(.+)$/m.exec(section)?.[1];
	if (by?.trim()) out.verifiable_by = by.trim();
	const quantRaw = /^- 量化：(.+)$/m.exec(section)?.[1];
	if (quantRaw) {
		try {
			const quant = JSON.parse(quantRaw);
			for (const k of ['skill_coverage', 'scenario_coverage', 'anti_example_count', 'predict_rate', 'overlap']) {
				if (quant[k] !== undefined) out[k] = quant[k];
			}
		} catch {
			/* 量化行坏了就当没有——不猜数字 */
		}
	}
	const refs = [...section.matchAll(/^- 证据：(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
	if (refs.length) out.evidence = refs;
	return Object.keys(out).length ? out : undefined;
}

export function criterionEvidenceFromInsights(insightFiles) {
	const out = [];
	for (const { theme, text } of insightFiles ?? []) {
		if (typeof text !== 'string') continue;
		// 已被取代的原则不再提名（历史保留但不进候选）。
		if (text.includes('⚠️ 已被取代')) continue;
		const srcLine = /^> 来源：(.*)$/m.exec(text)?.[1] ?? '';
		const sources = [...srcLine.matchAll(/functions\/([^)\s\]]+)\.md/g)].map((m) => m[1]);
		const unique = [...new Set(sources)];
		const principle = /^- (.+)$/m.exec(text.split('## 核心原则')[1]?.split('##')[0] ?? '')?.[1];
		const ve = parseValveEvidenceSection(text);
		const evidence = [...new Set([...unique.map((s) => `functions/${s}.md`), ...(ve?.evidence ?? [])])];
		out.push({
			candidate_id: `nom-criterion-${String(theme).slice(0, 48)}`,
			kind: 'positive',
			rule_type: 'criterion',
			statement: principle ?? String(theme),
			skill_coverage: ve?.skill_coverage ?? unique.length,
			scenario_coverage: ve?.scenario_coverage ?? unique.length, // 保守下界，见函数头
			evidence,
			// 无阀门证据节时留空：磁盘数不出"怎么推翻这条原则"——那要人工写。
			// 阀门会如实 downgrade(not_externally_verifiable)，正是该记的账。
			...(ve?.verifiable_by === undefined ? {} : { verifiable_by: ve.verifiable_by }),
			...(ve?.anti_example_count === undefined ? {} : { anti_example_count: ve.anti_example_count }),
			...(ve?.predict_rate === undefined ? {} : { predict_rate: ve.predict_rate }),
			...(ve?.overlap === undefined ? {} : { overlap: ve.overlap }),
			origin: 'nomination',
		});
	}
	return out;
}