/**
 * IV-1 灰度放量：规则从 staged 转 full 的依据只能是**真实命中**。
 *
 * ## 为什么要有这个机制
 *
 * 一条新规则刚确认时最容易误伤——关键词还没被真实语料打磨过。灰度让它先
 * 以 staged 拦截（拦截力与 full 完全相同，不打折），攒够 N 次干净命中再标
 * full，等于用真实使用为它背书。定时器不会转正（那是绕开证据），人工也不会
 * 批量转正（同上）。
 *
 * ## 一条重要的边界
 *
 * 灰度**不动 `status`**。status 是生命周期（active/sunk），被沉底、回滚、探针
 * 共同依赖；把 staged 塞进 status 会连带改掉那些语义 —— 实测直接打红 2 条
 * 沉底用例。所以放量进度是正交字段 `rollout`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { confirmNegativeRule, readNegativeRules, promoteStagedRules, matchNegativeRules, rulesPath } = await import('../src/store.js');
const { DEFAULT_THRESHOLDS } = await import('../src/thresholds.js');

const temp = () => mkdtempSync(join(tmpdir(), 'dsh-rollout-'));

test('a newly confirmed rule starts staged, and still BLOCKS', async () => {
	const dir = temp();
	try {
		const r = await confirmNegativeRule(dir, { id: 'r1', statement: '禁止删库', negative_type: 'forbidden_skill', keywords: ['删库'] }, { human: true });
		assert.equal(r.ok, true);
		const rules = await readNegativeRules(dir);
		assert.equal(rules[0].rollout, 'staged', '新规则从 staged 起步');
		assert.equal(rules[0].status, undefined, 'staged 不写进 status（status 是生命周期）');
		// 拦截力不打折：staged 规则照样命中。
		assert.deepEqual(matchNegativeRules(rules, '我要删库'), ['r1'], 'staged 规则必须照常拦截');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('skipStaging confirms straight to full', async () => {
	const dir = temp();
	try {
		await confirmNegativeRule(dir, { id: 'r2', statement: '禁止 rm -rf', negative_type: 'forbidden_skill', keywords: ['rm -rf'] }, { human: true, skipStaging: true });
		const rules = await readNegativeRules(dir);
		assert.equal(rules[0].rollout, 'full');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('promotion needs real hits; below the threshold nothing moves', () => {
	const rules = [{ id: 'r1', rollout: 'staged' }];
	const few = [{ ruleId: 'r1' }, { ruleId: 'r1' }];
	const { promoted, rules: after } = promoteStagedRules(rules, few, { stagedHits: 3 });
	assert.deepEqual(promoted, [], '未达阈值不转正');
	assert.equal(after[0].rollout, 'staged');
});

test('enough hits promote staged → full, and record when', () => {
	const rules = [{ id: 'r1', rollout: 'staged' }];
	const enough = [{ ruleId: 'r1' }, { ruleId: 'r1' }, { ruleId: 'r1' }];
	const { promoted, rules: after } = promoteStagedRules(rules, enough, { stagedHits: 3 });
	assert.deepEqual(promoted, ['r1']);
	assert.equal(after[0].rollout, 'full');
	assert.ok(after[0].promoted_at, '转正时间必须留痕');
});

test('rules without a rollout field are untouched (old roots keep working)', () => {
	// Pre-IV-1 rules have no `rollout` at all — they are already fully trusted and
	// must never be demoted or rewritten by this mechanism.
	const old = [{ id: 'legacy' }, { id: 'legacy2', status: 'sunk' }];
	const triggers = Array.from({ length: 10 }, () => ({ ruleId: 'legacy' }));
	const { promoted, rules: after } = promoteStagedRules(old, triggers, { stagedHits: 3 });
	assert.deepEqual(promoted, []);
	assert.deepEqual(after, old, '旧规则逐字不变');
});

test('a sunk rule is never resurrected by promotion', () => {
	const rules = [{ id: 'r1', rollout: 'staged', status: 'sunk' }];
	const triggers = Array.from({ length: 10 }, () => ({ ruleId: 'r1' }));
	const { promoted, rules: after } = promoteStagedRules(rules, triggers, { stagedHits: 3 });
	assert.deepEqual(promoted, [], '沉底优先于转正');
	assert.equal(after[0].rollout, 'staged');
});

test('an unreadable trigger log promotes nothing (no evidence, no promotion)', () => {
	const rules = [{ id: 'r1', rollout: 'staged' }];
	const { promoted } = promoteStagedRules(rules, undefined, { stagedHits: 3 });
	assert.deepEqual(promoted, [], '读不到流水 ≠ 没命中，但更不能当命中');
});

test('threshold 0 disables rollout entirely', () => {
	const rules = [{ id: 'r1', rollout: 'staged' }];
	const { promoted } = promoteStagedRules(rules, [{ ruleId: 'r1' }], { stagedHits: 0 });
	assert.deepEqual(promoted, [], '0 = 关闭灰度');
});

test('the default threshold is a real number (not silently off)', () => {
	assert.equal(typeof DEFAULT_THRESHOLDS.negativeRuleStagedHits, 'number');
	assert.ok(DEFAULT_THRESHOLDS.negativeRuleStagedHits > 0, '默认应开启灰度，而不是默默关掉');
});
