/**
 * 越权拦截（III-5）：规则库的写入必须**证明**自己经过了人工确认。
 *
 * ## 为什么需要它（问题本身）
 *
 * III-4 之后，规则库只有两个写入点：`confirmNegativeRule` 与
 * `rollbackNegativeRule`。但"只有两个入口"是**我读代码得出的结论**，
 * 不是机制保证的——任何人（包括未来的我）加一条新路径，只要直接
 * `writeFile(rulesPath(...))`，就绕过了人工确认闸门，而且**不会报错**。
 *
 * 越权在这个系统里有三种具体形态：
 *
 * 1. **候选未确认直接生效** —— 提名/判定产出的候选被当作正式规则写库。
 *    危害最大：它让阀门从"人工闸门"退回"自动全信"。
 * 2. **跳过判据写库** —— 绕过 `layer-gate` 之类的准入判据直接落盘。
 * 3. **越层写** —— 写自己无权写的层（如提名器向 L1 直接写规则）。
 *
 * ## 做法：写入票（write permit）
 *
 * 不靠"调用者记得走 confirm"。写入点必须出示一张**由人工动作签发的票**：
 * `issuePermit()` 只在 `confirm` / `rollback` 这两个人工通道里被调用，
 * `requirePermit()` 在真正落盘前校验。没有票 → 拒绝写入并记审计事件。
 *
 * 票带：
 * - `via`：签发渠道（confirm / rollback）—— 审计时能回答"这是谁批准写的"
 * - `ruleId`：绑定的规则 id —— 防止拿 A 规则的票去写 B
 * - `at`：签发时刻 —— 过期票不许用（默认 5 分钟，够一次调用的往返）
 *
 * ## 不追求"防恶意"
 *
 * 这不是安全边界（同进程内的代码总能绕过），是**防手滑与防遗忘**：
 * 让"绕过人工闸门"变成一个必须显式撒谎的动作，而不是一次疏忽。
 * 说明书 §4.8 的语义越权（靠相似度检测）在 III-6，那是另一个层面。
 *
 * @module src/guard
 */
import { randomUUID } from 'node:crypto';

/** 票的有效期（毫秒）。够一次工具调用往返，又短到过期票不会被复用。 */
export const PERMIT_TTL_MS = 5 * 60 * 1000;

/**
 * 允许签发票的渠道 —— 只有人工通道。自动提名/判定**不在**此列。
 *
 * IV-3 补 `sink`：沉底是 valve_confirm 的第三个 action，与 confirm/rollback
 * 同属人工入口（定时巡检只报候选，不代劳）。它同样是改规则库的动作，
 * 必须有票；放进白名单不是放宽，是承认"这也是人在点"。
 */
export const HUMAN_CHANNELS = Object.freeze(['confirm', 'rollback', 'sink']);

/** 进程内票据表（票只活一次调用，不需要持久化）。 */
const permits = new Map();

/**
 * 三类越权的稳定代号（落账与测试都用它，避免各写各的字符串）。
 */
export const VIOLATIONS = Object.freeze({
	/** 候选未确认直接生效。 */
	unconfirmedCandidate: 'unconfirmed_candidate',
	/** 绕过准入判据直接写库。 */
	skippedCriteria: 'skipped_criteria',
	/** 越层写入。 */
	crossLayerWrite: 'cross_layer_write',
});

/**
 * 签发一张写入票。**只能由人工通道调用。**
 *
 * @param {object} input 签发内容。
 * @param {string} input.via 渠道（必须是 HUMAN_CHANNELS 之一）。
 * @param {string} input.ruleId 绑定的规则 id。
 * @param {object} [options] `{ now }` 注入时钟（测试用）。
 * @returns {{ok: boolean, token?: string, error?: string}}
 *   非人工渠道会被拒绝——这是"候选未确认直接生效"的第一道拦截。
 */
export function issuePermit(input, options = {}) {
	const via = String(input?.via ?? '').trim();
	const ruleId = String(input?.ruleId ?? '').trim();
	if (!ruleId) return { ok: false, error: 'permit_requires_rule_id' };
	if (!HUMAN_CHANNELS.includes(via)) {
		// 自动通道（nomination / 判定）不得签票。
		return { ok: false, error: 'permit_requires_human_channel', violation: VIOLATIONS.unconfirmedCandidate, via };
	}
	const token = randomUUID();
	const now = Number.isFinite(options?.now) ? options.now : Date.now();
	permits.set(token, { via, ruleId, at: now });
	// 顺便清理过期票，避免长期运行后表里堆垃圾。
	for (const [t, p] of permits) {
		if (now - p.at > PERMIT_TTL_MS) permits.delete(t);
	}
	return { ok: true, token };
}

/**
 * 校验一张票：存在、未过期、且绑定的是这条规则。
 *
 * @param {string} token 票。
 * @param {object} input 待校验的写入。
 * @param {string} input.ruleId 要写的规则 id。
 * @param {object} [options] `{ now, allowLayers, layer }`。
 * @returns {{ok: boolean, error?: string, violation?: string, via?: string}}
 */
export function requirePermit(token, input, options = {}) {
	const t = String(token ?? '').trim();
	const ruleId = String(input?.ruleId ?? '').trim();
	if (!t) {
		return { ok: false, error: 'missing_permit', violation: VIOLATIONS.unconfirmedCandidate };
	}
	const p = permits.get(t);
	if (!p) {
		// 没有票 / 伪造的票：与"未确认"同类。
		return { ok: false, error: 'unknown_permit', violation: VIOLATIONS.unconfirmedCandidate };
	}
	const now = Number.isFinite(options?.now) ? options.now : Date.now();
	if (now - p.at > PERMIT_TTL_MS) {
		permits.delete(t);
		return { ok: false, error: 'expired_permit', violation: VIOLATIONS.unconfirmedCandidate };
	}
	if (p.ruleId !== ruleId) {
		// 拿 A 的票写 B：票是绑定的，不能借用。
		return { ok: false, error: 'permit_rule_mismatch', violation: VIOLATIONS.unconfirmedCandidate };
	}
	// 越层检查：给了允许层清单才判（不提供就跳过，不为不存在的规则编造约束）。
	if (Array.isArray(options.allowLayers) && typeof options.layer === 'string' && options.layer) {
		if (!options.allowLayers.includes(options.layer)) {
			return { ok: false, error: 'layer_not_allowed', violation: VIOLATIONS.crossLayerWrite, via: p.via };
		}
	}
	return { ok: true, via: p.via };
}

/**
 * 消费一张票（写入成功后调用）。票是一次性的：同一张票不能写两次。
 *
 * @param {string} token 票。
 * @returns {boolean} 是否成功消费（票不存在或已用返回 false）。
 */
export function consumePermit(token) {
	const t = String(token ?? '').trim();
	return permits.delete(t);
}

/**
 * 跳过判据直接写库的显式拦截。
 *
 * 单独成函数而不是散在各处，是为了让"跳过判据"只有一个可读的判据来源：
 * 调用方必须显式声明它跑了哪些判据；空数组 = 什么都没跑 = 越权。
 *
 * @param {string[]} criteriaRun 实际执行过的判据名。
 * @returns {{ok: boolean, error?: string, violation?: string}}
 */
export function requireCriteria(criteriaRun) {
	const list = Array.isArray(criteriaRun) ? criteriaRun.filter((c) => typeof c === 'string' && c.trim()) : [];
	if (list.length === 0) {
		return { ok: false, error: 'skipped_criteria', violation: VIOLATIONS.skippedCriteria };
	}
	return { ok: true, criteria: list };
}

/** 仅供测试：清空票据表（生产路径不需要）。 */
export function __resetPermits() {
	permits.clear();
}
