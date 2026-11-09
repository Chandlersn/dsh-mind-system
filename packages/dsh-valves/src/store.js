/**
 * 阀门账本 + 负向规则库 —— 横切轴的最小落地。
 *
 * 存储两份，都在 <dshHome>/storages/（与 clis-interventions.jsonl 同级）：
 *
 * 1. `mind-valves.jsonl`   追加式判定账本。每次评估一行：
 *    admitted 侧（allow/accept/human_gate/downgrade）与 skipped 侧（deny/reject）
 *    **都记**，带稳定 reason 代号。「闸门指标须成对报」：只有拦截数没有
 *    放行数的指标，会把"阀门全拒"读成"阀门在工作"。
 *
 * 2. `mind-negative-rules.json` 已生效的负向规则（黑名单/已证伪/outside_scope）。
 *    只有人工确认（confirm）才写入；候选不自动生效（§9.2）。
 *    结构 { rules: [{ id, negative_type, statement, layer, confirmed_at, source }] }。
 *
 * 失败纪律与 memory 的 usage.js 一致：账本写失败**永不**破坏调用方
 * （fire-and-forget），但读失败要如实报告（读不到黑名单 ≠ 黑名单为空，
 * 返回 undefined 让调用方决定降级口径）。
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LEDGER_FILE = 'mind-valves.jsonl';
export const RULES_FILE = 'mind-negative-rules.json';

export function ledgerPath(storageDir) {
	return join(storageDir, LEDGER_FILE);
}
export function rulesPath(storageDir) {
	return join(storageDir, RULES_FILE);
}

/** 追加一条判定记录。永不抛错（记账不能破坏执行）。 */
export async function appendDecision(storageDir, entry) {
	try {
		await mkdir(storageDir, { recursive: true });
		await appendFile(ledgerPath(storageDir), `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`, 'utf8');
		return true;
	} catch {
		return false;
	}
}

/**
 * 读账本（新→旧倒序不需要，保持追加序）。坏行跳过。
 * 读失败返回 undefined —— 与"账本为空([])"区分：前者是故障，后者是没数据。
 */
export async function readDecisions(storageDir) {
	let text;
	try {
		text = await readFile(ledgerPath(storageDir), 'utf8');
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

/**
 * 双侧汇总：admitted/skipped/评估总数 + 按 reason 分布。
 * missRate 语义与 clis_metrics 一致：skipped / evaluated。
 * 它接近 1 = 阀门几乎全拒（可能在误杀），接近 0 = 几乎全放（可能没在管）。
 *
 * origin 口径（2026-11-09）：验证/演练/提名样本**计入总分布**（它们也是
 * 真实判定），但单独报 byOrigin 与 dailyCount——阈值校准与 I-1 计数
 * 只认日常样本，验证样本不得给校准分布灌水。历史行无 origin 字段，
 * 如实归入 untagged（不猜它是日常还是验证）。
 */
export function summarizeDecisions(entries) {
	const byReason = {};
	const byGate = {};
	const byOrigin = {};
	let admitted = 0;
	let skipped = 0;
	let dailyCount = 0;
	for (const e of entries) {
		if (e?.outcome === 'admitted') admitted++;
		else if (e?.outcome === 'skipped') skipped++;
		else continue;
		const reason = String(e.reason ?? 'unknown');
		byReason[reason] = (byReason[reason] ?? 0) + 1;
		const gate = String(e.gate ?? 'unknown');
		byGate[gate] = (byGate[gate] ?? 0) + 1;
		const origin = typeof e.origin === 'string' && e.origin ? e.origin : 'untagged';
		byOrigin[origin] = (byOrigin[origin] ?? 0) + 1;
		if (origin === 'daily') dailyCount++;
	}
	const evaluated = admitted + skipped;
	return {
		evaluated,
		admitted,
		skipped,
		missRate: evaluated ? Number((skipped / evaluated).toFixed(3)) : null,
		byReason,
		byGate,
		byOrigin,
		dailyCount,
	};
}

/**
 * 读负向规则库。ENOENT → []（还没生效过规则是正常态）；
 * 其它读失败/解析失败 → undefined（故障，调用方必须如实降级，不得当空库放行）。
 */
export async function readNegativeRules(storageDir) {
	let text;
	try {
		text = await readFile(rulesPath(storageDir), 'utf8');
	} catch (err) {
		if (err?.code === 'ENOENT') return [];
		return undefined;
	}
	try {
		const parsed = JSON.parse(text);
		if (!Array.isArray(parsed?.rules)) return undefined;
		return parsed.rules;
	} catch {
		return undefined;
	}
}

/**
 * 人工确认后写入一条负向规则。这是**唯一**的生效通道——
 * 阀门判定（human_gate）之后由人（经 agent 转达确认）调用。
 * 同 id 覆盖（修订），不重复追加。
 *
 * @returns { ok, count } 或 { ok: false, error }（写失败必须让调用方知道，
 *   确认过的规则没落库 = 下次拦不住，这不是可以静默的事）。
 */
export async function confirmNegativeRule(storageDir, rule) {
	const id = String(rule?.id ?? '').trim();
	const statement = String(rule?.statement ?? '').trim();
	const negativeType = String(rule?.negative_type ?? '').trim();
	const TYPES = ['forbidden_skill', 'invalidated_criterion', 'out_of_scope_scenario', 'weakened_axiom'];
	if (!id || !statement || !TYPES.includes(negativeType)) {
		return { ok: false, error: 'rule 需要 id、statement 与合法 negative_type' };
	}
	const existing = await readNegativeRules(storageDir);
	if (existing === undefined) {
		return { ok: false, error: '负向规则库读取失败，拒绝盲写（避免覆盖掉读不到的既有规则）' };
	}
	const next = existing.filter((r) => r?.id !== id);
	next.push({
		id,
		negative_type: negativeType,
		statement,
		layer: typeof rule.layer === 'string' ? rule.layer : undefined,
		keywords: Array.isArray(rule.keywords) ? rule.keywords.filter((k) => typeof k === 'string' && k.trim()) : [],
		confirmed_at: new Date().toISOString(),
		source: typeof rule.source === 'string' ? rule.source : 'human_confirm',
	});
	try {
		await mkdir(storageDir, { recursive: true });
		await writeFile(rulesPath(storageDir), `${JSON.stringify({ rules: next }, null, 2)}\n`, 'utf8');
		return { ok: true, count: next.length };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * 下行黑名单匹配：候选路径描述撞上任一规则的关键词即命中。
 *
 * v1 用关键词包含（可解释、零依赖）；语义相似度是说明书 §4.8 的
 * 后续增强，需要 embedder 可选 peer——现在不引入（N4 降级纪律：
 * 附加能力缺了要降级，不是让核心等它）。
 *
 * @param rules readNegativeRules 的结果（undefined 时返回 undefined，
 *   调用方必须区分"没命中"与"没查成"）。
 * @param text 候选路径/约束的描述文本。
 * @returns 命中的规则 id 列表；rules 为 undefined 时返回 undefined。
 */
export function matchNegativeRules(rules, text) {
	if (rules === undefined) return undefined;
	const t = String(text ?? '').toLowerCase();
	if (!t.trim()) return [];
	const hits = [];
	for (const r of rules) {
		const keywords = Array.isArray(r?.keywords) ? r.keywords : [];
		if (keywords.some((k) => typeof k === 'string' && k.trim() && t.includes(k.toLowerCase()))) {
			hits.push(r.id);
		}
	}
	return hits;
}