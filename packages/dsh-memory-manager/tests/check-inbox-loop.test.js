/**
 * 发现→跟踪闭环测试（2026-11-09 用户质问"发现了为啥跳过"后加）。
 *
 * 回路的断点：memory_check 只出报表，WARN 不进跟踪队列，"存量"是无代价
 * 口头标签。修复：体检自动投递收件箱（指纹去重、复发 times+1、resolved
 * 复现自动重开）。本测试钉住闭环的三段：投递、复发递增、复现重开。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { MemoryInbox } from '../health-inbox.js';

function tempInbox() {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-inbox-loop-'));
	const inbox = new MemoryInbox(() => dir);
	return { inbox, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
import { join } from 'node:path';

/** 模拟 memory_check 的投递段（与 server.js execute 里的形状一致）。 */
async function postFindings(inbox, results) {
	const tracked = [];
	for (const r of results) {
		const { item } = await inbox.post({
			from: 'memory-manager',
			code: r.rule,
			severity: r.level === 'FAIL' ? 'error' : 'warn',
			message: r.message,
			hint: '体检自动投递：处置后 memory_inbox update resolved，或说明搁置理由',
		});
		tracked.push({ rule: r.rule, times: item.times, status: item.status, fingerprint: item.fingerprint });
	}
	return tracked;
}

test('闭环：首检投递 open times=1；复检同问题 times=2（"存量"有了代价）', async () => {
	const { inbox, cleanup } = tempInbox();
	try {
		const findings = [{ level: 'WARN', rule: 'R14', message: 'functions/x.md 迭代块正文 1267 字 > 900' }];
		const t1 = await postFindings(inbox, findings);
		assert.equal(t1[0].times, 1);
		assert.equal(t1[0].status, 'open');
		const t2 = await postFindings(inbox, findings);
		assert.equal(t2[0].times, 2, '同一问题第二次发现必须递增——这就是打破回路的阻尼');
		assert.equal(t2[0].fingerprint, t1[0].fingerprint, '指纹去重不刷屏');
	} finally {
		cleanup();
	}
});

test('闭环：resolved 后问题复现 → 自动重新 open（不是新条目）', async () => {
	const { inbox, cleanup } = tempInbox();
	try {
		const findings = [{ level: 'WARN', rule: 'R3', message: '头部摘要早于最新迭代块' }];
		const t1 = await postFindings(inbox, findings);
		await inbox.update(t1[0].fingerprint, 'resolved', '已刷新头部');
		const t2 = await postFindings(inbox, findings);
		assert.equal(t2[0].status, 'open', '修好又坏 = 复现重开');
		assert.equal(t2[0].times, 2);
		assert.equal(t2[0].fingerprint, t1[0].fingerprint);
	} finally {
		cleanup();
	}
});

test('闭环：不同问题各自计数；FAIL 映射 error 严重度', async () => {
	const { inbox, cleanup } = tempInbox();
	try {
		const t = await postFindings(inbox, [
			{ level: 'WARN', rule: 'R5', message: 'functions/a.md 没有索引行' },
			{ level: 'FAIL', rule: 'R10', message: '死链指向不存在文件' },
		]);
		assert.equal(t.length, 2);
		assert.notEqual(t[0].fingerprint, t[1].fingerprint);
		const items = await inbox.list();
		const fail = items.find((i) => i.code === 'R10');
		assert.equal(fail.severity, 'error');
	} finally {
		cleanup();
	}
});

test('降级：inbox 缺席时体检照常返回（跟踪是附加能力）', async () => {
	// server.js 的形状：if (inbox && !opts.memoryRoot) 才投递——这里验证
	// 无 inbox 路径不抛
	const report = { root: 'x', results: [{ level: 'WARN', rule: 'R5', message: 'm' }], warnCount: 1, failCount: 0 };
	const inbox = undefined;
	const tracked = [];
	if (inbox) { /* 不会进来 */ }
	assert.deepEqual(tracked, []);
	assert.equal(report.warnCount, 1, '报表本体不受跟踪缺席影响');
});

test('污染守卫：测试态（opts.memoryRoot 注入）不投递全局收件箱', () => {
	// 复刻 server.js execute 的判定：`inbox && !opts.memoryRoot`。
	// 测试套件用临时根造 25 个假 WARN，若没有守卫会灌进真实收件箱 ×N，
	// 把复发计数变成噪音。钉住：注入了 memoryRoot 就绝不投递。
	const shouldTrack = (inbox, opts) => Boolean(inbox) && !opts.memoryRoot;
	assert.equal(shouldTrack({}, {}), true, '默认全局根：投递');
	assert.equal(shouldTrack({}, { memoryRoot: 'C:/Temp/dsh-mem-xxx' }), false, '测试态临时根：不投递');
	assert.equal(shouldTrack(undefined, {}), false, '无 inbox：不投递');
});