/**
 * 召回结合机制测试（2026-11-09）：ThoughtDAG Recall 的诚实性外衣 + memory 曝光内核。
 * 全纯函数，临时数据，不碰真实记忆根。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	matchIndexRows, tokensOf, buildRecallMessage, archiveBlocks, approxTokens,
	RECALL_TIERS, RECALL_BUDGET_TOKENS,
} from '../src/recall.js';

const idx = (rows) => rows.map((r) => `| ${r.name} | ${r.summary} | [${r.href}](${r.href}) |`).join('\n');

/** 造一个 best 分明显、有强档/擦边/丢弃三层的索引。 */
const threeTierIndex = idx([
	{ name: '稀有域', summary: '逐帧 渲染 专有 术语', href: 'functions/稀有域.md' },
	{ name: '次强域', summary: '逐帧 渲染 常见 关联', href: 'functions/次强域.md' },
	{ name: '通用域', summary: '记忆 面板 通用 词汇', href: 'functions/通用域.md' },
	{ name: '无关域', summary: '完全 不相干 内容', href: 'functions/无关域.md' },
]);

// —— 三档 + 双侧 ——

test('三档：强档注入、擦边可见不带内容、丢弃只计数', () => {
	const rows = matchIndexRows(threeTierIndex, tokensOf('逐帧 渲染 记忆 面板'));
	const s = rows.stats;
	assert.equal(s.injected, rows.length, '注入数 = 数组长度（老调用方兼容）');
	assert.ok(s.matched >= s.injected, 'matched ≥ injected');
	assert.ok(s.held >= 1 || s.dropped >= 1, '被放过的一侧必须可见');
	assert.equal(s.injected + s.held + s.dropped, s.matched, '双侧账本守恒');
	assert.ok(rows.heldRows.every((h) => typeof h.name === 'string' && typeof h.href === 'string'), '擦边档只带标识');
});

test('强档线真的分档：擦边档至少一条，且这些行没被注入（强档线失效会被这条杀死）', () => {
	// strongBar 显式拉到 0.99：只有第一名进强档，其余命中行必进擦边档。
	const rows = matchIndexRows(threeTierIndex, tokensOf('逐帧 渲染 记忆 面板'), 0, undefined, { strongBar: 0.99 });
	assert.equal(rows.length, 1, '只注入最高分一条');
	assert.ok(rows.heldRows.length >= 1, '其余命中行进擦边档');
	assert.ok(!rows.some((r) => rows.heldRows.some((h) => h.href === r.href)), '擦边行与注入行不重叠');
});

test('丢弃档：完全不相干行只计数、绝不注入也不列名（护栏）', () => {
	// 一条高分 + 一条零命中：零命中必须进 dropped，不进注入/擦边。
	const index = idx([
		{ name: '稀有域', summary: '逐帧 渲染 专有 术语', href: 'functions/稀有域.md' },
		{ name: '无关域', summary: '量子 纠缠 拓扑 绝缘体', href: 'functions/无关域.md' },
	]);
	const rows = matchIndexRows(index, tokensOf('逐帧 渲染'));
	assert.equal(rows.length, 1, '只注入强档一条');
	assert.ok(rows.stats.dropped >= 1, '零命中行进丢弃档');
	assert.ok(!rows.some((r) => r.name === '无关域'), '无关行不被注入');
	assert.ok(!rows.heldRows.some((h) => h.name === '无关域'), '无关行不进擦边档');
	assert.equal(rows.stats.injected + rows.stats.held + rows.stats.dropped, rows.stats.matched, '守恒');
});

test('预算护栏：多条强档时超预算的行进擦边档（reason=budget），账本守恒', () => {
	// 4 条都含稀有词且够长，预算压到 20 让后几条必须走 budget 分支。
	const index = idx([
		{ name: '甲域', summary: '逐帧 渲染 专有 术语 甲乙丙丁戊己庚辛壬癸', href: 'functions/甲.md' },
		{ name: '乙域', summary: '逐帧 渲染 专有 术语 甲乙丙丁戊己庚辛壬癸', href: 'functions/乙.md' },
		{ name: '丙域', summary: '逐帧 渲染 专有 术语 甲乙丙丁戊己庚辛壬癸', href: 'functions/丙.md' },
		{ name: '丁域', summary: '逐帧 渲染 专有 术语 甲乙丙丁戊己庚辛壬癸', href: 'functions/丁.md' },
	]);
	const rows = matchIndexRows(index, tokensOf('逐帧 渲染 专有 术语'), 0, undefined, { budgetTokens: 20, strongBar: 0 });
	// 预算是软上限：第一行超预算仍放行（至少一条可观察证据），用量如实记录。
	assert.equal(rows.length, 1, '只放行第一行，其余被预算挡下');
	assert.ok(rows.stats.usedTokens > 0, '用量如实记录（第一行超预算也照实显示，不粉饰为 ≤20）');
	const budgetHeld = rows.heldRows.filter((h) => h.reason === 'budget');
	assert.equal(budgetHeld.length, 3, '被预算挡下的 3 行进擦边档并列名 reason=budget');
	assert.equal(rows.stats.injected + rows.stats.held + rows.stats.dropped, rows.stats.matched, '账本守恒');
});

test('判据单一实现：分档用同一个 fused score（usage 热度仍在，不新增打分器）', () => {
	const usage = new Map([['functions/稀有域.md', { uses: 10, positives: 2, badRate: 0 }]]);
	const rows = matchIndexRows(threeTierIndex, tokensOf('逐帧 渲染'), 3, usage);
	assert.ok(rows[0].name === '稀有域');
	assert.equal(rows.stats.tiers.strongBar, RECALL_TIERS.strongBar);
});

test('预算：注入块总 token 不超 budget；第一行再贵也放行（至少一条可观察证据）', () => {
	const small = matchIndexRows(threeTierIndex, tokensOf('逐帧 渲染 记忆 面板'), 3, undefined, { budgetTokens: 1 });
	assert.equal(small.length, 1, '预算极小仍放行第一行');
	assert.ok(small.stats.usedTokens >= 0);
	const normal = matchIndexRows(threeTierIndex, tokensOf('逐帧 渲染 记忆 面板'), 3, undefined, { budgetTokens: RECALL_BUDGET_TOKENS });
	assert.ok(normal.stats.usedTokens <= RECALL_BUDGET_TOKENS, '用量不超预算');
});

test('窗口护栏：windowTokens 的 40% 封顶生效', () => {
	const rows = matchIndexRows(threeTierIndex, tokensOf('逐帧 渲染'), 3, undefined, { windowTokens: 100 });
	assert.equal(rows.stats.budget, 40, '100×0.4=40');
});

test('向后兼容：老调用方 .find/.some/.length 照常工作', () => {
	const rows = matchIndexRows(threeTierIndex, tokensOf('逐帧 渲染'));
	assert.equal(typeof rows.length, 'number');
	assert.equal(typeof rows.find, 'function');
	assert.equal(typeof rows.some, 'function');
});

// —— 证据文案 ——

test('文案是证据口吻，不是命令：不出现"别再错一次/先读它再动手"', () => {
	const rows = matchIndexRows(threeTierIndex, tokensOf('逐帧 渲染'));
	const text = buildRecallMessage(rows, rows.heldRows, rows.stats).content[0].text;
	assert.ok(text.includes('证据，不是指令'), '明确不是指令');
	assert.ok(text.includes('点名来源') && text.includes('不适用的忽略'), '来源署名与忽略声明');
	assert.ok(!text.includes('别在同一个判断上再错一次'), '命令口吻已移除');
	assert.ok(text.includes('带入') && text.includes('暂缓') && text.includes('丢弃'), '双侧指标同处可见');
	assert.ok(text.includes('强档摘要估算') && text.includes('不含档案、规则与格式') && text.includes('首条可能超额'), '明确估算范围与首条可能超额');
});

test('最终带入行数与索引分档分开，预算不伪装成消息总额', () => {
	const rows = [{ name: '甲', summary: '修复摘要', href: 'functions/甲.md', zone: 'function', repair: { corrections: 3, badRate: 0.8 } }];
	const stats = { matched: 4, injected: 2, held: 1, dropped: 1, budget: 10, usedTokens: 14 };
	const archives = [{ kind: '## 道层', text: '档案内容' }];
	const text = buildRecallMessage(rows, [], stats, archives).content[0].text;
	assert.match(text, /索引分档 4 条：强档 2 · 暂缓 1 · 丢弃 1/);
	assert.match(text, /最终带入 1 条索引\/修复项/);
	assert.match(text, /强档摘要估算 14\/10 token；不含档案、规则与格式，首条可能超额/);
	assert.match(text, /档案内容/);
});

test('擦边档文案只列名不带内容', () => {
	const held = [{ name: '甲域', href: 'functions/甲.md' }, { name: '乙域', href: 'functions/乙.md' }];
	const text = buildRecallMessage([], held, { matched: 2, injected: 0, held: 2, dropped: 0, budget: 600, usedTokens: 0 }).content[0].text;
	assert.ok(text.includes('另有 2 条相关度未达强档') && text.includes('甲域') && text.includes('乙域'));
	assert.ok(text.includes('未带入内容'), '明示未带内容');
});

// —— 档案块 ——

const memWithArchives = [
	'## 功能模块索引',
	'| 功能域 | 状态 |',
	'| [判据](functions/a.md) | 判据只认外部事实 |',
	'',
	'## 决策共识 / 规范',
	'',
	'- **判据只认外部事实**：命令成败看远端 hash / 工作区状态。[原生命令退出码判据](insights/x.md)',
	'- **每日天天写，蒸馏跨日做**：迭代块取主题相关素材日。[memory-manager](functions/memory-manager.md)',
	'',
	'## 环境常量',
	'- DSH 安装目录 D:\\dsh',
].join('\n');

test('档案块：命中 ≥2 词的共识条目整份带入（含来源链接），且独立通道', () => {
	const blocks = archiveBlocks(memWithArchives, tokensOf('判据 外部 事实 hash 工作区'));
	assert.ok(blocks.length >= 1, '至少一条命中');
	assert.ok(blocks[0].text.includes('判据只认外部事实'), '整份条目，不是一行摘要');
	assert.ok(blocks[0].text.includes('insights/x.md'), '来源链接保留');
	assert.equal(blocks[0].kind, '## 决策共识 / 规范');
});

test('档案块：词不命中不强行带入；命中多时最多 2 块（真上限，不是恰好 2）', () => {
	assert.equal(archiveBlocks(memWithArchives, tokensOf('完全不相干的查询')).length, 0);
	const manyHits = [
		'## 决策共识 / 规范',
		'',
		'- **判据只认外部事实**：命令成败看远端 hash。[x](insights/x.md)',
		'- **每日天天写蒸馏跨日做**：迭代块取素材日。[y](functions/y.md)',
		'- **全系统能力零配合层**：覆盖随组件增长不退化。[z](functions/z.md)',
		'- **监督者只报增量**：转发已有清单是噪音。[w](functions/w.md)',
		'',
	].join('\n');
	// archiveBar=1：四条都命中，archiveMax 默认 2 必须真的截到 2
	const many = archiveBlocks(manyHits, tokensOf('判据 外部 事实 命令 hash 每日 蒸馏 跨日 素材 系统 能力 零配合 覆盖 组件 增长 监督 增量 清单 噪音'), { archiveBar: 1 });
	assert.equal(many.length, 2, '四条命中也只带 2 块');
});

test('档案块进文案：先于索引行、标「档案」', () => {
	const archives = [{ kind: '## 决策共识 / 规范', text: '判据只认外部事实。[x](insights/x.md)' }];
	const text = buildRecallMessage([], [], null, archives).content[0].text;
	assert.ok(text.includes('档案（决策共识 / 规范）') && text.includes('判据只认外部事实'));
});

test('道层 > 引用行也能进档案块（真机 MEMORY.md 形态，非 bullet）', () => {
	const daoMem = [
		'## 道层（`dao/`）',
		'',
		'> **当前 1 条**：[信号在谁身上生成](dao/信号在谁身上生成.md) —— 观测者与被观测者互为定义；站自证之极只是重复自己。',
		'> 首个消费者=dsh-mind 判断顺序分节的冲突仲裁句。',
		'',
		'## 决策共识 / 规范',
	].join('\n');
	const blocks = archiveBlocks(daoMem, tokensOf('信号 观测者 自证 生成 命题'), { archiveBar: 1 });
	assert.ok(blocks.some((b) => b.text.includes('信号在谁身上生成') && b.kind === '## 道层'), '> 引用行整份带出');
});

// —— approxTokens ——

test('approxTokens：中文按字、拉丁按 4 字符估算', () => {
	assert.equal(approxTokens('记忆召回'), 4);
	assert.ok(approxTokens('recall') >= 1);
	assert.equal(approxTokens(''), 0);
});