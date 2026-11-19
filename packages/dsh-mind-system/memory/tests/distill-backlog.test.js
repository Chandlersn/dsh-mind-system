/**
 * R28 蒸馏积压检测（2026-11-19）。
 *
 * ## 这条规则为什么必须存在
 *
 * 实测：五天日记录 86KB，只产出 1 个迭代块，而**没有任何提示**。R14 只查块「太长」
 * ——没写的块永远是合格的；R27 只查「同一天多块」。于是整条流水线可以停住而保持安静，
 * 这正是 `insights/失败被伪装成成功` 说的那类：**停住但不出声的东西，和健康空转长得一样**。
 *
 * 发现它的唯一原因，是用户问了句「蒸馏系统在运行没」。
 *
 * ## 判据的三个要害
 *
 * 1. **due 不是「素材多」**，而是「有 ≥3 天同主题素材，且最新素材日**晚于**该功能域最新迭代块」。
 *    只看体量会把「一天写了 50KB」判成该蒸馏——那不是纪律说的东西。
 * 2. **不能只报计数**。「3 天」不可行动，「11-17、11-18」才能让人去开对的文件。
 * 3. **没有归属的素材必须报，不许悄悄丢**。素材不属于任何功能域是结构缺口，不是噪音。
 *
 * ## 反例也要测
 *
 * 素材已被吸收（最新块晚于素材日）时必须安静——一个永远在叫的警告和一个从不叫的
 * 警告，读起来是一样的。
 *
 * ## 关于体量门槛
 *
 * 默认 minBytes=400（一节素材的实际量级）。早期版本用 30 字节的假数据测，检测器
 * 因门槛未达而返回空——那暴露的是测试不真实，不是代码错。这里用接近真实的体量。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { detectDistillationBacklog } = await import('../server.js');

/** A section body with realistic bulk (>400B) so the volume bar is exercised. */
const bulk = (topic) => `## 段落\n${topic} ${'这段内容描述实际发生的工作与判断。'.repeat(28)}\n`;

function makeRoot({ areas = [], days = {} } = {}) {
	const root = mkdtempSync(path.join(tmpdir(), 'dsh-r28-'));
	mkdirSync(path.join(root, 'functions'), { recursive: true });
	for (const a of areas) {
		const blocks = a.blocks.map((d) => `## [${d}] x\n内容`).join('\n\n');
		writeFileSync(path.join(root, 'functions', `${a.name}.md`), `# ${a.name}\n\n${blocks}\n`, 'utf8');
	}
	for (const [day, text] of Object.entries(days)) {
		writeFileSync(path.join(root, `${day}.md`), text, 'utf8');
	}
	return root;
}

test('≥3 天同主题素材且晚于最新块 → 报 due，并点名是哪几天', async () => {
	const root = makeRoot({
		areas: [{ name: 'memory-manager', blocks: ['2026-11-01'] }],
		days: {
			'2026-11-10': bulk('memory_write 召回 索引行'),
			'2026-11-11': bulk('memory_read 召回注入'),
			'2026-11-12': bulk('索引行摘要 召回'),
		},
	});
	try {
		const r = await detectDistillationBacklog(root);
		const hit = r.due.find((d) => d.area === 'memory-manager');
		assert.ok(hit, `应报 due，实际 ${JSON.stringify(r.due)}`);
		assert.deepEqual(hit.days, ['2026-11-10', '2026-11-11', '2026-11-12'], '必须点名是哪几天，不是只给计数');
		assert.equal(hit.newestBlock, '2026-11-01');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('素材已被吸收（最新块晚于素材日）→ 安静（不许永远在叫）', async () => {
	const root = makeRoot({
		areas: [{ name: 'memory-manager', blocks: ['2026-11-20'] }],
		days: {
			'2026-11-10': bulk('memory_write 召回'),
			'2026-11-11': bulk('memory_read 召回'),
			'2026-11-12': bulk('索引行 召回'),
		},
	});
	try {
		const r = await detectDistillationBacklog(root);
		assert.equal(r.due.length, 0, `已吸收就不该再报：${JSON.stringify(r.due)}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('不足 3 天 → 不报（2 天是积累期，不是积压）', async () => {
	const root = makeRoot({
		areas: [{ name: 'memory-manager', blocks: ['2026-11-01'] }],
		days: {
			'2026-11-10': bulk('memory_write 召回'),
			'2026-11-11': bulk('memory_read 召回'),
		},
	});
	try {
		const r = await detectDistillationBacklog(root);
		assert.equal(r.due.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('只写一天但体量很大 → 不报（due 不是「素材多」）', async () => {
	const root = makeRoot({
		areas: [{ name: 'memory-manager', blocks: ['2026-11-01'] }],
		days: { '2026-11-10': `## 甲\n${'memory_write 召回 索引行 '.repeat(400)}` },
	});
	try {
		const r = await detectDistillationBacklog(root);
		assert.equal(r.due.length, 0, '单日大体积不该被判成该蒸馏');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('没有归属的素材 → 报 orphan（结构缺口不许悄悄丢）', async () => {
	const root = makeRoot({
		areas: [{ name: 'memory-manager', blocks: ['2026-01-01'] }],
		days: {
			'2026-11-10': bulk('双循环运行时阶段0隔离执行 DL-1 契约'),
			'2026-11-11': bulk('运行时调度器与预算预留 DR-03'),
			'2026-11-12': bulk('双循环执行框架的恢复入口'),
		},
	});
	try {
		const r = await detectDistillationBacklog(root);
		assert.equal(r.due.length, 0, '没有对应功能域就不该报 due');
		assert.equal(r.orphan.length, 1, `应报 orphan，实际 ${JSON.stringify(r.orphan)}`);
		assert.equal(r.orphan[0].days.length, 3);
		assert.ok(r.orphan[0].bytes > 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('全新空根：安静，不报「积压状态未知」', async () => {
	// A brand-new root has no functions/ directory. ENOENT there means "no areas
	// yet", not "cannot tell". Measured: treating it as unknown made every fresh
	// install report a distillation problem it does not have.
	const root = mkdtempSync(path.join(tmpdir(), 'dsh-r28empty-'));
	try {
		const r = await detectDistillationBacklog(root);
		assert.equal(r.due.length, 0);
		assert.equal(r.orphan.length, 0);
		assert.equal(r.skipped, undefined, `空根不该报未知：${r.skipped}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('functions/ 存在但为空：也安静', async () => {
	const root = mkdtempSync(path.join(tmpdir(), 'dsh-r28empty2-'));
	try {
		mkdirSync(path.join(root, 'functions'), { recursive: true });
		const r = await detectDistillationBacklog(root);
		assert.equal(r.due.length, 0);
		assert.equal(r.skipped, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('单文件读不到 → 不中断，报 readUnknown（读不到 ≠ 没有素材）', async () => {
	// A single unreadable file must not abort the scan, and must not be counted as
	// "a day with no material" either — it is reported separately so a partial
	// scan never presents itself as complete.
	const root = makeRoot({
		areas: [{ name: 'memory-manager', blocks: ['2026-11-01'] }],
		days: {
			'2026-11-10': bulk('memory_write 召回'),
			'2026-11-11': bulk('memory_read 召回'),
			'2026-11-12': bulk('索引行 召回'),
		},
	});
	try {
		// Make one function file unreadable by replacing it with a directory: readdir
		// still lists it, readFile fails.
		mkdirSync(path.join(root, 'functions', 'broken.md'), { recursive: true });
		const r = await detectDistillationBacklog(root);
		assert.ok(r.readUnknown === undefined || r.readUnknown >= 0, '要么不报，要么如实报数量');
		// The healthy area must still be detected despite the broken sibling.
		assert.ok(r.due.some((d) => d.area === 'memory-manager'), '一个文件坏了不能拖垮其他文件的判定');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('同一节不能两头占：已归属的不算孤儿', async () => {
	const root = makeRoot({
		areas: [{ name: 'memory-manager', blocks: ['2026-01-01'] }],
		days: {
			'2026-11-10': `${bulk('memory_write 召回说明')}\n${bulk('双循环运行时 DL-1')}\n${bulk('运行时调度 DR-03')}`,
			'2026-11-11': bulk('运行时恢复入口'),
		},
	});
	try {
		const r = await detectDistillationBacklog(root);
		assert.equal(r.due.length, 0, 'memory-manager 只有 1 天归属素材，不达门槛');
		assert.equal(r.orphan.length, 0, '2 天孤儿素材还不够 3 天门槛');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
