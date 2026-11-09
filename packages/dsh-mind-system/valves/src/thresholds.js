/**
 * 阀门阈值 —— 全部**暂定**，单一真值源。
 *
 * ## 来源与校准状态
 *
 * 数值来自《心智系统开发说明书》§4.2/§4.5 的设计值，经用户 2026-11-09
 * 确认「按经验暂定，跑起来后再调」。每一个数都还没有真实分布支撑——
 * 校准数据从 .valves.jsonl 的 evaluated/skipped 双侧账本里长出来
 * （「判据从实测分布中长出」：先量再调，不是先发明指标再拿结果验证）。
 *
 * ## 为什么集中在这一个文件
 *
 * 「判据单一实现」：谓词在 predicates.js，阈值在这里，别处只 import。
 * 测试改阈值走 override 参数（mergeThresholds），不改这份常量——
 * 常量被测试改过一次就再也证明不了生产用的是哪个数。
 */

/** 层的初始注册值。层可修改（说明书 §4.6），所以谓词不 switch 具体层名。 */
export const DEFAULT_LAYERS = ['L0', 'L1', 'L2', 'L3'];

/** 暂定阈值。每一项都标注了它在说明书里的出处；全部待校准。 */
export const DEFAULT_THRESHOLDS = {
	/** 器→术 正向：重复次数下限（说明书 §4.5）。 */
	skillMinRepeats: 5,
	/** 器→术 正向：成功率下限（§4.5）。成败只认外部证据，见 predicates.js。 */
	skillMinSuccessRate: 0.7,
	/** 器→术 负向：失败次数下限（§4.5，负向收敛低于正向）。 */
	forbiddenMinFailures: 2,
	/** 术→法：覆盖独立技能数（§4.5 量化判据）。 */
	criterionMinSkills: 3,
	/** 术→法：覆盖场景数（§4.5）。 */
	criterionMinScenarios: 2,
	/** 术→法：反例覆盖数；不足降级为 candidate_with_warning（§4.5）。 */
	criterionMinAntiExamples: 1,
	/** 术→法：预测新场景成功率（§4.5）。 */
	criterionMinPredictRate: 0.6,
	/** 术→法：与已有判据的重叠度上限（§4.5）。 */
	criterionMaxOverlap: 0.7,
	/** 缺反例/预测不达标时的置信度上限（§4.5：降级 candidate_with_warning）。 */
	downgradedMaxConfidence: 0.6,
	/** 术→法 负向：证伪判据只需 1 个可外部检验的反例（§4.5）。 */
	invalidateMinAntiExamples: 1,
	/** 术→法 负向：越界场景次数下限（§4.5）。 */
	outOfScopeMinHits: 2,
	/** 外层治理：原则失效反例数（§4.1，任一判据触发即 invalid）。 */
	principleInvalidAntiExamples: 3,
	/** 外层治理：反例来源多样性下限（§4.1）。 */
	principleInvalidMinSources: 2,
	/** 外层治理：原则覆盖率下限（§4.1；低于即触发）。 */
	principleInvalidCoverageBelow: 0.5,
	/** 外层治理：反例统计窗口轮数（§4.1 默认 20 轮）。 */
	principleWindowRounds: 20,
};

/**
 * 合并配置覆盖。只接受**有限数值**且键必须在默认表里——
 * 未知键静默通过会让配置错字永远不生效（静默失效是本项目最常见的病）。
 * 非法覆盖直接抛错：配置错了要在装载时炸，不要带着错阈值跑一个月。
 *
 * @param overrides 配置对象（可 undefined）。
 * @returns 合并后的完整阈值表（新对象，不改 DEFAULT）。
 */
export function mergeThresholds(overrides) {
	const out = { ...DEFAULT_THRESHOLDS };
	if (overrides === undefined || overrides === null) return out;
	if (typeof overrides !== 'object' || Array.isArray(overrides)) {
		throw new Error('thresholds 覆盖必须是对象');
	}
	for (const [key, value] of Object.entries(overrides)) {
		if (!(key in DEFAULT_THRESHOLDS)) throw new Error(`未知阈值键：${key}（错字不会被静默忽略）`);
		if (!Number.isFinite(value)) throw new Error(`阈值 ${key} 必须是有限数值，收到：${String(value)}`);
		out[key] = value;
	}
	return out;
}