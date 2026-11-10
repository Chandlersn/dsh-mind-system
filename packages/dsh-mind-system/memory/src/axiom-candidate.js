/**
 * 候选公理层（2026-11-10，用户要求）。
 *
 * ## 用户原话与它解决的问题
 *
 * > "公理层可以加一个候选公理层，agent 按照机制一层层迭代升华、抽象，
 * > 最后主动展现给用户，由用户来决策，点击确认，是否加入真正的公理层。"
 *
 * 原来道层是**一步到位**的：够 5 条法就能写进去，写进去立刻就是道。
 * 这有两个毛病：
 *
 * 1. **缺一个"我看过但还没同意"的位置**。agent 攒够 5 条法就能自己升格，
 *    用户只在事后看到结果——而道是最抽象、错了影响最大的一层。
 * 2. **候选没处放，就只能两种结局**：要么硬憋着不写（攒着攒着就忘了），
 *    要么直接写成正式道（绕过了人的决策）。
 *
 * 候选层是第三种位置：**它存在、可见、能被反复打磨，但在用户点确认之前
 * 不参与任何判断**。
 *
 * ## 与正式道的分工（判据仍是一处）
 *
 * 候选**走同一套 gateDao**（≥5 条不同的法 / 命题不含具体标记 / 不是操作手册）。
 * 候选态不是"降低标准"，只是"还没到最后一步"。所以：
 *
 * - 候选三关全过 → 可以进候选区（status=candidate）
 * - 用户确认 → 转正（status=active），才进入 MEMORY.md 道层、才被召回
 * - 用户否决 → status=rejected，保留理由与证据（反例也是资产）
 *
 * ## 为什么候选绝不能进召回
 *
 * 召回会把内容当作"证据"注入下一轮判断。候选公理还没被人认可，一旦注入，
 * agent 会拿一个"我猜的命题"当既定前提推理——这正是"自产信号给自己背书"。
 * 所以 `recallable()` 只放行 active。
 *
 * @module src/axiom-candidate
 */

/** 候选公理的生命周期。只有 confirm 能把它推到 active。 */
export const AXIOM_CANDIDATE_STATES = Object.freeze({
	/** 已过闸门，等待用户决策。可被反复打磨（改命题/补来源）。 */
	candidate: 'candidate',
	/** 用户点确认后的正式公理。进入 MEMORY.md 道层，参与召回。 */
	active: 'active',
	/** 用户否决。保留提案与理由——被否决的命题是"这个世界不是什么"的证据。 */
	rejected: 'rejected',
});

/** 稳定代号（账本、测试、面板共用）。 */
export const AXIOM_CANDIDATE_CODES = Object.freeze({
	notCandidate: 'axiom_not_candidate',
	unknown: 'axiom_candidate_unknown',
	gateFailed: 'axiom_gate_failed',
});

/**
 * 造一条候选公理（**不生效**）。
 *
 * 判据委托给调用方传入的 gate（生产上是 `gateDao`），本函数只负责：
 * 逐层来源必须齐全、状态置 candidate、记下"为什么它够格"。
 *
 * @param {object} input
 * @param {string} input.name 道名 slug。
 * @param {string} input.proposition 一句话命题。
 * @param {string[]} input.extractedFrom 来源法 slug（≥5 条不同的）。
 * @param {string} [input.evidence] 为什么这些法指向同一个命题（人写的理由）。
 * @param {object} input.gate 闸门函数 `(input) => {ok, reason?, warnings?}`。
 * @param {number} [input.now] 注入时钟。
 * @returns {{ok: boolean, candidate?: object, reason?: string}}
 */
export function proposeAxiomCandidate(input) {
	const name = String(input?.name ?? '').trim();
	const proposition = String(input?.proposition ?? '').trim();
	const from = Array.isArray(input?.extractedFrom)
		? [...new Set(input.extractedFrom.map((s) => String(s ?? '').trim()).filter(Boolean))]
		: [];
	const gate = input?.gate;
	if (typeof gate !== 'function') {
		return { ok: false, reason: '需要 gate 函数（生产上传 gateDao）——候选不走自己的判据' };
	}
	// 复用同一套闸门：候选不是"降标准的道"。
	const verdict = gate({ name, proposition, extractedFrom: from, existing: input?.existing });
	if (!verdict?.ok) {
		return { ok: false, reason: verdict?.reason ?? AXIOM_CANDIDATE_CODES.gateFailed };
	}
	const now = Number.isFinite(input?.now) ? input.now : Date.now();
	return {
		ok: true,
		candidate: {
			name,
			proposition,
			extracted_from: from,
			evidence: typeof input?.evidence === 'string' ? input.evidence : '',
			status: AXIOM_CANDIDATE_STATES.candidate,
			proposed_at: new Date(now).toISOString(),
			// 闸门的警告（如来源过多）一路带上来，呈现在用户面前时不丢信息。
			...(Array.isArray(verdict.warnings) && verdict.warnings.length ? { warnings: verdict.warnings } : {}),
		},
	};
}

/**
 * 用户确认 → 转正。
 *
 * **这是候选变成正式公理的唯一通道**，且必须是用户显式决定
 * （`byUser: true`）。agent 自己调不算——那会让"主动展现给用户"退化成
 * "自己批准自己"。
 *
 * @param {object} candidate 候选公理。
 * @param {object} input `{ byUser: boolean, note?: string, now?: number }`
 * @returns {{ok: boolean, axiom?: object, reason?: string}}
 */
export function confirmAxiomCandidate(candidate, input) {
	if (!candidate || candidate.status !== AXIOM_CANDIDATE_STATES.candidate) {
		return { ok: false, reason: AXIOM_CANDIDATE_CODES.notCandidate, state: candidate?.status };
	}
	if (input?.byUser !== true) {
		// 与阀门的人工闸门同一纪律：确认必须是人的动作，不能由生成方代劳。
		return { ok: false, reason: 'confirmation_requires_user', hint: '候选必须由用户点确认，agent 不能代替' };
	}
	const now = Number.isFinite(input?.now) ? input.now : Date.now();
	return {
		ok: true,
		axiom: {
			...candidate,
			status: AXIOM_CANDIDATE_STATES.active,
			confirmed_at: new Date(now).toISOString(),
			...(typeof input?.note === 'string' ? { confirm_note: input.note } : {}),
		},
	};
}

/**
 * 用户否决。
 *
 * 否决**保留**候选与理由：被否决的命题是"这个世界不是什么"的证据，
 * 下次有人提出同一个命题时能查到"上次为什么没通过"。
 *
 * @param {object} candidate 候选公理。
 * @param {object} input `{ reason: string, now?: number }`
 * @returns {{ok: boolean, axiom?: object, reason?: string}}
 */
export function rejectAxiomCandidate(candidate, input) {
	if (!candidate || candidate.status !== AXIOM_CANDIDATE_STATES.candidate) {
		return { ok: false, reason: AXIOM_CANDIDATE_CODES.notCandidate, state: candidate?.status };
	}
	const why = String(input?.reason ?? '').trim();
	if (!why) {
		// 否决必须说理由：否则下次同一个命题会原样再提一遍。
		return { ok: false, reason: 'rejection_requires_reason' };
	}
	const now = Number.isFinite(input?.now) ? input.now : Date.now();
	return {
		ok: true,
		axiom: {
			...candidate,
			status: AXIOM_CANDIDATE_STATES.rejected,
			rejected_at: new Date(now).toISOString(),
			reject_reason: why,
		},
	};
}

/**
 * 候选能否进入召回/判定。
 *
 * **只放行 active**。候选与被否决的一律不进——召回会把内容当证据注入下一轮，
 * 让 agent 拿"还没被认可的命题"当前提推理，就是自产信号给自己背书。
 *
 * @param {object} axiom 一条公理/候选。
 * @returns {boolean}
 */
export function recallable(axiom) {
	return axiom?.status === AXIOM_CANDIDATE_STATES.active;
}

/**
 * 把候选整理成"给用户看的一条"——主动展现的呈现层。
 *
 * 刻意包含：命题、来源法清单、为什么够格（闸门判据）、待决策标记。
 * 不包含：让它看起来像已成定论的任何措辞。
 *
 * @param {object} candidate 候选公理。
 * @returns {object} 可渲染的呈现数据。
 */
export function describeCandidate(candidate) {
	if (!candidate) return null;
	return {
		name: candidate.name,
		proposition: candidate.proposition,
		source_count: Array.isArray(candidate.extracted_from) ? candidate.extracted_from.length : 0,
		sources: Array.isArray(candidate.extracted_from) ? [...candidate.extracted_from] : [],
		evidence: candidate.evidence || '',
		status: candidate.status,
		// 明确写出"等你决定"，避免被读成已经生效。
		decision_needed: candidate.status === AXIOM_CANDIDATE_STATES.candidate,
		...(Array.isArray(candidate.warnings) && candidate.warnings.length ? { warnings: candidate.warnings } : {}),
	};
}
