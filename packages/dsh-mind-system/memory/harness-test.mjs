/**
 * Functional harness for dsh-memory-manager (server.js).
 * Loads the real plugin entry, captures the registered tool definitions with a
 * fake ctx, and exercises write/index/insight/fold/rename/check/resolve/
 * supersede/recall against a temp memory root.
 *
 * Data-flow contract (layered): the daily log is the RAW layer (free-form, the
 * model maintains it), memory_write distills functions/ blocks only,
 * memory_index is the sole index writer, insights sit between, and the check
 * lints everything.
 *
 * The Host installation must be discoverable (see resolveDshRoot): set
 * DSH_INSTALL_DIR when the harness install is not the process's own ancestor.
 */
import { mkdir, mkdtemp, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 宿主缺席时**跳过**而不是失败：本脚本验证的是"与真宿主协作"，没有宿主就
// 没有可验证的对象。CI 要求必须有宿主时设 DSH_REQUIRE_HOST=1（缺席即失败）。
const { resolveDshRoot } = await import(new URL('./src/host.js', import.meta.url).href);
try {
	resolveDshRoot(process.env.DSH_INSTALL_DIR);
} catch (error) {
	console.log(`SKIP: 找不到 DSH 宿主安装 —— ${error.message}`);
	console.log('      真跑：DSH_INSTALL_DIR=<宿主目录>；要它成为硬失败：DSH_REQUIRE_HOST=1。');
	process.exit(process.env.DSH_REQUIRE_HOST === '1' ? 1 : 0);
}

const mod = await import(new URL('./server.js', import.meta.url).href);
console.log('exports:', Object.keys(mod).join(','), '| inject:', mod.inject.join(','));

const registered = [];
const noop = () => {};
const fakeCtx = {
	tools: { register: (d) => (registered.push(d), noop) },
	on: (name, listener) => {
		if (name === 'agent/pre-step') globalThis.__preStepListener = listener;
		return noop;
	},
	inject: (names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
	systemPrompt: {
		getSectionOrder: () => 2900,
		section: (s) => (registered.push({ __section: s }), noop),
	},
};
mod.apply(fakeCtx, { dshRoot: process.env.DSH_INSTALL_DIR });
const section = registered.find((r) => r.__section)?.__section;
console.log('section:', section?.name, '| bytes:', section?.text.length, '| mentions fold:', section.text.includes('memory_fold'));

const root = await mkdtemp(path.join(tmpdir(), 'dsh-memfo-'));
// Skills now live in the host catalog; tests MUST NOT touch the real one.
const skillRoot = await mkdtemp(path.join(tmpdir(), 'dsh-skills-'));
const exec = {};
const statExists = async (p) => { try { await (await import('node:fs/promises')).stat(p); return true; } catch { return false; } };
// Second apply with an explicit root: this instance's tools and pre-step
// listener both read the temp index. registered now holds BOTH applies' tool
// definitions (same names), so keep only the LAST registration per name —
// the second apply's. Name-keyed dedupe (not a slice with a hardcoded count)
// so adding a tool never silently shifts the window.
// `newFeatureGraceDays: 0` disables the cold-memory grace window so the
// temperature rule can be asserted deterministically (see 11d for the grace).
const disposer2 = mod.apply(fakeCtx, { memoryRoot: root, skillRoot, newFeatureGraceDays: 0  });
const tools2 = Object.fromEntries(
	registered.filter((r) => r?.name && r.execute).map((t) => [t.name, t]),
);
const T = tools2;
const disposer = noop;
let failures = 0;
const ok = (cond, label) => {
	console.log(cond ? `  PASS ${label}` : `  FAIL ${label}`);
	if (!cond) failures++;
};

// Index rows carry their link in the NAME cell since 5.15.0, so these helpers
// match either shape and the suite never has to know which generation wrote it.
const rowOf = (name) => name; // first cell text, resolved by firstCellOf below
const firstCellOf = (row) => {
	const first = String(row).trim().replace(/^\|/, '').split('|')[0].trim();
	const m = /^\[([^\]]+)\]\([^)]*\)$/.exec(first);
	return m ? m[1] : first;
};
const rowsFor = (text, name) => String(text ?? '').split('\n').filter((l) => l.trim().startsWith('|') && firstCellOf(l) === name);

// 1) empty root -> check reports FAIL R0
const c0 = await T.memory_check.execute({}, exec);
ok(c0.failCount === 1 && c0.results[0].rule === 'R0', `check on empty root: ${c0.results[0]?.rule}`);

// 2) first write -> creates the function file only (index + daily are separate
// layers now; the raw daily log is the model's to maintain)
const w1 = await T.memory_write.execute(
	{ feature: '测试功能', title: '第一次迭代', summary: '验证插件写入闭环', currentState: '初始状态', change: '写入测试', verification: '本测试', result: 'done', open: '待验证遗留项' },
	exec,
);
ok(w1.createdFunctionFile === true, 'write creates function file');
ok(w1.warnings.length === 0, `no warnings (${w1.warnings.join('; ')})`);
ok(w1.indexFile === undefined && w1.dailyFile === undefined, 'write touches neither index nor daily log');
const today = w1.appendedHeading.match(/\[(\d{4}-\d{2}-\d{2})/)[1];
const fn1 = await readFile(w1.featureFile, 'utf8');
ok(fn1.includes('- **概括**：验证插件写入闭环'), 'block carries the summary as 概括');

// 3) index does NOT auto-sync; the file doesn't even exist until memory_index
let idx = await T.memory_read.execute({ kind: 'index' }, exec);
ok(!idx.found && rowsFor(idx.content, '测试功能').length === 0, 'index row absent until memory_index');
const ix1 = await T.memory_index.execute(
	{ zone: 'functions', name: '测试功能', summary: '验证插件写入闭环的测试功能' },
	exec,
);
ok(ix1.created === true, 'memory_index creates the row');
idx = await T.memory_read.execute({ kind: 'index' }, exec);
ok(idx.found && idx.content.includes('| [测试功能](functions/测试功能.md) |'), 'index row present with a clickable name cell');
const ix2 = await T.memory_index.execute(
	{ zone: 'functions', name: '测试功能', summary: '更新后的功能一句话' },
	exec,
);
ok(ix2.created === false, 'memory_index upserts (created=false on update)');

// 3b) memory_search: ranked retrieval over the whole root (bodies, not just
// index summaries). A rare token must win over a token every row shares.
await T.memory_write.execute(
	{ feature: '检索目标', title: '逐帧渲染静默失败的三类事故', summary: '检索测试素材', change: '写一段只有这里才有的稀有词：逐帧渲染。', result: 'done' },
	exec,
);
const s1 = await T.memory_search.execute({ q: '逐帧' }, exec);
ok(s1.count >= 1 && s1.hits[0].name === '检索目标.md', `search finds the rare token (${s1.hits[0]?.name})`);
ok(s1.hits.every((h) => ['zone', 'name', 'line', 'heading', 'snippet'].every((k) => k in h)), 'search hits carry zone/name/line/heading/snippet');
ok(s1.hits[0].line > 0 && s1.hits[0].snippet.includes('逐帧'), 'search hit carries line number + snippet');
const s2 = await T.memory_search.execute({ q: '逐帧', zone: 'insights' }, exec);
ok(s2.count === 0, 'search honours the zone filter');
const s3 = await T.memory_search.execute({ q: '完全不存在的词条xyzzy' }, exec);
ok(s3.count === 0, 'search returns empty for a miss');
let searchThrew = false;
try {
	await T.memory_search.execute({ q: 'x' }, exec);
} catch {
	searchThrew = true;
}
ok(searchThrew, 'search rejects a query shorter than 2 chars');
// CRLF regression: a daily log written by another tool carries \r, and `.` does
// not match \r — a naive `^#{1,3}\s+(.+)$` leaves every hit heading-less.
const crlfDay = path.join(root, '1999-01-01.md');
await writeFile(crlfDay, '# 1999-01-01 记录\r\n\r\n## 今日线索\r\n\r\n- 冷启动 关键字只在换行风格异常的文件里\r\n', 'utf8');
const s4 = await T.memory_search.execute({ q: '冷启动' }, exec);
ok(s4.count >= 1 && s4.hits[0].heading === '今日线索', `search survives CRLF input (heading=${JSON.stringify(s4.hits[0]?.heading)})`);
await rm(crlfDay, { force: true });

// 3g) Temporal bounds (Hindsight borrow): every hit carries its attributed date
// (iteration block tag → file head 截至 → filename → mtime), and after/before
// (inclusive) filter by it. An invalid or inverted bound FAILS LOUD — a
// silently-wrong filter is worse than none.
{
	await T.memory_write.execute(
		{ feature: '时序检索', title: '三月旧事', summary: 's', change: '时序锚点只在旧块出现', date: '2026-03-01', result: 'done' },
		exec,
	);
	await T.memory_write.execute(
		{ feature: '时序检索', title: '十月新篇', summary: 's2', change: '时序锚点只在新块出现', date: '2026-10-05', result: 'done' },
		exec,
	);
	const allT = await T.memory_search.execute({ q: '时序锚点' }, exec);
	ok(allT.count >= 2 && allT.hits.every((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.date ?? '')), `every hit resolves an attribution date (${JSON.stringify(allT.hits.map((h) => h.date))})`);
	const oldHit = (h) => h.snippet.includes('旧块');
	const newHit = (h) => h.snippet.includes('新块');
	const onlyNew = await T.memory_search.execute({ q: '时序锚点', after: '2026-09-01' }, exec);
	ok(onlyNew.hits.some(newHit) && !onlyNew.hits.some(oldHit), 'after excludes the older block');
	ok(onlyNew.hits.find(newHit)?.date === '2026-10-05', 'the kept block reports its own tag date');
	const onlyOld = await T.memory_search.execute({ q: '时序锚点', before: '2026-04-01' }, exec);
	ok(onlyOld.hits.some(oldHit) && !onlyOld.hits.some(newHit), 'before excludes the newer block');
	const window = await T.memory_search.execute({ q: '时序锚点', after: '2026-10-01', before: '2026-10-31' }, exec);
	ok(window.hits.some(newHit) && !window.hits.some(oldHit), 'after+before bound a range');
	let boundThrew = 0;
	for (const bad of [{ q: '时间线词', after: '2026-13-99' }, { q: '时间线词', before: '上个月' }, { q: '时间线词', after: '2026-06-01', before: '2026-01-01' }]) {
		try {
			await T.memory_search.execute(bad, exec);
		} catch {
			boundThrew++;
		}
	}
	ok(boundThrew === 3, `invalid/inverted bounds fail loud (threw=${boundThrew}/3)`);
}
// Ranking: a token shared by most rows must not beat a rare token. With 5 rows
// where 4 share 「记忆/面板」 and 1 owns 「逐帧/渲染」, IDF gives the rare row
// roughly twice the weight per token, so it must rank first — and the common
// row must still survive the 40%-of-best threshold.
const rankIndex = [
	'| 甲域 | 记忆 面板 是通用词 | [functions/甲域.md](functions/甲域.md) |',
	'| 乙域 | 记忆 面板 也是通用词 | [functions/乙域.md](functions/乙域.md) |',
	'| 丙域 | 记忆 面板 还是通用词 | [functions/丙域.md](functions/丙域.md) |',
	'| 丁域 | 记忆 面板 一样通用词 | [functions/丁域.md](functions/丁域.md) |',
	'| 戊域 | 逐帧 渲染 稀有词 | [functions/戊域.md](functions/戊域.md) |',
].join('\n');
const ranked = mod.matchIndexRows(rankIndex, mod.tokensOf('记忆 面板 逐帧 渲染'));
ok(ranked[0]?.name === '戊域', `IDF ranking prefers the rare-token row (${ranked[0]?.name})`);
// 三档设计：强档注入、擦边档列名可见（不带内容）、丢弃档只计数。
// 断言"通用词行进了擦边档"而非"被注入"——这才是新判据的意图。
ok(
	ranked.heldRows.some((h) => h.name === '甲域') && ranked.stats.held >= 1,
	`擦边档保留可见的通用词行，不带内容 (held=${ranked.stats?.held})`,
);
ok(ranked.stats.injected >= 1 && ranked.stats.matched >= ranked.stats.injected, '双侧统计：matched ≥ injected，且强档至少一条');

// 3c) Decision-repair (MemOS borrow ④): the recent-correction signal that only
// fed R18's circuit breaker now also decides what gets force-recalled NEXT step.
// Pure function first — thresholds are the contract.
const repItems = [
	{ href: 'functions/常错域.md', corrections: 4, uses: 6, badRate: 0.67 },
	{ href: 'functions/偶错域.md', corrections: 1, uses: 10, badRate: 0.09 },
	{ href: 'functions/干净域.md', corrections: 0, uses: 12, badRate: 0 },
];
const repTargets = mod.decisionRepairTargets(repItems);
ok(repTargets.length === 1 && repTargets[0].href === 'functions/常错域.md', `decision-repair picks the repeatedly-corrected area (${repTargets.length})`);
ok(!repTargets.some((r) => r.href === 'functions/偶错域.md'), 'decision-repair ignores a single correction');
// The repair row must be visibly marked in the injected message, otherwise the
// model cannot tell a forced recall from a topical hit.
const repairMsg = mod.buildRecallMessage([
	{ name: '常错域', summary: '反复判错的地方', href: 'functions/常错域.md', zone: 'function', repair: { corrections: 4, badRate: 0.67 } },
]).content[0].text;
ok(repairMsg.includes('决策修复') && repairMsg.includes('纠正 4 次'), 'repair row is marked with its correction count');
ok(repairMsg.includes('未被打断'), 'repair note says the current step was not interrupted');
// 3d) Recall budget (MemOS borrow ⑤): every non-empty turn attempts a recall,
// but under an absolute foreground budget. Config may shorten, never extend.
ok(mod.DEFAULTS.recallTimeoutMs === 3000, `recall budget default is 3s (${mod.DEFAULTS.recallTimeoutMs})`);
ok(mod.resolveRecallBudget(undefined) === 3000, 'missing config -> default budget');
ok(mod.resolveRecallBudget(60_000) === 3000, 'config cannot EXTEND the budget past the ceiling');
ok(mod.resolveRecallBudget(200) === 200, 'config can shorten the budget');
ok(mod.resolveRecallBudget(-5) === 0, 'negative budget clamps to 0 (still bounded)');

// 3e) Passive capture (MemOS borrow ⑥): OFF by default — the raw layer belongs
// to the model, so blind logging of every turn must be opt-in. Pure function
// first: truncation + exact-duplicate guard + the off switch.
ok(mod.DEFAULTS.captureUserTurns === false, 'passive capture is OFF by default (privacy/noise)');
ok(mod.captureLineFor('记一下', '', { enabled: false }) === null, 'disabled capture records nothing');
ok(mod.captureLineFor('  a   b  ', '', { enabled: true }) === '- a b', 'whitespace is normalized in the captured line');
const truncated = mod.captureLineFor('x'.repeat(400), '', { enabled: true, maxChars: 160 });
ok(truncated === `- ${'x'.repeat(160)}…`, `long turns are truncated (len=${truncated?.length})`);
ok(mod.captureLineFor('同一条请求', '- 同一条请求', { enabled: true }) === null, 'an exact repeat is not appended twice');
ok(mod.captureLineFor('', '', { enabled: true }) === null, 'empty turns are not captured');

// indexRowsOf turns an href into a recallable row (used by the repair hook).
const idxRows = mod.indexRowsOf('| 甲域 | 摘要甲 | [functions/甲域.md](functions/甲域.md) |');
ok(idxRows.some((r) => r.href === 'functions/甲域.md' && r.zone === 'function'), 'indexRowsOf lists index rows by href');
// rank, so a topically-relevant row that is also heavily used outranks one that
// is merely relevant. Without a usage map the behavior must stay lexical.
const fusionIndex = [
	'| 冷门域 | 逐帧 渲染 稀有词 | [functions/冷门域.md](functions/冷门域.md) |',
	'| 热门域 | 逐帧 渲染 也稀有 | [functions/热门域.md](functions/热门域.md) |',
].join('\n');
const noUsage = mod.matchIndexRows(fusionIndex, mod.tokensOf('逐帧 渲染'), 3);
ok(noUsage.length === 2, `no usage map -> pure lexical ranking (${noUsage.length} rows)`);
const usageMap = new Map([['functions/热门域.md', { uses: 20, positives: 3, badRate: 0 }]]);
const fused = mod.matchIndexRows(fusionIndex, mod.tokensOf('逐帧 渲染'), 3, usageMap);
ok(fused[0]?.href === 'functions/热门域.md', `usage fusion promotes the heavily-used row (${fused[0]?.href})`);
// A row that keeps getting corrected is demoted even when used often (R18's raw
// material, now feeding ranking instead of only the circuit breaker).
const badUsage = new Map([
	['functions/热门域.md', { uses: 20, positives: 0, badRate: 0.8 }],
	['functions/冷门域.md', { uses: 10, positives: 2, badRate: 0 }],
]);
const demoted = mod.matchIndexRows(fusionIndex, mod.tokensOf('逐帧 渲染'), 3, badUsage);
ok(demoted[0]?.href === 'functions/冷门域.md', `high correction rate demotes a hot row (${demoted[0]?.href})`);
// SELF-REFERENCE FIX (2026-10-27): recall exposure is NOT use. A row pushed at
// the model 150 times without a single engagement must not outrank one that was
// actually read — otherwise the plugin's own injections manufacture the
// popularity that decides what it injects next (the loop that grew the insight
// layer to 26 entries with 13 of them invisible).
const exposureOnly = new Map([
	['functions/冷门域.md', { uses: 0, exposure: 150, positives: 0, badRate: 0 }],
	['functions/热门域.md', { uses: 4, exposure: 4, positives: 1, badRate: 0 }],
]);
const exposureRanked = mod.matchIndexRows(fusionIndex, mod.tokensOf('逐帧 渲染'), 3, exposureOnly);
ok(exposureRanked[0]?.href === 'functions/热门域.md', `engagement beats pure recall exposure (${exposureRanked[0]?.href})`);
// The usage signal is a TIE-BREAKER, never a second opinion: with a decisive
// lexical gap, the more-engaged row must not displace the better match.
// NOTE the fixture must produce an ACTUAL lexical gap — two rows that both match
// every query token score identically, and breaking that tie by usage is exactly
// what the fusion is FOR. The gap here comes from name tokens: 「精确域」matches
// 逐帧/渲染 in both cells, 「沾边域」matches only in its summary.
const wideIndex = [
	'| 逐帧渲染域 | 逐帧 渲染 | [functions/逐帧渲染域.md](functions/逐帧渲染域.md) |',
	'| 沾边域 | 逐帧 渲染 之外还有一大堆无关词 面板 记忆 索引 折叠 迁移 | [functions/沾边域.md](functions/沾边域.md) |',
].join('\n');
const decisive = new Map([['functions/沾边域.md', { uses: 99, exposure: 99, positives: 10, badRate: 0 }]]);
const decisiveRanked = mod.matchIndexRows(wideIndex, mod.tokensOf('逐帧 渲染'), 3, decisive);
ok(decisiveRanked[0]?.href === 'functions/逐帧渲染域.md', `a decisive lexical match survives the usage tie-breaker (${decisiveRanked[0]?.href})`);

// 3f) Insight trust (Hindsight borrow): a principle is a belief that carries
// proof counts, computed from the SAME usage evidence the panel and R18 use —
// never declared by hand. Levels and the 动摇 boundary are the contract.
ok(mod.insightTrust({}).level === '待验证', 'no evidence -> 待验证');
ok(mod.insightTrust({ positives: 1, corrections: 0 }).level === '已验证', 'one confirmation -> 已验证');
ok(mod.insightTrust({ positives: 3, corrections: 0 }).level === '稳固', 'three confirmations -> 稳固');
ok(mod.insightTrust({ positives: 2, corrections: 1 }).level === '已验证', 'corrections below positives stay 已验证');
ok(mod.insightTrust({ positives: 1, corrections: 1 }).level === '动摇', 'corrections REACHED positives -> 动摇');
ok(mod.insightTrust({ positives: 0, corrections: 3 }).level === '待验证', 'corrections with zero positives is 待验证 not 动摇');
// matchIndexRows attaches the computed trust to insight rows only, and
// buildRecallMessage marks a shaken one — the recall line can never disagree
// with the file head because both call insightTrust.
const trustIndex = [
	'| 已验证思想 | 逐帧 渲染 的原则 | [insights/甲.md](insights/甲.md) |',
	'| 被动摇思想 | 逐帧 渲染 的旧原则 | [insights/乙.md](insights/乙.md) |',
].join('\n');
const trustUsage = new Map([
	['insights/甲.md', { uses: 5, positives: 4, corrections: 0, badRate: 0 }],
	['insights/乙.md', { uses: 5, positives: 1, corrections: 2, badRate: 0.3 }],
]);
const trustRows = mod.matchIndexRows(trustIndex, mod.tokensOf('逐帧 渲染'), 3, trustUsage);
ok(trustRows.find((r) => r.href === 'insights/甲.md')?.trust?.level === '稳固', 'insight row carries its computed trust');
ok(trustRows.find((r) => r.href === 'insights/乙.md')?.trust?.level === '动摇', 'shaken insight computed from the same signal');
const trustMsg = mod.buildRecallMessage(trustRows).content[0].text;
ok(trustMsg.includes('信任动摇') && trustMsg.includes('认可 1 · 纠正 2'), 'a shaken principle is marked in the recall');
ok(mod.matchIndexRows(trustIndex, mod.tokensOf('逐帧 渲染'), 3).find((r) => r.href === 'insights/甲.md')?.trust?.level === '待验证', 'insight recall without usage map still computes (待验证)');

// 4) second write same day -> 补 suffix
const w2 = await T.memory_write.execute(
	{ feature: '测试功能', title: '第二次迭代', summary: '同日第二块加补后缀', currentState: '两块后仍稳定', result: 'pending' },
	exec,
);
ok(w2.appendedHeading.includes('补'), `补 suffix: ${w2.appendedHeading}`);

// 5) insight with valid source
const i1 = await T.memory_insight.execute(
	{ theme: '闭环验证', principle: '测试原则', summary: '测试内涵', sources: ['测试功能'], open: '待验证点' },
	exec,
);
ok(i1.linkedSources.length === 1 && i1.skippedSources.length === 0, `insight backlink: ${i1.linkedSources.join(',')}`);
ok(i1.indexBytes === undefined && i1.dailyFile === undefined, 'insight touches neither index nor daily log');
// Contract: the output schema must not require what execute no longer returns —
// the 5.10 data-flow flip dropped indexBytes from the return but the schema kept
// it required, so the HOST rejected every memory_insight result even though the
// insight file was written ("missing required property value.indexBytes").
ok(!('indexBytes' in (T.memory_insight.output?.schema?.properties ?? {})), 'memory_insight schema does not require indexBytes');

// 5b) related: existing = bare sibling link; missing = plain text
const w3 = await T.memory_write.execute(
	{ feature: '测试功能', title: '相关链接写法验证', summary: 'related 链接必须是裸文件名', related: ['测试功能'], result: 'done' },
	exec,
);
const fn3 = await readFile(w3.featureFile, 'utf8');
ok(fn3.includes('相关：[测试功能.md](测试功能.md)') || fn3.includes('相关：（无）'), 'self-related filtered');
const w4 = await T.memory_write.execute(
	{ feature: '测试功能', title: '未建档相关渲染', summary: '不存在的 related 渲染为纯文本', related: ['另一功能'], result: 'done' },
	exec,
);
const fn4 = await readFile(w4.featureFile, 'utf8');
ok(fn4.includes('另一功能（未建档）'), 'missing related renders as plain text');
ok(!fn4.includes('](另一功能.md)'), 'no dangling href for missing related');

// 6) resolve: second feature with an open item, then resolve it. The raw daily
// layer is free-form — simulate the model recording an open item itself.
await T.memory_write.execute(
	{ feature: '遗留功能', title: '引入遗留', summary: '有遗留项的功能', result: 'pending' },
	exec,
);
const dailyPath0 = path.join(root, `${today}.md`);
await writeFile(dailyPath0, `# ${today} 记录\n\n- 遗留功能有个开放风险 → [functions/遗留功能.md](functions/遗留功能.md)\n`, 'utf8');
const w5 = await T.memory_write.execute(
	{ feature: '测试功能', title: '解决遗留项', summary: '勾掉遗留功能的待观察', resolve: '遗留功能', result: 'done' },
	exec,
);
const d1 = await T.memory_read.execute({ kind: 'daily' }, exec);
ok(d1.content.includes('✅') && d1.content.includes('functions/遗留功能.md'), `resolve stamps the open item (logs: ${w5.resolvedDailyLogs.join(',')})`);
ok(!d1.content.includes('已解决 → ['), 'bare ✅ stamp, no second pointer');

// 7) supersede: new insight replaces the old one
const i2 = await T.memory_insight.execute(
	{ theme: '闭环验证2', principle: '更好的测试原则', summary: '取代旧原则', sources: ['测试功能'], supersedes: '闭环验证' },
	exec,
);
ok(i2.supersededFile && i2.supersededFile.includes('闭环验证'), 'supersede stamped old file');
const oldInsight = await T.memory_read.execute({ kind: 'insight', name: '闭环验证' }, exec);
ok(oldInsight.content.includes('已被取代') && oldInsight.content.includes('闭环验证2'), 'old insight stamped with successor link');

// 7b) updating an insight must refresh its applicability too, and the result
// must never carry an `undefined` property (the Host rejects non-lossless JSON
// even after the write succeeded).
ok(!('supersededFile' in i1), 'insight result omits supersededFile when nothing was superseded');
const i3 = await T.memory_insight.execute(
	{ theme: '闭环验证2', principle: '再迭代一次的原则', summary: '可迁移原则更新', sources: ['测试功能'], applicability: '刷新后的适用面文案' },
	exec,
);
ok(i3.supersededFile === undefined && !('supersededFile' in i3), 'no undefined field in an insight update result');
const insightText = await readFile(i3.insightFile, 'utf8');
ok(insightText.includes('刷新后的适用面文案'), 'applicability refreshed on insight update');

// 7c) insight trust end-to-end: every insight file carries a computed
// 「> 信任：」 head line; recorded evidence moves it, and shaking it both warns
// at write time and trips the R22 lint.
ok(insightText.includes('> 信任：'), 'insight file starts with a trust line');
const tPos = await T.memory_insight.execute({ theme: '信任主题', principle: '被反复认可的原则', summary: '信任测试', sources: ['测试功能'] }, exec);
ok(tPos.trust?.level === '待验证', `fresh insight is 待验证 (${JSON.stringify(tPos.trust)})`);
await T.memory_usage.execute({ action: 'record', href: 'insights/信任主题.md', kind: 'positive' }, exec);
await T.memory_usage.execute({ action: 'record', href: 'insights/信任主题.md', kind: 'positive' }, exec);
const tSteady = await T.memory_insight.execute({ theme: '信任主题', principle: '被反复认可的原则（迭代）', summary: '信任测试', sources: ['测试功能'] }, exec);
ok(tSteady.trust?.level === '已验证' && tSteady.trust.positives === 2, `two positives raise trust (${JSON.stringify(tSteady.trust)})`);
await T.memory_usage.execute({ action: 'record', href: 'insights/信任主题.md', kind: 'correction' }, exec);
await T.memory_usage.execute({ action: 'record', href: 'insights/信任主题.md', kind: 'correction' }, exec);
const tShaken = await T.memory_insight.execute({ theme: '信任主题', principle: '被纠正追平的同一原则', summary: '信任测试', sources: ['测试功能'] }, exec);
ok(tShaken.trust?.level === '动摇', `corrections reached positives -> 动摇 (${JSON.stringify(tShaken.trust)})`);
ok(tShaken.warnings.some((w) => w.includes('动摇') && w.includes('supersedes')), 'shaking an insight warns at write time');
const shakenFile = await readFile(tShaken.insightFile, 'utf8');
ok(/>\s*信任：动摇（认可 2 · 纠正 2/.test(shakenFile), 'the head line holds the current evidence counts');
const cTrust = await T.memory_check.execute({}, exec);
ok(cTrust.results.some((r) => r.rule === 'R22' && r.message.includes('信任主题')), 'R22 reports the shaken insight');
// Regression (found end-to-end on the REAL root): a file written BEFORE the
// 5.16.1 template carries no `> 信任：` line, so the update must INSERT one.
// The insert regex originally lacked the `m` flag — `^` anchored at the very
// start (the `# 标题` line), never matched, and all 16 pre-existing insights
// silently stayed without the line R22 and the recall marker key on.
{
	const legacyPath = path.join(root, 'insights', '旧代思想.md');
	await writeFile(legacyPath, '# 创新优化思想：旧代思想\n\n> 性质：可重套的原则。\n> 来源：[functions/测试功能.md](../functions/测试功能.md)\n\n## 核心原则\n\n- 旧版原则本体\n', 'utf8');
	await T.memory_insight.execute({ theme: '旧代思想', principle: '旧版原则本体（迭代）', summary: '旧代补信任', sources: ['测试功能'] }, exec);
	const legacyText = await readFile(legacyPath, 'utf8');
	ok(/^> 信任：.*$/m.test(legacyText), 'a pre-template file gets its trust line INSERTED on update');
}

// 8) fold: create a file with many blocks, fold keeping 2
await T.memory_write.execute({ feature: '折叠目标', title: '块一', summary: 's1', result: 'reverted', open: '教训一' }, exec);
await T.memory_write.execute({ feature: '折叠目标', title: '块二', summary: 's2', result: 'done' }, exec);
await T.memory_write.execute({ feature: '折叠目标', title: '块三', summary: 's3', result: 'done' }, exec);
await T.memory_write.execute({ feature: '折叠目标', title: '块四', summary: 's4', result: 'done' }, exec);
await T.memory_write.execute({ feature: '折叠目标', title: '块五', summary: 's5', result: 'done' }, exec);
const fold1 = await T.memory_fold.execute({ feature: '折叠目标', keep: 2 }, exec);
ok(fold1.foldedBlocks === 3 && fold1.keptBlocks === 2, `fold counts: ${fold1.foldedBlocks}/${fold1.keptBlocks}`);
ok(fold1.bytesAfter < fold1.bytesBefore, `fold shrinks: ${fold1.bytesBefore} -> ${fold1.bytesAfter}`);
const foldedFile = await T.memory_read.execute({ kind: 'function', name: '折叠目标' }, exec);
ok(foldedFile.content.includes('早期演化'), 'folded file has evolution paragraph');
ok(!/^## 早期演化.*→/m.test(foldedFile.content), 'fold heading does not duplicate every date tag');
ok((foldedFile.content.match(/^- \[\d{4}-\d{2}-\d{2}/gm) ?? []).length >= 3, 'fold retains individual date tags for numbering and history');
{
	const p = path.join(root, 'functions', '折叠隔离.md');
	const before = '# test\n\n## [2026-01-01] first\n\n- **结果**：完成\n\n## 必须保留\n\n不可丢失\n\n## [2026-01-02] second\n\n正文\n';
	await writeFile(p, before, 'utf8');
	let rejected = false;
	try { await T.memory_fold.execute({ feature: '折叠隔离', keep: 1 }, exec); } catch { rejected = true; }
	ok(rejected && await readFile(p, 'utf8') === before, 'fold refuses to discard intervening sections');
}
ok(foldedFile.content.includes('块一') && foldedFile.content.includes('块五'), 'folded history names oldest, kept names newest');
ok(foldedFile.content.includes('## ['), 'kept blocks remain');
// Existing headings are shortened only when every tag survives in that section's body.
{
	const p = path.join(root, 'functions', '标题整理.md');
	const before = '# 测试\n\n## 早期演化（2 块已折叠：2026-01-01→2026-01-01补）\n\n- [2026-01-01] 甲\n  补充说明\n- [2026-01-01补] 乙\n\n## 早期演化（1 块已折叠：2026-01-02）\n\n原文缺失标签\n';
	await writeFile(p, before, 'utf8');
	await T.memory_fold.execute({ feature: '标题整理', normalizeHeadings: true }, exec);
	const actual = await readFile(p, 'utf8');
	ok(actual === before.replace('## 早期演化（2 块已折叠：2026-01-01→2026-01-01补）', '## 早期演化（2 块已折叠）'), 'normalization keeps all body text and skips missing tags');
	const report = await T.memory_check.execute({}, exec);
	ok(report.results.some((r) => r.rule === 'R27' && r.message.includes('标题整理.md')), 'R27 identifies duplicated evolution headings in a real fixture');
}
// 8b) a fold must not recycle a same-day tag: the folded tags live on in the
// 「早期演化」 list, so the next write continues the sequence (补4 → 补5) instead
// of colliding with a folded 补2 and tripping the R3 ordering check.
const w11 = await T.memory_write.execute({ feature: '折叠目标', title: '折叠后新块', summary: '折叠后编号不撞名', result: 'done' }, exec);
ok(w11.appendedHeading.includes('补5'), `post-fold tag continues the sequence: ${w11.appendedHeading}`);

// 9) rename: bare rename rewrites references everywhere
await T.memory_write.execute({ feature: '旧名功能', title: '重命名前', summary: '将被重命名', result: 'done' }, exec);
await T.memory_write.execute(
	{ feature: '测试功能', title: '引用旧名', summary: '含旧名相关链接', related: ['旧名功能'], result: 'done' },
	exec,
);
await T.memory_index.execute({ zone: 'functions', name: '旧名功能', summary: '将被重命名的功能' }, exec);
const r1 = await T.memory_rename.execute({ from: '旧名功能', to: '新名功能' }, exec);
ok(r1.mode === 'renamed', `rename mode: ${r1.mode}`);
ok(r1.danglingAfter === 0, `dangling after rename: ${r1.danglingAfter}`);
const refFile = await T.memory_read.execute({ kind: 'function', name: '测试功能' }, exec);
ok(refFile.content.includes('新名功能.md') && !refFile.content.includes('旧名功能.md'), 'references rewritten to new name');
const oldGone = await T.memory_read.execute({ kind: 'function', name: '旧名功能' }, exec);
ok(!oldGone.found, 'old file gone after rename');
const newIdx = await T.memory_read.execute({ kind: 'index' }, exec);
ok(newIdx.content.includes('新名功能'), 'index row renamed');

// 10) merge: fold 待并入 into 测试功能
await T.memory_write.execute({ feature: '待并入', title: '并入前块', summary: '将被合并', result: 'done' }, exec);
await T.memory_index.execute({ zone: 'functions', name: '待并入', summary: '将被合并的功能' }, exec);
const r2 = await T.memory_rename.execute({ from: '待并入', to: '测试功能' }, exec);
ok(r2.mode === 'merged', `merge mode: ${r2.mode}`);
ok(r2.danglingAfter === 0, `dangling after merge: ${r2.danglingAfter}`);
const mergedFile = await T.memory_read.execute({ kind: 'function', name: '测试功能' }, exec);
ok(mergedFile.content.includes('并入前块'), 'merged blocks appended to target');
const mergedIdx = await T.memory_read.execute({ kind: 'index' }, exec);
ok(!mergedIdx.content.includes('| 待并入 |'), 'merged source row removed from index');
{
	const { readLedger, contentHash } = await import('./src/write-ledger.js');
	const ledger = await readLedger(root);
	ok(ledger?.get('functions/旧名功能.md')?.op === 'delete' && ledger.get('functions/旧名功能.md').to === 'functions/新名功能.md', 'rename records completed source deletion and destination');
	ok(ledger?.get('functions/待并入.md')?.op === 'delete' && ledger.get('functions/待并入.md').to === 'functions/测试功能.md', 'merge records completed source deletion and destination');
	ok(ledger?.get('functions/新名功能.md')?.hash === contentHash(await readFile(path.join(root, 'functions', '新名功能.md'), 'utf8')), 'rename destination content matches recorded hash');
	const report = await T.memory_check.execute({}, exec);
	ok(!report.results.some((r) => r.rule === 'R26' && /(?:旧名功能|待并入)\.md.*不存在/.test(r.message)), 'R26 does not flag completed rename or merge as unexplained loss');
}

// 11) full check now passes (no FAIL)
const c1 = await T.memory_check.execute({}, exec);
ok(c1.failCount === 0, `check clean (FAIL=${c1.failCount}, WARN=${c1.warnCount})`);
for (const r of c1.results) console.log(`    [${r.level}] ${r.rule}: ${r.message}`);

// 11b) temperature: a feature nobody references is flagged as cold; a heavily
// referenced one is not. At this point 测试功能 is referenced by the index and
// insights, so it must NOT be cold; 无引用功能 would be.
await T.memory_write.execute({ feature: '无引用功能', title: '孤立块', summary: '没有任何其他文件引用此功能', result: 'done' }, exec);
const c2 = await T.memory_check.execute({}, exec);
const cold = c2.results.filter((r) => r.rule === 'TEMP');
ok(cold.some((r) => r.message.includes('无引用功能')), `cold flagged: ${cold.map((r) => r.message.split('：')[0]).join('; ')}`);
ok(!cold.some((r) => r.message.includes('测试功能')), 'referenced feature not flagged cold');

// 11c) dedupe: writing a summary highly overlapping an INDEXED row's warns.
// In the layered flow the index only carries stabilized features, so dedupe
// compares against indexed rows — index 无引用功能 first.
await T.memory_index.execute({ zone: 'functions', name: '无引用功能', summary: '没有任何其他文件引用此功能' }, exec);
const w6 = await T.memory_write.execute(
	{ feature: '相近功能', title: '疑似重复写入', summary: '没有任何其他文件引用此功能的孤立块', result: 'done' },
	exec,
);
ok(w6.warnings.some((x) => x.includes('疑似与已有功能域')), `dedupe warning: ${w6.warnings.join(' | ').slice(0, 80)}`);

// 11d) grace period: a brand-new feature file has had no chance to be
// backlinked, so the default window suppresses the cold flag for it.
mod.apply(fakeCtx, { memoryRoot: root, skillRoot  });
const tools3 = Object.fromEntries(
	registered.filter((r) => r?.name && r.execute).slice(-11).map((t) => [t.name, t]),
);
const c3 = await tools3.memory_check.execute({}, exec);
ok(!c3.results.some((r) => r.rule === 'TEMP'), `grace window suppresses cold flag on fresh files (TEMP=${c3.results.filter((r) => r.rule === 'TEMP').length})`);

// 12) bad slug rejected
let threw = false;
try {
	await T.memory_write.execute({ feature: '../逃逸', title: 'x', summary: 's' }, exec);
} catch {
	threw = true;
}
ok(threw, 'path-escape slug rejected');

// 13) proactive recall: pre-step listener matches index rows
const ps = globalThis.__preStepListener;
ok(typeof ps === 'function', 'pre-step listener registered');
if (typeof ps === 'function') {
	const fakeAgent = { id: 'sess-test' };
	const nextEnter = () => Promise.resolve({ kind: 'enter', messages: [] });
	// 13a) hit: user text overlapping an index row (测试功能 exists in the index)
	const hit = await ps(
		{ agent: fakeAgent, messages: [{ role: 'user', content: [{ type: 'text', text: '接下来处理测试功能的待观察项' }] }], turn: 1, step: 1, signal: new AbortController().signal },
		nextEnter,
	);
	ok(hit.kind === 'enter' && hit.messages.length === 1 && hit.messages[0].source?.form === 'recall', `recall injected on hit (${hit.messages?.length})`);
	ok(hit.messages[0].content[0].text.includes('测试功能'), 'recall cites the matching row');
	// 13b) dedupe: same batch again -> no second recall
	const dedup = await ps(
		{ agent: fakeAgent, messages: [{ role: 'user', content: [{ type: 'text', text: '接下来处理测试功能的待观察项' }] }], turn: 1, step: 2, signal: new AbortController().signal },
		nextEnter,
	);
	ok(dedup.kind === 'enter' && dedup.messages.length === 0, 'dedupe suppresses repeat recall');
	// 13c) miss: unrelated text -> no recall
	const miss = await ps(
		{ agent: fakeAgent, messages: [{ role: 'user', content: [{ type: 'text', text: '今天天气怎么样' }], }], turn: 2, step: 1, signal: new AbortController().signal },
		nextEnter,
	);
	ok(miss.kind === 'enter' && miss.messages.length === 0, 'no recall on unrelated input');
	// 13d) pointer dedupe: user text already cites the file (e.g. quoting an
	// earlier recall) -> that row is NOT injected again. Other rows may still be
	// (generic bigrams can match unrelated rows); the cited one must be gone.
	const agent2 = { id: 'sess-quote' };
	const cited = await ps(
		{ agent: agent2, messages: [{ role: 'user', content: [{ type: 'text', text: 'functions/测试功能.md 这个文件怎么样' }] }], turn: 1, step: 1, signal: new AbortController().signal },
		nextEnter,
	);
	const citedText = cited.messages?.[0]?.content?.[0]?.text ?? '';
	ok(citedText.length === 0 || !citedText.includes('functions/测试功能.md'), 'user-cited pointer not re-injected');
	// mixed: one cited row + one uncited hit -> only the uncited one stays
	const mixed = await ps(
		{ agent: agent2, messages: [{ role: 'user', content: [{ type: 'text', text: '看看 insights/闭环验证.md 和无引用功能 的记忆' }] }], turn: 2, step: 1, signal: new AbortController().signal },
		nextEnter,
	);
	const mixedText = mixed.messages?.[0]?.content?.[0]?.text ?? '';
	ok(mixed.kind === 'enter' && !mixedText.includes('insights/闭环验证.md') && mixedText.includes('无引用功能'), `cited row dropped, uncited kept (${mixed.messages?.length} msgs)`);
}

// 14) distillation gate (R14): a block is a conclusion, not a process log —
// flagged both at write time and by the health check, but only as a WARN.
const longChange = '实现细节逐条流水。'.repeat(110); // 990 chars > MAX_BLOCK_CHARS
const w7 = await T.memory_write.execute(
	{ feature: '冗长功能', title: '未蒸馏的块', summary: '用来验证蒸馏闸门', change: longChange, result: 'done' },
	exec,
);
ok(w7.warnings.some((x) => x.includes('本块正文')), 'write warns on an over-long block');
const longSummary = '这一段索引摘要故意写得非常长'.repeat(12); // 168 chars > MAX_ROW_SUMMARY_CHARS
const w8 = await T.memory_write.execute(
	{ feature: '摘要过长功能', title: '摘要过长', summary: longSummary, change: '简短改动', result: 'done' },
	exec,
);
ok(w8.warnings.some((x) => x.includes('索引行摘要')), 'write warns on an over-long summary');
// R14's index-row check reads MEMORY.md table rows, so push the over-long
// summary through memory_index and expect the health check to flag it.
await T.memory_index.execute({ zone: 'functions', name: '摘要过长功能', summary: longSummary }, exec);
const c4 = await T.memory_check.execute({}, exec);
const r14 = c4.results.filter((r) => r.rule === 'R14');
ok(r14.some((r) => r.message.includes('冗长功能')), `R14 flags the un-distilled block (${r14.length} R14)`);
ok(r14.some((r) => r.message.includes('摘要过长功能')), 'R14 flags the over-long index row');
// R14 measures the SENTENCE, not the markdown: a folded source-link tail
// (`（来源：[x.md](functions/x.md)）`) is href noise — since 5.15.0 insight
// rows carry it, and counting it flagged a 34-char principle as 129.
const shortPrinciple = '跨功能写入接口必须成对实现进退两方向，否则副本与主行并存。'; // 35 chars
await T.memory_insight.execute(
	{ theme: '带长来源的主题', principle: shortPrinciple, summary: shortPrinciple, sources: ['测试功能', '冗长功能'] },
	exec,
);
await T.memory_index.execute(
	{ zone: 'insights', name: '带长来源的主题', summary: shortPrinciple, sources: ['测试功能', '冗长功能', '摘要过长功能', '无引用功能'] },
	exec,
);
const c4b = await T.memory_check.execute({}, exec);
const r14b = c4b.results.filter((r) => r.rule === 'R14');
ok(!r14b.some((r) => r.message.includes('带长来源的主题')), 'R14 strips source links before measuring the summary');
ok(r14b.some((r) => r.message.includes('摘要过长功能')), 'a genuinely over-long plain-text summary is STILL flagged');
ok(c4b.failCount === 0, 'R14 is advisory (WARN), never a FAIL');

// 14b) related: "x.md" is accepted as the slug (no `x.md.md（未建档）`)
const w9 = await T.memory_write.execute(
	{ feature: '测试功能', title: 'related 带 .md 后缀', summary: 'related 容忍 .md 后缀', related: ['冗长功能.md'], result: 'done' },
	exec,
);
const fn9 = await readFile(w9.featureFile, 'utf8');
ok(fn9.includes('](冗长功能.md)') && !fn9.includes('冗长功能.md.md'), 'related "x.md" resolves to the sibling file');

// 14c) a distilled block raises no verbosity warning
const w10 = await T.memory_write.execute(
	{ feature: '测试功能', title: '蒸馏块不告警', summary: '结论级块不触发蒸馏闸门', change: '改动一句', reason: '原因一句', verification: '验证一句', result: 'done', open: '待观察一句' },
	exec,
);
ok(!w10.warnings.some((x) => x.includes('本块正文')), 'a distilled block raises no verbosity warning');

// 15) memory_index is idempotent: indexing twice keeps exactly one row
await T.memory_index.execute({ zone: 'functions', name: '测试功能', summary: '幂等索引' }, exec);
const idxPath = path.join(root, 'MEMORY.md');
const idxNow = await readFile(idxPath, 'utf8');
ok(rowsFor(idxNow, '测试功能').length === 1, 'memory_index is idempotent (one row)');

// 15a) grouping for scale: past ~40 rows the index splits into `### 索引·<域>`.
// memory_index must land each row in its own sub-table, upsert within it, and
// the health check must nag while a big table is still flat.
await T.memory_index.execute({ zone: 'functions', name: '测试功能', summary: '基础设施域的一行', group: '基础设施' }, exec);
await T.memory_index.execute({ zone: 'functions', name: '检索目标', summary: '业务域的一行', group: '业务功能' }, exec);
const grouped = await readFile(idxPath, 'utf8');
ok(grouped.includes('### 索引·基础设施') && grouped.includes('### 索引·业务功能'), 'memory_index creates per-group sub-sections');
const infraStart = grouped.indexOf('### 索引·基础设施');
const bizStart = grouped.indexOf('### 索引·业务功能');
const infraBlock = grouped.slice(infraStart, bizStart === -1 ? undefined : bizStart);
ok(rowsFor(infraBlock, '测试功能').length === 1 && rowsFor(infraBlock, '检索目标').length === 0, 'each row lands in its own group block');
await T.memory_index.execute({ zone: 'functions', name: '测试功能', summary: '基础设施域更新后的一行', group: '基础设施' }, exec);
const grouped2 = await readFile(idxPath, 'utf8');
ok(rowsFor(grouped2, '测试功能').length === 1, 'grouped upsert is idempotent');
ok(grouped2.includes('基础设施域更新后的一行'), 'grouped upsert replaced the summary');
// R15 must NOT flag the shared header row: every `### 索引·<域>` sub-table reuses
// FUNC_TABLE_HEADER by design, so a repeated header is structure, not a stale row.
const cGroup = await T.memory_check.execute({}, exec);
ok(
	cGroup.results.every((r) => !(r.rule === 'R15' && r.message.includes('功能域摘要'))),
	`R15 ignores shared group headers (${cGroup.results.filter((r) => r.rule === 'R15').length} R15)`
);
// Ungrouping is the OTHER half of the migration: a later upsert WITHOUT group
// must move the row back to the flat table and drop the emptied sub-section —
// otherwise the row lives in two tables and R15 fires on the next check.
await T.memory_index.execute({ zone: 'functions', name: '测试功能', summary: '回到总表的一行' }, exec);
const ungrouped = await readFile(idxPath, 'utf8');
ok(rowsFor(ungrouped, '测试功能').length === 1, 'ungrouped upsert leaves exactly one row');
ok(ungrouped.includes('回到总表的一行'), 'ungrouped upsert wrote the new summary into the flat table');
ok(!ungrouped.includes('### 索引·基础设施'), 'the emptied group section was removed');
ok(ungrouped.includes('### 索引·业务功能') && rowsFor(ungrouped, '检索目标').length === 1, 'a sibling group that still has rows survives');
// R5 scaling hint: 41 flat rows and no ### 索引· -> WARN
const flatRows = Array.from({ length: 41 }, (_, i) => `| 域${i} | 第 ${i} 个功能的一句话 | [functions/域${i}.md](functions/域${i}.md) |`).join('\n');
const flatIndex = ['# 索引', '', '## 功能模块索引（functions/）', '', '| 功能域摘要 | 一句话状态 | 过程链接 | 摘要 |', '|---|---|---|---|', flatRows, '', '## 创新优化思想索引（insights/）', '', '| 思想主题 | 内涵 | 思想内容 | 相关 |', '|---|---|---|---|'].join('\n');
const flatRoot = await mkdtemp(path.join(tmpdir(), 'dsh-flat-'));
await writeFile(path.join(flatRoot, 'MEMORY.md'), flatIndex, 'utf8');
const flatHealth = await mod.runHealthCheck(flatRoot, { maxIndexBytes: 64 * 1024, maxIndexHardBytes: 96 * 1024, maxFunctionBytes: 30 * 1024, newFeatureGraceDays: 0 });
ok(flatHealth.results.some((r) => r.rule === 'R5' && r.message.includes('拆分子分区')), `R5 flags a big flat function table (${flatHealth.results.filter((r) => r.rule === 'R5').length} R5)`);
await rm(flatRoot, { recursive: true, force: true });

// 15b) R15: duplicated index rows and duplicated table sections are flagged.
// Simulate the fallback-table twin by hand-editing the index. The twin row
// carries the twin's own summary, so the upsert's column-2 refresh cannot
// absorb the duplicate — only the section self-heal (or a manual fix) removes it.
const twinSection = [
	'## 功能域（细节在子目录，本表只留指针）',
	'',
	'| 功能域摘要 | 一句话状态 / 待验证 | 过程链接 | 摘要 |',
	'|---|---|---|---|',
	'| 测试功能 | 旧代兜底表里的一行 | [functions/测试功能.md](functions/测试功能.md) |',
	'',
].join('\n');
await writeFile(idxPath, idxNow + '\n' + twinSection, 'utf8');
const c5 = await T.memory_check.execute({}, exec);
const r15 = c5.results.filter((r) => r.rule === 'R15');
ok(r15.some((r) => r.message.includes('测试功能')), `R15 flags the duplicated row (${r15.length} R15)`);
ok(r15.some((r) => r.message.includes('出现 2 次')), 'R15 flags the duplicated section');
// the self-healing upsert removes the twin table on the next memory_index call
await T.memory_index.execute({ zone: 'functions', name: '测试功能', summary: 'upsert 后重复表消失' }, exec);
const idxHealed = await readFile(idxPath, 'utf8');
ok(!idxHealed.includes('## 功能域（细节在子目录'), 'twin table removed by upsert self-heal');
const rows = rowsFor(idxHealed, '测试功能').length;
ok(rows === 1, `index has exactly one 测试功能 row (rows=${rows})`);
const c6 = await T.memory_check.execute({}, exec);
ok(c6.results.every((r) => r.rule !== 'R15'), `R15 clean after self-heal (${c6.results.filter((r) => r.rule === 'R15').length})`);
// R10 must not silently skip links whose target contains a SPACE: safeSlug
// allows spaces, so 「可观测性先于修 bug.md」 is a real filename shape. The old
// [^)\s] href pattern matched zero links like this — a dangling one never
// tripped the lint, and the panel rendered the raw markdown as "duplicated" text.
await writeFile(idxPath, idxHealed + '\n- 空格悬空测试 → [insights/不存在的 主题.md](insights/不存在的 主题.md)\n', 'utf8');
const cSpaced = await T.memory_check.execute({}, exec);
ok(
	cSpaced.results.some((r) => r.rule === 'R10' && r.message.includes('不存在的 主题.md')),
	`R10 flags a spaced dangling href (${cSpaced.results.filter((r) => r.rule === 'R10').length} R10)`,
);
await writeFile(idxPath, idxHealed, 'utf8');

// R10 + file:/// links (5.24.0): a skill index row points at its HOST bundle by
// absolute file URL. The dangling half of R10 must still fire (a renamed bundle
// silently loses recall), but a LIVE file:/// row must never warn as an escape —
// leaving the memory root is the design.
{
	const bundleDir = path.join(skillRoot, 'linked-skill');
	await mkdir(bundleDir, { recursive: true });
	await writeFile(path.join(bundleDir, 'SKILL.md'), '# live bundle\n', 'utf8');
	const liveUrl = 'file:///' + bundleDir.replace(/\\/g, '/') + '/SKILL.md';
	const deadUrl = 'file:///' + path.join(skillRoot, 'ghost-skill').replace(/\\/g, '/') + '/SKILL.md';
	await writeFile(idxPath, `${idxHealed}\n| [linked-skill](${liveUrl}) | live row | active |\n| [ghost-skill](${deadUrl}) | dead row | active |\n`, 'utf8');
	const cFile = await T.memory_check.execute({}, exec);
	ok(!cFile.results.some((r) => r.rule === 'R10' && r.message.includes('linked-skill')), `a live file:/// bundle link resolves without R10/R10e (${cFile.results.filter((r) => r.rule === 'R10e').length} escapes flagged)`);
	ok(!cFile.results.some((r) => r.rule === 'R10e' && r.message.includes('linked-skill')), 'a file:/// row is NOT an escape warning (outside-root is by design)');
	ok(cFile.results.some((r) => r.rule === 'R10' && r.message.includes('ghost-skill')), 'a dangling file:/// bundle link still trips R10');
	await writeFile(idxPath, idxHealed, 'utf8');
}

// 16) R3 head guardrail: a head summary whose 截至 date is older than the newest
// iteration block is flagged (append must pair with head refresh); a missing
// head summary is flagged too. R16: env-constant absolute paths must exist.
const fnPath15 = w1.featureFile;
const fnText15 = await readFile(fnPath15, 'utf8');
const staleHead = fnText15.replace(/当前状态摘要（截至\s*\d{4}-\d{2}-\d{2}/, '当前状态摘要（截至 2000-01-01');
await writeFile(fnPath15, staleHead, 'utf8');
const c7 = await T.memory_check.execute({}, exec);
ok(c7.results.some((r) => r.rule === 'R3' && r.message.includes('早于最新迭代块')), `R3 flags a stale head summary (${c7.results.filter((r) => r.rule === 'R3').length} R3)`);
await writeFile(fnPath15, fnText15.replace(/当前状态摘要（截至\s*\d{4}-\d{2}-\d{2}/, '当前状态摘要（截至'), 'utf8');
const c8 = await T.memory_check.execute({}, exec);
ok(c8.results.some((r) => r.rule === 'R3' && r.message.includes('缺少')), 'R3 flags a missing head summary');
// R16: a dead absolute path in the index's env-constants is flagged.
const idxText16 = await readFile(idxPath, 'utf8');
await writeFile(idxPath, idxText16 + '\n- 旧工具链：`Z:/definitely/gone/tool.cmd`', 'utf8');
const c9 = await T.memory_check.execute({}, exec);
ok(c9.results.some((r) => r.rule === 'R16' && r.message.includes('Z:/definitely/gone')), 'R16 flags a dead env-constant path');
// a live path must NOT be flagged
await writeFile(idxPath, idxText16 + '\n- 临时目录：' + '`' + root.replace(/\\/g, '/') + '`', 'utf8');
const c10 = await T.memory_check.execute({}, exec);
ok(!c10.results.some((r) => r.rule === 'R16'), 'R16 silent on live paths');

// 17) federation (three-tier): project truth sources -> federation layer.
// Two throwaway project roots, one throwaway federation root; sync copies each
// MEMORY.md into sources/ and builds the mechanical project table; check lints
// the layer (F1 missing index, F2 dangling link, F3 missing copy/row, F5 orphan).
const fedRoot = await mkdtemp(path.join(tmpdir(), 'dsh-fed-'));
const projA = await mkdtemp(path.join(tmpdir(), 'dsh-proj-a-'));
const projB = await mkdtemp(path.join(tmpdir(), 'dsh-proj-b-'));
for (const [dir, label] of [[projA, 'A'], [projB, 'B']]) {
	await writeFile(path.join(dir, 'MEMORY.md'), `# ${label} 项目记忆\n\n## 功能模块索引（functions/）\n\n| 功能域摘要 | 一句话状态 | 过程链接 | 摘要 |\n|---|---|---|---|\n| ${label}功能 | ${label} 的一句话 | [functions/${label}功能.md](functions/${label}功能.md) |\n`, 'utf8');
	await mkdir(path.join(dir, 'functions'), { recursive: true });
	await writeFile(path.join(dir, 'functions', `${label}功能.md`), '# x\n', 'utf8');
}
mod.apply(fakeCtx, { memoryRoot: root, skillRoot, federation: { root: fedRoot, projects: [{ key: 'proj-a', root: projA }, { key: 'proj-b', root: projB }] } });
const FED = Object.fromEntries(registered.filter((r) => r?.name && r.execute).slice(-11).map((t) => [t.name, t]));
ok(typeof FED.memory_federation?.execute === 'function', 'memory_federation registered');
const synced = await FED.memory_federation.execute({ action: 'sync' }, exec);
ok(synced.projects.length === 2 && synced.projects.every((p) => p.copied), 'sync copies every project index');
ok(await statExists(path.join(fedRoot, 'sources', 'proj-a.MEMORY.md')), 'sources/proj-a.MEMORY.md written');
const fedIndex = await readFile(path.join(fedRoot, 'MEMORY.md'), 'utf8');
ok(fedIndex.includes('## 项目索引（联邦层）') && fedIndex.includes('sources/proj-b.MEMORY.md'), 'federation index table links each copy');
ok(fedIndex.includes('## 跨项目共识'), 'federation index keeps a consensus section for the model');
const check1 = await FED.memory_federation.execute({ action: 'check' }, exec);
ok(check1.failCount === 0 && check1.warnCount === 0, `federation check clean (${check1.failCount} FAIL / ${check1.warnCount} WARN)`);
// re-sync must preserve a hand-written consensus line (model-owned section)
await writeFile(path.join(fedRoot, 'MEMORY.md'), fedIndex.replace('- \n', '- 两个项目共用 Node 22 与 pnpm 工作流\n'), 'utf8');
await FED.memory_federation.execute({ action: 'sync' }, exec);
const fedIndex2 = await readFile(path.join(fedRoot, 'MEMORY.md'), 'utf8');
ok(fedIndex2.includes('两个项目共用 Node 22'), 'sync preserves the model-written consensus section');
// orphan copy -> F5 WARN
await writeFile(path.join(fedRoot, 'sources', 'ghost.MEMORY.md'), '# ghost\n', 'utf8');
const check2 = await FED.memory_federation.execute({ action: 'check' }, exec);
ok(check2.findings.some((f) => f.rule === 'F5' && f.message.includes('ghost')), 'F5 flags an orphan copy');
await rm(path.join(fedRoot, 'sources', 'ghost.MEMORY.md'), { force: true });
// missing project MEMORY.md -> F3 FAIL
await rm(path.join(projB, 'MEMORY.md'), { force: true });
const check3 = await FED.memory_federation.execute({ action: 'check' }, exec);
ok(check3.failCount >= 1 && check3.findings.some((f) => f.rule === 'F3' && f.message.includes('proj-b')), 'F3 flags a project without MEMORY.md');
// dangling link in the federation index -> F2 FAIL
await writeFile(path.join(fedRoot, 'MEMORY.md'), fedIndex2 + '\n- 参考：[不存在](sources/nope.MEMORY.md)\n', 'utf8');
const check4 = await FED.memory_federation.execute({ action: 'check' }, exec);
ok(check4.findings.some((f) => f.rule === 'F2'), 'F2 flags a dangling federation link');
// unconfigured federation -> explicit error, not silence
mod.apply(fakeCtx, { memoryRoot: root, skillRoot  });
// Name-keyed (not count-based): adding a tool must never shift this window.
const NOFED = Object.fromEntries(registered.filter((r) => r?.name && r.execute).map((t) => [t.name, t]));
let fedThrew = null;
try {
	await NOFED.memory_federation.execute({ action: 'check' }, exec);
} catch (e) {
	fedThrew = String(e.message);
}
ok(fedThrew && fedThrew.includes('federation'), `unconfigured federation fails loud (${fedThrew?.slice(0, 40)})`);
await rm(fedRoot, { recursive: true, force: true });
await rm(projA, { recursive: true, force: true });
await rm(projB, { recursive: true, force: true });

// 18) usage signals -> self-sorting layers, guard channel, circuit breaker.
// The article's model: usage frequency + correction frequency decide the layer,
// and a low-frequency/high-value memory must be able to opt out of the cold
// judgement entirely.
const US = T.memory_usage;
ok(typeof US?.execute === 'function', 'memory_usage registered');
// guard: a marked file is skipped by the TEMP cold rule
const gw = await T.memory_write.execute(
	{ feature: '守护域', title: '低频高价值的兜底规则', summary: '安全审计类低频高价值记忆', result: 'done', guard: true },
	exec,
);
const guardText = await readFile(gw.featureFile, 'utf8');
ok(guardText.includes('🛡 守护型'), 'guard=true writes the guard marker');
const cg = await T.memory_check.execute({}, exec);
const coldNames = cg.results.filter((r) => r.rule === 'TEMP').map((r) => r.message).join(' ');
ok(!coldNames.includes('守护域'), 'guarded file is exempt from the cold-memory rule');
// un-guarded control file IS flagged
await T.memory_write.execute({ feature: '普通冷域', title: '没人引用的块', summary: '会被判冷的普通域', result: 'done' }, exec);
const cg2 = await T.memory_check.execute({}, exec);
ok(cg2.results.some((r) => r.rule === 'TEMP' && r.message.includes('普通冷域')), 'unguarded cold file still flagged');
// usage recording: recalls from the pre-step hook are logged automatically
const psH = globalThis.__preStepListener;
ok(typeof psH === 'function', 'pre-step listener available for usage logging');
const usageLog = await readFile(path.join(root, '.usage.jsonl'), 'utf8').catch(() => '');
ok(usageLog.length > 0 && usageLog.includes('recall'), 'recall injections are logged as usage');
// manual record: correction + positive, then report layers
await US.execute({ action: 'record', href: 'functions/检索目标.md', kind: 'correction', note: '用户说不对' }, exec);
await US.execute({ action: 'record', href: 'functions/检索目标.md', kind: 'positive', note: '这次对了' }, exec);
const rep = await US.execute({ action: 'report', days: 30 }, exec);
const target = rep.items.find((i) => i.href === 'functions/检索目标.md');
ok(target && target.corrections >= 1 && target.positives >= 1, `usage report aggregates correction/positive (${target?.corrections}/${target?.positives})`);
ok(target.layer === '专项' || target.layer === '实验', `layer suggestion present (${target?.layer})`);
ok(rep.items.some((i) => i.href.startsWith('functions/')), 'report lists function targets');
// FLIPS must mean "one conclusion overturned", not "one file collected verdicts
// about different subjects". Real root case: three verdicts about three unrelated
// matters (duplicate-row cleanup / then capability-ledger semantics) were reported
// as 结论被反复推翻（翻转 2 次）. Notes that share content = same subject (flip);
// notes about different matters = not a flip.
for (const [kind, note] of [
	['correction', '能力台账把插件自身脚本登记进去了'],
	['positive', '这次对了'],
	['correction', '另一件事：召回排序有问题'],
]) {
	await US.execute({ action: 'record', href: 'functions/多主题域.md', kind, note }, exec);
}
const repMulti = await US.execute({ action: 'report', days: 30 }, exec);
const multiItem = repMulti.items.find((i) => i.href === 'functions/多主题域.md');
ok(multiItem?.flips === 0, `verdicts about DIFFERENT subjects do not count as flips (flips=${multiItem?.flips})`);
// Narrow to the FLIP warning: this fixture also trips the correction-rate warning
// (2 corrections / 3 engagements), which is a different and correct complaint.
ok(
	!repMulti.warnings.some((w) => w.includes('多主题域') && w.includes('反复推翻')),
	'a file with unrelated corrections is not named as an unstable conclusion',
);
// circuit breaker: 3 corrections with few uses trips R18
await US.execute({ action: 'record', href: 'functions/熔断域.md', kind: 'correction' }, exec);
await US.execute({ action: 'record', href: 'functions/熔断域.md', kind: 'correction' }, exec);
await US.execute({ action: 'record', href: 'functions/熔断域.md', kind: 'correction' }, exec);
await T.memory_write.execute({ feature: '熔断域', title: '反复被纠正的域', summary: '用来验证熔断规则', result: 'pending' }, exec);
const cg3 = await T.memory_check.execute({}, exec);
ok(cg3.results.some((r) => r.rule === 'R18' && r.message.includes('熔断')), `R18 trips on a repeatedly corrected area (${cg3.results.filter((r) => r.rule === 'R18').length} R18)`);
// bad href / bad kind are rejected loudly
let usageThrew = 0;
for (const args of [{ action: 'record', href: '../escape.md', kind: 'correction' }, { action: 'record', href: 'functions/x.md', kind: 'bogus' }]) {
	try {
		await US.execute(args, exec);
	} catch {
		usageThrew++;
	}
}
ok(usageThrew === 2, 'invalid usage records are rejected');
// record must return a visible receipt: the renderer used to fall through to the
// "no signals yet" placeholder for a successful record (items is empty by design).
const recRes = await US.execute({ action: 'record', href: 'functions/回执测试.md', kind: 'positive', note: '这次对了' }, exec);
ok(recRes.action === 'record' && recRes.warnings.length > 0, 'record returns a receipt');
const renderedRec = US.output.render({}, recRes).map((b) => b.text).join('\n');
ok(renderedRec.includes('已记录') && !renderedRec.includes('还没有使用信号'), `record receipt is rendered (${renderedRec.slice(0, 30)})`);

// 19) 道层验证闸门 (P0): a transferable principle must clear the mechanically
// checkable half of the four gates — >=2 unrelated source areas, and no
// operation-manual phrasing. Consensus entries (the binding layer) must carry
// evidence and stay one sentence; usage flips expose unstable conclusions.
const i4 = await T.memory_insight.execute({ theme: '单源原则', principle: '只有一个来源的原则', summary: '单源测试', sources: ['测试功能'] }, exec);
ok(i4.warnings.some((w) => w.includes('专项')), 'insight warns when it has only one source area (gateFa tiers it as 专项)');
const i5 = await T.memory_insight.execute({ theme: '双源原则', principle: '两个来源支持的原则', summary: '双源测试', sources: ['测试功能', '检索目标'] }, exec);
ok(!i5.warnings.some((w) => w.includes('专项')), 'no 专项 warning with two source areas');
const i6 = await T.memory_insight.execute({ theme: '步骤原则', principle: '1. 先运行 npm test；2. 再部署上线', summary: '步骤测试', sources: ['测试功能'] }, exec);
ok(i6.warnings.some((w) => w.includes('操作手册')), 'insight warns when the principle reads like a procedure');
const longPrinciple = '这是一个非常长的原则句子用来验证长度闸门'.repeat(12);
const i7 = await T.memory_insight.execute({ theme: '超长原则', principle: longPrinciple, summary: '超长测试', sources: ['测试功能'] }, exec);
ok(i7.warnings.some((w) => w.includes('字 >')), 'insight warns when the principle is too long');
// R19: consensus section — long entry / no evidence / cross-domain claim on one source
const memPath19 = path.join(root, 'MEMORY.md');
const memBefore19 = await readFile(memPath19, 'utf8');
const consensusHeading = '## 决策共识 / 规范（跨功能、约束级）';
const injected = [
	'## 决策共识 / 规范（跨功能、约束级）',
	'',
	`- ${'这条共识非常长'.repeat(20)}`,
	'- 没有依据的共识：靠感觉定规矩',
	'- 跨功能结论只有单来源 [functions/测试功能.md](functions/测试功能.md)',
	'- 两条来源的跨功能结论 [functions/测试功能.md](functions/测试功能.md)、[insights/双源原则.md](insights/双源原则.md)',
	'',
].join('\n');
const memAfter19 = memBefore19.includes(consensusHeading)
	? memBefore19.replace(new RegExp(`${consensusHeading}[\\s\\S]*?(?=\\n## )`), injected)
	: `${memBefore19}\n${injected}\n`;
await writeFile(memPath19, memAfter19, 'utf8');
const c19 = await T.memory_check.execute({}, exec);
const r19 = c19.results.filter((r) => r.rule === 'R19');
ok(r19.length >= 3, `R19 flags long / evidence-free / single-source consensus (${r19.length} R19)`);
ok(!r19.some((r) => r.message.includes('两条来源的跨功能结论')), 'a properly sourced consensus entry is not flagged');
// usage flips: positive -> correction -> positive is two verdict changes
await US.execute({ action: 'record', href: 'functions/翻转域.md', kind: 'positive' }, exec);
await US.execute({ action: 'record', href: 'functions/翻转域.md', kind: 'correction' }, exec);
await US.execute({ action: 'record', href: 'functions/翻转域.md', kind: 'positive' }, exec);
const rep2 = await US.execute({ action: 'report', days: 30 }, exec);
const flipItem = rep2.items.find((i) => i.href === 'functions/翻转域.md');
ok(flipItem && flipItem.flips >= 2, `usage report counts verdict flips (${flipItem?.flips})`);
ok(rep2.warnings.some((w) => w.includes('反复推翻')), 'a flip warning surfaces for unstable conclusions');

// 20) capability ledger: a CLI/MCP tool the agent actually used gets recorded
// once (one file per tool, updated in place) with its exact invocation,
// prerequisites and what it solved; record keeps the index row in sync.
const cap1 = await T.memory_capability.execute(
	{ action: 'record', name: 'ffmpeg', kind: 'cli', invocation: 'ffmpeg -f image2pipe -i pipe.png -c:v libx264 out.mp4', prereq: '已装 ffmpeg 7.x，PATH 可用', solved: 'OpenMontage 出片：静帧序列转 1920×1080 H.264', summary: '静帧序列转视频的渲染器' },
	exec,
);
ok(cap1.created === true && cap1.file.replace(/\\/g, '/').includes('capabilities/ffmpeg.md'), 'capability record creates a ledger file');
const capText = await readFile(cap1.file, 'utf8');
ok(capText.includes('## 调用方式') && capText.includes('ffmpeg -f image2pipe'), 'ledger keeps the exact invocation');
ok(capText.includes('> 摘要：静帧序列转视频的渲染器'), 'summary lands in the head line');
const cap2 = await T.memory_capability.execute(
	{ action: 'record', name: 'ffmpeg', kind: 'cli', invocation: 'ffmpeg -f image2pipe -i pipe.png -c:v libx264 -pix_fmt yuv420p out.mp4', solved: '批印坊 v2 成片 96s' },
	exec,
);
ok(cap2.created === false && cap2.file === cap1.file, 'record updates in place (one file per tool)');
const capText2 = await readFile(cap1.file, 'utf8');
ok(capText2.includes('-pix_fmt yuv420p'), 'invocation refreshed to the newer command');
ok(capText2.split('OpenMontage 出片').length === 2 && capText2.includes('批印坊 v2 成片 96s'), 'solved entries accumulate (ledger, not journal)');
const idxCap = await T.memory_read.execute({ kind: 'index' }, exec);
ok(rowsFor(idxCap.content, 'ffmpeg').length === 1 && idxCap.content.includes('capabilities/ffmpeg.md'), 'capability row lands in the index table');
// 5.15.2 heading: one bracket pair, meaning first — and an old-generation
// heading is renamed IN PLACE by the next upsert (no twin table).
ok(idxCap.content.includes('## 能力台账 细节子目录（可用工具 / MCP / CLI）'), 'capability heading is the new single-paren form');
ok(!idxCap.content.includes('（可用工具 / MCP / CLI）（'), 'no doubled paren after the rename');
{
	const idxP = path.join(root, 'MEMORY.md');
	const pre = await readFile(idxP, 'utf8');
	await writeFile(idxP, pre.replace('## 能力台账 细节子目录（可用工具 / MCP / CLI）', '## 能力台账（可用工具 / MCP / CLI）'), 'utf8');
	// Re-record the SAME slug with its invocation kept verbatim: upsertIndexRow
	// runs (heading must be migrated) yet the ledger body still contains the
	// image2pipe string a later search assertion depends on.
	await T.memory_capability.execute({ action: 'record', name: 'ffmpeg', kind: 'cli', invocation: 'ffmpeg -f image2pipe -i pipe.png -c:v libx264 -pix_fmt yuv420p out.mp4', solved: '迁移断言用的再记一次' }, exec);
	const post = await readFile(idxP, 'utf8');
	ok(post.includes('## 能力台账 细节子目录（可用工具 / MCP / CLI）'), 'legacy capability heading is migrated in place');
	ok((post.match(/^## 能力台账/gm) ?? []).length === 1, 'migration leaves exactly one capability table');
	ok(rowsFor(post, 'ffmpeg').length === 1, 'row count survives the heading migration');
}
const capList = await T.memory_capability.execute({ action: 'list' }, exec);
ok(capList.items.length === 1 && capList.items[0].name === 'ffmpeg' && capList.items[0].kind === 'cli', `list returns ledger entries (${capList.items.length})`);
const capRead = await T.memory_capability.execute({ action: 'read', name: 'ffmpeg' }, exec);
ok(capRead.content.includes('## 调用方式'), 'read returns the full ledger');
let capThrew = 0;
for (const args of [{ action: 'record', name: 'bad', kind: 'cli' }, { action: 'read', name: '不存在的能力' }]) {
	try {
		await T.memory_capability.execute(args, exec);
	} catch {
		capThrew++;
	}
}
ok(capThrew === 2, 'capability record/read validate their inputs');
// Boundary (user correction 2026-10-19): the ledger is for EXTERNAL tools only.
// The tool description and the injected discipline must both name what does NOT
// belong — harness built-ins and the project's own scripts/API — or agents
// re-file system capabilities as "discoveries" and the ledger becomes noise.
ok(/EXTERNAL CAPABILITY/.test(T.memory_capability.description), 'tool description scopes the ledger to external tools');
ok(/built-in/.test(T.memory_capability.description) && /own scripts/.test(T.memory_capability.description), 'tool description names the two excluded classes');
const capDisc = mod.DISCIPLINE_TEXT ?? '';
ok(capDisc.includes('外部工具') && capDisc.includes('harness 自带工具'), 'discipline text names the ledger boundary (external tools only)');
const capViaRead = await T.memory_read.execute({ kind: 'capability', name: 'ffmpeg' }, exec);
ok(capViaRead.found && capViaRead.content.includes('调用方式'), 'memory_read kind=capability works');
const capSearch = await T.memory_search.execute({ q: 'image2pipe' }, exec);
ok(capSearch.count >= 1 && capSearch.hits.some((h0) => h0.zone === 'capabilities'), `search covers capabilities (${capSearch.count} hits)`);
const capSearchZone = await T.memory_search.execute({ q: 'image2pipe', zone: 'capabilities' }, exec);
ok(capSearchZone.count >= 1 && capSearchZone.hits.every((h0) => h0.zone === 'capabilities'), 'capabilities zone filter works');
const cCap = await T.memory_check.execute({}, exec);
ok(!cCap.results.some((r) => r.message.includes('ffmpeg') && r.level === 'FAIL'), 'capability files do not trip the linter');

// 22b) memory defence (Hindsight-borrowed): credentials are redacted at the
// write choke point; the health check reports what the redactor cannot reach
// (the RAW daily layer, pre-defence files) and personal identifiers (tier 2)
// are reported, NEVER rewritten — facts must not be silently mangled.
{
	const wSec = await T.memory_write.execute(
		{ feature: '防线测试', title: '带密钥的迭代', summary: '验证写侧 redact', change: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 已配置', result: 'done' },
		exec,
	);
	ok(wSec.warnings.some((x) => x.includes('凭据材料') && x.includes('github-token')), 'write warns which credential was redacted');
	const secFn = await readFile(path.join(root, 'functions', '防线测试.md'), 'utf8');
	ok(secFn.includes('[REDACTED:github-token]') && !secFn.includes('ghp_abcdefghijklmnopqrstuvwxyz'), 'credential never reaches disk');
	// A credential arriving via the plugin's own index path is redacted too.
	await T.memory_index.execute({ zone: 'functions', name: '防线测试', summary: 'sk-proj-abcdefghijklmnopqrstuvwxyz123456 混进摘要' }, exec);
	const secIdx = await readFile(path.join(root, 'MEMORY.md'), 'utf8');
	ok(!secIdx.includes('sk-proj-abcdefghijklmnopqrstuvwxyz') && secIdx.includes('[REDACTED:'), 'index path is redacted as well');
	// Tier-2: an ID number in the daily RAW layer is reported, never rewritten.
	await writeFile(path.join(root, '2026-10-20.md'), '# 原始层\n\n- 用户身份证 11010519491231002X 已核对\n', 'utf8');
	const cSec = await T.memory_check.execute({}, exec);
	ok(cSec.results.some((r) => r.rule === 'R21' && r.level === 'WARN' && r.message.includes('cn-id')), 'R21 reports ID in the RAW layer');
	const stillThere = await readFile(path.join(root, '2026-10-20.md'), 'utf8');
	ok(stillThere.includes('11010519491231002X'), 'tier-2 is never rewritten');
	// A fenced code example is documentation, not a leak (no false positive).
	await T.memory_write.execute(
		{ feature: '防线测试', title: '代码块示例', summary: '验证误报边界', change: '示例见下\n\n```bash\nexport OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx\n```\n\n正文结束', result: 'done' },
		exec,
	);
	const cSec2 = await T.memory_check.execute({}, exec);
	ok(!cSec2.results.some((r) => r.rule === 'R21' && r.level === 'FAIL' && r.message.includes('防线测试')), 'fenced credential example is not a leak');
}

// 22b) R5 orphan + R23 insight budget — the RETIREMENT side of the layered flow.
// Every other zone could shrink (functions/ folds, skills retire, the index caps);
// insights/ could only grow, and an unindexed file is invisible to recall. Both
// holes were measured on a real root: 13 of 26 insight files unindexed while
// memory_check reported 0 WARN. Each case below is a hand-written OLD-generation
// artifact (a file on disk, a ledger line) — not something the tools just wrote.
{
	const orphanRoot = await mkdtemp(path.join(tmpdir(), 'dsh-orphan-'));
	await mkdir(path.join(orphanRoot, 'functions'), { recursive: true });
	await mkdir(path.join(orphanRoot, 'insights'), { recursive: true });
	await mkdir(path.join(orphanRoot, 'capabilities'), { recursive: true });
	// The index names ONE function row (2-column, link baked into the name cell)
	// and one insight row; everything else on disk is deliberately unindexed.
	await writeFile(
		path.join(orphanRoot, 'MEMORY.md'),
		[
			'# 索引', '', '## 功能模块索引（functions/）', '',
			'| 功能域 | 一句话状态 / 待验证 |', '|---|---|',
			'| [已索引功能](functions/已索引功能.md) | 进了索引 |',
			'', '## 创新优化思想索引（insights/）', '',
			'| 思想主题 | 一句话内涵 / 解决的权衡 |', '|---|---|',
			'| [已索引思想](insights/已索引思想.md) | 进了索引 |',
			'', '## 决策共识 / 规范', '', '- ', '',
		].join('\n'),
		'utf8',
	);
	const fnHead = (d) => `# 测试\n\n## 当前状态摘要（截至 ${d}）\n\n- 状态\n\n---\n\n## [${d}] 块\n\n- **概括**：一块\n`;
	await writeFile(path.join(orphanRoot, 'functions', '已索引功能.md'), fnHead('2026-10-20'), 'utf8');
	await writeFile(path.join(orphanRoot, 'functions', '未索引功能.md'), fnHead('2026-10-20'), 'utf8');
	await writeFile(
		path.join(orphanRoot, 'insights', '已索引思想.md'),
		'# 思想\n\n> 来源：[functions/已索引功能.md](../functions/已索引功能.md)\n\n## 核心原则\n\n- 一条原则。\n',
		'utf8',
	);
	await writeFile(
		path.join(orphanRoot, 'insights', '未索引思想.md'),
		'# 思想\n\n> 来源：[functions/已索引功能.md](../functions/已索引功能.md)\n\n## 核心原则\n\n- 一条原则。\n',
		'utf8',
	);
	// A third principle so the count-budget branch (3 > 2) can fire independently
	// of the single-source branch.
	await writeFile(
		path.join(orphanRoot, 'insights', '第三条思想.md'),
		'# 思想\n\n> 来源：[functions/已索引功能.md](../functions/已索引功能.md)、[functions/未索引功能.md](../functions/未索引功能.md)\n\n## 核心原则\n\n- 一条跨域原则。\n',
		'utf8',
	);
	await writeFile(path.join(orphanRoot, 'capabilities', '未索引能力.md'), '# 能力\n\n- 一句话\n', 'utf8');
	const oh = await mod.runHealthCheck(orphanRoot, { ...mod.DEFAULTS, newFeatureGraceDays: 0 });
	const orphanMsgs = oh.results.filter((r) => r.rule === 'R5' && r.message.includes('没有索引行'));
	ok(orphanMsgs.length === 1, `R5-orphan fires once for the batch (${oh.results.filter((r) => r.rule === 'R5').length} R5)`);
	const om = orphanMsgs[0]?.message ?? '';
	ok(om.includes('insights/未索引思想.md') && om.includes('functions/未索引功能.md') && om.includes('capabilities/未索引能力.md'), 'R5-orphan names every unindexed file across the three zones');
	ok(!om.includes('insights/已索引思想.md') && !om.includes('functions/已索引功能.md'), 'R5-orphan leaves indexed files alone');

	// A superseded principle must NOT be pushed into the index: indexing it would
	// inject an overturned principle into recall as if it were live. Its absence
	// is correct, so R5-orphan has to skip it (R23 excludes it from the budget
	// for the same reason).
	await writeFile(
		path.join(orphanRoot, 'insights', '已取代未索引.md'),
		'# 思想\n\n> ⚠️ 已被取代 → [第三条思想.md](第三条思想.md)（2026-10-20）。以下内容保留作为决策历史。\n\n> 来源：[functions/已索引功能.md](../functions/已索引功能.md)\n\n## 核心原则\n\n- 旧原则。\n',
		'utf8',
	);
	const withSup = await mod.runHealthCheck(orphanRoot, { ...mod.DEFAULTS, newFeatureGraceDays: 0 });
	const supMsg = withSup.results.find((r) => r.rule === 'R5' && r.message.includes('没有索引行'))?.message ?? '';
	ok(!supMsg.includes('已取代未索引'), 'R5-orphan does not demand an index row for a superseded principle');
	await rm(path.join(orphanRoot, 'insights', '已取代未索引.md'), { force: true });

	// R23 (a) count over budget: 3 live files > 2 with a lowered cap.
	const tiny = await mod.runHealthCheck(orphanRoot, { ...mod.DEFAULTS, newFeatureGraceDays: 0, insightBudget: { maxInsights: 2, maxSingleSourceShare: 0.6, minLedgerMisses: 3 } });
	ok(tiny.results.some((r) => r.rule === 'R23' && r.message.includes('条 > 预算')), 'R23 flags the insight count over budget');

	// R23 (b) single-source share: 2 of 3 insights cite ONE area -> 67% > 60%,
	// while the third cites two — the share is a ratio, not a per-file verdict.
	ok(
		tiny.results.some((r) => r.rule === 'R23' && r.message.includes('2/3 条只有 1 个来源域')),
		`R23 flags a single-source majority by ratio (${tiny.results.filter((r) => r.rule === 'R23').length} R23)`,
	);

	// R23 must NOT count a superseded principle: the stamp is decision history,
	// and if it consumed the budget then `supersedes` could never bring the layer
	// back under the cap — the one operation this check exists to enable.
	await writeFile(
		path.join(orphanRoot, 'insights', '已取代思想.md'),
		'# 思想\n\n> ⚠️ 已被取代 → [第三条思想.md](第三条思想.md)（2026-10-20）。以下内容保留作为决策历史。\n\n> 来源：[functions/已索引功能.md](../functions/已索引功能.md)\n\n## 核心原则\n\n- 旧原则。\n',
		'utf8',
	);
	const withSuperseded = await mod.runHealthCheck(orphanRoot, { ...mod.DEFAULTS, newFeatureGraceDays: 0, insightBudget: { maxInsights: 3, maxSingleSourceShare: 0.6, minLedgerMisses: 3 } });
	ok(
		!withSuperseded.results.some((r) => r.rule === 'R23' && r.message.includes('条 > 预算')),
		'a superseded principle does not consume the count budget',
	);
	await rm(path.join(orphanRoot, 'insights', '已取代思想.md'), { force: true });

	// R23 (c) dangling ledger hrefs: the ledger is the ONLY record of corrections
	// and confirmations, so a href whose file is gone loses that evidence silently.
	await writeFile(
		path.join(orphanRoot, '.usage.jsonl'),
		[
			JSON.stringify({ t: '2026-10-20T00:00:00.000Z', href: 'insights/已索引思想.md', kind: 'recall' }),
			JSON.stringify({ t: '2026-10-20T00:00:01.000Z', href: 'insights/改名前的思想.md', kind: 'correction' }),
			JSON.stringify({ t: '2026-10-20T00:00:02.000Z', href: 'insights/删除的思想.md', kind: 'positive' }),
			JSON.stringify({ t: '2026-10-20T00:00:03.000Z', href: 'functions/也不存在了.md', kind: 'recall' }),
			// Skill bundles live OUTSIDE the root: their absence is R20e's business,
			// never a dangling ledger href here.
			JSON.stringify({ t: '2026-10-20T00:00:04.000Z', href: 'skills/some-bundle/SKILL.md', kind: 'recall' }),
		].join('\n') + '\n',
		'utf8',
	);
	const lh = await mod.runHealthCheck(orphanRoot, { ...mod.DEFAULTS, newFeatureGraceDays: 0 });
	const ledgerMsg = lh.results.find((r) => r.rule === 'R23' && r.message.includes('.usage.jsonl'));
	ok(Boolean(ledgerMsg), 'R23 flags dangling ledger hrefs');
	ok(ledgerMsg.message.includes('3 个') && ledgerMsg.message.includes('改名前的思想'), `R23 counts only root-zone misses (${ledgerMsg?.message.slice(0, 60)})`);
	ok(!ledgerMsg.message.includes('some-bundle'), 'R23 never reports a skill bundle as a dangling ledger href');
	// Below the noise floor: a single miss is a rename in progress, not a defect.
	await writeFile(
		path.join(orphanRoot, '.usage.jsonl'),
		JSON.stringify({ t: '2026-10-20T00:00:01.000Z', href: 'insights/改名前的思想.md', kind: 'correction' }) + '\n',
		'utf8',
	);
	const oneMiss = await mod.runHealthCheck(orphanRoot, { ...mod.DEFAULTS, newFeatureGraceDays: 0 });
	ok(!oneMiss.results.some((r) => r.rule === 'R23' && r.message.includes('.usage.jsonl')), 'R23 stays silent under minLedgerMisses');
	await rm(orphanRoot, { recursive: true, force: true });
}

// 22c) R24's extraction prompt must be CLEARABLE. It counts laws per source area
// and suggests extracting a 道; but an area's law count only ever grows, so
// counting ALL laws made the prompt permanent — a check that can never go green
// is wallpaper, not a signal. Laws already claimed by a live dao no longer count.
{
	const daoRoot = await mkdtemp(path.join(tmpdir(), 'dsh-r24-'));
	await mkdir(path.join(daoRoot, 'functions'), { recursive: true });
	await mkdir(path.join(daoRoot, 'insights'), { recursive: true });
	await mkdir(path.join(daoRoot, 'dao'), { recursive: true });
	// MEMORY.md must exist: runHealthCheck returns early with R0 otherwise, and
	// every later assertion in this block would pass vacuously.
	await writeFile(
		path.join(daoRoot, 'MEMORY.md'),
		['# 索引', '', '## 功能模块索引（functions/）', '', '| 功能域 | 一句话状态 / 待验证 |', '|---|---|', '| [甲域](functions/甲域.md) | 甲的状态 |', '', '## 决策共识 / 规范', '', '- （空）', ''].join('\n'),
		'utf8',
	);
	await writeFile(path.join(daoRoot, 'functions', '甲域.md'), '# 甲\n\n## 当前状态摘要（截至 2026-10-20）\n\n- 状态\n\n---\n\n## [2026-10-20] 块\n\n- **概括**：一块\n', 'utf8');
	// 10 条法：5 条回链「甲域」且已被道认领，5 条回链「乙域」且无人认领。
	const law = (n, area) => `# 法${n}\n\n> 来源：[functions/${area}.md](../functions/${area}.md)\n\n## 核心原则\n\n- 原则 ${n}。\n`;
	for (let i = 1; i <= 10; i++) await writeFile(path.join(daoRoot, 'insights', `法${i}.md`), law(i, i <= 5 ? '甲域' : '乙域'), 'utf8');
	// A 道 that claims the five 甲域 laws.
	await writeFile(
		path.join(daoRoot, 'dao', '已认领之道.md'),
		[
			'# 道 · 已认领之道', '',
			'> 性质：道层。', '',
			'## 命题', '',
			'秩序与混乱会互相转化', '',
			'## 来源法', '',
			...Array.from({ length: 5 }, (_, i) => `- [法${i + 1}](../insights/法${i + 1}.md)`), '',
		].join('\n'),
		'utf8',
	);
	const r24 = await mod.runHealthCheck(daoRoot, { ...mod.DEFAULTS, newFeatureGraceDays: 0 });
	const prompt = r24.results.find((r) => r.rule === 'R24' && r.message.includes('尚未被任何道认领'))?.message ?? '';
	ok(prompt.includes('乙域') && prompt.includes('5 条未认领'), `R24 prompts only for unclaimed clusters (${prompt.slice(0, 60)})`);
	ok(!prompt.includes('甲域'), 'a fully claimed area is NOT suggested again (the prompt can go green)');
	// Claim the 乙域 laws too: the prompt must disappear entirely.
	await writeFile(
		path.join(daoRoot, 'dao', '已认领之道.md'),
		[
			'# 道 · 已认领之道', '',
			'> 性质：道层。', '',
			'## 命题', '',
			'秩序与混乱会互相转化', '',
			'## 来源法', '',
			...Array.from({ length: 10 }, (_, i) => `- [法${i + 1}](../insights/法${i + 1}.md)`), '',
		].join('\n'),
		'utf8',
	);
	const r24b = await mod.runHealthCheck(daoRoot, { ...mod.DEFAULTS, newFeatureGraceDays: 0 });
	ok(!r24b.results.some((r) => r.rule === 'R24' && r.message.includes('尚未被任何道认领')), 'R24 extraction prompt clears once every law is claimed');
	await rm(daoRoot, { recursive: true, force: true });
}

// 22c2) R5 and R24 must agree on what "the dao is registered" MEANS. The dao
// section registers its entries as bullets, and BOTH spellings occur in real
// roots; the heading's parenthetical also differs across roots. The table-only
// href scan said "never indexed" while R24/the panel said "right there" — two
// answers to one question.
for (const [form, bullet] of [
	['bold+正文 link', '- **被登记的道** — 命题是一句话（[正文](dao/被登记的道.md)）'],
	['link form (old gen)', '- **[被登记的道](dao/被登记的道.md)** — 命题是一句话（5 条法）'],
]) {
	const daoIdx = await mkdtemp(path.join(tmpdir(), 'dsh-r5dao-'));
	await mkdir(path.join(daoIdx, 'dao'), { recursive: true });
	await writeFile(
		path.join(daoIdx, 'dao', '被登记的道.md'),
		'# 道\n\n> 性质：道层。\n\n## 命题\n\n命题是一句话\n\n## 来源法\n\n- [a](../insights/a.md)\n- [b](../insights/b.md)\n- [c](../insights/c.md)\n- [d](../insights/d.md)\n- [e](../insights/e.md)\n',
		'utf8',
	);
	await writeFile(path.join(daoIdx, 'MEMORY.md'), ['# 索引', '', '## 道层（`dao/`）', '', bullet, '', '## 决策共识 / 规范', '', '- x', ''].join('\n'), 'utf8');
	const h = await mod.runHealthCheck(daoIdx, { ...mod.DEFAULTS, newFeatureGraceDays: 0 });
	ok(!h.results.some((r) => r.rule === 'R5' && r.message.includes('被登记的道')), `R5 accepts a bullet-registered dao (${form})`);
	await rm(daoIdx, { recursive: true, force: true });
}

// 2026-11-05：反向分叉反例。R24 曾用 `memText.includes('dao/x.md')` 裸子串，
// 于是「共识区里随口提到该路径」也算已登记 —— R5（结构化解析）报 orphan、
// R24 沉默，同一个问题两处检查结论相反。现在两者必须都报未登记。
{
	const ghostRoot = await mkdtemp(path.join(tmpdir(), 'dsh-r24ghost-'));
	await mkdir(path.join(ghostRoot, 'dao'), { recursive: true });
	await writeFile(
		path.join(ghostRoot, 'dao', '幽灵之道.md'),
		'# 道\n\n> 性质：道层。\n\n## 命题\n\n命题是一句话\n\n## 来源法\n\n- [a](../insights/a.md)\n- [b](../insights/b.md)\n- [c](../insights/c.md)\n- [d](../insights/d.md)\n- [e](../insights/e.md)\n',
		'utf8',
	);
	// 只在共识区提一句路径，道层小节里没有任何登记行。
	await writeFile(
		path.join(ghostRoot, 'MEMORY.md'),
		['# 索引', '', '## 道层（`dao/`）', '', '## 决策共识 / 规范', '', '- 讨论时提到过 dao/幽灵之道.md，但没有登记它', ''].join('\n'),
		'utf8',
	);
	const gh = await mod.runHealthCheck(ghostRoot, { ...mod.DEFAULTS, newFeatureGraceDays: 0 });
	ok(gh.results.some((r) => r.rule === 'R5' && r.message.includes('幽灵之道')), 'R5 报 orphan：共识区随口一提不算索引行');
	// 必须匹配「没有写进 MEMORY.md」这条特定措辞：只查文件名会被 R24 的
	// 「依据不足」告警误命中，那种断言在自己骗自己（绿灯不携带信息）。
	ok(
		gh.results.some((r) => r.rule === 'R24' && r.message.includes('没有写进 MEMORY.md') && r.message.includes('幽灵之道')),
		'R24 也报未登记——与 R5 同源，不再沉默（旧裸子串会漏）',
	);
	await rm(ghostRoot, { recursive: true, force: true });
}

// 22d) memory_dao 的**写入路径**：此前 execute 从未被任何测试调用过——重复来源能凑数、
// 上限口径与 R24 不一致、description 承诺写 MEMORY.md 却不写，三者都因此长期无人发现。
{
	const lawSlugs = [];
	for (let i = 1; i <= 5; i++) {
		const slug = `道源${i}`;
		await T.memory_insight.execute({ theme: slug, principle: `原则 ${i}：这件事总是不声不响地坏掉`, summary: `道源 ${i}`, sources: ['测试功能', '检索目标'] }, exec);
		lawSlugs.push(slug);
	}
	// 同一条法写 5 遍：硬闸门必须拒绝（这条此前是唯一能过的路）
	let dupThrew = 0;
	try {
		await T.memory_dao.execute({ name: '重复来源道', proposition: '秩序与混乱会互相转化，各自演化出不同的结构', extractedFrom: [lawSlugs[0], lawSlugs[0], lawSlugs[0], lawSlugs[0], lawSlugs[0]], body: '## 三种形态\n\n- 一种：自证。\n- 两种：外物。\n\n## 依据展开\n\n这几条法共同指向同一件事，因此合起来成为一条道。\n\n## 边界\n\n- 当产出者不在回路之内时，此判据不成立。\n' }, exec);
	} catch {
		dupThrew++;
	}
	ok(dupThrew === 1, 'memory_dao rejects duplicate-only sources through the real execute path');
	// 候选写入走真实插件工具，并登记到同一个自定义记忆根。
	await T.memory_dao.execute({ name: '集成候选', status: 'candidate', proposition: '秩序与混乱会互相转化，各自演化出不同的结构', extractedFrom: lawSlugs, body: '## 三种形态\n\n- 一种：自证。\n- 两种：外物。\n\n## 依据展开\n\n这几条法共同指向同一件事，因此合起来成为一条道。\n\n## 边界\n\n- 当产出者不在回路之内时，此判据不成立。\n' }, exec);
	const { readLedger: readCandidateLedger, contentHash: candidateHash } = await import('./src/write-ledger.js');
	const candidateText = await readFile(path.join(root, 'dao', '_candidates', '集成候选.md'), 'utf8');
	ok((await readCandidateLedger(root))?.get('dao/_candidates/集成候选.md')?.hash === candidateHash(candidateText), 'candidate tool records nested write under configured memory root');
	// 5 条不同的法 → 写入 dao/<name>.md
	await T.memory_dao.execute({ name: '集成之道', proposition: '秩序与混乱会互相转化，各自演化出不同的结构', extractedFrom: lawSlugs, body: '## 三种形态\n\n- 一种：自证。\n- 两种：外物。\n\n## 依据展开\n\n这几条法共同指向同一件事，因此合起来成为一条道。\n\n## 边界\n\n- 当产出者不在回路之内时，此判据不成立。\n' }, exec);
	ok(await statExists(path.join(root, 'dao', '集成之道.md')), 'memory_dao writes dao/<name>.md through the execute path');
	// 工具不写 MEMORY.md（description 曾谎称会写），所以体检必须点名未被登记的道
	const cDao = await T.memory_check.execute({}, exec);
	ok(cDao.results.some((r) => r.rule === 'R24' && r.message.includes('集成之道')), 'R24 flags a dao that never made it into the index');
	// 手工造一个没有「## 命题」小节的 dao：抽象度检查整条被跳过，必须点名
	await writeFile(path.join(root, 'dao', '无标题之道.md'), '# 道 · 无标题\n\n这条没有命题小节，抽象度检查会整条跳过。\n', 'utf8');
	const cHead = await T.memory_check.execute({}, exec);
	ok(cHead.results.some((r) => r.rule === 'R24' && r.message.includes('无标题之道')), 'R24 flags a dao without a 命题 section (the check used to skip it silently)');
	// dao 必须像其他层一样**可读、可数、可搜、可记证据**。此前它只被 memory_dao 与
	// R24 认识：能写但读不到，是「半个功能」。这几条断言锁住整条接线。
	const daoRead = await T.memory_read.execute({ kind: 'dao', name: '集成之道' }, exec);
	ok(daoRead.found && String(daoRead.content).includes('秩序与混乱会互相转化'), 'memory_read(kind=dao) reads the file');
	const daoList = await T.memory_read.execute({ kind: 'dao' }, exec);
	ok(daoList.listing.some((x) => x.name === '集成之道'), 'memory_read(kind=dao) lists the layer');
	// 每个 kind 必须读**自己**的目录。旧实现的 kind→目录是嵌套三元、默认分支是
	// capabilities/，于是新增 kind 会静默读到能力台账——找不到就报「记忆还是空的」。
	const kindDirs = { function: 'functions', insight: 'insights', dao: 'dao', capability: 'capabilities' };
	const wrongDir = [];
	for (const [k, dir] of Object.entries(kindDirs)) {
		const r = await T.memory_read.execute({ kind: k, name: '集成之道' }, exec);
		const p = String(r.path ?? '').replace(/\\/g, '/');
		if (r.found || p.includes(`/${dir}/`)) continue;
		wrongDir.push(`${k}→${p}`);
	}
	ok(wrongDir.length === 0, `every memory_read kind resolves its OWN directory (${wrongDir.join(', ') || 'all correct'})`);
	// 空分区 ≠ 空记忆库。dao/ 收敛后为空是闸门给出的正确答案（法层只有 4 条，
	// 凑不够 5 条），但旧文案对任何空分区都说「记忆还是空的——先记录第一次迭代」，
	// 会让人以为整库数据丢了。本块的 dao/ 已被上面的用例写入，所以直接构造
	// render 的输入（空 listing + 路径是分区目录）来测文案分支。
	{
		const fake = { found: false, path: path.join(root, 'dao'), content: '', listing: [] };
		const emptyMsg = T.memory_read.output.render({}, fake).map((b) => b.text).join('');
		ok(!emptyMsg.includes('记忆还是空的'), `an empty zone does not claim the whole memory is empty (${emptyMsg.slice(0, 36)}…)`);
		ok(emptyMsg.includes('这个分区还是空的'), 'an empty zone says only that zone is empty');
	}
	ok((await mod.zoneCounts(root, skillRoot)).dao >= 1, 'zoneCounts counts the dao layer (the rail badge used to miss it)');
	const daoSearch = await T.memory_search.execute({ q: '互相转化', zone: 'dao' }, exec);
	ok(daoSearch.hits.length >= 1 && daoSearch.hits.every((h) => h.zone === 'dao'), 'memory_search accepts zone=dao');
	await T.memory_usage.execute({ action: 'record', href: 'dao/集成之道.md', kind: 'positive', note: '道层也能留证据' }, exec);
	const daoUsage = await T.memory_usage.execute({ action: 'report', days: 30 }, exec);
	ok(daoUsage.items.some((i) => i.href === 'dao/集成之道.md'), 'the usage ledger accepts dao/ hrefs');
}

// 22e) R25: a batch of evidence-bearing files disappearing must be reported.
// Real incident (2026-10-27): a deliberate "insight layer consolidation" deleted
// 24 files (insights 25→4, dao 3→0) and memory_check reported only an unrelated
// R14 — the deletion itself was silent. Deliberate or accidental, the health
// check cannot tell them apart, so it must at least say something.
{
	const vanishRoot = await mkdtemp(path.join(tmpdir(), 'dsh-r25-'));
	await mkdir(path.join(vanishRoot, 'functions'), { recursive: true });
	await mkdir(path.join(vanishRoot, 'insights'), { recursive: true });
	await writeFile(path.join(vanishRoot, 'MEMORY.md'), ['# 索引', '', '## 功能模块索引（functions/）', '', '| 功能域 | 一句话状态 |', '|---|---|', '| [保留域](functions/保留域.md) | 留着 |', ''].join('\n'), 'utf8');
	await writeFile(path.join(vanishRoot, 'functions', '保留域.md'), '# 保留域\n\n## 当前状态摘要（截至 2026-10-27）\n\n- 状态\n', 'utf8');
	// Ledger records evidence for four files; all four exist right now.
	const names = ['消失一', '消失二', '消失三', '消失四'];
	for (const n of names) await writeFile(path.join(vanishRoot, 'functions', `${n}.md`), `# ${n}\n\n## 当前状态摘要（截至 2026-10-27）\n\n- 状态\n`, 'utf8');
	const ledger = ['保留域', ...names].map((n, i) => JSON.stringify({ t: `2026-10-2${i}T00:00:00.000Z`, href: `functions/${n}.md`, kind: 'read' }));
	await writeFile(path.join(vanishRoot, '.usage.jsonl'), ledger.join('\n') + '\n', 'utf8');
	const before = await mod.runHealthCheck(vanishRoot, { ...mod.DEFAULTS, newFeatureGraceDays: 0 });
	ok(!before.results.some((r) => r.rule === 'R25'), 'R25 silent when the evidence files still exist');
	// Now "consolidate": the four files are gone, the ledger still remembers them.
	for (const n of names) await rm(path.join(vanishRoot, 'functions', `${n}.md`), { force: true });
	const r25 = await mod.runHealthCheck(vanishRoot, { ...mod.DEFAULTS, newFeatureGraceDays: 0 });
	ok(r25.results.some((r) => r.rule === 'R25' && r.message.includes('消失一')), 'R25 flags evidence-bearing files that vanished');
	// Rewriting the ledger to point at the survivor is the CORRECT consolidation
	// (evidence moved, nothing lost) — and then the check must fall silent.
	await writeFile(path.join(vanishRoot, '.usage.jsonl'), ledger.map((l) => l.replace(/functions\/消失[一二三四]\.md/g, 'functions/保留域.md')).join('\n') + '\n', 'utf8');
	const after = await mod.runHealthCheck(vanishRoot, { ...mod.DEFAULTS, newFeatureGraceDays: 0 });
	ok(!after.results.some((r) => r.rule === 'R25'), 'R25 clears once the ledger is redirected to the surviving file');
	await rm(vanishRoot, { recursive: true, force: true });
}

// R26 must scan nested files, report missing records, and keep failed scans unknown.
{
	const auditRoot = await mkdtemp(path.join(tmpdir(), 'dsh-r26-recursive-'));
	try {
		await mkdir(path.join(auditRoot, 'dao', '_candidates'), { recursive: true });
		await mkdir(path.join(auditRoot, 'functions'), { recursive: true });
		await writeFile(path.join(auditRoot, 'MEMORY.md'), '# 索引\n');
		const candidateKey = 'dao/_candidates/候选.md';
		await writeFile(path.join(auditRoot, ...candidateKey.split('/')), '# 变动后的候选\n');
		// ENOTDIR is deterministic even when tests run as an administrator.
		await writeFile(path.join(auditRoot, 'capabilities'), 'not a directory');
		await symlink(path.join(auditRoot, 'functions'), path.join(auditRoot, 'dao', '关联目录'), process.platform === 'win32' ? 'junction' : 'dir');
		const records = [
			{ key: candidateKey, hash: 'stale' },
			{ key: 'functions/消失.md', hash: 'old' },
			{ key: 'capabilities/状态未知.md', hash: 'old' },
			{ key: 'dao/关联目录/状态未知.md', hash: 'old' },
			{ key: 'functions/未完成.md', op: 'delete_intent', id: 'pending' },
			{ key: 'functions/已删除.md', op: 'delete_intent', id: 'done' },
			{ key: 'functions/已删除.md', op: 'delete', id: 'done' },
			{ key: 'functions/重现.md', op: 'delete_intent', id: 'reappear' },
			{ key: 'functions/重现.md', op: 'delete', id: 'reappear' },
		];
		await writeFile(path.join(auditRoot, 'functions', '重现.md'), 'again');
		await writeFile(path.join(auditRoot, '.write-ledger.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
		const report = await mod.runHealthCheck(auditRoot, { ...mod.DEFAULTS, newFeatureGraceDays: 0 });
		const findings = report.results.filter((r) => r.rule === 'R26').map((r) => r.message);
		ok(findings.some((m) => m.includes(candidateKey) && m.includes('不符')), 'R26 scans nested candidate files and detects mismatches');
		ok(findings.some((m) => m.includes('functions/消失.md') && m.includes('不存在')), 'R26 reports recorded files absent from the filesystem');
		ok(findings.some((m) => m.includes('functions/未完成.md') && m.includes('未完成')), 'R26 reports an unfinished deletion as unknown');
		ok(!findings.some((m) => m.includes('functions/已删除.md') && m.includes('不存在')), 'R26 accepts a recorded completed deletion');
		ok(findings.some((m) => m.includes('functions/重现.md') && m.includes('文件存在')), 'R26 reports a deleted path that reappears');
		ok(findings.some((m) => m.includes('capabilities') && m.includes('状态未知')), 'R26 reports directory scan errors as unknown');
		ok(!findings.some((m) => m.includes('capabilities/状态未知.md') && m.includes('不存在')), 'R26 never calls an unreadable subtree missing');
		ok(findings.some((m) => m.includes('dao/关联目录') && m.includes('符号链接') && m.includes('状态未知')), 'R26 reports unscanned links as unknown');
		ok(!findings.some((m) => m.includes('dao/关联目录/状态未知.md') && m.includes('不存在')), 'R26 never calls entries beneath an unscanned link missing');
		ok(!findings.some((m) => /插件之外|外部.*写入|外部.*修改/.test(m)), 'R26 does not claim who wrote a mismatched file');
	} finally {
		await rm(auditRoot, { recursive: true, force: true });
	}
}

// Interrupted deletion and same-path races are tested against an isolated root.
{
	const isolated = await mkdtemp(path.join(tmpdir(), 'dsh-delete-events-'));
	try {
		const { recordDeleteEvent, readLedger } = await import('./src/write-ledger.js');
		const { writeText } = await import('./src/util.js');
		await mkdir(path.join(isolated, 'functions'), { recursive: true });
		await writeFile(path.join(isolated, 'MEMORY.md'), '# index\n');
		const first = path.join(isolated, 'functions', '完成失败.md');
		await writeText(first, 'source', { memoryRoot: isolated });
		let failure = '';
		try { await mod.deleteTrackedFile(isolated, first, 'source', { writeEvent: (root, e) => e.op === 'delete' ? false : recordDeleteEvent(root, e) }); } catch (e) { failure = e.message; }
		ok(failure.includes('已删除') && failure.includes('记账结果未知') && failure.includes('不要盲目重试') && !await statExists(first), 'failed completion explicitly reports deletion and unknown ledger outcome');
		ok((await readLedger(isolated))?.get('functions/完成失败.md')?.op === 'delete_intent', 'failed completion leaves an incomplete intent');
		const report = await mod.runHealthCheck(isolated, { ...mod.DEFAULTS, newFeatureGraceDays: 0 });
		ok(report.results.some((r) => r.rule === 'R26' && r.message.includes('完成失败.md') && r.message.includes('未完成')), 'R26 reports incomplete deletion after completion append failure');
		const second = path.join(isolated, 'functions', '意图失败.md');
		await writeText(second, 'source', { memoryRoot: isolated });
		failure = '';
		try { await mod.deleteTrackedFile(isolated, second, 'source', { writeEvent: async () => false }); } catch (e) { failure = e.message; }
		ok(failure.includes('删除尚未执行') && failure.includes('意图记账结果未知') && failure.includes('不要盲目重试') && await readFile(second, 'utf8') === 'source', 'failed intent append preserves source and reports unknown ledger outcome');
		const third = path.join(isolated, 'functions', '发生竞争.md');
		await writeText(third, 'source', { memoryRoot: isolated });
		failure = '';
		try { await mod.deleteTrackedFile(isolated, third, 'source', { writeEvent: async (root, e) => { const ok = await recordDeleteEvent(root, e); if (e.op === 'delete_intent') await writeFile(third, 'changed by other writer'); return ok; } }); } catch (e) { failure = e.message; }
		ok(failure.includes('发生变化') && await readFile(third, 'utf8') === 'changed by other writer', 'concurrent change observed after intent is not deleted');
		ok((await readLedger(isolated))?.get('functions/发生竞争.md')?.op === 'delete_intent', 'concurrent change leaves deletion state unknown');
		const target = path.join(isolated, 'functions', '目标竞争.md');
		await writeText(target, 'newer', { memoryRoot: isolated });
		failure = '';
		try { await mod.writeRenameTarget(isolated, target, 'older', 'merged'); } catch (e) { failure = e.message; }
		ok(failure.includes('发生变化') && await readFile(target, 'utf8') === 'newer', 'rename target changed since read is not overwritten');
		const fourth = path.join(isolated, 'functions', '同进程写入.md');
		await writeText(fourth, 'old', { memoryRoot: isolated });
		let concurrent;
		await mod.deleteTrackedFile(isolated, fourth, 'old', { writeEvent: async (root, e) => { const ok = await recordDeleteEvent(root, e); if (e.op === 'delete_intent') concurrent = writeText(fourth, 'new', { memoryRoot: isolated }); return ok; } });
		await concurrent;
		ok(await readFile(fourth, 'utf8') === 'new' && (await readLedger(isolated))?.get('functions/同进程写入.md')?.hash, 'same-process write is serialized after delete and remains recorded');
	} finally { await rm(isolated, { recursive: true, force: true }); }
}

// 23) memory_skill — the crystallization layer (MemOS-borrowed, file-discipline
// adapted): nomination is mechanical over the usage ledger, crystallization is
// the model's judgement, and the lifecycle candidate→active→retired decides what
// proactive recall is allowed to trust. Signals recorded via memory_usage(record)
// (awaited) so the ledger is complete before nomination runs.
// The nominated area gets a real function file first: a skill must cite a
// source that exists (else R10 dangles), and the same slug as the nominated
// href is what proves de-nomination is keyed on the EVIDENCE, not the name.
await T.memory_write.execute({ feature: '分离延迟重启', title: '建立被提名域', summary: '反复重跑的操作，等待结晶', result: 'done' }, exec);
// NOMINATION COUNTS ENGAGEMENT, NOT EXPOSURE (2026-10-27): this fixture used to
// reach the >=6 use floor with recalls alone — i.e. the plugin could nominate a
// procedure for crystallization purely by having injected it, without the model
// ever opening it. Reads + verdicts are what a "repeatedly re-run procedure"
// actually looks like.
for (let i = 0; i < 6; i++) await US.execute({ action: 'record', href: 'functions/分离延迟重启.md', kind: i < 2 ? 'positive' : 'read' }, exec);
// Exposure with no engagement must NOT nominate, however large it gets.
for (let i = 0; i < 20; i++) await US.execute({ action: 'record', href: 'functions/只被召回域.md', kind: 'recall' }, exec);
for (let i = 0; i < 4; i++) await US.execute({ action: 'record', href: 'functions/弱信号域.md', kind: 'recall' }, exec);
await US.execute({ action: 'record', href: 'functions/弱信号域.md', kind: 'correction' }, exec);
const sk1 = await T.memory_skill.execute({ action: 'candidates' }, exec);
ok(sk1.candidates.some((c) => c.href === 'functions/分离延迟重启.md' && c.uses >= 6 && c.positives >= 1), `nomination lists a high-engagement confirmed area (${sk1.candidates.length})`);
ok(!sk1.candidates.some((c) => c.href === 'functions/弱信号域.md'), 'nomination skips low-usage / corrected areas');
ok(!sk1.candidates.some((c) => c.href === 'functions/只被召回域.md'), 'nomination ignores pure recall exposure (the self-reference fix)');
const skCry = await T.memory_skill.execute(
	{
		action: 'crystallize',
		name: 'detached-restart',
		summary: '会话跑在宿主内时用分离进程延迟杀旧起新',
		when: '需要让 DSH server 半新代码生效、而当前会话正运行在该宿主里时',
		procedure: ['写独立脚本：Start-Sleep 数秒 → Stop-Process 旧 PID → 启动 start-web.cmd', '会话内以分离后台任务启动脚本并立即结束当前回合', '刷新页面确认新 PID 启动时间晚于新提交'],
		pitfalls: '旧代进程可能在重启窗口写入过期数据，重启后复核',
		verification: 'overview 返回 200 且新 PID 创建时间晚于目标提交',
		sources: ['functions/分离延迟重启.md'],
	},
	exec,
);
ok(skCry.created && skCry.status === 'candidate' && skCry.file.replace(/\\/g, '/').endsWith('detached-restart/SKILL.md'), 'crystallize writes a candidate skill bundle');
const skText = await readFile(skCry.file, 'utf8');
ok(skText.includes('## 调用步骤') && /^\s*1[.、]/m.test(skText), 'skill body has numbered procedure steps');
// Evidence link is ABSOLUTE into the memory root (5.27.0): the bundle lives at
// <skillRoot>/<name>/, OUTSIDE the memory root, so the old `../functions/x.md`
// resolved to <skillRoot>/functions/x.md — a path that never exists (R10 was
// blind to it until the audit). Assert the href lands on a REAL file: the whole
// point of the change, not just its spelling.
const memRootUrl = 'file:///' + root.replace(/\\/g, '/');
ok(skText.includes(`${memRootUrl}/functions/分离延迟重启.md`), 'skill backlinks its evidence source with an absolute memory-root href');
ok(!(await statExists(path.join(skillRoot, 'functions'))) && (await statExists(path.join(root, 'functions', '分离延迟重启.md'))), 'the linked target exists in the memory root, not beside the bundle');
// Regression (5.16.4, found on the REAL root): a bare-slug source ("x") was
// emitted as `../x` — the zone prefix was stripped for the label and forgotten
// for the href, so R10 flagged the skill file dangling. Callers pass bare slugs
// as often as zone paths, and the existing fixture only used the path form.
const skBare = await T.memory_skill.execute(
	{
		action: 'crystallize',
		name: 'bare-source-skill',
		summary: '验证裸 slug 回链',
		when: '回归裸来源时',
		procedure: ['步骤一：打开文件', '步骤二：确认回链'],
		verification: '回链能解析',
		sources: ['测试功能', 'insights/闭环验证', 'functions/分离延迟重启.md'],
	},
	exec,
);
const skBareText = await readFile(skBare.file, 'utf8');
ok(skBareText.includes(`${memRootUrl}/functions/测试功能.md`), 'bare slug resolves to functions/ in the href');
ok(skBareText.includes(`${memRootUrl}/insights/闭环验证.md`), 'zone-prefixed source keeps its zone');
ok((skBareText.match(new RegExp(`${memRootUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/functions/分离延迟重启\\.md`, 'g')) ?? []).length === 1 && !skBareText.includes('.md.md'), 'x.md tolerates to one .md and no doubling');
ok(!skBareText.includes('](../测试功能.md)'), 'no zone-less bare href survives');
{
	const cSk = await T.memory_check.execute({}, exec);
	ok(!cSk.results.some((r) => r.rule === 'R10' && r.level === 'FAIL' && r.message.includes('裸来源技能')), 'crystallized skill links resolve (no R10)');
}
// The frontmatter router (skill-creator lesson): description carries the WHEN.
ok(/^---\nname: detached-restart\n/m.test(skText) && /^description: "当.*时使用本技能/m.test(skText), 'skill file is frontmatter-shaped with a router description');
ok(skText.includes('agent_created: true') && skText.includes('status: candidate'), 'frontmatter carries agent_created + status');
// 5.23.0 — the skill-creator workflow is MANDATORY for crystallizing: the
// discipline text must say so (the model reads it every session), the tool
// description must name the six steps, and the template must carry the
// 程序体 pointer section (one body, the host bundle, not two).
ok(mod.DISCIPLINE_TEXT.includes('skill-creator') && mod.DISCIPLINE_TEXT.includes('quick_validate.py') && mod.DISCIPLINE_TEXT.includes('init_skill.py'), 'the discipline text mandates the skill-creator workflow');
ok(/init_skill\.py/.test(T.memory_skill.description) && /Quality Bar/.test(T.memory_skill.description) && /host bundle/i.test(T.memory_skill.description), 'the tool description names the skill-creator steps and the one-storage rule');
// The daily RAW layer carries ONE light filter (the user's ruling: execution
// logs already live in the transcript and the log files — copying them here
// dilutes the distillation feed). Both surfaces the model sees must say it:
// the injected discipline text AND the template line written into a fresh day.
ok(mod.DISCIPLINE_TEXT.includes('执行式日志') && mod.DISCIPLINE_TEXT.includes('不要抄'), 'the discipline text carries the daily-filter rule');
{
	const { dailyTemplate } = await import(new URL('./src/markdown.js', import.meta.url).href);
	const dt = dailyTemplate('2026-10-21');
	ok(dt.includes('执行式日志') && dt.includes('只能通过插件采集写入') && dt.includes('不自动记录助手'), 'a fresh daily log states collection source, limits and execution-log filter');
}
// 5.24.0: a skill IS the host bundle — no bundlePath arg, no pointer section.
ok(!('bundlePath' in (T.memory_skill.parameters ?? {})) && !('hostName' in (T.memory_skill.parameters ?? {})), 'obsolete skill fields are gone (bundlePath/hostName)');
const skBundle = await T.memory_skill.execute(
	{ action: 'crystallize', name: 'bundle-path-skill', summary: '包路径回归', when: '包路径回归', procedure: ['一', '二'], verification: '写入宿主包', sources: ['测试功能'] },
	exec,
);
ok(skBundle.file.replace(/\\/g, '/').endsWith('bundle-path-skill/SKILL.md'), 'crystallize writes into the host bundle layout');
const skIdx = await T.memory_read.execute({ kind: 'index' }, exec);
ok(rowsFor(skIdx.content, 'detached-restart').length === 1 && /detached-restart\/SKILL\.md/.test(skIdx.content), 'skill row lands in the index table (bundle path)');
// 5.27.0 (adversarial audit) — the skill body no longer carries a 使用记录
// section: every activate/retire used to append a dated line, growing the body
// with use while a skill must stay the CURRENT procedure.
ok(!skText.includes('## 使用记录'), 'crystallized body has no 使用记录 section (lifecycle is status: only)');
// RENDER PROJECTION is part of the contract: the host calls output.render after
// EVERY success, and the audit caught `p is not defined` turning a landed write
// into an "invalid output" rejection. Execute-alone tests never walked this —
// each of the four action receipts must render without throwing.
{
	const cryParts = T.memory_skill.output.render({ action: 'crystallize', name: 'bundle-path-skill' }, skBundle);
	ok(Array.isArray(cryParts) && cryParts[0].text.includes('已结晶技能') && cryParts[0].text.includes('目录包已写入'), 'the crystallize receipt renders (the audit p-not-defined regression is locked)');
}
// Ownership gate: an existing NON-owned bundle is never overwritten.
await mkdir(path.join(skillRoot, 'foreign-skill'), { recursive: true });
await writeFile(path.join(skillRoot, 'foreign-skill', 'SKILL.md'), '---\nname: foreign-skill\ndescription: d\n---\n\n# 外来技能，不是我们结晶的\n', 'utf8');
let ownThrew = false;
try {
	await T.memory_skill.execute({ action: 'crystallize', name: 'foreign-skill', summary: 's', when: 'w', procedure: ['一', '二'], verification: 'v', sources: ['测试功能'] }, exec);
} catch (e) {
	ownThrew = /不是本插件结晶/.test(String(e?.message));
}
ok(ownThrew, 'crystallize refuses to overwrite a foreign (non-agent_created) bundle');
// The evidence gate: activation with zero usage signal AND no note throws —
// "only after the procedure was actually followed" is code now, not prose. The
// source area must be one NOTHING has read/confirmed: a memory_write creates the
// file but is NOT a usage signal, so the skill's evidence base stays empty.
await T.memory_write.execute({ feature: '闸门零信号源', title: 't', summary: 's', change: 'c', result: 'done' }, exec);
await T.memory_skill.execute({ action: 'crystallize', name: 'gate-skill', summary: '闸门回归', when: '闸门回归', procedure: ['一', '二'], verification: 'v', sources: ['闸门零信号源'] }, exec);
let gateThrew = false;
try {
	await T.memory_skill.execute({ action: 'activate', name: 'gate-skill' }, exec);
} catch (e) {
	gateThrew = /转正需要证据/.test(String(e?.message));
}
ok(gateThrew, 'activate without evidence throws (the ⭐ gate is mechanical)');
// The explicit-carrier path: a note carries it, visibly warned, and the same
// call again with the note flips the status.
const gateNote = await T.memory_skill.execute({ action: 'activate', name: 'gate-skill', note: '2026-10-21 会话里按此程序跑通一次' }, exec);
ok(gateNote.status === 'active' && gateNote.warnings.some((w) => w.includes('仅凭 note')), 'note-carried activation works and declares its weak evidence');
// Re-crystallization archives the superseded body before overwriting it —
// receipts promised "git is the archive" while the skill store is NOT a repo.
const reCry = await T.memory_skill.execute({ action: 'crystallize', name: 'bundle-path-skill', summary: '包路径回归（重结晶）', when: '包路径回归', procedure: ['一', '二'], verification: '写入宿主包', sources: ['测试功能'] }, exec);
const histDir = path.join(skillRoot, '.history');
const { readdir: rdTmp } = await import('node:fs/promises');
const histFiles = (await rdTmp(histDir).catch(() => [])).filter((n) => n.startsWith('bundle-path-skill-'));
ok(reCry.warnings.some((w) => w.includes('.history')) && histFiles.length === 1, 're-crystallize archives the old body to .history/ before overwriting');
const archived = await readFile(path.join(histDir, histFiles[0]), 'utf8');
ok(archived.includes('包路径回归') && !archived.includes('重结晶'), 'the archive holds the PREVIOUS body, not the new one');
// A crystallized area must drop out of nomination (support is now filed).
const sk2 = await T.memory_skill.execute({ action: 'candidates' }, exec);
ok(!sk2.candidates.some((c) => c.href === 'functions/分离延迟重启.md'), 'already-crystallized area is not re-nominated');
// Recall gate: candidate is NOT recallable, active is, retired is not.
// The skill's identity is its kebab bundle name now, so the query tokens must
// match that name (the summary still carries the Chinese wording).
const qTok = mod.tokensOf('detached restart 宿主');
const rowsCand = mod.matchIndexRows(skIdx.content, qTok);
ok(!rowsCand.some((r) => r.zone === 'skill'), 'candidate skill is filtered out of recall');
const skAct = await T.memory_skill.execute({ action: 'activate', name: 'detached-restart', note: '真实任务照做成功（本会话）' }, exec);
ok(skAct.status === 'active', 'activate flips lifecycle to active');
const idxAfterAct = (await T.memory_read.execute({ kind: 'index' }, exec)).content;
const rowsActive = mod.matchIndexRows(idxAfterAct, qTok);
ok(rowsActive.some((r) => r.zone === 'skill' && r.name === 'detached-restart'), 'active skill is recallable (identified by bundle dir name)');
const actMsgText = mod.buildRecallMessage(rowsActive).content[0].text;
ok(actMsgText.includes('⭐ 已结晶技能') && actMsgText.includes('按程序步骤执行'), 'recall message marks the active skill with a do-not-rederive hint');
const skRet = await T.memory_skill.execute({ action: 'retire', name: 'detached-restart', note: '宿主改为热重载，程序失效' }, exec);
ok(skRet.status === 'retired', 'retire flips lifecycle to retired');
const idxAfterRet = (await T.memory_read.execute({ kind: 'index' }, exec)).content;
ok(!mod.matchIndexRows(idxAfterRet, mod.tokensOf('分离延迟重启 宿主')).some((r) => r.zone === 'skill'), 'retired skill leaves recall');
// Lint + input guards.
let skThrew = 0;
for (const a of [
	{ action: 'crystallize', name: 'x', summary: 's', when: 'w', procedure: ['only one step'], verification: 'v', sources: ['functions/a.md'] },
	{ action: 'crystallize', name: 'x', summary: 's', when: 'w', procedure: ['a', 'b'], verification: 'v' },
	{ action: 'activate', name: '不存在技能' },
]) {
	try {
		await T.memory_skill.execute(a, exec);
	} catch {
		skThrew++;
	}
}
ok(skThrew === 3, `crystallize/activate validate their inputs (${skThrew}/3)`);
// delete (5.21.0): removes BOTH the file and the index row — a lingering row
// would be a dangling pointer the next recall trusts. Also refuses a name that
// is not there (400, not a silent success).
await T.memory_skill.execute(
	{ action: 'crystallize', name: 'to-delete-skill', summary: '删除断言', when: '删除回归', procedure: ['一', '二'], verification: '文件与行俱消', sources: ['测试功能'] },
	exec,
);
const delOk = await T.memory_skill.execute({ action: 'delete', name: 'to-delete-skill' }, exec);
ok(delOk.status === 'deleted' && delOk.items.length === 0, 'delete reports the terminal status');
const gone = !(await statExists(path.join(skillRoot, 'to-delete-skill/SKILL.md')));
ok(gone, 'the skill file is gone');
const idxAfterDel = await readFile(path.join(root, 'MEMORY.md'), 'utf8');
ok(!idxAfterDel.includes('| [待删技能]'), 'the index row is gone with it');
let delThrew = false;
try {
	await T.memory_skill.execute({ action: 'delete', name: '不存在技能abc' }, exec);
} catch {
	delThrew = true;
}
ok(delThrew, 'deleting a missing skill throws');
// 5.24.0 — skills live ONLY as host bundles. A file left in the memory root's
// skills/ is a second body for the same skill, so the audit flags it for
// removal instead of validating its shape (the old R20 field audit moved to
// skill-creator's quick_validate.py, which the bundle itself must pass).
await mkdir(path.join(root, 'skills'), { recursive: true });
await writeFile(path.join(root, 'skills', 'legacy-layout.md'), '---\nname: legacy-layout\nagent_created: true\nstatus: active\n---\n\n# 旧布局残留\n', 'utf8');
const cSk = await T.memory_check.execute({}, exec);
const r20 = cSk.results.filter((r) => r.rule === 'R20');
ok(r20.some((r) => r.message.includes('旧布局残留')), 'R20 flags a leftover memory-root skill file');
ok(r20.some((r) => r.message.includes('宿主目录包')), 'the leftover warning names the real storage location');
await rm(path.join(root, 'skills'), { recursive: true, force: true });
// The obsolete pointer machinery is gone for good: no field can resurrect a
// second body, and the tool schema no longer offers the knobs.
ok(!('hostName' in T.memory_skill.parameters) && !('bundlePath' in T.memory_skill.parameters), 'the pointer-era fields are gone from the schema');

// 24) host skill bridge + scope metadata (5.17.0). The core lesson this encodes
// is the same as 5.16.3's: a compat path MUST be exercised with the legacy
// artifact. The bridge must be tested with a FAKE registry too — the whole
// plugin suite runs against a ctx with no `skills` service at all, which only
// ever exercised the degrade path.
{
	const bridge = await import(new URL('./src/host-skill.js', import.meta.url).href);
	// Name grammar parity with the Host (drift guard: the real package's regex).
	ok(bridge.isSkillName('detached-restart') && !bridge.isSkillName('Detached_Restart') && !bridge.isSkillName('分离重启'), 'isSkillName mirrors kebab-case incl. CJK rejection');
	ok(bridge.isSkillName('a') && !bridge.isSkillName('a-') && !bridge.isSkillName('-a') && !bridge.isSkillName('a--b'), 'isSkillName rejects degenerate hyphen runs');
	const src = await readFile(new URL('./src/host-skill.js', import.meta.url), 'utf8');
	const hostSkillSrc = await readFile(new URL(`file:///${(process.env.DSH_INSTALL_DIR ?? 'D:/dsh').replace(/\\/g, '/')}/node_modules/@deepseek-ai/dsh-skill/lib/index.js`), 'utf8').catch(() => '');
	const hostRe = /const SKILL_NAME = (\/[^\n]+\/);/.exec(hostSkillSrc)?.[1];
	ok(!hostRe || hostRe === '/^[a-z0-9]+(?:-[a-z0-9]+)*$/', `grammar matches the Host (${hostRe ?? 'host unreadable — local checks above still apply'})`);
	// parseSkillText: frontmatter quoted/array/plain values + missing block.
	const ps = bridge.parseSkillText('---\nname: x\ndescription: "带: 冒号 的值"\nstatus: active\n---\n\n正文开始\n');
	ok(ps.fields.description === '带: 冒号 的值' && ps.fields.status === 'active' && ps.body.startsWith('正文开始'), 'parseSkillText handles quoted scalars and body split');
	ok(bridge.parseSkillText('# 无 frontmatter').fields.description === undefined, 'head-less text parses without throwing');
	// End-to-end against a fake registry — the degrade path alone would have
	// hidden every provider bug forever.
	const providers = [];
	const fakeRegistry = {
		registerProvider: (make) => {
			providers.push(make({ signal: new AbortController().signal, invalidate: () => {} }));
			return () => providers.length === 0;
		},
	};
	const fakeCtx = { get: (n) => (n === 'skills' ? fakeRegistry : undefined) };
	const bridgeHandle = bridge.registerMemorySkillBridge(fakeCtx, { skillsDir: skillRoot });
	ok(!!bridgeHandle && providers.length === 1, 'bridge registers exactly one provider on a host WITH the skill service');
	// 5.24.0 publish gate: a bundle is published iff it is OURS (agent_created)
	// AND active. There is no hostName knob any more — the bundle directory name
	// IS the host name, so "crystallized" and "publishable" finally agree.
	const pubName = 'bridge-test-skill';
	await T.memory_skill.execute(
		{
			action: 'crystallize',
			name: pubName,
			summary: '验证宿主桥接',
			when: '桥接回归时',
			procedure: ['步骤一', '步骤二'],
			verification: 'list 可见',
			sources: ['测试功能'],
			scope: 'project',
			scopeProject: 'demo-project',
		},
		exec,
	);
	const provider = providers[0];
	const listed = await provider.list({});
	ok(listed.every((c) => c.name !== pubName), 'candidate is NOT published to the host');
	await T.memory_skill.execute({ action: 'activate', name: pubName, note: '桥接回归跑通' }, exec);
	const listed2 = await provider.list({});
	const row = listed2.find((c) => c.name === pubName);
	ok(!!row && row.invocation.modelInvocable === true && row.source === 'custom' && row.rank > 600, 'an active owned bundle publishes with rank above bundled (user wins ties)');
	const def = await provider.get(row, {});
	ok(def?.content.includes('步骤一') && def.name === pubName && def.resourceBase?.kind === 'directory', 'provider.get loads the live body for the winning candidate');
	ok(def.resourceBase.path.replace(/\\/g, '/').endsWith(`${pubName}`), 'resourceBase points at the skill\'s OWN directory');
	await T.memory_skill.execute({ action: 'retire', name: pubName, note: '桥接测试完' }, exec);
	const listed3 = await provider.list({});
	ok(!listed3.some((c) => c.name === pubName), 'retire un-publishes in real time (no cache)');
	// get() re-checks: a retire between list and get must not still load.
	const stale = { locator: path.join(skillRoot, pubName, 'SKILL.md'), name: pubName };
	ok((await provider.get(stale, {})) === undefined, 'get() rejects a skill retired after discovery');
	// Scope in the template (G1/G2): written, parseable, and READ by the filter.
	const privName = 'internal-only-skill';
	await T.memory_skill.execute(
		{ action: 'crystallize', name: privName, summary: '内部作用域回归', when: '内部用', procedure: ['一', '二'], verification: '作用域可读', sources: ['测试功能'] },
		exec,
	);
	await T.memory_skill.execute({ action: 'activate', name: privName }, exec);
	const privText = await readFile(path.join(skillRoot, privName, 'SKILL.md'), 'utf8');
	ok(privText.includes('scope: global') && privText.includes('agent_created: true') && privText.includes('status: active'), 'template writes agent_created/status/scope');
	ok(!privText.includes('scope_project'), 'global scope carries no scope_project');
	ok(!privText.includes('hostName') && !privText.includes('whenToUse:'), 'the template no longer emits the obsolete fields');
	// Re-crystallize KEEPS the lifecycle (the 5.17.0 thorn): activating then
	// improving must not silently demote.
	const keepCry = await T.memory_skill.execute(
		{ action: 'crystallize', name: privName, summary: '重结晶但应保持 active', when: '内部用', procedure: ['一', '二'], verification: '状态不丢', sources: ['测试功能'] },
		exec,
	);
	ok(keepCry.status === 'active', 're-crystallization keeps status=active');
	ok(keepCry.warnings.some((w) => w.includes('生命周期保留')), 'keeping the lifecycle is visible in the receipt');
	// The scope field must have a CONSUMER, not just a writer (the day's theme:
	// a written-but-unread field is dead). skillAppliesToProject is the reader.
	ok(bridge.skillAppliesToProject({ scope: 'global' }, 'any') === true, 'global applies to every project');
	ok(bridge.skillAppliesToProject({ scope: 'project', scope_project: 'alpha' }, 'alpha') === true, 'project matches its own key');
	ok(bridge.skillAppliesToProject({ scope: 'project', scope_project: 'alpha' }, 'beta') === false, 'project excludes other keys');
	ok(bridge.skillAppliesToProject({}, 'alpha') === false, 'missing scope is NOT definitely applicable');
	ok(bridge.skillAppliesToProject({ scope: 'global' }) === true, 'no project key disables the filter');
	// A project-scoped skill end-to-end through the tool's project filter.
	await T.memory_skill.execute(
		{ action: 'crystallize', name: 'alpha-project-skill', summary: '只适用甲', when: '甲项目', procedure: ['一', '二'], verification: '路由过滤', sources: ['测试功能'], scope: 'project', scopeProject: 'alpha-proj' },
		exec,
	);
	await T.memory_skill.execute({ action: 'activate', name: 'alpha-project-skill' }, exec);
	const listAlpha = await T.memory_skill.execute({ action: 'list', project: 'alpha-proj' }, exec);
	ok(listAlpha.items.some((i) => i.name === 'alpha-project-skill'), 'the project filter keeps its own project skill');
	const item = listAlpha.items.find((i) => i.name === 'alpha-project-skill');
	ok(item.scope === 'project' && item.published === true, 'list READS BACK scope + published (bridge gate parity)');
	const listBeta = await T.memory_skill.execute({ action: 'list', project: 'beta-proj' }, exec);
	ok(!listBeta.items.some((i) => i.name === 'alpha-project-skill'), 'the project filter drops another project\'s skill');
	ok(listBeta.items.some((i) => i.name === privName && i.scope === 'global'), 'global skills survive every project filter');
	ok(!listBeta.items.some((i) => i.name === 'missing-scope-skill'), 'an unscoped skill is not counted as applicable');
}
await rm(root, { recursive: true, force: true });
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);