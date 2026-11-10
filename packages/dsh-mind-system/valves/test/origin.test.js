/**
 * origin 口径回归（2026-11-10 修正）。
 *
 * 背景：原实现"调用方不传 origin 就不写字段"，本意是不猜来源，
 * 实际后果是**真实日常样本全部落成无归属**——实测 100 行账本里 dailyCount=0，
 * 阈值校准依赖的分布永远攒不出来。不猜来源被做成了数据黑洞。
 *
 * 新口径：不传 = daily（真实判定默认就是日常）；验证/演练/提名必须显式声明
 * 来把自己排除出校准分布。这里把新口径钉住，防止有人"出于谨慎"改回去。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../index.js';
import { readDecisions, summarizeDecisions } from '../src/store.js';

/**
 * 等账本落盘：record() 里的 appendDecision 是 fire-and-forget（记账不该拖慢执行），
 * 所以测试读完立刻断言会看不到行。这里给一个很短的等待窗口。
 */
const settle = () => new Promise((r) => setTimeout(r, 50));

function sandbox() {
	return mkdtempSync(join(tmpdir(), 'dsh-valves-origin-'));
}

test('不传 origin → 记成 daily（真实判定默认是日常，不是"无归属"）', async () => {
	const dir = sandbox();
	try {
		const rt = createRuntime({ storageDir: dir });
		rt.downward('L1', 'L2', { constraints: ['具体化约束'] });
		await settle();
		const rows = await readDecisions(dir);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].origin, 'daily', '不传必须是 daily，否则 dailyCount 永远为 0');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('显式传 verification → 保持 verification，绝不混进日常分布', async () => {
	const dir = sandbox();
	try {
		const rt = createRuntime({ storageDir: dir });
		rt.downward('L1', 'L2', { constraints: ['x'], origin: 'verification' });
		await settle();
		const rows = await readDecisions(dir);
		assert.equal(rows[0].origin, 'verification');
		const s = summarizeDecisions(rows);
		assert.equal(s.dailyCount, 0, '验证样本不得计入日常计数');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('upward 与 principle 走同一口径（三处判据一致）', async () => {
	const dir = sandbox();
	try {
		const rt = createRuntime({ storageDir: dir });
		rt.upward('L3', 'L2', {
			kind: 'positive', rule_type: 'skill', repeats: 9, success_rate: 0.9,
			success_evidence: 'external', evidence: ['trace-1'],
		});
		rt.principle({ anti_example_count: 0, source_diversity: 0, coverage_rate: 0.9, window_rounds: 30 });
		await settle();
		const rows = await readDecisions(dir);
		assert.ok(rows.length >= 2);
		for (const r of rows) {
			assert.equal(r.origin, 'daily', `${r.gate} 不传 origin 也应为 daily`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('dailyCount 能真正涨起来（这是阈值校准的前提）', async () => {
	const dir = sandbox();
	try {
		const rt = createRuntime({ storageDir: dir });
		for (let i = 0; i < 3; i++) rt.downward('L1', 'L2', { constraints: [`c${i}`] });
		await settle();
		const s = summarizeDecisions(await readDecisions(dir));
		assert.equal(s.dailyCount, 3, '三次真实判定应产生 3 条日常样本');
		assert.equal(s.byOrigin.daily, 3);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('空字符串/非法 origin 也退回 daily（不产生无法归类的行）', async () => {
	const dir = sandbox();
	try {
		const rt = createRuntime({ storageDir: dir });
		rt.downward('L1', 'L2', { constraints: ['a'], origin: '' });
		rt.downward('L1', 'L2', { constraints: ['b'], origin: 123 });
		await settle();
		const rows = await readDecisions(dir);
		assert.equal(rows.length, 2);
		for (const r of rows) assert.equal(r.origin, 'daily', '非法值不能让行失去归属');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
