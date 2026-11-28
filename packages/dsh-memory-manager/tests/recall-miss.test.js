/**
 * 召回漏判必须可见（2026-11-16）
 *
 * ## 为什么这个文件必须存在
 *
 * 实测 8 条真实查询，索引召回只对了 5 条。更麻烦的是失败形态：三条里有一条
 * 完全不命中、两条**命中了错的条目**——后者比"没命中"更危险，因为它看起来
 * 像有了依据。
 *
 * 原来的注入文本在漏判时**什么都不说**，于是"词法没匹配上"读起来和
 * "记忆里没有这条经验"一模一样。系统的准则里第一层就是"先查再动"，
 * 而一次静默的漏判恰好会让模型跳过这一步。
 *
 * ## 三条断言
 *
 * 1. 真漏判必须报 `miss=true` 并给出未命中的词（可行动）；
 * 2. 正常命中**不能**误报 miss（否则每次注入都挂警告，等于没有警告）；
 * 3. 注入文本里必须真的出现 ⚠ 标记和"这不等于记忆里没有"这句（否则
 *    stats 里算了却没用上，等于没做）。
 *
 * ## 判据为什么是"命中 token 占比"而不是"bestScore==0"
 *
 * 实测：一个纯无关的查询（「完全无关的量子化纤维护理流程」）仍然拿到
 * bestScore=4.8 —— 分词会产出"流程""完全"这类通用碎片，几乎总能命中某行。
 * 用 bestScore==0 判漏判会几乎永不触发。所以判据是**用户词命中的占比 < 50%**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const REPO = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const { tokensOf, matchIndexRows } = await import(new URL('../server.js', import.meta.url).href);
const { buildRecallMessage } = await import(new URL('../src/recall.js', import.meta.url).href);

const INDEX = [
	'## 功能模块索引（functions/）',
	'',
	'| 功能域 | 一句话状态 / 待验证 |',
	'|---|---|',
	'| [dsh插件开发](functions/dsh插件开发.md) | DSH 插件开发：hook 的 inject 语义与 ctx.get 不同；cordis shim 与真机坑。 |',
	'| [memory-manager](functions/memory-manager.md) | 记忆插件：写入溯源账本；写完怎么确认入库。 |',
	'',
].join('\n');

test('命中正常时不报漏判（否则每次注入都挂警告 = 没有警告）', () => {
	const r = matchIndexRows(INDEX, tokensOf('hook 的 inject 语义和 ctx.get 有什么不同'), 3);
	assert.equal(r.stats.miss, false, `不该报 miss：${JSON.stringify(r.stats)}`);
	assert.deepEqual(r.stats.missTokens, [], '没有漏判就不该有 missTokens');
	assert.ok(r.stats.hitTokens.length > 0, '应记录命中的词');
	assert.ok(r.stats.bestScore > 0, '命中时 bestScore 应为正');
});

test('真漏判报 miss=true 并给出未命中的词', () => {
	const r = matchIndexRows(INDEX, tokensOf('火星上的土豆种植技术'), 3);
	assert.equal(r.stats.miss, true, `应报 miss：${JSON.stringify(r.stats)}`);
	assert.ok(r.stats.missTokens.length > 0, '漏判必须点名未命中的词（否则不可行动）');
	// 未命中的词必须真的来自查询。
	const qTokens = [...tokensOf('火星上的土豆种植技术')];
	for (const t of r.stats.missTokens) assert.ok(qTokens.includes(t), `${t} 应来自查询`);
});

test('判据是占比而非 bestScore：通用碎片命中不算命中', () => {
	// 「流程」在索引里存在，但整句问的是别的事——不能因此判成命中。
	const r = matchIndexRows(INDEX, tokensOf('完全无关的量子化纤维护理流程'), 3);
	assert.equal(r.stats.miss, true, '通用碎片命中不足以判为命中');
	assert.ok(r.stats.missTokens.length > r.stats.hitTokens.length, '未命中的词应占多数');
});

test('分词碎片不该制造假漏判（判据按字符覆盖，不按 token 占比）', () => {
	// 2026-11-19: the first criterion counted TOKENS. Chinese tokenizes into
	// bigrams that straddle word boundaries — 面板时间线 → 面板/板时/时间/间线/
	// 线要/要倒/倒序. Fragments like 板时/线要/要倒 exist in no summary and never
	// will; charging the match for them made a fully-matched query report miss.
	// Measured: every real word hit, the row scored well, miss was still true —
	// and a warning that fires on correct matches is worse than no warning.
	const query = 'hook 的 inject 语义和 ctx.get 有什么不同';
	const r = matchIndexRows(INDEX, tokensOf(query), 3, undefined, { queryText: query });
	assert.equal(r.stats.miss, false, `真实词都命中就不该报漏判：${(r.stats.missTokens ?? []).join(',')}`);
	assert.ok(r.stats.charCoverage >= 0.75, `字符覆盖率应达标，实际 ${r.stats.charCoverage}`);
});

test('字符覆盖率把两类查询分开（阈值 0.75 落在实测分布中间）', () => {
	// Should match: 86–100% measured on real queries. Should not: 33–64%.
	// Assert the CONTRAST: a threshold that only separates one side is not a
	// criterion, it is a guess.
	const qHit = 'hook 的 inject 语义';
	const qMiss = '火星上的土豆种植技术';
	const hit = matchIndexRows(INDEX, tokensOf(qHit), 3, undefined, { queryText: qHit });
	const miss = matchIndexRows(INDEX, tokensOf(qMiss), 3, undefined, { queryText: qMiss });
	assert.ok(
		hit.stats.charCoverage > miss.stats.charCoverage,
		`两侧必须可比：${hit.stats.charCoverage} 应大于 ${miss.stats.charCoverage}`,
	);
	assert.equal(miss.stats.miss, true);
	assert.equal(hit.stats.miss, false);
});

test('partial query coverage remains visible with matched or budget-omitted rows', () => {
	const query = 'inject 火星土豆星际航行宇宙辐射探测太阳系';
	const rows = matchIndexRows(INDEX, tokensOf(query), 3, undefined, { queryText: query });
	assert.ok(rows.length > 0 && rows.stats.miss);
	for (const budget of [8192, 800]) {
		const oversized = rows.map(row => ({ ...row, summary: row.summary.repeat(30) }));
		const message = buildRecallMessage(oversized, rows.heldRows, rows.stats, [], { optionalBudgetBytes: budget });
		const text = message.content[0].text;
		assert.match(text, /查询用词覆盖不足/);
		assert.doesNotMatch(text, /召回未命中/);
		if (budget === 800) assert.match(text, /预算或展示上限省略：索引\/修复 [1-9]/);
	}
});

test('注入文本真的带出 ⚠ 标记（算了却没用 = 没做）', () => {
	// buildRecallMessage 是真正组装注入文本的函数；stats 从这里流进文本，
	// 所以直接给它一个 miss 的 stats，看标记有没有出现在结果里。
	const r = matchIndexRows(INDEX, tokensOf('火星上的土豆种植技术'), 3);
	const msg = buildRecallMessage(r, r.heldRows ?? [], r.stats);
	const text = typeof msg === 'string' ? msg : (msg?.content?.[0]?.text ?? '');
	assert.ok(/⚠ 召回未命中/.test(text), `漏判时注入文本必须带 ⚠ 标记，实际：${text.slice(0, 200)}`);
	assert.ok(/这不等于记忆里没有相关经验/.test(text), '必须明确禁止把漏判读成"没有记录"');

	// And a NORMAL hit must not carry the warning, or the marker becomes noise.
	const ok = matchIndexRows(INDEX, tokensOf('hook 的 inject 语义和 ctx.get 有什么不同'), 3);
	const okMsg = buildRecallMessage(ok, ok.heldRows ?? [], ok.stats);
	const okText = typeof okMsg === 'string' ? okMsg : (okMsg?.content?.[0]?.text ?? '');
	assert.ok(!/召回未命中/.test(okText), '正常命中不该挂漏判警告');
});

