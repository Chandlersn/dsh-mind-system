/**
 * 公理闸门限速（IV-5）：每月最多生效一次 + 显式测试通道。
 *
 * ## 为什么公理要单独限速
 *
 * 层里所有东西都能改，唯独公理代表"这个世界是什么"的最底层断言。改错一条
 * 公理，上层全部判据跟着歪——而且歪得自洽，事后极难发现（这正是我们反复
 * 踩过的"自洽的错误最难查"）。所以公理的修改不是"再多一道审批"，而是
 * **频率限制**：一个月最多让一条公理变更生效一次，逼迫"想清楚再动"。
 *
 * ## 上轮留下的矛盾（必须解决，不能绕）
 *
 * 上轮验收卡住的真实原因：限速一加，**测试就跑不过了**——测试需要反复生效
 * 公理来验证路径，而限速把第二次就拒掉。于是要么放宽限速（限速失效），
 * 要么把测试样本混进生产账本（**污染校准分布**，等于用测试给限速记账）。
 *
 * 两条路都是错的。第三条：**测试通道显式声明**。
 * - 生产通道：受月度限速约束，计入额度。
 * - 测试通道：调用方**显式**声明 `testChannel: true`；它照样完整走判据、
 *   照样返回真实判定，但**不消耗额度、不写生产账本**。
 *
 * 关键约束：`testChannel` 只能由**显式参数**打开，不能靠环境变量或全局开关
 * ——否则"忘关开关"会把生产流量当测试放行，限速形同虚设。
 *
 * @module src/ratelimit
 */

/** 默认限速窗口：一个月（按 30 天算——单用户系统里"月"没有日历意义，固定窗口更好推理）。 */
export const AXIOM_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** 窗口内最多允许生效几次。公理的语义是"极少变动"，一次即可。 */
export const AXIOM_MAX_PER_WINDOW = 1;

/** 限速拒绝码。 */
export const AXIOM_RATE_LIMITED = 'axiom_rate_limited';

/**
 * 判定一次公理变更是否被限速。
 *
 * @param {object} input
 * @param {object[]} input.entries 账本行（只看公理生效记录）。
 * @param {number} input.now 当前时间（毫秒）。
 * @param {boolean} [input.testChannel] 是否走测试通道（不消耗额度）。
 * @param {object} [options] `{ windowMs, maxPerWindow }` 覆盖默认。
 * @returns {{allowed: boolean, code?: string, used?: number, max?: number, windowMs?: number, resetAt?: string, testChannel?: boolean}}
 */
export function checkAxiomRate(input, options = {}) {
	const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : AXIOM_WINDOW_MS;
	const max = Number.isFinite(options.maxPerWindow) ? options.maxPerWindow : AXIOM_MAX_PER_WINDOW;
	const now = Number.isFinite(input?.now) ? input.now : Date.now();

	// 测试通道：照样返回判定，但永不拒绝、永不计数。
	// 这是上轮矛盾的解 —— 测试不必绕过限速，只需声明自己是测试。
	if (input?.testChannel === true) {
		return { allowed: true, used: 0, max, windowMs, testChannel: true };
	}

	// 只数"真正生效过"的公理变更。verify/演练不算额度消耗？
	// 算 —— 它们改变的是真实规则库；不写账本的才不算（那正是 testChannel）。
	const used = countAxiomChanges(input?.entries, now, windowMs);
	if (used >= max) {
		const oldest = oldestInWindow(input?.entries, now, windowMs);
		return {
			allowed: false,
			code: AXIOM_RATE_LIMITED,
			used,
			max,
			windowMs,
			// 说清什么时候能再动 —— 拒绝必须给出可行动的下一步，否则只是堵路。
			...(oldest === null ? {} : { resetAt: new Date(oldest + windowMs).toISOString() }),
		};
	}
	return { allowed: true, used, max, windowMs };
}

/** 窗口内公理变更的时间戳（升序）。 */
function axiomTimestamps(entries, now, windowMs) {
	const from = now - windowMs;
	const out = [];
	for (const e of Array.isArray(entries) ? entries : []) {
		// 公理变更的识别：上行判定里 rule_type/negative_type 指向公理，且真的生效了。
		// 「生效」= outcome admitted（被拒/降级的不占用额度，因为它们没改变规则库）。
		if (e?.outcome !== 'admitted') continue;
		const isAxiom = e?.rule_type === 'axiom'
			|| e?.negative_type === 'weakened_axiom'
			|| e?.action === 'axiom_change';
		if (!isAxiom) continue;
		const t = Date.parse(e?.t);
		if (!Number.isFinite(t) || t < from || t > now) continue;
		out.push(t);
	}
	return out.sort((a, b) => a - b);
}

function countAxiomChanges(entries, now, windowMs) {
	return axiomTimestamps(entries, now, windowMs).length;
}

function oldestInWindow(entries, now, windowMs) {
	const ts = axiomTimestamps(entries, now, windowMs);
	return ts.length === 0 ? null : ts[0];
}

/**
 * 把限速判定套到一次上行准入的结果上。
 *
 * 职责分离：谓词回答"这次变更合不合规"（admitUpward），本函数回答
 * "现在允不允许它落地"（限速）。两者都通过才进 human_gate。
 *
 * @param {object} decision admitUpward 的返回。
 * @param {object} rate checkAxiomRate 的返回。
 * @returns {object} 合并后的判定（保持原 reason，附加限速信息）。
 */
export function applyAxiomLimit(decision, rate) {
	if (!rate || rate.allowed !== false) return decision;
	return {
		...decision,
		// 合规但被限速：这不是"判据拒绝"，而是"时机不许"。两者必须能在账本上分开，
		// 否则事后分不清"这条公理本身有问题"还是"上个月已经改过一条了"。
		action: 'reject',
		reason: rate.code,
		rate_limited: true,
		used: rate.used,
		max: rate.max,
		...(rate.resetAt ? { reset_at: rate.resetAt } : {}),
	};
}
