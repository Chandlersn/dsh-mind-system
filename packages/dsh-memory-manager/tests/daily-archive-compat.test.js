// 每日归档兼容面（2026-11-13 任务书点名的兼容断言）：
//   1. 归档后 R26 对账 ok 且无 unexplained missing；
//   2. R21 扫到归档文件；
//   3. search 命中归档内容；
//   4. memory_read kind=daily 回落。
// 这四条在 daily-archive.test.js 里已有功能级覆盖；本文件用**另一条链路**
// （真实 server.js 工具注册 + 面板 API /list /file）复核同一批契约，并补
// 守卫与采集键的回归面。全部在隔离临时根上运行，不触碰真实记忆。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { archiveDailyMonths, readArchivedDay } from '../src/daily-archive.js';
import { classifyWrite, WRITE_DENIED } from '../src/write-guard.js';
import { isCaptureKey } from '../src/capture-baseline.js';
import { readLedger, reconcile } from '../src/write-ledger.js';
import { writeText } from '../src/util.js';
import { apply, runHealthCheck, DEFAULTS } from '../server.js';

async function fixture(t, prefix = 'daily-archive-compat-') {
	const home = await mkdtemp(path.join(tmpdir(), prefix));
	const root = path.join(home, 'memory');
	const skills = path.join(home, 'skills');
	await mkdir(root, { recursive: true });
	await mkdir(skills, { recursive: true });
	await writeFile(path.join(root, 'MEMORY.md'), '# 隔离测试索引\n', 'utf8');
	t.after(async () => {
		assert.equal(path.dirname(home), path.resolve(tmpdir()));
		assert.ok(path.basename(home).startsWith(prefix));
		await rm(home, { recursive: true, force: true });
	});
	return { home, root, skills };
}

const r26 = (report) => report.results.filter((r) => r.rule === 'R26');

test('兼容面①：归档后 R26 对账 ok 且无 unexplained missing', async (t) => {
	const { root, skills } = await fixture(t);
	const p = path.join(root, '2026-07-30.md');
	await writeFile(p, '# 2026-07-30 记录\n\n- 七月末的一天\n', 'utf8');
	const nominal = new Date('2026-07-30T12:00:00');
	await utimes(p, nominal, nominal);
	await writeText(path.join(root, '2026-11-13.md'), '- 当月现存\n', { memoryRoot: root });
	const res = await archiveDailyMonths(root, { today: '2026-11-13' });
	assert.deepEqual(res.errors, [], JSON.stringify(res.errors));
	const report = await runHealthCheck(root, { ...DEFAULTS, skillRoot: skills });
	const warns = r26(report).filter((r) => r.level === 'WARN');
	assert.ok(!warns.some((r) => /已登记但扫描时不存在/.test(r.message)), `unexplained missing 不得出现：${JSON.stringify(warns)}`);
	assert.ok(!warns.some((r) => /不在写入账本里/.test(r.message)), `未登记不得出现：${JSON.stringify(warns)}`);
	const ledger = await readLedger(root);
	assert.equal(reconcile({ key: 'daily/2026-07.md', text: await readFile(path.join(root, 'daily', '2026-07.md'), 'utf8'), ledger }).verdict, 'ok');
	assert.equal(ledger.get('2026-07-30.md')?.op, 'delete');
});

test('兼容面②：R21 扫到归档文件里的凭据（tier-1 FAIL）', async (t) => {
	const { root, skills } = await fixture(t);
	await mkdir(path.join(root, 'daily'), { recursive: true });
	const secret = 'ghp_' + 'a'.repeat(36);
	await writeFile(path.join(root, 'daily', '2026-06.md'), `# 每日归档 2026-06\n\n### [2026-06-30]\n\n凭据示例：${secret}\n\n`, 'utf8');
	const report = await runHealthCheck(root, { ...DEFAULTS, skillRoot: skills });
	const r21 = report.results.filter((r) => r.rule === 'R21');
	assert.ok(r21.some((r) => r.level === 'FAIL' && r.message.includes('daily/2026-06.md')), `归档文件必须被 R21 扫描：${JSON.stringify(r21)}`);
});

test('兼容面③：search 命中归档内容且日期归属 ### [YYYY-MM-DD]', async (t) => {
	const { root, skills } = await fixture(t);
	await mkdir(path.join(root, 'daily'), { recursive: true });
	await writeFile(
		path.join(root, 'daily', '2026-05.md'),
		'# 每日归档 2026-05\n\n## 周 2026-W23（06-01 ~ 06-07）\n\n### [2026-06-05]\n\n- 归档兼容面独有词丙\n\n',
		'utf8',
	);
	const registered = new Map();
	const noop = () => {};
	const ctx = {
		tools: { register: (def) => { registered.set(def.name, def); return noop; } },
		on: () => noop,
		inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
		systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
	};
	const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR });
	t.after(() => dispose?.());
	const tool = registered.get('memory_search');
	const result = await tool.execute({ q: '归档兼容面独有词丙', zone: 'all' }, {});
	const hit = (result.hits ?? []).find((h) => h.name === '2026-05.md' && h.date === '2026-06-05');
	assert.ok(hit, `归档日节内容必须被全库检索命中并归属到日节日期：${JSON.stringify(result.hits)}`);
	assert.equal(hit.date, '2026-06-05', `日期归属：${JSON.stringify(hit)}`);
	// 时间边界过滤吃日节归属：after 在该日之后 → 该日节行被排除。
	// （归档件头部行属于"未知日期放行"口径，按 mtime 归属——那是文档化的
	// 既有行为，不在本断言的管辖范围。）
	const excluded = await tool.execute({ q: '归档兼容面独有词丙', zone: 'all', after: '2026-06-06' }, {});
	assert.ok(!excluded.hits.some((h) => h.name === '2026-05.md' && h.date === '2026-06-05'), '时间过滤必须作用于归档日节归属');
});

test('兼容面④：memory_read kind=daily 顶层读不到时回落月归档', async (t) => {
	const { root, skills } = await fixture(t);
	await mkdir(path.join(root, 'daily'), { recursive: true });
	await writeFile(path.join(root, 'daily', '2026-04.md'), '# 每日归档 2026-04\n\n### [2026-04-01]\n\n- 四月的兼容面记录\n\n', 'utf8');
	const registered = new Map();
	const noop = () => {};
	const ctx = {
		tools: { register: (def) => { registered.set(def.name, def); return noop; } },
		on: () => noop,
		inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
		systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
	};
	const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR });
	t.after(() => dispose?.());
	const tool = registered.get('memory_read');
	const read = await tool.execute({ kind: 'daily', date: '2026-04-01' }, {});
	assert.equal(read.found, true);
	assert.ok(read.content.includes('- 四月的兼容面记录'), read.content);
	assert.equal(read.path, path.join(root, 'daily', '2026-04.md'));
	const parsed = await readArchivedDay(root, '2026-04-01');
	assert.ok(parsed?.text.includes('- 四月的兼容面记录'));
});

test('write-guard：daily/YYYY-MM.md 放行（顶层日期文件放行不回退），其他 daily/ 名仍拒', () => {
	const root = path.resolve('memory-root');
	for (const file of ['daily/2026-10.md', 'daily/1999-12.md']) {
		assert.equal(classifyWrite(root, path.join(root, ...file.split('/'))).block, false, file);
	}
	// 2026-11-13 已放行的顶层日期文件不得回退。
	assert.equal(classifyWrite(root, path.join(root, '2026-11-13.md')).block, false, '顶层日期文件');
	// daily/ 下其他名字一律仍拒（层目录语义不变）。
	for (const file of ['daily/legacy.md', 'daily/notes.txt', 'daily/2026-13.md', 'daily/sub/2026-10.md', 'daily/2026-10-05.md']) {
		assert.equal(classifyWrite(root, path.join(root, ...file.split('/'))).block, true, file);
	}
});

test('capture-baseline：daily/YYYY-MM.md 键放行且与 isTracked 对齐', () => {
	for (const key of ['daily/2026-10.md', 'daily/2026-01.md', 'daily/2026-12.md']) assert.equal(isCaptureKey(key), true, key);
	for (const key of ['daily/2026-13.md', 'daily/2026-00.md', 'daily/2026-1.md', 'daily/2026-10-05.md', 'daily/notes.md', 'functions/x.md']) assert.equal(isCaptureKey(key), false, key);
});

test('账本可追溯：归档写入 tool=daily-archive，删除事件带 to 指向归档位置', async (t) => {
	const { root } = await fixture(t, 'daily-archive-ledger-');
	const p = path.join(root, '2026-03-02.md');
	await writeFile(p, '# 2026-03-02 记录\n\n- 三月的一天\n', 'utf8');
	const { utimes } = await import('node:fs/promises');
	const nominal = new Date('2026-03-02T12:00:00');
	await utimes(p, nominal, nominal);
	const res = await archiveDailyMonths(root, { today: '2026-11-13' });
	assert.deepEqual(res.errors, [], JSON.stringify(res.errors));
	const raw = await readFile(path.join(root, '.write-ledger.jsonl'), 'utf8');
	const events = raw.trim().split('\n').map((l) => JSON.parse(l));
	// 归档件写入事件：tool=daily-archive（经 writeText { tool } 透传）。
	const archWrite = events.filter((e) => e.key === 'daily/2026-03.md' && e.op === undefined);
	assert.ok(archWrite.length >= 1 && archWrite.every((e) => e.tool === 'daily-archive'), JSON.stringify(archWrite));
	// 删除配对：intent 与 delete 都带 to='daily/2026-03.md'（真身
	// deleteTrackedFile 语义，与 memory_rename 的源删除一致）。
	const delEvents = events.filter((e) => e.key === '2026-03-02.md' && (e.op === 'delete_intent' || e.op === 'delete'));
	assert.equal(delEvents.length, 2, JSON.stringify(delEvents));
	assert.ok(delEvents.every((e) => e.to === 'daily/2026-03.md'), `删除事件必须带 to：${JSON.stringify(delEvents)}`);
	assert.equal(delEvents[0].op, 'delete_intent');
	assert.equal(delEvents[1].op, 'delete');
	assert.equal(delEvents[0].id, delEvents[1].id);
});
