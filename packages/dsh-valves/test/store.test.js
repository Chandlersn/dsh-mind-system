/**
 * 账本与负向规则库测试 —— 全部用临时目录，绝不碰真实 <dshHome>。
 *
 * 重点盯三件容易撒谎的事：
 * 1. 双侧记账：deny/reject 必须落 skipped（漏判分母的原料）；
 * 2. 读失败 ≠ 空：ENOENT 是 []，其它失败是 undefined（没查成不得当没命中）；
 * 3. 确认通道：写失败必须让调用方知道；库读不动时拒绝盲写。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	appendDecision,
	readDecisions,
	summarizeDecisions,
	readNegativeRules,
	confirmNegativeRule,
	matchNegativeRules,
	ledgerPath,
	rulesPath,
} from '../src/store.js';

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-valves-test-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('账本：追加可读、坏行跳过、无文件是 []', async () => {
	const { dir, cleanup } = tempDir();
	try {
		assert.deepEqual(await readDecisions(dir), []);
		assert.equal(await appendDecision(dir, { gate: 'g', outcome: 'admitted', reason: 'ok' }), true);
		assert.equal(await appendDecision(dir, { gate: 'g', outcome: 'skipped', reason: 'deny' }), true);
		// 插一条坏行：读侧必须跳过而不是整本账失败
		writeFileSync(ledgerPath(dir), `${readFileSync(ledgerPath(dir), 'utf8')}{corrupt\n`, 'utf8');
		const entries = await readDecisions(dir);
		assert.equal(entries.length, 2, '坏行必须跳过而不是让整本账读失败');
	} finally {
		cleanup();
	}
});

test('汇总：双侧成对，missRate = skipped/evaluated，按 reason/gate 分布', () => {
	const s = summarizeDecisions([
		{ gate: 'downward_L1_L2', outcome: 'admitted', reason: 'concretized' },
		{ gate: 'downward_L1_L2', outcome: 'skipped', reason: 'negative_rule_hit' },
		{ gate: 'upward_L3_L2', outcome: 'skipped', reason: 'insufficient_repeats' },
		{ gate: 'upward_L3_L2', outcome: 'admitted', reason: 'skill_thresholds_met' },
		{ outcome: 'garbage' }, // 未知 outcome 不计入任何一侧
	]);
	assert.equal(s.evaluated, 4);
	assert.equal(s.admitted, 2);
	assert.equal(s.skipped, 2);
	assert.equal(s.missRate, 0.5);
	assert.equal(s.byReason.negative_rule_hit, 1);
	assert.equal(s.byGate.upward_L3_L2, 2);
	assert.equal(summarizeDecisions([]).missRate, null, '没数据时 missRate 是 null 不是 0（0 会被读成完美）');
});

test('负向库：ENOENT → []，损坏 JSON → undefined（没查成 ≠ 没命中）', async () => {
	const { dir, cleanup } = tempDir();
	try {
		assert.deepEqual(await readNegativeRules(dir), []);
		writeFileSync(rulesPath(dir), '{broken', 'utf8');
		assert.equal(await readNegativeRules(dir), undefined);
		writeFileSync(rulesPath(dir), JSON.stringify({ rules: 'not-an-array' }), 'utf8');
		assert.equal(await readNegativeRules(dir), undefined);
	} finally {
		cleanup();
	}
});

test('确认通道：合法写入、同 id 覆盖为修订、非法输入拒绝', async () => {
	const { dir, cleanup } = tempDir();
	try {
		const r1 = await confirmNegativeRule(dir, {
			id: 'no-blind-retry', negative_type: 'forbidden_skill',
			statement: '禁止不读错误原样重试', keywords: ['原样重试'],
		});
		assert.equal(r1.ok, true);
		assert.equal(r1.count, 1);
		const r2 = await confirmNegativeRule(dir, {
			id: 'no-blind-retry', negative_type: 'forbidden_skill',
			statement: '修订版', keywords: ['原样重试', '盲目重试'],
		});
		assert.equal(r2.count, 1, '同 id 是覆盖不是追加');
		const rules = await readNegativeRules(dir);
		assert.equal(rules[0].statement, '修订版');
		assert.ok(rules[0].confirmed_at, '必须带确认时间');
		assert.equal((await confirmNegativeRule(dir, { id: 'x' })).ok, false);
		assert.equal((await confirmNegativeRule(dir, { id: 'x', statement: 's', negative_type: 'made_up' })).ok, false);
	} finally {
		cleanup();
	}
});

test('确认通道：库读不动时拒绝盲写（不覆盖读不到的既有规则）', async () => {
	const { dir, cleanup } = tempDir();
	try {
		writeFileSync(rulesPath(dir), '{broken', 'utf8');
		const r = await confirmNegativeRule(dir, { id: 'x', statement: 's', negative_type: 'forbidden_skill' });
		assert.equal(r.ok, false);
		assert.match(r.error, /读取失败/);
	} finally {
		cleanup();
	}
});

test('匹配：关键词包含命中；undefined 透传（调用方区分没查成）', () => {
	const rules = [{ id: 'r1', keywords: ['原样重试'] }, { id: 'r2', keywords: [''] }];
	assert.deepEqual(matchNegativeRules(rules, '不要原样重试这条命令'), ['r1']);
	assert.deepEqual(matchNegativeRules(rules, '无关文本'), []);
	assert.deepEqual(matchNegativeRules(rules, ''), []);
	assert.equal(matchNegativeRules(undefined, 'anything'), undefined);
	assert.deepEqual(matchNegativeRules([], 'anything'), []);
});