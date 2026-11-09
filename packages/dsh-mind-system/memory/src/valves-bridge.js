/**
 * 阀门桥 —— memory 对 dsh-valves 的**可选**依赖（N4：缺了降级，不阻断）。
 *
 * ## 为什么是桥而不是 import
 *
 * 直接 import 会让 memory 反向依赖 valves——没装 valves 就装不上 memory。
 * 桥走 `ctx.get('valves')` 运行时探测：valves 在就用，不在就全部返回
 * undefined/null，memory 的既有行为一分不变。
 *
 * ## 分工（判据单一实现）
 *
 * 层级写入闸门（gateFa/gateDao）仍归 memory——它更严、已实战；
 * 本桥只取 valves 独有的两件：
 * 1. 下行负向规则：召回时把已确认的禁令注入（零配合——写记忆的插件
 *    不需要知道 valves 存在，禁令照样出现在下一个任务的上下文里）。
 * 2. 上行评估留痕：insight/dao 写入后把量化证据送阀门账本评估一次，
 *    **只留痕不改写入结果**——两套判据不裁决同一件事，valves 的账本
 *    是分布原料，memory 的闸门是生效判据。
 */

/** 从宿主上下文探测 valves 服务；拿不到返回 undefined（每次探测，不缓存装载时序）。 */
export function probeValves(ctx) {
	try {
		const v = ctx?.get?.('valves');
		if (v && typeof v.negativeRules === 'function' && typeof v.upward === 'function') return v;
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * 取与当前用户文本相关的已确认负向规则（关键词命中）。
 *
 * 返回 [] = 查过没命中；undefined = 没查（服务不在或读库失败）。
 * 两者必须分开：召回文案对"查过没命中"沉默，对"没查成"也沉默——
 * 但账本/探针能区分（读库失败由 valves 自己的 metrics 报 store-unreadable）。
 *
 * @param ctx Cordis 上下文。
 * @param userText 本轮用户文本。
 * @returns 规则数组（可能为空）或 undefined。
 */
export async function relevantNegativeRules(ctx, userText) {
	const valves = probeValves(ctx);
	if (!valves) return undefined;
	const rules = await valves.negativeRules();
	if (!Array.isArray(rules) || rules.length === 0) return rules === undefined ? undefined : [];
	const t = String(userText ?? '').toLowerCase();
	if (!t.trim()) return [];
	return rules.filter((r) =>
		Array.isArray(r?.keywords) && r.keywords.some((k) => typeof k === 'string' && k.trim() && t.includes(k.toLowerCase())),
	);
}

/**
 * 上行评估留痕：把一次 insight/dao 写入送阀门账本。
 *
 * **永不抛错、永不改变写入结果**——桥坏了不能连累已经落盘的记忆。
 * 证据字段缺省时如实传缺省（valves 谓词会给出 downgrade/reject 并落账，
 * 那正是账本该记的：多少写入根本没带量化证据）。
 *
 * **字段映射的诚实边界**：memory 的写入参数没有 repeats/success_rate 这类
 * 执行统计，只有来源与验证陈述。所以这里映射的只是"证据是否可外部检验"
 * （J1）：verification/来源回链 → evidence，open（待观察）→ verifiable_by。
 * 量化覆盖（skill_coverage 等）在 args.valve_evidence 显式提供时才透传——
 * 不从来源数编造覆盖率（来源域数 ≠ 独立技能数）。
 *
 * @param ctx Cordis 上下文。
 * @param entry { rule_type: 'criterion'|'axiom', evidence: string[], verifiable_by?,
 *   skill_coverage?, scenario_coverage?, anti_example_count?, predict_rate?, candidate_id? }
 * @returns 阀门判定；服务不在时 undefined。
 */
export function recordUpwardWrite(ctx, entry) {
	try {
		const valves = probeValves(ctx);
		if (!valves) return undefined;
		// 记忆分层的映射：functions=术(L2)、insights=法(L1)、dao=道(L0)。
		const from = entry.rule_type === 'axiom' ? 'L1' : 'L2';
		const to = entry.rule_type === 'axiom' ? 'L0' : 'L1';
		return valves.upward(from, to, { kind: 'positive', ...entry });
	} catch {
		return undefined;
	}
}

/**
 * 从 memory_insight / memory_dao 的写入参数构造留痕 entry。
 * 显式 valve_evidence（对象）里只透传白名单字段，防止任意键混进账本。
 */
export function upwardEntryFromWrite(ruleType, args, fallbackEvidence) {
	const explicit = args?.valve_evidence && typeof args.valve_evidence === 'object' ? args.valve_evidence : {};
	const pick = {};
	for (const key of ['skill_coverage', 'scenario_coverage', 'anti_example_count', 'predict_rate', 'overlap', 'verifiable_by']) {
		if (explicit[key] !== undefined) pick[key] = explicit[key];
	}
	const evidence = Array.isArray(explicit.evidence) && explicit.evidence.length ? explicit.evidence : fallbackEvidence;
	return {
		rule_type: ruleType,
		candidate_id: String(args?.theme ?? args?.name ?? ''),
		evidence,
		// 没给 verifiable_by 就留空——谓词会判 not_externally_verifiable 并
		// downgrade 落账。不编一个默认值把"没说怎么检验"粉饰成"可检验"。
		...(pick.verifiable_by === undefined ? {} : { verifiable_by: pick.verifiable_by }),
		...pick,
	};
}