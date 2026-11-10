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
// III-4 回滚缰绳：覆盖写之前先快照，回退上限按规则计。
import { writeSnapshot, readLatestSnapshot, canRollback, markSnapshotConsumed } from './snapshot.js';
// III-5 越权拦截：规则库写入必须出示人工通道签发的票。
import { requirePermit, VIOLATIONS } from './guard.js';

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
 * ## III-4：覆盖是破坏性的，所以写前必须快照
 *
 * 覆盖式写入会让"上一版"彻底消失：一旦写进一条错的禁令，它立刻开始拦截
 * 所有匹配路径，而旧版本已经不存在、没有任何办法退回。快照不是为了留档，
 * 是**回退的唯一依据**——所以它在写入之前发生，且快照失败时**拒绝写入**
 * （宁可这次不生效，也不能制造一个无法回退的状态）。
 *
 * @returns { ok, count } 或 { ok: false, error }（写失败必须让调用方知道，
 *   确认过的规则没落库 = 下次拦不住，这不是可以静默的事）。
 */
export async function confirmNegativeRule(storageDir, rule, options = {}) {
	const id = String(rule?.id ?? '').trim();
	const statement = String(rule?.statement ?? '').trim();
	const negativeType = String(rule?.negative_type ?? '').trim();
	const TYPES = ['forbidden_skill', 'invalidated_criterion', 'out_of_scope_scenario', 'weakened_axiom'];
	if (!id || !statement || !TYPES.includes(negativeType)) {
		return { ok: false, error: 'rule 需要 id、statement 与合法 negative_type' };
	}
	// III-5 越权拦截：写入必须证明经过人工确认。
	// 两种合法姿势：①带一张 issuePermit() 签发的票（生产路径，只能由
	// confirm/rollback 通道签）；②显式声明 `human:true`（直接调用本函数的
	// 人工通道）。默认（两者都没有）= 拒绝，且这个拒绝必须响——静默降级
	// 会让"候选自己写进库"看起来像正常写入。
	if (options.permit !== undefined && options.permit !== null) {
		const ok = requirePermit(options.permit, { ruleId: id }, options);
		if (!ok.ok) return { ok: false, error: ok.error, violation: ok.violation };
	} else if (options.human !== true) {
		return { ok: false, error: 'not_human_confirmed', violation: VIOLATIONS.unconfirmedCandidate };
	}
	const existing = await readNegativeRules(storageDir);
	if (existing === undefined) {
		return { ok: false, error: '负向规则库读取失败，拒绝盲写（避免覆盖掉读不到的既有规则）' };
	}
	// 写前快照：记下这条规则**改动前**的样子（不存在则记 null）。
	// 快照失败就不写 —— 制造一个回不去的状态比这次没生效更糟。
	const prev = existing.find((r) => r?.id === id) ?? null;
	const snap = await writeSnapshot(storageDir, id, prev);
	if (!snap.ok) {
		return { ok: false, error: `快照失败，拒绝写入（无法建立回退点）：${snap.error}` };
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
		// 记录它被写过几次：回退计数要能回答"这条到底改了几版"。
		revisions: (Number(prev?.revisions ?? 0) || 0) + 1,
	});
	try {
		await mkdir(storageDir, { recursive: true });
		await writeFile(rulesPath(storageDir), `${JSON.stringify({ rules: next }, null, 2)}\n`, 'utf8');
		return { ok: true, count: next.length, snapshot: snap.n };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * 把一条规则回退到上一版快照（III-4）。
 *
 * ## 语义
 *
 * - 上一版不存在（快照里 `rule: null`）→ 这条规则是从无到有加的，回退 = 删掉它。
 * - 上一版存在 → 用快照内容覆盖回去。
 * - 超过回退上限（默认 3 次，按规则计）→ 拒绝自动回退，转人工。
 *
 * ## 为什么上限按规则计
 *
 * 同一条规则回退三次，说明问题不在"那一次写错"，而在**这条规则本身的判据
 * 不稳**（关键词选错、边界没想清）。继续自动回退只是让人舒服地重复同一个
 * 错误。到上限就该由人决定：精炼它，还是废弃它。
 *
 * @param {string} storageDir storages 根。
 * @param {string} ruleId 规则 id。
 * @param {object} [options] `{ rollbacks }` 该规则已回退次数（缺省按快照数近似）。
 * @returns {Promise<{ok: boolean, action?: 'restored'|'removed', n?: number, error?: string, used?: number, max?: number}>}
 */
export async function rollbackNegativeRule(storageDir, ruleId, options = {}) {
	const id = String(ruleId ?? '').trim();
	if (!id) return { ok: false, error: '需要 ruleId' };

	// III-5：回退同样是改规则库，必须走人工通道（与 confirm 同一守卫）。
	if (options.permit !== undefined && options.permit !== null) {
		const ok = requirePermit(options.permit, { ruleId: id }, options);
		if (!ok.ok) return { ok: false, error: ok.error, violation: ok.violation };
	} else if (options.human !== true) {
		return { ok: false, error: 'not_human_confirmed', violation: VIOLATIONS.unconfirmedCandidate };
	}

	const allowed = await canRollback(storageDir, id, options.rollbacks);
	if (!allowed.allowed) {
		return {
			ok: false,
			error: allowed.reason,
			used: allowed.used,
			max: allowed.max,
			// 到上限并不意味着失败，而是"这一类修法已试过三次"——调用方据此转人工。
			human_gate_required: true,
		};
	}

	const latest = await readLatestSnapshot(storageDir, id);
	if (!latest.ok) return { ok: false, error: latest.error ?? 'no_snapshot' };

	const existing = await readNegativeRules(storageDir);
	if (existing === undefined) return { ok: false, error: '负向规则库读取失败，拒绝盲写' };

	const prev = latest.rule;
	const next = existing.filter((r) => r?.id !== id);
	if (prev && typeof prev === 'object') next.push(prev);

	try {
		await mkdir(storageDir, { recursive: true });
		await writeFile(rulesPath(storageDir), `${JSON.stringify({ rules: next }, null, 2)}\n`, 'utf8');
		// 标记该快照已消费，否则下次回退会重复恢复同一版（实测缺陷）。
		await markSnapshotConsumed(storageDir, id, latest.n);
		return {
			ok: true,
			action: prev ? 'restored' : 'removed',
			n: latest.n,
			used: allowed.used + 1,
			max: allowed.max,
		};
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