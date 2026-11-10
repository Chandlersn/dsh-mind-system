/**
 * III-5 越权拦截测试。
 *
 * 三类越权各有拦截断言（说明书 §4.8）：
 * 1. 候选未确认直接生效
 * 2. 跳过判据写库
 * 3. 越层写入
 *
 * 这一节点的意义不是"加功能"，而是**证明闸门真的关着**。所以测试的重点
 * 全在"试图绕过时会被拦住"，而不是"正常路径能用"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	issuePermit, requirePermit, consumePermit, requireCriteria,
	HUMAN_CHANNELS, PERMIT_TTL_MS, VIOLATIONS, __resetPermits,
} from '../src/guard.js';
import { confirmNegativeRule, rollbackNegativeRule, readNegativeRules, rulesPath } from '../src/store.js';

function sandbox() {
	__resetPermits();
	return mkdtempSync(join(tmpdir(), 'dsh-valves-guard-'));
}

const RULE = { id: 'g-rule', negative_type: 'forbidden_skill', statement: '不要走 G', keywords: ['g 路径'] };

// ——————————————————————————————————————————————
// 越权 1：候选未确认直接生效
// ——————————————————————————————————————————————

test('越权1：不带票、不声明人工的写入被拒绝，且规则库不变', async () => {
	const dir = sandbox();
	try {
		const r = await confirmNegativeRule(dir, RULE);
		assert.equal(r.ok, false);
		assert.equal(r.error, 'not_human_confirmed');
		assert.equal(r.violation, VIOLATIONS.unconfirmedCandidate);
		// 库必须还是空的 —— 拒绝要真的没写
		let text = '';
		try { text = readFileSync(rulesPath(dir), 'utf8'); } catch { /* 不存在也算没写 */ }
		assert.ok(!text.includes('g-rule'), '规则不得落库');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('越权1：自动通道（nomination/判定）签不出票', () => {
	for (const via of ['nomination', 'auto', 'check', 'clis_trace', 'criteria', '']) {
		const p = issuePermit({ via, ruleId: 'x' });
		assert.equal(p.ok, false, `${via || '(空)'} 不该能签票`);
		assert.equal(p.violation, VIOLATIONS.unconfirmedCandidate);
	}
	// 只有人工通道能签
	for (const via of HUMAN_CHANNELS) {
		assert.equal(issuePermit({ via, ruleId: 'x' }).ok, true, `${via} 应能签票`);
	}
});

test('越权1：伪造/未知/已消费的票都拒绝', async () => {
	const dir = sandbox();
	try {
		const forged = await confirmNegativeRule(dir, RULE, { permit: 'not-a-real-token' });
		assert.equal(forged.ok, false);
		assert.equal(forged.error, 'unknown_permit');

		const p = issuePermit({ via: 'confirm', ruleId: 'g-rule' });
		consumePermit(p.token); // 一次性
		const reused = await confirmNegativeRule(dir, RULE, { permit: p.token });
		assert.equal(reused.ok, false);
		assert.equal(reused.error, 'unknown_permit', '票用过就不能再用');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('越权1：空票与未知票错误码不同（空票是可诊断的漏传，不是"查无此票"）', () => {
	// 这两条要分开断言：只测"被拒"的话，把空票分支删掉也不会红——
	// 因为它会落到 permits.get('') === undefined 的兜底上（实测存活变异）。
	const empty = requirePermit('', { ruleId: 'r' });
	assert.equal(empty.ok, false);
	assert.equal(empty.error, 'missing_permit', '空票应报 missing_permit，不是 unknown_permit');
	const blank = requirePermit('   ', { ruleId: 'r' });
	assert.equal(blank.error, 'missing_permit', '纯空白也算漏传');
	const unknown = requirePermit('no-such-token', { ruleId: 'r' });
	assert.equal(unknown.error, 'unknown_permit', '未知票才是 unknown_permit');
});

test('越权1：拿 A 规则的票写 B 规则被拒（票绑定 id）', async () => {
	const dir = sandbox();
	try {
		const p = issuePermit({ via: 'confirm', ruleId: 'other-rule' });
		const r = await confirmNegativeRule(dir, RULE, { permit: p.token });
		assert.equal(r.ok, false);
		assert.equal(r.error, 'permit_rule_mismatch');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('越权1：过期的票被拒（票有有效期）', async () => {
	const dir = sandbox();
	try {
		const past = Date.now() - PERMIT_TTL_MS - 1000;
		const p = issuePermit({ via: 'confirm', ruleId: 'g-rule' }, { now: past });
		const r = await confirmNegativeRule(dir, RULE, { permit: p.token });
		assert.equal(r.ok, false);
		assert.equal(r.error, 'expired_permit');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('越权1：合法人工路径仍然可用（闸门不能把正路也堵死）', async () => {
	const dir = sandbox();
	try {
		const viaHuman = await confirmNegativeRule(dir, RULE, { human: true });
		assert.equal(viaHuman.ok, true);

		const p = issuePermit({ via: 'confirm', ruleId: 'g-rule' });
		const viaPermit = await confirmNegativeRule(dir, { ...RULE, statement: '改一版' }, { permit: p.token });
		assert.equal(viaPermit.ok, true);
		const rules = await readNegativeRules(dir);
		assert.equal(rules[0].statement, '改一版');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ——————————————————————————————————————————————
// 越权 2：跳过判据写库
// ——————————————————————————————————————————————

test('越权2：没跑任何判据就写库 → 拦截并标 skipped_criteria', () => {
	const bad = requireCriteria([]);
	assert.equal(bad.ok, false);
	assert.equal(bad.violation, VIOLATIONS.skippedCriteria);
	assert.equal(bad.error, 'skipped_criteria');

	// 未传、传非数组、传空字符串数组，都算"没跑判据"
	for (const v of [undefined, null, 'layer-gate', [''], ['  ']]) {
		assert.equal(requireCriteria(v).ok, false, `${JSON.stringify(v)} 应被判为未跑判据`);
	}
});

test('越权2：跑了判据则放行，并回传判据清单（审计要能回答跑了什么）', () => {
	const ok = requireCriteria(['layer-gate', 'negative-conflict']);
	assert.equal(ok.ok, true);
	assert.deepEqual(ok.criteria, ['layer-gate', 'negative-conflict']);
});

test('越权2：回退同样需要人工凭据（不能拿回退当后门删规则）', async () => {
	const dir = sandbox();
	try {
		await confirmNegativeRule(dir, RULE, { human: true });
		await confirmNegativeRule(dir, { ...RULE, statement: 'v2' }, { human: true });
		// 无凭据回退 → 拒绝
		const blocked = await rollbackNegativeRule(dir, 'g-rule');
		assert.equal(blocked.ok, false);
		assert.equal(blocked.violation, VIOLATIONS.unconfirmedCandidate);
		// 规则仍在
		const rules = await readNegativeRules(dir);
		assert.ok(rules.some((r) => r.id === 'g-rule'), '被拒的回退不得改动规则库');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ——————————————————————————————————————————————
// 越权 3：越层写入
// ——————————————————————————————————————————————

test('越权3：写到不在允许层的层 → 拦并标 cross_layer_write', () => {
	const p = issuePermit({ via: 'confirm', ruleId: 'r' });
	const r = requirePermit(p.token, { ruleId: 'r' }, { allowLayers: ['L3', 'L2'], layer: 'L1' });
	assert.equal(r.ok, false);
	assert.equal(r.violation, VIOLATIONS.crossLayerWrite);
	assert.equal(r.error, 'layer_not_allowed');
});

test('越权3：允许层内放行；不提供层约束时不臆造限制', () => {
	const p = issuePermit({ via: 'confirm', ruleId: 'r' });
	assert.equal(requirePermit(p.token, { ruleId: 'r' }, { allowLayers: ['L3', 'L2'], layer: 'L2' }).ok, true);
	// 没给 allowLayers 就不判层（不为不存在的规则编造约束）
	const p2 = issuePermit({ via: 'confirm', ruleId: 'r2' });
	assert.equal(requirePermit(p2.token, { ruleId: 'r2' }, { layer: 'L1' }).ok, true);
});

// ——————————————————————————————————————————————
// 票的通用不变量
// ——————————————————————————————————————————————

test('票绑定规则 id：缺 ruleId 签不出票', () => {
	assert.equal(issuePermit({ via: 'confirm' }).ok, false);
	assert.equal(issuePermit({ via: 'confirm', ruleId: '  ' }).ok, false);
});

test('票一次性：消费后不可再用', () => {
	const p = issuePermit({ via: 'confirm', ruleId: 'r' });
	assert.equal(consumePermit(p.token), true);
	assert.equal(consumePermit(p.token), false, '第二次消费应失败');
	assert.equal(requirePermit(p.token, { ruleId: 'r' }).ok, false);
});
