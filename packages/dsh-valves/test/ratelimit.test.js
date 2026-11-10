/**
 * IV-5 公理闸门限速测试。
 *
 * 上轮验收被卡住的真实原因：限速一加测试就跑不过（需要反复生效公理），
 * 于是要么放宽限速（失效），要么把测试样本混进生产账本（污染分布）。
 * 这里钉住第三条路：**显式测试通道**——照样验证路径，但不消耗额度。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	checkAxiomRate, applyAxiomLimit,
	AXIOM_WINDOW_MS, AXIOM_MAX_PER_WINDOW, AXIOM_RATE_LIMITED,
} from '../src/ratelimit.js';
import { createRuntime } from '../index.js';
import { readDecisions, summarizeDecisions } from '../src/store.js';

function sandbox() {
	return mkdtempSync(join(tmpdir(), 'dsh-valves-rate-'));
}
const settle = () => new Promise((r) => setTimeout(r, 60));

/** 造一条"公理已生效"的账本行。 */
const axiomRow = (msAgo, now = Date.now()) => ({
	t: new Date(now - msAgo).toISOString(),
	gate: 'upward_L2_L1', direction: 'up', outcome: 'admitted', action: 'human_gate',
	reason: 'axiom_human_only', rule_type: 'axiom',
});

// ——————————————————————————————————————————————
// 限速本身
// ——————————————————————————————————————————————

test('窗口内没有公理变更 → 放行', () => {
	const r = checkAxiomRate({ entries: [], now: Date.now() });
	assert.equal(r.allowed, true);
	assert.equal(r.used, 0);
	assert.equal(r.max, AXIOM_MAX_PER_WINDOW);
});

test('本月已生效过一条公理 → 拒绝，并给出何时可再动（resetAt）', () => {
	const now = Date.now();
	const entries = [axiomRow(5 * 24 * 60 * 60 * 1000, now)]; // 5 天前
	const r = checkAxiomRate({ entries, now });
	assert.equal(r.allowed, false);
	assert.equal(r.code, AXIOM_RATE_LIMITED);
	assert.equal(r.used, 1);
	assert.ok(r.resetAt, '拒绝必须给可行动的下一步，否则只是堵路');
	assert.ok(Date.parse(r.resetAt) > now, 'resetAt 指向未来');
});

test('窗口外的旧公理变更不占额度（固定 30 天窗口）', () => {
	const now = Date.now();
	const entries = [axiomRow(40 * 24 * 60 * 60 * 1000, now)]; // 40 天前
	assert.equal(checkAxiomRate({ entries, now }).allowed, true);
});

test('被拒绝/降级的公理变更不占额度（它们没改变规则库）', () => {
	const now = Date.now();
	const rejected = [
		{ t: new Date(now - 1000).toISOString(), outcome: 'skipped', action: 'reject', reason: 'insufficient_evidence', rule_type: 'axiom' },
		{ t: new Date(now - 2000).toISOString(), outcome: 'skipped', action: 'downgrade', rule_type: 'axiom' },
	];
	const r = checkAxiomRate({ entries: [...rejected], now });
	assert.equal(r.allowed, true, '没生效的不该消耗额度');
});

test('非公理的上行变更不占公理额度', () => {
	const now = Date.now();
	const entries = [{
		t: new Date(now - 1000).toISOString(), outcome: 'admitted', action: 'human_gate',
		rule_type: 'criterion',
	}];
	assert.equal(checkAxiomRate({ entries, now }).allowed, true);
});

test('weakened_axiom 也算公理变更（削弱的公理同样是公理）', () => {
	const now = Date.now();
	const entries = [{
		t: new Date(now - 1000).toISOString(), outcome: 'admitted',
		negative_type: 'weakened_axiom',
	}];
	assert.equal(checkAxiomRate({ entries, now }).allowed, false);
});

// ——————————————————————————————————————————————
// 测试通道：上轮矛盾的解
// ——————————————————————————————————————————————

test('测试通道：即使本月已改过公理也放行（验收不被限速卡住）', () => {
	const now = Date.now();
	const entries = [axiomRow(1000, now)];
	const r = checkAxiomRate({ entries, now, testChannel: true });
	assert.equal(r.allowed, true, '测试通道不该被额度挡住');
	assert.equal(r.testChannel, true);
});

test('测试通道：不消耗额度（连跑多次都不会把生产额度用光）', () => {
	const now = Date.now();
	for (let i = 0; i < 5; i++) {
		assert.equal(checkAxiomRate({ entries: [], now, testChannel: true }).allowed, true);
	}
	// 生产通道额度不受影响
	assert.equal(checkAxiomRate({ entries: [], now }).used, 0);
});

test('测试通道只能由显式参数打开：不传就是 false', () => {
	const r = checkAxiomRate({ entries: [] });
	assert.notEqual(r.testChannel, true, '缺省绝不是测试通道');
});

// ——————————————————————————————————————————————
// 合并到判定：合规 ≠ 允许落地
// ——————————————————————————————————————————————

test('applyAxiomLimit：合规但被限速 → reject + rate_limited 标记（可与判据拒绝区分）', () => {
	const decision = { action: 'human_gate', reason: 'axiom_human_only' };
	const rate = { allowed: false, code: AXIOM_RATE_LIMITED, used: 1, max: 1, resetAt: '2026-12-01T00:00:00.000Z' };
	const out = applyAxiomLimit(decision, rate);
	assert.equal(out.action, 'reject');
	assert.equal(out.reason, AXIOM_RATE_LIMITED);
	assert.equal(out.rate_limited, true, '必须能区分"判据拒绝"与"时机不许"');
	assert.equal(out.reset_at, '2026-12-01T00:00:00.000Z');
});

test('applyAxiomLimit：未被限速 → 原样返回', () => {
	const decision = { action: 'human_gate', reason: 'axiom_human_only' };
	assert.deepEqual(applyAxiomLimit(decision, { allowed: true }), decision);
});

// ——————————————————————————————————————————————
// 端到端：走 runtime
// ——————————————————————————————————————————————

test('runtime：当月已改过公理 → 第二次公理变更被限速拒绝', async () => {
	const dir = sandbox();
	try {
		const rt = createRuntime({ storageDir: dir });
		// 先人工写入一条"已生效"的公理记录
		const { appendDecision } = await import('../src/store.js');
		await appendDecision(dir, axiomRow(1000));
		const out = await rt.upwardWithAxiomLimit('L2', 'L1', { rule_type: 'axiom', evidence: ['t1'], origin: 'daily' });
		assert.equal(out.action, 'reject');
		assert.equal(out.reason, AXIOM_RATE_LIMITED);
		assert.equal(out.rate_limited, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('runtime：测试通道的公理变更不进日常分布（origin 记为 verification）', async () => {
	const dir = sandbox();
	try {
		const rt = createRuntime({ storageDir: dir });
		const { appendDecision } = await import('../src/store.js');
		await appendDecision(dir, axiomRow(1000));
		const out = await rt.upwardWithAxiomLimit('L2', 'L1', {
			rule_type: 'axiom', evidence: ['t1'], testChannel: true,
		});
		assert.equal(out.rate_limited, undefined, '测试通道不该被限速');
		await settle();
		const s = summarizeDecisions(await readDecisions(dir));
		assert.equal(s.byOrigin.verification >= 1, true, '测试通道样本要标 verification');
		assert.equal(s.dailyCount, 0, '测试样本绝不能进 daily 分布');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('runtime：非公理变更不受限速影响（不读额度、行为不变）', async () => {
	const dir = sandbox();
	try {
		const rt = createRuntime({ storageDir: dir });
		const { appendDecision } = await import('../src/store.js');
		await appendDecision(dir, axiomRow(1000));
		const out = await rt.upwardWithAxiomLimit('L2', 'L1', {
			rule_type: 'criterion', skill_coverage: 4, scenario_coverage: 3,
			anti_example_count: 1, predict_rate: 0.8, overlap: 0.2, evidence: ['t'], verifiable_by: '跑一次对照',
		});
		assert.notEqual(out.reason, AXIOM_RATE_LIMITED, '判据类不该被公理限速拦');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('runtime：账本读不到 → 转人工，不当作零额度放行', async () => {
	const dir = sandbox();
	try {
		const rt = createRuntime({ storageDir: dir });
		// 让账本路径变成目录，读会失败
		const { mkdirSync } = await import('node:fs');
		const { ledgerPath } = await import('../src/store.js');
		mkdirSync(ledgerPath(dir), { recursive: true });
		const out = await rt.upwardWithAxiomLimit('L2', 'L1', { rule_type: 'axiom', evidence: ['t'] });
		assert.equal(out.action, 'human_gate');
		assert.equal(out.reason, 'axiom_ledger_unreadable');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
