/**
 * III-4 回滚缰绳测试。
 *
 * 核心判据：覆盖写**前**必须有快照（否则错的禁令再也退不回去）；
 * 同一规则回退到上限后必须转人工，而不是继续自动重试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	snapshotDir, snapshotNumbers, writeSnapshot, readLatestSnapshot, canRollback, MAX_ROLLBACKS,
} from '../src/snapshot.js';
import { confirmNegativeRule, readNegativeRules, rollbackNegativeRule, rulesPath } from '../src/store.js';

function sandbox() {
	return mkdtempSync(join(tmpdir(), 'dsh-valves-snap-'));
}

const RULE = { id: 'forbidden-x', negative_type: 'forbidden_skill', statement: '不要走 X 路径', keywords: ['x 路径'] };

test('确认写入会自动产生快照（回退点的唯一来源）', async () => {
	const dir = sandbox();
	try {
		const r = await confirmNegativeRule(dir, RULE);
		assert.equal(r.ok, true);
		assert.equal(r.snapshot, 1, '首次确认应写下 1 号快照');
		const nums = await snapshotNumbers(dir, RULE.id);
		assert.deepEqual(nums, [1]);
		// 首次快照的内容必须是"此前不存在"，回退才能等价于删除
		const latest = await readLatestSnapshot(dir, RULE.id);
		assert.equal(latest.rule, null, '上一版是"不存在"');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('修订同一规则：快照记录的是**改动前**的内容，不是新内容', async () => {
	const dir = sandbox();
	try {
		await confirmNegativeRule(dir, RULE);
		await confirmNegativeRule(dir, { ...RULE, statement: '改成 Y 路径' });
		const latest = await readLatestSnapshot(dir, RULE.id);
		assert.equal(latest.n, 2);
		assert.equal(latest.rule.statement, '不要走 X 路径', '2 号快照必须是第 1 版的内容');
		const rules = await readNegativeRules(dir);
		assert.equal(rules[0].statement, '改成 Y 路径', '生效的是新版本');
		assert.equal(rules[0].revisions, 2, '修订次数要能回答"改了几版"');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('回退：有上一版则恢复它，并保留规则库其余条目', async () => {
	const dir = sandbox();
	try {
		await confirmNegativeRule(dir, { id: 'other', negative_type: 'forbidden_skill', statement: '别的规则', keywords: ['别'] });
		await confirmNegativeRule(dir, RULE);
		await confirmNegativeRule(dir, { ...RULE, statement: '改坏了' });

		const r = await rollbackNegativeRule(dir, RULE.id);
		assert.equal(r.ok, true);
		assert.equal(r.action, 'restored');
		const rules = await readNegativeRules(dir);
		const x = rules.find((x) => x.id === RULE.id);
		assert.equal(x.statement, '不要走 X 路径', '已恢复到上一版');
		assert.ok(rules.some((y) => y.id === 'other'), '别的规则不受影响');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('回退：首次确认的规则回退 = 删除它（上一版本不存在）', async () => {
	const dir = sandbox();
	try {
		await confirmNegativeRule(dir, RULE);
		await confirmNegativeRule(dir, { ...RULE, statement: '第二版' });
		// 第一次回退：恢复第 1 版（2 号快照存的就是第 1 版），并标记该快照已消费
		const r = await rollbackNegativeRule(dir, RULE.id);
		assert.equal(r.ok, true);
		assert.equal(r.action, 'restored');
		// 第二次回退：2 号已消费，走到 1 号快照（rule=null）→ 删除。
		// 这一步是实测抓到的缺陷：不标记消费的话会一直恢复同一版。
		const r2 = await rollbackNegativeRule(dir, RULE.id, { rollbacks: 1 });
		assert.equal(r2.ok, true);
		assert.equal(r2.action, 'removed', '上一版为 null 时回退等于删除');
		const rules = await readNegativeRules(dir);
		assert.ok(!rules.some((x) => x.id === RULE.id), '规则已被移除');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('回退不会重复恢复同一版：连续两次回退必须走到不同快照', async () => {
	const dir = sandbox();
	try {
		await confirmNegativeRule(dir, RULE);                              // 1 号: null
		await confirmNegativeRule(dir, { ...RULE, statement: 'v2' });       // 2 号: v1
		await confirmNegativeRule(dir, { ...RULE, statement: 'v3' });       // 3 号: v2

		const first = await rollbackNegativeRule(dir, RULE.id);
		assert.equal(first.action, 'restored');
		assert.equal(first.n, 3, '第一次应消费 3 号快照（v2）');
		const second = await rollbackNegativeRule(dir, RULE.id, { rollbacks: 1 });
		assert.equal(second.action, 'restored');
		assert.equal(second.n, 2, '第二次应消费 2 号快照（v1），而不是又读 3 号');
		assert.notEqual(first.n, second.n, '两次回退必须来自不同快照');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('回退上限：达到 3 次后拒绝自动回退并转人工', async () => {
	const dir = sandbox();
	try {
		await confirmNegativeRule(dir, RULE);
		await confirmNegativeRule(dir, { ...RULE, statement: 'v2' });

		const blocked = await canRollback(dir, RULE.id, MAX_ROLLBACKS);
		assert.equal(blocked.allowed, false);
		assert.equal(blocked.reason, 'rollback_limit_reached');

		const r = await rollbackNegativeRule(dir, RULE.id, { rollbacks: MAX_ROLLBACKS });
		assert.equal(r.ok, false);
		assert.equal(r.error, 'rollback_limit_reached');
		assert.equal(r.human_gate_required, true, '到上限必须转人工，不是静默失败');
		assert.equal(r.max, MAX_ROLLBACKS);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('回退计数按规则各自计：A 到上限不影响 B', async () => {
	const dir = sandbox();
	try {
		await confirmNegativeRule(dir, { id: 'a', negative_type: 'forbidden_skill', statement: 'A', keywords: ['a'] });
		await confirmNegativeRule(dir, { id: 'b', negative_type: 'forbidden_skill', statement: 'B', keywords: ['b'] });
		await confirmNegativeRule(dir, { id: 'b', negative_type: 'forbidden_skill', statement: 'B2', keywords: ['b'] });

		assert.equal((await canRollback(dir, 'a', 3)).allowed, false, 'A 已到上限');
		assert.equal((await canRollback(dir, 'b', 1)).allowed, true, 'B 只回退 1 次，仍可回退');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('没有快照时回退报 no_snapshot（不猜、不伪造）', async () => {
	const dir = sandbox();
	try {
		const r = await rollbackNegativeRule(dir, 'never-confirmed');
		assert.equal(r.ok, false);
		assert.equal(r.error, 'no_snapshot');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('快照失败 → 拒绝写入（宁可不生效，也不制造回不去的状态）', async () => {
	const dir = sandbox();
	try {
		// 让快照目录的位置被一个**文件**占住，mkdir 必然失败。
		mkdirSync(dir, { recursive: true });
		writeFileSync(snapshotDir(dir), 'not a directory', 'utf8');

		const r = await confirmNegativeRule(dir, RULE);
		assert.equal(r.ok, false, '快照失败必须阻断写入');
		assert.match(String(r.error), /快照失败/);
		// 规则库不该出现这条 —— 写都没写
		let text = '';
		try { text = readFileSync(rulesPath(dir), 'utf8'); } catch { /* 文件不存在也算没写 */ }
		assert.ok(!text.includes('forbidden-x'), '规则不得落库');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('规则 id 里的路径分隔符被中性化（不逃出快照目录）', async () => {
	const dir = sandbox();
	try {
		const nasty = { id: '../../evil', negative_type: 'forbidden_skill', statement: '越界尝试', keywords: ['e'] };
		await confirmNegativeRule(dir, nasty);
		const nums = await snapshotNumbers(dir, '../../evil');
		assert.equal(nums.length, 1, '快照应正常落在目录内');
		// 目录里应只有一条文件，且没有逃到上级
		const latest = await readLatestSnapshot(dir, '../../evil');
		assert.equal(latest.ok, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
