/**
 * 层修改机制（IV-4）：提议 → 人工终审 → 迁移映射 → 兼容期。
 *
 * ## 为什么层修改比规则修改更危险
 *
 * 规则错了，回滚一条规则就完事。**层名错了，所有按旧层名写下的历史记录
 * 全部指向一个不再存在的层**——而那些历史记录是判据的证据。所以这里有一条
 * 不可协商的纪律：**旧 trace 永不重写**。
 *
 * 重写历史看起来"干净"，实际是把证据改成符合当前说法的样子，
 * 事后无法核验当初到底判的是什么。宁可让查询时做一次映射。
 *
 * ## 四个阶段，前三个都不改任何东西
 *
 * 1. **提议**（propose）：只是记下"想改成什么、为什么"。不生效。
 * 2. **人工终审**（approve）：显式人工确认。这是唯一让状态前进的通道。
 * 3. **迁移映射**（mapping）：旧名→新名的对照表，供查询时实时换算。
 * 4. **兼容期**（compat）：旧名仍可查、结果标注"已映射"，到期后才退役。
 *
 * 全程**不自动生效**：`approve` 之外没有任何函数能把 `proposed` 变成 `active`。
 *
 * @module src/layerchange
 */

/** 层修改状态机。只有 approve 能推进。 */
export const LAYER_CHANGE_STATES = Object.freeze({
	proposed: 'proposed',
	approved: 'approved',
	active: 'active',
	retired: 'retired',
	rejected: 'rejected',
});

/** 稳定代号（账本与测试共用）。 */
export const LAYER_CHANGE_CODES = Object.freeze({
	notApproved: 'layer_change_not_approved',
	invalidLayers: 'layer_change_invalid_layers',
	unknownOldLayer: 'layer_unknown_old',
});

/** 默认兼容期：90 天（与道/法的演化节奏同量级，够长到不打断使用，够短到不会永久背着）。 */
export const DEFAULT_COMPAT_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * 提议一次层修改。**不生效**，只登记。
 *
 * @param {object} input
 * @param {string[]} input.layers 当前层表。
 * @param {string} input.from 旧层名。
 * @param {string} input.to 新层名。
 * @param {string} input.reason 为什么要改（必填——没有理由的改名无法复核）。
 * @param {string} [input.proposedBy] 提议来源。
 * @param {number} [input.now] 注入时钟（测试用）。
 * @returns {{ok: boolean, change?: object, error?: string}}
 */
export function proposeLayerChange(input) {
	const layers = Array.isArray(input?.layers) ? input.layers.map(String) : [];
	const from = String(input?.from ?? '').trim();
	const to = String(input?.to ?? '').trim();
	const reason = String(input?.reason ?? '').trim();
	if (!from || !to || !reason) return { ok: false, error: '需要 from / to / reason' };
	if (!layers.includes(from)) {
		// 改一个不存在的层 = 提议本身就错了，不能进流程。
		return { ok: false, error: LAYER_CHANGE_CODES.unknownOldLayer, detail: { from, layers } };
	}
	if (layers.includes(to)) {
		// 新名撞上现有层：会让两个不同的层共用一个名字。
		return { ok: false, error: LAYER_CHANGE_CODES.invalidLayers, detail: { to, layers } };
	}
	const now = Number.isFinite(input?.now) ? input.now : Date.now();
	return {
		ok: true,
		change: {
			id: `layer-change-${from}-to-${to}`.replace(/[^\w-]/g, '_'),
			from,
			to,
			reason,
			state: LAYER_CHANGE_STATES.proposed,
			proposed_at: new Date(now).toISOString(),
			...(typeof input?.proposedBy === 'string' ? { proposed_by: input.proposedBy } : {}),
			// 迁移映射在提议时就算好并冻结：终审时看到的映射必须与生效时一致，
			// 否则"批准的是什么"与"执行的是什么"可能是两件事。
			mapping: { [from]: to },
		},
	};
}

/**
 * 人工终审。**这是唯一让提议前进的通道。**
 *
 * @param {object} change proposeLayerChange 的产出。
 * @param {object} input
 * @param {boolean} input.approved 是否批准。
 * @param {string} [input.by] 审批人/来源。
 * @param {string} [input.note] 备注。
 * @param {number} [input.now] 注入时钟。
 * @returns {{ok: boolean, change?: object, error?: string}}
 */
export function reviewLayerChange(change, input) {
	if (!change || typeof change !== 'object') return { ok: false, error: 'change 缺失' };
	if (change.state !== LAYER_CHANGE_STATES.proposed) {
		return { ok: false, error: 'only_proposed_can_be_reviewed', detail: { state: change.state } };
	}
	const now = Number.isFinite(input?.now) ? input.now : Date.now();
	const approved = input?.approved === true;
	const at = new Date(now).toISOString();
	return {
		ok: true,
		change: {
			...change,
			state: approved ? LAYER_CHANGE_STATES.approved : LAYER_CHANGE_STATES.rejected,
			reviewed_at: at,
			...(typeof input?.by === 'string' ? { reviewed_by: input.by } : {}),
			...(typeof input?.note === 'string' ? { review_note: input.note } : {}),
		},
	};
}

/**
 * 把已批准的修改激活（进入兼容期）。**未批准一律拒绝。**
 *
 * 这个函数是"层修改永不自动生效"的执行点：它只接受
 * `state === approved`，而 approved 只能由 reviewLayerChange 产出。
 *
 * @param {object} change 已 approve 的修改。
 * @param {object} [options] `{ compatMs, now }`。
 * @returns {{ok: boolean, change?: object, error?: string}}
 */
export function activateLayerChange(change, options = {}) {
	if (!change || typeof change !== 'object') return { ok: false, error: 'change 缺失' };
	if (change.state !== LAYER_CHANGE_STATES.approved) {
		return {
			ok: false,
			error: LAYER_CHANGE_CODES.notApproved,
			detail: { state: change.state },
		};
	}
	const compatMs = Number.isFinite(options?.compatMs) ? options.compatMs : DEFAULT_COMPAT_MS;
	const now = Number.isFinite(options?.now) ? options.now : Date.now();
	return {
		ok: true,
		change: {
			...change,
			state: LAYER_CHANGE_STATES.active,
			activated_at: new Date(now).toISOString(),
			// 兼容期：旧名仍可查，到期才退役。给一个明确的截止时间，
			// 而不是"以后某天再说"——那等于永不退役。
			compat_until: new Date(now + compatMs).toISOString(),
		},
	};
}

/**
 * 把旧层名映射成新名（兼容期内使用）。
 *
 * **只做查询时的换算，不碰历史记录。** 返回 `mapped: true` 让调用方
 * 知道这个结果来自旧名——否则用户会以为历史上就是这么写的。
 *
 * @param {object[]} changes 全部层修改记录。
 * @param {string} name 待查层名。
 * @param {object} [options] `{ now }`。
 * @returns {{name: string, mapped: boolean, from?: string, compatUntil?: string, state?: string}}
 */
export function mapLayerName(changes, name, options = {}) {
	const target = String(name ?? '').trim();
	const now = Number.isFinite(options?.now) ? options.now : Date.now();
	for (const c of Array.isArray(changes) ? changes : []) {
		if (!c || c.from !== target) continue;
		const active = c.state === LAYER_CHANGE_STATES.active;
		if (!active) continue;
		const until = Date.parse(c.compat_until);
		// 兼容期已过：映射仍然给出（旧数据永远需要能读），但标 retired。
		const expired = Number.isFinite(until) && now > until;
		return {
			name: c.to,
			mapped: true,
			from: target,
			...(c.compat_until ? { compatUntil: c.compat_until } : {}),
			state: expired ? LAYER_CHANGE_STATES.retired : LAYER_CHANGE_STATES.active,
		};
	}
	return { name: target, mapped: false };
}

/**
 * 层表的当前形态：应用所有 active 修改后的结果。
 *
 * @param {string[]} baseLayers 原始层表。
 * @param {object[]} changes 层修改记录。
 * @param {object} [options] `{ now }`。
 * @returns {{layers: string[], applied: number}}
 */
export function effectiveLayers(baseLayers, changes, options = {}) {
	const layers = (Array.isArray(baseLayers) ? baseLayers : []).map(String);
	let applied = 0;
	for (const c of Array.isArray(changes) ? changes : []) {
		if (c?.state !== LAYER_CHANGE_STATES.active) continue;
		const i = layers.indexOf(c.from);
		if (i === -1) continue;
		layers[i] = c.to;
		applied++;
	}
	void options;
	return { layers, applied };
}
