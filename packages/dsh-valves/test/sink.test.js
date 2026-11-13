/**
 * IV-3 负向规则沉底 —— 隔离测试，全部用临时目录。
 *
 * 判据（I-5/D3 定案）：90 天未触发 → 移出拦截、保留为反例资产（不删除）。
 * 盯住四件容易撒谎的事：
 * 1. 沉底规则**仍可检索**（sunkRules / includeSunk）但**不再拦截**；
 * 2. 活动时间取 max(最近命中, confirmed_at)——只看命中会误杀刚确认的，
 *    只看确认会误杀天天在用的；
 * 3. 触发流水读不到（undefined）≠ 从未命中——返回 unknown，不沉底；
 * 4. 沉底是人工通道（票/显式 human），定时器不许代劳；写前快照可回退。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issuePermit } from '../src/guard.js';
import {
	appendRuleTrigger,
	readRuleTriggers,
	lastTriggeredMap,
	findSinkCandidates,
	matchNegativeRules,
	sinkRules,
	sunkRules,
	confirmNegativeRule,
	readNegativeRules,
	rulesPath,
	triggersPath,
} from '../src/store.js';
import { weeklyPrinciplePatrol } from '../src/patrol.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-13T12:00:00Z');

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-sink-test-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function rule(id, confirmedAt, extra = {}) {
	return {
		id,
		negative_type: 'forbidden_skill',
		statement: `禁令 ${id}`,
		keywords: [id],
		confirmed_at: confirmedAt,
		...extra,
	};
}

/** 经人工通道确认一条规则（隔离目录，走真实 confirmNegativeRule）。 */
async function confirm(dir, r) {
	const permit = issuePermit({ via: 'confirm', ruleId: r.id });
	assert.equal(permit.ok, true);
	return confirmNegativeRule(dir, { ...r, source: 'test' }, { permit: permit.token });
}

test('命中流水：只追加、坏行跳过、无文件是 []', async () => {
	const { dir, cleanup } = tempDir();
	try {
		assert.deepEqual(await readRuleTriggers(dir), []);
		assert.equal(await appendRuleTrigger(dir, { ruleIds: ['a', 'b'], at: '2026-11-13T00:00:00Z' }), true);
		assert.equal(await appendRuleTrigger(dir, { ruleIds: ['a'], at: '2026-11-14T00:00:00Z' }), true);
		writeFileSync(triggersPath(dir), `${readFileSync(triggersPath(dir), 'utf8')}{corrupt\n`, 'utf8');
		const lines = await readRuleTriggers(dir);
		assert.equal(lines.length, 2);
		const last = lastTriggeredMap(lines);
		assert.equal(last.get('a'), Date.parse('2026-11-14T00:00:00Z'), '同一 id 取最近一次');
		assert.equal(last.get('b'), Date.parse('2026-11-13T00:00:00Z'));
	} finally { cleanup(); }
});

test('读失败 ≠ 空：触发流水不可读时判 unknown，不产出沉底候选', async () => {
	const rules = [rule('r1', new Date(NOW - 200 * DAY).toISOString())];
	const found = findSinkCandidates(rules, undefined, { now: NOW, windowDays: 90 });
	assert.equal(found.unknown, true);
	assert.deepEqual(found.candidates, []);
	// 库本身读不到时也不得沉底
	const { dir, cleanup } = tempDir();
	try {
		writeFileSync(join(dir, 'broken'), 'x');
		const res = await sinkRules(dir, ['r1'], { human: true });
		assert.equal(res.ok, false, '没有规则库时拒绝盲写');
	} finally { cleanup(); }
});

test('沉底候选：max(命中,确认)；刚确认不误杀、天天命中不误杀、久不触发才提名', () => {
	const rules = [
		rule('fresh', new Date(NOW - 2 * DAY).toISOString()),
		rule('hot', new Date(NOW - 200 * DAY).toISOString()),
		rule('stale', new Date(NOW - 200 * DAY).toISOString()),
	];
	const triggers = [
		{ t: new Date(NOW - 1 * DAY).toISOString(), ms: NOW - 1 * DAY, ids: ['hot'] },
		{ t: new Date(NOW - 120 * DAY).toISOString(), ms: NOW - 120 * DAY, ids: ['stale'] },
	];
	const found = findSinkCandidates(rules, triggers, { now: NOW, windowDays: 90 });
	assert.equal(found.unknown, false);
	const ids = found.candidates.map((c) => c.id);
	assert.deepEqual(ids, ['stale'], '只报真正过期的那条');
	assert.equal(found.candidates[0].lastActivityAt, new Date(NOW - 120 * DAY).toISOString());
	assert.equal(found.candidates[0].reason, 'no_trigger_within_window');
});

test('从未命中的老规则：确认时间起算，过期才提名', () => {
	const rules = [rule('never', new Date(NOW - 200 * DAY).toISOString())];
	const found = findSinkCandidates(rules, [], { now: NOW, windowDays: 90 });
	assert.equal(found.candidates.length, 1);
	assert.equal(found.candidates[0].reason, 'never_triggered_since_confirm');
});

test('沉底后：不再拦截，但内容保留、可检索、可 includeSunk', async () => {
	const { dir, cleanup } = tempDir();
	try {
		assert.equal((await confirm(dir, rule('no-blind-retry', new Date(NOW - 200 * DAY).toISOString()))).ok, true);
		const rulesBefore = await readNegativeRules(dir);
		assert.ok(rulesBefore.find((r) => r.id === 'no-blind-retry'));
		assert.ok(matchNegativeRules(rulesBefore, '准备原样重试 no-blind-retry').includes('no-blind-retry'));

		const permit = issuePermit({ via: 'sink', ruleId: 'no-blind-retry' });
		const res = await sinkRules(dir, ['no-blind-retry'], { permits: [permit.token], reason: '90 天未触发' });
		assert.equal(res.ok, true);
		assert.deepEqual(res.sunk, ['no-blind-retry']);
		assert.equal(res.deleted, false, '必须是"保留"而非删除');

		const rulesAfter = await readNegativeRules(dir);
		const r = rulesAfter.find((x) => x.id === 'no-blind-retry');
		assert.equal(r.status, 'sunk');
		assert.equal(r.statement, '禁令 no-blind-retry', '正文一字不删');
		assert.equal(r.sink_reason, '90 天未触发');
		assert.deepEqual(matchNegativeRules(rulesAfter, '准备原样重试 no-blind-retry'), [], '沉底规则不再拦截');
		assert.ok(matchNegativeRules(rulesAfter, '准备原样重试 no-blind-retry', { includeSunk: true }).includes('no-blind-retry'), '仍可检索为反例资产');
		assert.equal(sunkRules(rulesAfter).length, 1);
	} finally { cleanup(); }
});

test('沉底必须人工通道：无票拒绝，且票绑定 ruleId（A 票不能沉 B）', async () => {
	const { dir, cleanup } = tempDir();
	try {
		await confirm(dir, rule('a-rule', new Date(NOW - 200 * DAY).toISOString()));
		await confirm(dir, rule('b-rule', new Date(NOW - 200 * DAY).toISOString()));
		const noPermit = await sinkRules(dir, ['a-rule'], {});
		assert.equal(noPermit.ok, false);
		assert.equal(noPermit.violation, 'unconfirmed_candidate');

		const wrong = issuePermit({ via: 'sink', ruleId: 'a-rule' });
		const mismatch = await sinkRules(dir, ['b-rule'], { permit: wrong.token });
		assert.equal(mismatch.ok, false);
		assert.equal(mismatch.error, 'permit_rule_mismatch', '票绑定规则 id，不能借用');
		assert.equal((await readNegativeRules(dir)).find((r) => r.id === 'b-rule').status, undefined, '被拒后库未变');
	} finally { cleanup(); }
});

test('沉底写前快照 → rollback 可重新激活（回退=撤销沉底）', async () => {
	const { dir, cleanup } = tempDir();
	try {
		await confirm(dir, rule('reversible', new Date(NOW - 200 * DAY).toISOString()));
		const permit = issuePermit({ via: 'sink', ruleId: 'reversible' });
		assert.equal((await sinkRules(dir, ['reversible'], { permits: [permit.token] })).ok, true);
		assert.equal((await readNegativeRules(dir)).find((r) => r.id === 'reversible').status, 'sunk');
		// 回退走真实 rollbackNegativeRule：上一版快照是沉底前的活跃规则
		const { rollbackNegativeRule } = await import('../src/store.js');
		const rb = issuePermit({ via: 'rollback', ruleId: 'reversible' });
		const back = await rollbackNegativeRule(dir, 'reversible', { permit: rb.token });
		assert.equal(back.ok, true);
		const restored = (await readNegativeRules(dir)).find((r) => r.id === 'reversible');
		assert.equal(restored.status, undefined, '回退后重新激活');
		assert.ok(matchNegativeRules(await readNegativeRules(dir), 'reversible').includes('reversible'));
	} finally { cleanup(); }
});

test('批量沉底：一票对一条；重复沉底幂等，不重写库', async () => {
	const { dir, cleanup } = tempDir();
	try {
		await confirm(dir, rule('x', new Date(NOW - 200 * DAY).toISOString()));
		await confirm(dir, rule('y', new Date(NOW - 200 * DAY).toISOString()));
		const px = issuePermit({ via: 'sink', ruleId: 'x' });
		const py = issuePermit({ via: 'sink', ruleId: 'y' });
		const res = await sinkRules(dir, ['x', 'y'], { permits: [px.token, py.token] });
		assert.equal(res.ok, true);
		assert.deepEqual(res.sunk.sort(), ['x', 'y']);
		const bytes = readFileSync(rulesPath(dir));
		const px2 = issuePermit({ via: 'sink', ruleId: 'x' });
		const py2 = issuePermit({ via: 'sink', ruleId: 'y' });
		const again = await sinkRules(dir, ['x', 'y'], { permits: [px2.token, py2.token] });
		assert.equal(again.ok, true);
		assert.deepEqual(again.sunk, [], '已沉底的不重复写');
		assert.deepEqual(readFileSync(rulesPath(dir)), bytes, '幂等：库字节不变');
	} finally { cleanup(); }
});

test('周检只报沉底候选，不代劳沉底（定时器不许替人决定去留）', async () => {
	const { dir, cleanup } = tempDir();
	try {
		// confirmNegativeRule 会把 confirmed_at 写为"当前真实时间"，这里要构造
		// 一条 200 天前的老规则：直接写隔离库（只影响本临时目录）。
		writeFileSync(rulesPath(dir), `${JSON.stringify({ rules: [rule('old-guard', new Date(NOW - 200 * DAY).toISOString())] }, null, 2)}\n`, 'utf8');
		const rules = await readNegativeRules(dir);
		const triggers = await readRuleTriggers(dir);
		const found = findSinkCandidates(rules, triggers, { now: NOW, windowDays: 90 });
		const patrol = weeklyPrinciplePatrol({ principles: [{ id: 'p1', refs: 2 }] });
		const findings = [
			...patrol.findings,
			...found.candidates.map((c) => ({ kind: 'negative_rule_sink_candidate', rule_id: c.id })),
		];
		assert.ok(findings.some((f) => f.rule_id === 'old-guard'));
		assert.equal((await readNegativeRules(dir)).find((r) => r.id === 'old-guard').status, undefined, '巡检后规则仍活跃');
	} finally { cleanup(); }
});

test('沉底规则不进触发流水：拦截层记的是"实际生效的命中"', async () => {
	const { dir, cleanup } = tempDir();
	try {
		await confirm(dir, rule('gone', new Date(NOW - 200 * DAY).toISOString()));
		const p = issuePermit({ via: 'sink', ruleId: 'gone' });
		await sinkRules(dir, ['gone'], { permits: [p.token] });
		const rules = await readNegativeRules(dir);
		const hits = matchNegativeRules(rules, '触发 gone 关键词');
		assert.deepEqual(hits, [], '沉底后 matchNegative 返回空');
		assert.equal(await appendRuleTrigger(dir, { ruleIds: hits }), false, '空命中不写流水');
		assert.deepEqual(await readRuleTriggers(dir), []);
	} finally { cleanup(); }
});
