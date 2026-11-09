/**
 * 谓词穷举测试 —— 判据的每一条边界都从两侧打。
 *
 * 变异纪律：这些用例就是"改坏判据必须红"的靶子。阈值走
 * mergeThresholds 的 override（不改 DEFAULT 常量），层表可注入
 * （证明"层可修改"不是空话：换一张层表，跳层判定跟着变）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	admitDownward,
	admitUpward,
	checkPrinciple,
	isExternallyVerifiable,
} from '../src/predicates.js';
import { mergeThresholds, DEFAULT_THRESHOLDS, DEFAULT_LAYERS } from '../src/thresholds.js';

// —— 阈值表 ——

test('mergeThresholds：合法覆盖生效、未知键与非法值抛错', () => {
	assert.equal(mergeThresholds(undefined).skillMinRepeats, DEFAULT_THRESHOLDS.skillMinRepeats);
	assert.equal(mergeThresholds({ skillMinRepeats: 3 }).skillMinRepeats, 3);
	assert.throws(() => mergeThresholds({ skillMinRepeat: 3 }), /未知阈值键/);
	assert.throws(() => mergeThresholds({ skillMinRepeats: 'x' }), /有限数值/);
	assert.throws(() => mergeThresholds([]), /对象/);
	// 覆盖不污染默认表
	assert.equal(DEFAULT_THRESHOLDS.skillMinRepeats, 5);
});

// —— J1 可外部检验 ——

test('J1：证据数组 + verifiable_by 缺一即不可检验', () => {
	const good = { evidence: ['trace-1'], verifiable_by: '重跑命令看退出码' };
	assert.equal(isExternallyVerifiable(good), true);
	assert.equal(isExternallyVerifiable({ ...good, evidence: [] }), false);
	assert.equal(isExternallyVerifiable({ ...good, evidence: [''] }), false);
	assert.equal(isExternallyVerifiable({ ...good, evidence: [42] }), false);
	assert.equal(isExternallyVerifiable({ ...good, verifiable_by: ' ' }), false);
	assert.equal(isExternallyVerifiable(undefined), false);
});

// —— 下行准入 ——

const concrete = { constraints: ['先读文件再改'] };

test('下行：具体化 + 相邻层 → allow', () => {
	assert.equal(admitDownward('L1', 'L2', concrete).action, 'allow');
});

test('下行：未具体化 → deny + 点名缺失字段', () => {
	const d = admitDownward('L1', 'L2', {});
	assert.equal(d.action, 'deny');
	assert.equal(d.reason, 'not_concretized');
	assert.deepEqual(d.missing_fields, ['constraints']);
	// 空串约束不算具体化
	assert.equal(admitDownward('L1', 'L2', { constraints: ['  '] }).action, 'deny');
});

test('下行：黑名单命中优先于一切（先于具体化判定）', () => {
	const d = admitDownward('L1', 'L2', { negative_rule_hits: ['rule-x'] });
	assert.equal(d.action, 'deny');
	assert.equal(d.reason, 'negative_rule_hit');
	assert.deepEqual(d.negative_rule_hits, ['rule-x']);
});

test('下行：跳层与未知层都拒绝', () => {
	assert.equal(admitDownward('L0', 'L2', concrete).reason, 'non_adjacent_descent');
	assert.equal(admitDownward('L2', 'L1', concrete).reason, 'non_adjacent_descent');
	assert.equal(admitDownward('L9', 'L2', concrete).reason, 'unknown_layer');
});

test('下行：触及公理语义 → human_gate（不自动）', () => {
	assert.equal(admitDownward('L0', 'L1', { ...concrete, touches_axiom: true }).action, 'human_gate');
});

test('下行：层表可注入——自定义层结构下相邻判定跟着变', () => {
	const layers = ['A', 'B', 'C'];
	assert.equal(admitDownward('A', 'B', concrete, { layers }).action, 'allow');
	assert.equal(admitDownward('A', 'C', concrete, { layers }).reason, 'non_adjacent_descent');
	// 默认四层表在自定义表下是未知层
	assert.equal(admitDownward('L0', 'L1', concrete, { layers }).reason, 'unknown_layer');
});

// —— 上行准入：通用门 ——

const skillOk = {
	kind: 'positive',
	rule_type: 'skill',
	repeats: 5,
	success_rate: 0.8,
	success_evidence: 'external',
	evidence: ['trace-a', 'trace-b'],
	verifiable_by: '重放序列比对退出码',
};

test('上行：无证据记录一律拒（F12，正负同规）', () => {
	assert.equal(admitUpward('L3', 'L2', { ...skillOk, evidence: [] }).reason, 'no_evidence_record');
	assert.equal(
		admitUpward('L3', 'L2', { kind: 'negative', negative_type: 'forbidden_skill', failure_count: 3, evidence: [] }).reason,
		'no_evidence_record',
	);
});

test('上行：跳层拒、逆向拒、未知层拒', () => {
	assert.equal(admitUpward('L3', 'L1', skillOk).reason, 'non_adjacent_ascent');
	assert.equal(admitUpward('L2', 'L3', skillOk).reason, 'non_adjacent_ascent');
	assert.equal(admitUpward('L3', 'X', skillOk).reason, 'unknown_layer');
});

test('上行 J1：正向不可检验 → downgrade 封顶；负向不可检验 → 拒', () => {
	const d = admitUpward('L3', 'L2', { ...skillOk, verifiable_by: '' });
	assert.equal(d.action, 'downgrade');
	assert.equal(d.confidence_cap, DEFAULT_THRESHOLDS.downgradedMaxConfidence);
	const n = admitUpward('L3', 'L2', {
		kind: 'negative', negative_type: 'forbidden_skill', failure_count: 3,
		evidence: ['t'], verifiable_by: '',
	});
	assert.equal(n.action, 'reject');
	assert.equal(n.reason, 'not_externally_verifiable');
});

// —— 上行：技能正负向阈值两侧 ——

test('技能正向：重复与成功率各打两侧；self_report 不采信', () => {
	assert.equal(admitUpward('L3', 'L2', skillOk).action, 'human_gate');
	assert.equal(admitUpward('L3', 'L2', { ...skillOk, repeats: 4 }).reason, 'insufficient_repeats');
	assert.equal(admitUpward('L3', 'L2', { ...skillOk, success_rate: 0.69 }).reason, 'success_rate_below_threshold');
	// 边界值本身达标（≥ 语义）
	assert.equal(admitUpward('L3', 'L2', { ...skillOk, repeats: 5, success_rate: 0.7 }).action, 'human_gate');
	// P0-1：自报成功率即使数值达标也拒
	assert.equal(admitUpward('L3', 'L2', { ...skillOk, success_evidence: 'self_report' }).reason, 'success_not_external');
	assert.equal(admitUpward('L3', 'L2', { ...skillOk, success_rate: '0.9' }).reason, 'malformed_skill_evidence');
});

test('技能负向：失败 ≥2 即可提名（低于正向的 5），阈值两侧', () => {
	const neg = {
		kind: 'negative', negative_type: 'forbidden_skill', failure_count: 2,
		evidence: ['fail-1', 'fail-2'], verifiable_by: '重放失败序列',
	};
	assert.equal(admitUpward('L3', 'L2', neg).action, 'human_gate');
	assert.equal(admitUpward('L3', 'L2', { ...neg, failure_count: 1 }).reason, 'insufficient_failures');
	assert.ok(DEFAULT_THRESHOLDS.forbiddenMinFailures < DEFAULT_THRESHOLDS.skillMinRepeats, '负向收敛阈值必须低于正向');
});

// —— 上行：判据（术→法）五判据 ——

const critOk = {
	kind: 'positive', rule_type: 'criterion',
	skill_coverage: 3, scenario_coverage: 2, anti_example_count: 1,
	predict_rate: 0.6, overlap: 0.5,
	evidence: ['t1'], verifiable_by: '新场景预测对照',
};

test('判据：五判据全过 → human_gate；覆盖不足 → 拒', () => {
	assert.equal(admitUpward('L2', 'L1', critOk).action, 'human_gate');
	assert.equal(admitUpward('L2', 'L1', { ...critOk, skill_coverage: 2 }).reason, 'insufficient_skill_coverage');
	assert.equal(admitUpward('L2', 'L1', { ...critOk, scenario_coverage: 1 }).reason, 'insufficient_scenario_coverage');
});

test('判据：缺反例/预测率不足 → downgrade 不拒（§4.5），重叠超限 → 拒', () => {
	const noAnti = admitUpward('L2', 'L1', { ...critOk, anti_example_count: 0 });
	assert.equal(noAnti.action, 'downgrade');
	assert.equal(noAnti.reason, 'insufficient_anti_examples');
	assert.equal(noAnti.confidence_cap, 0.6);
	assert.equal(admitUpward('L2', 'L1', { ...critOk, predict_rate: 0.5 }).action, 'downgrade');
	assert.equal(admitUpward('L2', 'L1', { ...critOk, overlap: 0.71 }).reason, 'redundant_with_existing');
	// overlap 未提供时不判冗余（没有可比对象）
	const { overlap, ...noOverlap } = critOk;
	assert.equal(admitUpward('L2', 'L1', noOverlap).action, 'human_gate');
});

test('公理：法→道永远 human_gate，不设量化门', () => {
	const d = admitUpward('L1', 'L0', {
		kind: 'positive', rule_type: 'axiom', evidence: ['insights/a.md'], verifiable_by: '人工判断',
	});
	assert.equal(d.action, 'human_gate');
	assert.equal(d.reason, 'axiom_human_only');
});

test('负向其余三类：证伪 1 反例、越界 2 次、削弱公理 2 反例 2 判据', () => {
	const base = { kind: 'negative', evidence: ['t'], verifiable_by: '外部复核' };
	assert.equal(admitUpward('L2', 'L1', { ...base, negative_type: 'invalidated_criterion', anti_example_count: 1 }).action, 'human_gate');
	assert.equal(admitUpward('L2', 'L1', { ...base, negative_type: 'invalidated_criterion', anti_example_count: 0 }).action, 'reject');
	assert.equal(admitUpward('L2', 'L1', { ...base, negative_type: 'out_of_scope_scenario', out_of_scope_hits: 2 }).action, 'human_gate');
	assert.equal(admitUpward('L2', 'L1', { ...base, negative_type: 'out_of_scope_scenario', out_of_scope_hits: 1 }).action, 'reject');
	assert.equal(admitUpward('L1', 'L0', { ...base, negative_type: 'weakened_axiom', anti_example_count: 2, distinct_criteria: 2 }).action, 'human_gate');
	assert.equal(admitUpward('L1', 'L0', { ...base, negative_type: 'weakened_axiom', anti_example_count: 2, distinct_criteria: 1 }).action, 'reject');
	assert.equal(admitUpward('L3', 'L2', { ...base, negative_type: 'made_up' }).reason, 'unknown_negative_type');
});

// —— 原则失效 ——

const statsOk = {
	anti_example_count: 0, source_diversity: 0, coverage_rate: 0.9,
	conflict_with_upper: false, window_rounds: 20,
};

test('原则：四判据任一触发即 invalid', () => {
	assert.equal(checkPrinciple(statsOk).status, 'valid');
	assert.equal(checkPrinciple({ ...statsOk, anti_example_count: 3, source_diversity: 2 }).status, 'invalid');
	assert.equal(checkPrinciple({ ...statsOk, coverage_rate: 0.49 }).status, 'invalid');
	assert.equal(checkPrinciple({ ...statsOk, conflict_with_upper: true }).status, 'invalid');
	// 边界：覆盖率恰 0.5 不算低于
	assert.equal(checkPrinciple({ ...statsOk, coverage_rate: 0.5 }).status, 'valid');
});

test('原则：数据不全 → uncertain（没测过 ≠ 通过）', () => {
	assert.equal(checkPrinciple({ anti_example_count: 0 }).status, 'uncertain');
	assert.equal(checkPrinciple({ ...statsOk, window_rounds: 19 }).status, 'uncertain');
	assert.equal(checkPrinciple(undefined).status, 'uncertain');
});

test('原则：阈值覆盖传导（窗口 5 轮时 5 轮即可判 valid）', () => {
	const t = mergeThresholds({ principleWindowRounds: 5 });
	assert.equal(checkPrinciple({ ...statsOk, window_rounds: 5 }, { thresholds: t }).status, 'valid');
});

test('层表契约：默认四层有序且互异', () => {
	assert.deepEqual(DEFAULT_LAYERS, ['L0', 'L1', 'L2', 'L3']);
	assert.equal(new Set(DEFAULT_LAYERS).size, 4);
});