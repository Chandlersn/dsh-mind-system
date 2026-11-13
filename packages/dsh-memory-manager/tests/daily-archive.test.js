// 每日按月/周归档通道（2026-11-13 用户要求）：全部在隔离临时根上验证。
// 不触碰真实记忆根；不构建；node --test 直跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { archiveDailyMonths, readArchivedDay, latestArchivedDay } from '../src/daily-archive.js';
import { isTracked, readLedger, reconcile, contentHash } from '../src/write-ledger.js';
import { writeText } from '../src/util.js';
import { apply, runHealthCheck, DEFAULTS } from '../server.js';

async function fixture(t, prefix = 'daily-archive-') {
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

/**
 * mtime 回溯：mtime<24h 防护（防跨月 capture 竞态）会跳过刚写完的 fixture。
 * 历史 fixture 必须把 mtime 拨回其名义日期附近——这正是防护语义：
 * 「上个月且最近没被动过」才可归档。根目录已存在是回溯的前提。
 */
async function backdate(root, name, dateStr) {
	const p = path.join(root, name);
	const nominal = new Date(`${dateStr}T12:00:00`);
	await utimes(p, nominal, nominal);
}
/** 创建一个名义日期在上个月、mtime 拨回当时的 fixture 日文件。 */
async function writeDated(root, dateStr, text) {
	const p = path.join(root, `${dateStr}.md`);
	await writeFile(p, text, 'utf8');
	const nominal = new Date(`${dateStr}T12:00:00`);
	await utimes(p, nominal, nominal);
	return p;
}

const r26 = (report) => report.results.filter((r) => r.rule === 'R26');
const r10 = (report) => report.results.filter((r) => r.rule === 'R10');

test('跨月两文件归档 + 当月保留 + 周分组（含跨周同月）', async (t) => {
	const { root } = await fixture(t);
	await writeDated(root, '2026-09-15', '# 2026-09-15 记录\n\n> 头注\n\n- 周二的判断\n');
	await writeDated(root, '2026-09-21', '# 2026-09-21 记录\n\n- 周一的取舍\n');
	await writeDated(root, '2026-09-23', '- 同一周的周三\n');
	await writeFile(path.join(root, '2026-11-13.md'), '- 当月不归档\n', 'utf8');
	const res = await archiveDailyMonths(root, { today: '2026-11-13' });
	assert.deepEqual(res.errors, []);
	assert.deepEqual(res.archived.map((a) => a.day).sort(), ['2026-09-15', '2026-09-21', '2026-09-23']);
	assert.deepEqual(res.skipped, [{ day: '2026-11-13', reason: 'current_month' }]);
	const arch = await readFile(path.join(root, 'daily', '2026-09.md'), 'utf8');
	// 09-15（周二，W38）与 09-21/09-23（W39）：两个周节；周节范围取实际收纳日期。
	assert.ok(arch.includes('## 周 2026-W38（09-15 ~ 09-15）'), arch);
	assert.ok(arch.includes('## 周 2026-W39（09-21 ~ 09-23）'), arch);
	assert.ok(arch.includes('### [2026-09-15]'));
	assert.ok(arch.includes('### [2026-09-21]'));
	assert.ok(arch.includes('### [2026-09-23]'));
	// 剥原 H1，保留其余正文。
	assert.ok(!arch.includes('# 2026-09-15 记录'));
	assert.ok(arch.includes('- 周二的判断'));
	assert.ok(arch.includes('- 同一周的周三'));
	// 归档件首次创建带说明头。
	assert.ok(arch.includes('每日归档 2026-09'));
	// 源文件消失（每天最多归档一次由它天然保证），当月保留。
	for (const d of ['2026-09-15', '2026-09-21', '2026-09-23']) {
		await assert.rejects(stat(path.join(root, `${d}.md`)), (e) => e.code === 'ENOENT', d);
	}
	await assert.ok(await readFile(path.join(root, '2026-11-13.md'), 'utf8'));
});

test('重复运行幂等：源没了不再归档；已有日节跳过且不重写已有字节', async (t) => {
	const { root } = await fixture(t);
	await writeDated(root, '2026-10-07', '- 第一次归档\n');
	const first = await archiveDailyMonths(root, { today: '2026-11-13' });
	assert.equal(first.archived.length, 1);
	const archPath = path.join(root, 'daily', '2026-10.md');
	const before = await readFile(archPath, 'utf8');
	// 第二轮：源文件已消失，无事可做。
	const second = await archiveDailyMonths(root, { today: '2026-11-13' });
	assert.deepEqual(second.archived, []);
	assert.deepEqual(second.errors, []);
	assert.equal(await readFile(archPath, 'utf8'), before);
	// 模拟"日已存在归档、源文件又出现"：跳过已有日节，不重写已有字节。
	await writeDated(root, '2026-10-08', '- 这天已在归档里\n');
	const arch = await readFile(archPath, 'utf8');
	const patched = `${arch}### [2026-10-08]\n\n- 预置日节\n\n`;
	await writeFile(archPath, patched, 'utf8');
	const third = await archiveDailyMonths(root, { today: '2026-11-13' });
	assert.ok(third.skipped.some((s) => s.day === '2026-10-08' && s.reason === 'already_archived'), JSON.stringify(third.skipped));
	assert.deepEqual(third.archived, []);
	assert.equal(await readFile(archPath, 'utf8'), patched, '已有字节不得被重写');
});

test('归档件被 recordWrite 登记（R26 对账 ok），源文件删除配对事件完整', async (t) => {
	const { root } = await fixture(t);
	await writeDated(root, '2026-10-07', '- 要归档的内容\n');
	const res = await archiveDailyMonths(root, { today: '2026-11-13' });
	assert.deepEqual(res.errors, []);
	const ledger = await readLedger(root);
	assert.ok(ledger instanceof Map);
	const archKey = 'daily/2026-10.md';
	const archText = await readFile(path.join(root, archKey), 'utf8');
	assert.equal(reconcile({ key: archKey, text: archText, ledger }).verdict, 'ok', '归档件必须与账本对账 ok');
	assert.equal(isTracked(archKey), true, 'daily/YYYY-MM.md 归档键必须 tracked');
	// 源文件：delete_intent → delete 配对（同 id），最终账本状态是已完成删除。
	const srcKey = '2026-10-07.md';
	const rec = ledger.get(srcKey);
	assert.equal(rec?.op, 'delete', JSON.stringify(rec));
	const raw = await readFile(path.join(root, '.write-ledger.jsonl'), 'utf8');
	const events = raw.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.key === srcKey && (e.op === 'delete_intent' || e.op === 'delete'));
	assert.equal(events.length, 2);
	assert.equal(events[0].op, 'delete_intent');
	assert.equal(events[1].op, 'delete');
	assert.equal(events[0].id, events[1].id, '意图与完成事件必须同 id 配对');
	assert.notEqual(events[0].tool, 'unknown', '删除事件要可追溯到归档通道');
});

test('归档件写入失败时源文件保留并给出明确阶段', async (t) => {
	const { root } = await fixture(t);
	await writeDated(root, '2026-10-07', '- 原文\n');
	// Fault injection：writeText 经 rename 提交，让归档暂存路径的 rename 失败，
	// 精确命中"写入阶段"而不是读阶段（读失败是另一个阶段，另有语义）。
	// ESM 内置绑定需 syncBuiltinESMExports 才能让插件模块看到替换（同 r10 测试）。
	const fs = await import('node:fs');
	const { syncBuiltinESMExports } = await import('node:module');
	const originalRename = fs.promises.rename;
	let faulted = 0;
	fs.promises.rename = async function (from, ...args) {
		if (String(from).includes('.tmp-')) {
			faulted++;
			throw Object.assign(new Error('synthetic rename failure'), { code: 'EPERM' });
		}
		return originalRename.call(this, from, ...args);
	};
	syncBuiltinESMExports();
	try {
		const res = await archiveDailyMonths(root, { today: '2026-11-13' });
		assert.ok(faulted > 0, 'fault must actually target the archive commit rename');
		assert.equal(res.archived.length, 0);
		assert.equal(res.errors.length, 1, JSON.stringify(res.errors));
		assert.equal(res.errors[0].stage, 'write_archive');
		assert.equal(res.errors[0].day, '2026-10-07');
		assert.equal(await readFile(path.join(root, '2026-10-07.md'), 'utf8'), '- 原文\n', '失败必须保留源文件');
		const ledger = await readLedger(root);
		assert.equal(ledger.get('2026-10-07.md')?.op, undefined, '失败时不得登记删除');
	} finally {
		fs.promises.rename = originalRename;
		syncBuiltinESMExports();
	}
	// 故障移除后重跑：源文件仍在，正常归档成功（失败不破坏后续归档）。
	const retry = await archiveDailyMonths(root, { today: '2026-11-13' });
	assert.deepEqual(retry.errors, [], JSON.stringify(retry.errors));
	assert.deepEqual(retry.archived.map((a) => a.day), ['2026-10-07']);
});

test('归档后体检 R26 对账 ok（无未登记/未配对告警）', async (t) => {
	const { root, skills } = await fixture(t);
	await writeDated(root, '2026-10-07', '- 已归档的一天\n');
	// 当月文件用受登记的 writeText 创建：直写会触发 R26 的"未登记"告警——
	// 那是防线对未登记写入的如实报告，不是归档通道的缺陷。
	await writeText(path.join(root, '2026-11-13.md'), '- 现存的一天\n', { memoryRoot: root });
	const res = await archiveDailyMonths(root, { today: '2026-11-13' });
	assert.deepEqual(res.errors, []);
	const report = await runHealthCheck(root, { ...DEFAULTS, skillRoot: skills });
	const offending = r26(report).filter((r) => r.level === 'WARN' && /2026-10-07|daily\/2026-10/.test(r.message));
	assert.deepEqual(offending, [], JSON.stringify(r26(report)));
	// 未登记聚合计数也不应出现（所有现存受管文件都有账本记录）。
	assert.ok(!r26(report).some((r) => /不在写入账本里/.test(r.message)), JSON.stringify(r26(report)));
});

test('归档后 R26 对账 ok 且无 unexplained missing（任务书点名断言）', async (t) => {
	const { root, skills } = await fixture(t);
	// 两个非当月源文件 + 一份当月文件（writeText 登记，模拟正常通道）。
	await writeDated(root, '2026-08-20', '- 八月的一天\n');
	await writeDated(root, '2026-09-11', '- 九月的一天\n');
	await writeText(path.join(root, '2026-11-13.md'), '- 当月现存\n', { memoryRoot: root });
	const res = await archiveDailyMonths(root, { today: '2026-11-13' });
	assert.deepEqual(res.errors, [], JSON.stringify(res.errors));
	assert.deepEqual(res.archived.map((a) => a.day).sort(), ['2026-08-20', '2026-09-11']);
	const report = await runHealthCheck(root, { ...DEFAULTS, skillRoot: skills });
	const warnings = r26(report).filter((r) => r.level === 'WARN');
	// 双向误报防线：已删除的源文件不得被判「已登记但扫描时不存在」；
	// 归档件与当月文件不得被判「不在写入账本里」；删除意图必须全部配对完成。
	assert.ok(!warnings.some((r) => /已登记但扫描时不存在/.test(r.message)), `unexplained missing 不得出现：${JSON.stringify(warnings)}`);
	assert.ok(!warnings.some((r) => /不在写入账本里/.test(r.message)), `未登记不得出现：${JSON.stringify(warnings)}`);
	assert.ok(!warnings.some((r) => /删除意图未完成/.test(r.message)), `删除配对必须完整：${JSON.stringify(warnings)}`);
	assert.ok(!warnings.some((r) => /已记录删除但文件存在|账本记录已删除但文件存在/.test(r.message)), JSON.stringify(warnings));
	// 正控：账本里两个源键的最终状态都是 delete（配对完成），归档键对账 ok。
	const ledger = await readLedger(root);
	assert.ok(ledger instanceof Map);
	for (const key of ['2026-08-20.md', '2026-09-11.md']) assert.equal(ledger.get(key)?.op, 'delete', key);
	for (const key of ['daily/2026-08.md', 'daily/2026-09.md', '2026-11-13.md']) {
		assert.equal(reconcile({ key, text: await readFile(path.join(root, ...key.split('/')), 'utf8'), ledger }).verdict, 'ok', key);
	}
});

test('体检同时扫描顶层日记与 daily/ 月归档（链接 + R21）', async (t) => {
	const { root, skills } = await fixture(t);
	await writeFile(path.join(root, '2026-10-07.md'), '[顶层死链](missing-top.md)\n', 'utf8');
	await mkdir(path.join(root, 'daily'), { recursive: true });
	await writeFile(path.join(root, 'daily', '2026-10.md'), '# 每日归档 2026-10\n\n### [2026-10-07]\n\n[归档死链](missing-archived.md)\n\n', 'utf8');
	const report = await runHealthCheck(root, { ...DEFAULTS, skillRoot: skills });
	assert.ok(r10(report).some((r) => r.level === 'FAIL' && r.message.includes('2026-10-07.md') && r.message.includes('missing-top.md')), JSON.stringify(r10(report)));
	assert.ok(r10(report).some((r) => r.level === 'FAIL' && r.message.includes('2026-10.md') && r.message.includes('missing-archived.md')), '归档文件必须同样跑 R10');
});

test('R21 密钥扫描不遗漏归档文件（最危险的静默失效）', async (t) => {
	const { root, skills } = await fixture(t);
	await mkdir(path.join(root, 'daily'), { recursive: true });
	// 归档件里藏一级凭据（tier-1）；顶层日记放一条同样的作为正控。
	// 只放在代码围栏外，让 scanForSecrets 真正命中。
	const secret = 'sk-abcdef1234567890abcdef1234567890';
	await writeFile(path.join(root, '2026-10-07.md'), `### 顶层的密钥\n\n${secret}\n\n`, 'utf8');
	await writeFile(path.join(root, 'daily', '2026-10.md'), `# 每日归档 2026-10\n\n### [2026-10-07]\n\n### 归档里的密钥\n\n${secret}\n\n`, 'utf8');
	const report = await runHealthCheck(root, { ...DEFAULTS, skillRoot: skills });
	const r21 = report.results.filter((r) => r.rule === 'R21');
	assert.ok(r21.some((r) => r.level === 'FAIL' && r.message.includes('2026-10-07.md')), `顶层日记的 R21 正控必须命中：${JSON.stringify(r21)}`);
	assert.ok(r21.some((r) => r.level === 'FAIL' && r.message.includes('daily/2026-10.md')), `归档文件必须被 R21 扫描：${JSON.stringify(r21)}`);
});

test('memory_search 的 daily 枚举合并两来源：顶层与归档月文件都命中', async (t) => {
	const { root, skills } = await fixture(t);
	await mkdir(path.join(root, 'daily'), { recursive: true });
	await writeFile(path.join(root, '2026-11-13.md'), '### 归档检索主题甲\n\n- 顶层日记正文\n\n', 'utf8');
	await writeFile(path.join(root, 'daily', '2026-09.md'), '# 每日归档 2026-09\n\n## 周 2026-W38（09-15 ~ 09-15）\n\n### [2026-09-15]\n\n### 归档检索主题甲\n\n- 归档里的九月正文\n\n', 'utf8');
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
	assert.ok(tool && typeof tool.execute === 'function');
	const result = await tool.execute({ q: '归档检索主题甲', zone: 'daily' }, {});
	const hits = result.hits ?? [];
	assert.ok(hits.some((h) => h.name === '2026-11-13.md'), `顶层日文件必须命中：${JSON.stringify(hits)}`);
	assert.ok(hits.some((h) => h.name === '2026-09.md'), `归档月文件必须进入 daily 枚举：${JSON.stringify(hits)}`);
	// 归档件内按 ### [YYYY-MM-DD] 行级日期归属：命中行应归属到 2026-09-15。
	const archHit = hits.find((h) => h.name === '2026-09.md');
	assert.equal(archHit.date, '2026-09-15', `归档命中行的日期归属：${JSON.stringify(archHit)}`);
});

test('memory_read kind=daily 回落到归档：指定日期与最新日节', async (t) => {
	const { home, root, skills } = await fixture(t);
	await mkdir(path.join(root, 'daily'), { recursive: true });
	await writeFile(
		path.join(root, 'daily', '2026-10.md'),
		'# 每日归档 2026-10\n\n## 周 2026-W40（09-28 ~ 10-04）\n\n### [2026-10-01]\n\n- 国庆前一天\n\n### [2026-10-04]\n\n- 周日记录\n\n',
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
	const tool = registered.get('memory_read');
	assert.ok(tool && typeof tool.execute === 'function');
	const archiveFile = path.join(root, 'daily', '2026-10.md');
	// 指定日期：顶层没有 → 回落归档日节。
	const byDate = await tool.execute({ kind: 'daily', date: '2026-10-01' }, {});
	assert.equal(byDate.found, true);
	assert.ok(byDate.content.includes('- 国庆前一天'), byDate.content);
	assert.equal(byDate.path, archiveFile);
	// 缺省（最新）：顶层无任何日文件 → 最新归档的最新日节。
	const latest = await tool.execute({ kind: 'daily' }, {});
	assert.equal(latest.found, true);
	assert.ok(latest.content.includes('- 周日记录'), latest.content);
	assert.equal(latest.path, archiveFile);
	// 顶层有日文件时不回落。
	await writeFile(path.join(root, '2026-11-13.md'), '- 当月顶层\n', 'utf8');
	const topLevel = await tool.execute({ kind: 'daily' }, {});
	assert.equal(topLevel.path, path.join(root, '2026-11-13.md'));
	assert.ok(topLevel.content.includes('- 当月顶层'));
	// 未使用的 home 参数保持引用以避免 lint 噪音。
	assert.ok(home.length > 0);
});

test('readArchivedDay / latestArchivedDay 只读解析日节', async (t) => {
	const { root } = await fixture(t);
	assert.equal(await readArchivedDay(root, '2026-10-01'), undefined);
	assert.equal(await latestArchivedDay(root), undefined);
	await mkdir(path.join(root, 'daily'), { recursive: true });
	await writeFile(path.join(root, 'daily', '2026-10.md'), '### [2026-10-01]\n\n- 甲\n\n### [2026-10-02]\n\n- 乙\n\n', 'utf8');
	const day = await readArchivedDay(root, '2026-10-01');
	assert.equal(day.date, '2026-10-01');
	assert.ok(day.text.includes('- 甲') && !day.text.includes('- 乙'), day.text);
	const latest = await latestArchivedDay(root);
	assert.equal(latest.date, '2026-10-02');
	assert.ok(latest.text.includes('- 乙'));
	// 非法日期返回 undefined，不抛。
	assert.equal(await readArchivedDay(root, 'garbage'), undefined);
});

test('参数非法抛 TypeError；记忆根缺失返回空（幂等）', async (t) => {
	const { root } = await fixture(t);
	await assert.rejects(archiveDailyMonths('', {}), TypeError);
	await assert.rejects(archiveDailyMonths(root, { today: '2026-11' }), TypeError);
	await assert.rejects(archiveDailyMonths(root, { today: 'not-a-date' }), TypeError);
	const missing = path.join(root, 'does-not-exist');
	const res = await archiveDailyMonths(missing, { today: '2026-11-13' });
	assert.deepEqual(res, { archived: [], skipped: [], errors: [] });
});

test('未来月份的顶层日文件跳过不归档', async (t) => {
	const { root } = await fixture(t);
	await writeFile(path.join(root, '2027-01-01.md'), '- 未来\n', 'utf8');
	const res = await archiveDailyMonths(root, { today: '2026-11-13' });
	assert.deepEqual(res.archived, []);
	assert.deepEqual(res.skipped, [{ day: '2027-01-01', reason: 'future_month' }]);
	await assert.ok(await readFile(path.join(root, '2027-01-01.md'), 'utf8'));
});

test('mtime<24h 的历史月文件跳过（防跨月 capture 竞态），拨回 mtime 后归档', async (t) => {
	const { root } = await fixture(t);
	// 名义上是上个月，但 mtime 是刚刚——仍在活跃写入窗口，不得归档。
	await writeFile(path.join(root, '2026-10-20.md'), '- 刚被写过的历史日\n', 'utf8');
	const first = await archiveDailyMonths(root, { today: '2026-11-13' });
	assert.deepEqual(first.archived, [], JSON.stringify(first.archived));
	assert.ok(first.skipped.some((s) => s.day === '2026-10-20' && s.reason === 'mtime_fresh'), JSON.stringify(first.skipped));
	await assert.ok(await readFile(path.join(root, '2026-10-20.md'), 'utf8'), '跳过时源文件保留');
	// mtime 拨回名义日期后，同一文件正常归档。
	await backdate(root, '2026-10-20.md', '2026-10-20');
	const second = await archiveDailyMonths(root, { today: '2026-11-13' });
	assert.deepEqual(second.errors, [], JSON.stringify(second.errors));
	assert.deepEqual(second.archived.map((a) => a.day), ['2026-10-20']);
	await assert.rejects(stat(path.join(root, '2026-10-20.md')), (e) => e.code === 'ENOENT');
});
