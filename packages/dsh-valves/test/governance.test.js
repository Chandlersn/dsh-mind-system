/**
 * 治理循环测试 —— III-2 覆盖率口径 + III-1 循环体终止条件。
 * 全部临时目录，不碰真实账本。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { referenceCoverage, validateClassification, governanceRound, COVERAGE_MIN_SAMPLE } from '../src/governance.js';
import { appendDecision } from '../src/store.js';

const row = (over = {}) => ({ t: new Date().toISOString(), gate: 'g', outcome: 'admitted', reason: 'r', origin: 'daily', ...over });
const rows = (n, over = {}) => Array.from({ length: n }, () => row(over));

// —— III-2 覆盖率 ——

test('覆盖率：显式引用计数；小样本不出数（null 不是 0）', () => {
	const entries = [...rows(9, { principle_refs: ['p1'] }), row()];
	const r = referenceCoverage(entries, 'p1');
	assert.equal(r.total, 10);
	assert.equal(r.cited, 9);
	assert.equal(r.coverage, 0.9);
	assert.equal(r.basis, 'explicit_refs');
	// 9 条 < 10：不出数
	assert.equal(referenceCoverage(entries.slice(0, 9), 'p1').coverage, null);
	// 0 引用 + 足样本 = 0（真零，不是没测）
	assert.equal(referenceCoverage(rows(12), 'p1').coverage, 0);
});

test('覆盖率：origin 过滤——验证/提名样本默认不进分母', () => {
	const entries = [...rows(10, { principle_refs: ['p1'] }), ...rows(50, { origin: 'verification', principle_refs: [] })];
	const r = referenceCoverage(entries, 'p1');
	assert.equal(r.total, 10, 'verification 不灌分母');
	assert.equal(r.coverage, 1);
	// 显式要求全部 origin 时才算进去
	assert.equal(referenceCoverage(entries, 'p1', { origins: ['daily', 'verification'] }).total, 60);
});

test('覆盖率：窗口过滤 + 不猜语义（无 refs 字段不计分子）', () => {
	const old = row({ t: '2020-01-01T00:00:00Z', principle_refs: ['p1'] });
	const entries = [old, ...rows(10, { reason: '文本里提到 p1 但没声明 refs' })];
	const r = referenceCoverage(entries, 'p1', { windowDays: 30 });
	assert.equal(r.total, 10, '窗口外不算');
	assert.equal(r.cited, 0, '文本相似不算引用——只认显式 principle_refs');
});

// —— 归类校验 ——

test('归类：形态合规 + 置信度门槛；校验器不自己猜层', () => {
	const good = { layer: 'L2', confidence: 0.9, evidence: ['e1'] };
	assert.equal(validateClassification(good).human_gate_required, false);
	assert.equal(validateClassification({ ...good, confidence: 0.6 }).reason, 'low_confidence');
	assert.equal(validateClassification({ ...good, confidence: 0.6 }).human_gate_required, true);
	assert.equal(validateClassification({ ...good, layer: 'L9' }).reason, 'unknown_layer_nomination');
	assert.equal(validateClassification({ ...good, evidence: [] }).reason, 'no_classification_evidence');
	assert.equal(validateClassification(undefined).human_gate_required, true, '没提名 = 转人工，不是默认 L3');
});

// —— III-1 循环体 ——

test('治理：健康原则 → principles_valid，无提议', () => {
	const entries = rows(20, { principle_refs: ['p1'] });
	const r = governanceRound({ entries, principles: [{ principle_id: 'p1', statement: 's' }] });
	assert.equal(r.terminated_by, 'principles_valid');
	assert.equal(r.redefinition_proposals.length, 0);
	assert.equal(r.principle_reports[0].status, 'valid');
	assert.equal(r.human_gate_required, false);
});

test('治理：反例触发 → invalid + 改定义提议 + 人工闸门（不自动改库）', () => {
	const entries = rows(20, { principle_refs: ['p1'] });
	const anti = [
		{ source: 'taskA', trace_ref: 'ledger#1' },
		{ source: 'taskB', trace_ref: 'ledger#2' },
		{ source: 'taskA', trace_ref: 'ledger#3' },
	];
	const r = governanceRound({ entries, principles: [{ principle_id: 'p1', statement: '旧原则', anti_examples: anti }] });
	assert.equal(r.terminated_by, 'redefinition_proposed');
	assert.equal(r.principle_reports[0].status, 'invalid');
	assert.equal(r.redefinition_proposals.length, 1);
	assert.deepEqual(r.redefinition_proposals[0].evidence, ['ledger#1', 'ledger#2', 'ledger#3']);
	assert.equal(r.human_gate_required, true, '提议必须过人工，不自动生效');
});

test('治理：小样本覆盖率 null → uncertain（没测过≠通过≠失效）', () => {
	const r = governanceRound({ entries: rows(3), principles: [{ principle_id: 'p1' }] });
	assert.equal(r.principle_reports[0].coverage, null);
	assert.equal(r.principle_reports[0].status, 'uncertain');
	assert.equal(r.terminated_by, 'principles_valid', 'uncertain 不出提议也不报 valid 结论——报告里如实 uncertain');
});

test('治理：低覆盖率足样本 → coverage_below 触发 invalid（窗口内有人声明过引用）', () => {
	const entries = [...rows(4, { principle_refs: ['p1'] }), ...rows(16, { principle_refs: ['p2'] })];
	const r = governanceRound({ entries, principles: [{ principle_id: 'p1' }] });
	assert.equal(r.principle_reports[0].coverage, 0.2);
	assert.equal(r.principle_reports[0].status, 'invalid');
	assert.ok(r.principle_reports[0].triggered.includes('coverage_below'));
});

test('治理：冷启动保护——全账本无任何 refs 声明时覆盖率 0 不触发假失效（真机第一轮教训）', () => {
	// 历史行都没带 principle_refs：0 是"没测过"不是"解释不了"
	const entries = rows(20);
	const r = governanceRound({ entries, principles: [{ principle_id: 'p1' }] });
	assert.equal(r.principle_reports[0].coverage, 0);
	assert.equal(r.principle_reports[0].coverage_basis, 'cold_start_no_refs');
	assert.equal(r.principle_reports[0].status, 'uncertain', '冷启动走 uncertain，不出假失效提议');
	assert.equal(r.redefinition_proposals.length, 0);
	// 但反例判据不受冷启动影响：真反例照常触发
	const anti = [{ source: 'a', trace_ref: 't1' }, { source: 'b', trace_ref: 't2' }, { source: 'a', trace_ref: 't3' }];
	const r2 = governanceRound({ entries, principles: [{ principle_id: 'p1', anti_examples: anti }] });
	assert.equal(r2.principle_reports[0].status, 'invalid', '反例是独立证据，冷启动不豁免它');
});

test('治理：语义覆盖率人工显式输入时覆盖引用口径并标注 basis', () => {
	const entries = rows(20); // 引用覆盖率 0
	const r = governanceRound({ entries, principles: [{ principle_id: 'p1', semantic_coverage: 0.8 }] });
	assert.equal(r.principle_reports[0].coverage_basis, 'human_semantic');
	assert.equal(r.principle_reports[0].status, 'valid', '人工判读 0.8 覆盖引用口径的 0');
});

test('治理：归类低置信度 → human_gate 终止优先级最高', () => {
	const r = governanceRound({
		entries: rows(20),
		principles: [{ principle_id: 'p1' }],
		classification: { layer: 'L2', confidence: 0.5, evidence: ['e'] },
	});
	assert.equal(r.terminated_by, 'human_gate');
	assert.equal(r.classification.reason, 'low_confidence');
});

test('runtime.govern：账本从盘读、结果落账 gate=governance', async () => {
	const { createRuntime } = await import('../index.js');
	const dir = mkdtempSync(join(tmpdir(), 'dsh-gov-'));
	try {
		const rt = createRuntime({ storageDir: dir });
		// 造 20 条日常判定，全部引用 p1
		for (let i = 0; i < 20; i++) {
			await appendDecision(dir, { gate: 'downward_L1_L2', outcome: 'admitted', reason: 'concretized', origin: 'daily', principle_refs: ['p1'] });
		}
		const r = await rt.govern({ principles: [{ principle_id: 'p1' }] });
		assert.equal(r.principle_reports[0].status, 'valid');
		assert.equal(r.principle_reports[0].sample_total, 20);
		await new Promise((res) => setTimeout(res, 50));
		const m = await rt.metrics();
		assert.equal(m.byGate.governance, 1, '治理轮本身也落账');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('runtime.govern：principle_refs 经 downward/upward 落账可被覆盖率数到', async () => {
	const { createRuntime } = await import('../index.js');
	const dir = mkdtempSync(join(tmpdir(), 'dsh-gov-'));
	try {
		const rt = createRuntime({ storageDir: dir });
		for (let i = 0; i < 12; i++) {
			rt.downward('L1', 'L2', { constraints: ['c'], origin: 'daily', principle_refs: ['形状按最严格边界写'] });
		}
		await new Promise((res) => setTimeout(res, 50));
		const r = await rt.govern({ principles: [{ principle_id: '形状按最严格边界写' }] });
		assert.equal(r.principle_reports[0].coverage, 1);
		assert.equal(r.principle_reports[0].sample_total, 12);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});