/**
 * 语义越权检测（III-6）——**标记不阻断**。
 *
 * ## 为什么是"标记"而不是"拦截"
 *
 * 显式越权（III-5）能拦，因为判据是硬的：没有票就是没有票，没有歧义。
 * 语义越权不同——它判断的是"这条候选在**意思上**碰了不该碰的边界"，
 * 而意思的判定本身会错。**拦截一个判错的语义越权，就是误伤一条正当路径**，
 * 代价比漏掉一条更大：
 *
 * - 漏掉：一场错误的规则被人工确认时才发现（有人工闸门兜底）；
 * - 误杀：正当规则被静默拦下，且没人知道为什么——这正是"阀门全拒"
 *   那种看起来在工作、实际在破坏的状态。
 *
 * 所以这里只做一件事：**标 possible_semantic_bypass 进人工抽查**。
 * 阻断权仍在人工确认闸门（`valve_confirm`）手里。
 *
 * ## 两层检测，第二层可选（N4 降级纪律）
 *
 * 1. **词面层（永远可用）**：`boundary_keywords` —— 规则自己声明"我保护
 *    的边界上有哪些词"，候选里出现同义/近义说法时标记。零依赖、可解释。
 * 2. **语义层（可选 peer）**：传 embedder 时算向量相似度，与边界关键词的
 *    质心比较；**不传就标 degraded 并继续**，主流程一行都不受影响。
 *
 * 缺 embedder 不是错误，是常态——所以 `degraded` 是 `status` 的一个正常取值，
 * 不是警告、不是失败、更不是阻断理由。
 *
 * @module src/semantic
 */

/** 语义通道的状态码。`degraded` 表示"没装 embedder，只用词面层"。 */
export const SEMANTIC_STATUS = Object.freeze({
	ok: 'ok',
	degraded: 'degraded',
	unavailable: 'unavailable',
});

/** 标记代号：进人工抽查队列，从不阻断。 */
export const POSSIBLE_BYPASS = 'possible_semantic_bypass';

/**
 * 归一化文本用于词面比较：统一大小写与空白。
 * 不做词干化（中文没有词干，英文词干化会引入不可解释的第三方规则）。
 */
function norm(text) {
	return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 词面层：候选描述与规则声明的边界关键词有多少重合。
 *
 * 判据刻意简单：**关键词包含**（不是分词）。理由与下行黑名单一致——
 * `matchNegativeRules` 已经在用包含匹配，两处判据保持一致才能解释得通
 * （否则维护者要同时理解两套匹配语义）。
 *
 * @param {object[]} rules 规则清单（每条可带 `boundary_keywords`）。
 * @param {string} text 候选描述。
 * @returns {{hits: Array<{ruleId: string, keyword: string}>, checked: number}}
 */
export function lexicalOverlap(rules, text) {
	const t = norm(text);
	const hits = [];
	let checked = 0;
	if (!t) return { hits, checked };
	for (const r of Array.isArray(rules) ? rules : []) {
		const kws = Array.isArray(r?.boundary_keywords) ? r.boundary_keywords : [];
		if (kws.length === 0) continue;
		checked++;
		for (const k of kws) {
			const kw = norm(k);
			if (kw && t.includes(kw)) hits.push({ ruleId: String(r?.id ?? ''), keyword: String(k) });
		}
	}
	return { hits, checked };
}

/**
 * 余弦相似度（语义层用）。
 *
 * 自己算而不是引第三方：这个函数只有八行，引入一个库来解决它会把
 * "可选 peer"变成"事实依赖"。
 *
 * @param {number[]} a 向量。
 * @param {number[]} b 向量。
 * @returns {number|null} 相似度；维度不一致或含非有限值时返回 null（不瞎算）。
 */
export function cosineSimilarity(a, b) {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return null;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	if (na === 0 || nb === 0) return null; // 零向量没有方向，相似度无意义
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 语义层：候选与某条边界声明的相似度。
 *
 * @param {object} input
 * @param {string} input.text 候选描述。
 * @param {string[]} input.boundaryKeywords 该规则声明的边界关键词。
 * @param {Function} [input.embed] 可选：(text) => Promise<number[]>。
 * @returns {Promise<{status: string, similarity: number|null, note?: string}>}
 *   `degraded` 时 similarity 为 null，**调用方不得据此阻断**。
 */
export async function semanticSimilarity(input) {
	const embed = input?.embed;
	if (typeof embed !== 'function') {
		// 没有 embedder 是常态，不是错误。主流程照常走词面层。
		return { status: SEMANTIC_STATUS.degraded, similarity: null, note: 'no_embedder' };
	}
	const text = String(input?.text ?? '');
	const kws = Array.isArray(input?.boundaryKeywords) ? input.boundaryKeywords : [];
	if (!text.trim() || kws.length === 0) {
		return { status: SEMANTIC_STATUS.ok, similarity: null, note: 'nothing_to_compare' };
	}
	try {
		const [vText, ...vKws] = await Promise.all([embed(text), ...kws.map((k) => embed(k))]);
		// 与每个边界关键词比，取最高——"最像哪一个"才是越权风险所在。
		let best = null;
		for (const v of vKws) {
			const s = cosineSimilarity(vText, v);
			if (s === null) continue;
			if (best === null || s > best) best = s;
		}
		if (best === null) {
			return { status: SEMANTIC_STATUS.unavailable, similarity: null, note: 'embedder_bad_vector' };
		}
		return { status: SEMANTIC_STATUS.ok, similarity: Number(best.toFixed(4)) };
	} catch (err) {
		// embedder 抛错同样只降级——可选件坏了不该拖垮主流程。
		return {
			status: SEMANTIC_STATUS.degraded,
			similarity: null,
			note: `embedder_error:${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/**
 * 越权判定：把两层结果合成一个**标记**（永不返回"阻断"）。
 *
 * @param {object} input
 * @param {object[]} input.rules 规则清单。
 * @param {string} input.text 候选描述。
 * @param {Function} [input.embed] 可选 embedder。
 * @param {object} [options] `{ similarityThreshold }` 默认 0.82（暂定）。
 * @returns {Promise<{
 *   flagged: boolean, code?: string, reasons: string[],
 *   lexical: {hits: Array, checked: number},
 *   semantic: {status: string, similarity: number|null},
 *   blocked: false
 * }>}
 *   `blocked` 恒为 false —— 这是本模块的契约，测试钉住它。
 */
export async function detectSemanticBypass(input, options = {}) {
	const threshold = Number.isFinite(options.similarityThreshold) ? options.similarityThreshold : 0.82;
	const rules = Array.isArray(input?.rules) ? input.rules : [];
	const text = String(input?.text ?? '');

	const lexical = lexicalOverlap(rules, text);
	const reasons = [];
	if (lexical.hits.length > 0) {
		// 词面命中是最强的证据：规则自己声明过这个词。
		for (const h of lexical.hits.slice(0, 5)) reasons.push(`boundary_keyword:${h.ruleId}:${h.keyword}`);
	}

	// 语义层：对每条带边界关键词的规则各算一次，取最高。
	let semantic = { status: SEMANTIC_STATUS.degraded, similarity: null, note: 'no_embedder' };
	if (typeof input?.embed === 'function') {
		let best = { status: SEMANTIC_STATUS.ok, similarity: null };
		for (const r of rules) {
			const kws = Array.isArray(r?.boundary_keywords) ? r.boundary_keywords : [];
			if (kws.length === 0) continue;
			const s = await semanticSimilarity({ text, boundaryKeywords: kws, embed: input.embed });
			if (s.status !== SEMANTIC_STATUS.ok) {
				// 任何一条降级就记降级，但不放弃其它规则的结果。
				if (best.status === SEMANTIC_STATUS.ok) best = s;
				continue;
			}
			if (s.similarity !== null && (best.similarity === null || s.similarity > best.similarity)) best = s;
		}
		semantic = best;
		if (semantic.status === SEMANTIC_STATUS.ok && semantic.similarity !== null && semantic.similarity >= threshold) {
			reasons.push(`semantic_similarity:${semantic.similarity}>=${threshold}`);
		}
	}
	// 非函数（含调用方传错类型）仍走上面的初始值：degraded + note=no_embedder，
	// 且**从未尝试调用**——降级是短路，不是调用后兜底。

	const flagged = reasons.length > 0;
	return {
		flagged,
		...(flagged ? { code: POSSIBLE_BYPASS } : {}),
		reasons,
		lexical,
		semantic,
		// 契约：语义标记从不阻断。写进返回值，测试与调用方都读得到。
		blocked: false,
	};
}
