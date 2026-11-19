/**
 * 归档日线索必须最新在上（2026-11-19，用户要求）。
 *
 * ## 为什么这条值得单独测
 *
 * 归档文件 `daily/YYYY-MM.md` 是**只追加**的：`### [YYYY-MM-DD]` 日节按写入顺序
 * 落盘，所以**文件顺序天然最早在上**。面板原样渲染，于是"最近几天"跑到列表最下面。
 * 用户要求倒过来。
 *
 * ## 为什么测纯函数而不是 HTTP 端点
 *
 * 排序是**数据契约**，不是渲染细节。`memoryPanelApi` 是内部实现（未导出），
 * 为了测它而扩大公开面不值得；`parseArchiveDays` 导出后直接测，既覆盖正则也覆盖
 * 排序，且不依赖宿主路由。
 *
 * ## 两个真实的坑（都有来历）
 *
 * · `\s*` 会吃掉换行，把下一天正文第一行当成标题尾 —— 文件里已有注释记录踩过；
 * · 正文里被引用的 `### [YYYY-MM-DD]` 不能算日节 —— 用 `$` + `m` 标志区分。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { parseArchiveDays } = await import('../server.js');

test('乱序书写也按日期降序输出（最新在上）', () => {
	const text = [
		'# 每日归档 2026-10',
		'### [2026-10-20]', '正文',
		'### [2026-10-28]', '正文',
		'### [2026-10-18]', '正文',
		'### [2026-10-25]', '正文',
	].join('\n');
	const dates = parseArchiveDays(text).map((d) => d.date);
	assert.deepEqual(dates, ['2026-10-28', '2026-10-25', '2026-10-20', '2026-10-18'], `实际 ${dates.join(',')}`);
});

test('不变式：任意相邻两对都是降序（不只是这个例子碰巧对）', () => {
	const text = ['### [2026-03-02]', '### [2026-03-09]', '### [2026-03-01]', '### [2026-03-15]'].join('\n');
	const dates = parseArchiveDays(text).map((d) => d.date);
	assert.ok(dates.every((d, i) => i === 0 || dates[i - 1] >= d), `必须严格降序：${dates.join(',')}`);
});

test('标题文字被保留，排序不吃标题', () => {
	const text = ['### [2026-10-18] 旧的一天', '### [2026-10-28] 新的一天'].join('\n');
	const days = parseArchiveDays(text);
	assert.equal(days[0].date, '2026-10-28');
	assert.equal(days[0].title, '新的一天');
	assert.equal(days[1].title, '旧的一天');
});

test('标题为空时不产生 undefined（面板会把它渲染成字面量）', () => {
	const days = parseArchiveDays('### [2026-10-20]\n正文');
	assert.equal(days[0].title, '', '空标题应是空串，不是 undefined');
});

test('正文里被引用的日标题不算日节（\\s* 跨行与 $ 边界）', () => {
	const text = [
		'# 归档',
		'### [2026-10-20]',
		'',
		'> 引用里写了 ### 但不是标题',
		'',
		'正文提到 `### [YYYY-MM-DD]` 只是说明',
	].join('\n');
	const days = parseArchiveDays(text);
	assert.equal(days.length, 1, `只该有 1 个真实日节，实际 ${JSON.stringify(days)}`);
	assert.equal(days[0].date, '2026-10-20');
});

test('标题后的正文第一行不能被吃进标题（真正的跨行坑）', () => {
	const text = ['### [2026-10-20]', '', '这一行是正文，不是标题的一部分'].join('\n');
	const days = parseArchiveDays(text);
	assert.equal(days[0].title, '', '标题必须是空的');
	assert.ok(!days[0].title.includes('正文'), '正文行不许被当成标题尾巴');
});

test('空输入返回空数组，不抛错', () => {
	assert.deepEqual(parseArchiveDays(''), []);
	assert.deepEqual(parseArchiveDays(null), []);
	assert.deepEqual(parseArchiveDays(undefined), []);
});

test('个位数月份/日期按字典序也正确（ISO 定长因此安全）', () => {
	const text = ['### [2026-09-30]', '### [2026-10-01]', '### [2026-10-09]'].join('\n');
	const dates = parseArchiveDays(text).map((d) => d.date);
	assert.deepEqual(dates, ['2026-10-09', '2026-10-01', '2026-09-30'], '定长 ISO 字符串比较不需要 Date');
});
