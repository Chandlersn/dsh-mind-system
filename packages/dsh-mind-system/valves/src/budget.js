/**
 * 预算缰绳（III-3）：给"自动批量执行面"加一道数量上限。
 *
 * ## 为什么需要它（问题本身）
 *
 * 提名器与治理循环都是**一次处理一整批**：一次 `valve_nominate` 会把
 * 几十条候选一起算出来、一起进账本。批量作业失控时不会有任何警报——
 * 账本只是安静地长出几千行，等到有人去看，混杂的数据已经无法回溯哪条
 * 是哪次跑的。预算缰绳的作用不是"省资源"，是**把失控变成一次明确的终止**：
 * 超限就停，并说清停在哪、还剩多少没处理。
 *
 * ## 数字从哪来（不抄说明书魔数）
 *
 * 说明书 §4.5 给了一个设计值（71 会话），但那是按"一个会话一批"算的。
 * 本机真实分布（2026-11-09 阀门账本 100 行）：
 *
 * ```
 * clis_nomination  44    ← 单次提名作业的实际规模
 * upward_*         46    ← 上行判定合计
 * 整天              100
 * ```
 *
 * 所以默认上限取 **120**（单批实测峰值 44 的约 2.7 倍），足够跑完一次
 * 完整提名 + 治理而不会误伤，又能在"某次突然冒出几百条"时立刻刹车。
 * 这个数是**暂定**的，和 thresholds.js 里其它数同一纪律：等更多天的分布再说。
 *
 * ## 设计要点
 *
 * - **先判后做**：`check()` 在批次开始前判定，不做事后补救（事后才发现
 *   超限时，副作用已经落盘）。
 * - **超限不静默截断**：直接终止并返回 `budget_exceeded` + 明细，绝不允许
 *   "悄悄只处理前 N 条"——那会让账本看起来完整、实际缺一段。
 * - **终止也要留痕**：调用方必须把 terminated_by 记进账本，否则"这次为什么
 *   只有一半数据"永远查不到。
 *
 * @module src/budget
 */

/** 暂定默认上限（单批处理条数）。标定依据见文件头。 */
export const DEFAULT_BUDGET = {
	/** 单批最多处理的条目数。 */
	maxItems: 120,
	/** 单批最多产出的账本行数（提名 + 治理合计）。 */
	maxLedgerRows: 400,
};

/**
 * 预算超限时的终止码。调用方据此写账本、抛错或降级。
 */
export const BUDGET_EXCEEDED = 'budget_exceeded';

/**
 * 判定一批作业是否在预算内。
 *
 * @param {object} input 待判定规模。
 * @param {number} [input.items] 本批要处理的条目数。
 * @param {number} [input.rows] 本批预计产出的账本行数。
 * @param {object} [options] 覆盖默认预算（测试用；生产走 DEFAULT_BUDGET）。
 * @returns {{ok: boolean, code?: string, detail?: object}}
 *   超限时返回 `{ok:false, code:'budget_exceeded', detail:{...}}`。
 */
export function check(input, options = {}) {
	const budget = { ...DEFAULT_BUDGET, ...(options.budget ?? {}) };
	const items = Number.isFinite(input?.items) ? input.items : 0;
	const rows = Number.isFinite(input?.rows) ? input.rows : 0;

	if (items < 0 || rows < 0) {
		// 负数规模说明调用方算错了 —— 与"超预算"是两件事，不能混为一谈。
		return { ok: false, code: 'invalid_scale', detail: { items, rows } };
	}

	const overItems = items > budget.maxItems;
	const overRows = rows > budget.maxLedgerRows;
	if (!overItems && !overRows) return { ok: true };

	return {
		ok: false,
		code: BUDGET_EXCEEDED,
		detail: {
			items, rows,
			maxItems: budget.maxItems,
			maxLedgerRows: budget.maxLedgerRows,
			// 超了哪个维度，还剩多少没处理（人看到的必须是具体的数）。
			exceeded: [overItems ? 'items' : null, overRows ? 'rows' : null].filter(Boolean),
			overBy: {
				items: overItems ? items - budget.maxItems : 0,
				rows: overRows ? rows - budget.maxLedgerRows : 0,
			},
		},
	};
}

/**
 * 把一次批量作业切成合规的批次。
 *
 * 与 `check()` 的分工：`check` 回答"这一批能不能跑"，`chunk` 回答
 * "跑不完就怎么切"。刻意不提供"自动只跑第一批然后假装成功"的便捷函数
 * —— 分批必须由调用方显式驱动，否则静默丢数据。
 *
 * @param {Array} list 待处理清单。
 * @param {object} [options] 覆盖默认预算。
 * @returns {Array<Array>} 批次数组（每批 ≤ maxItems）。
 */
export function chunk(list, options = {}) {
	const budget = { ...DEFAULT_BUDGET, ...(options.budget ?? {}) };
	const all = Array.isArray(list) ? list : [];
	if (all.length === 0) return [];
	const size = Math.max(1, budget.maxItems);
	const out = [];
	for (let i = 0; i < all.length; i += size) out.push(all.slice(i, i + size));
	return out;
}
