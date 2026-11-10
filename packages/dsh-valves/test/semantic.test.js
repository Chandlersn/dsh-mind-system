/**
 * III-6 语义越权测试 —— **标记不阻断**。
 *
 * 这个模块的契约只有一条必须守住：`blocked` 恒为 false。
 * 语义判断会错，拦错一条就是误伤一条正当路径；所以它只把可疑项推进
 * 人工抽查队列，阻断权仍在 valve_confirm（人工确认）手里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	detectSemanticBypass, lexicalOverlap, cosineSimilarity, semanticSimilarity,
	SEMANTIC_STATUS, POSSIBLE_BYPASS,
} from '../src/semantic.js';

const rules = [
	{ id: 'r-boundary', boundary_keywords: ['不要删共享库', '别碰生产配置'] },
	{ id: 'r-no-boundary' },
];

// ——————————————————————————————————————————————
// 契约：永不阻断
// ——————————————————————————————————————————————

test('契约：任何情况下 blocked 恒为 false（标记不阻断）', async () => {
	const cases = [
		{ rules, text: '不要删共享库' },                       // 词面命中
		{ rules, text: '完全不相关的描述' },                   // 无命中
		{ rules: [], text: '空规则' },
		{ rules, text: '' },
		{ rules, text: '语义很像', embed: async () => [1, 0, 0] }, // 语义层可用
	];
	for (const input of cases) {
		const v = await detectSemanticBypass(input);
		assert.equal(v.blocked, false, `blocked 必须恒 false（输入：${input.text}）`);
	}
});

test('契约：即使 embedder 抛错也 blocked=false（可选件坏了不拖垮主流程）', async () => {
	const v = await detectSemanticBypass({
		rules,
		text: '任意文本',
		embed: async () => { throw new Error('embedder 挂了'); },
	});
	assert.equal(v.blocked, false);
	assert.equal(v.semantic.status, SEMANTIC_STATUS.degraded, '如实标降级');
});

// ——————————————————————————————————————————————
// 词面层：永远可用，零依赖
// ——————————————————————————————————————————————

test('词面层：命中 boundary_keywords 即标记', async () => {
	const v = await detectSemanticBypass({ rules, text: '我打算不要删共享库里的东西' });
	assert.equal(v.flagged, true);
	assert.equal(v.code, POSSIBLE_BYPASS);
	assert.ok(v.reasons.some((r) => r.startsWith('boundary_keyword:r-boundary')), '理由要点名是哪条规则的哪个词');
});

test('词面层：没有 boundary_keywords 的规则不参与（不臆造边界）', () => {
	const out = lexicalOverlap(rules, '别碰生产配置');
	assert.equal(out.checked, 1, '只有 r-boundary 有边界词');
	assert.deepEqual(out.hits.map((h) => h.ruleId), ['r-boundary']);
});

test('词面层：大小写与空白归一（不做词干化）', () => {
	const out = lexicalOverlap([{ id: 'a', boundary_keywords: ['Prod  Config'] }], 'prod   config 在这里');
	assert.equal(out.hits.length, 1);
});

test('词面层：空文本不命中任何东西', () => {
	assert.deepEqual(lexicalOverlap(rules, '').hits, []);
	assert.deepEqual(lexicalOverlap(rules, '   ').hits, []);
});

// ——————————————————————————————————————————————
// 语义层：可选 peer，缺了 degraded
// ——————————————————————————————————————————————

test('N4 降级：没有 embedder → degraded，词面层照常工作', async () => {
	const v = await detectSemanticBypass({ rules, text: '不要删共享库' });
	assert.equal(v.semantic.status, SEMANTIC_STATUS.degraded);
	assert.equal(v.semantic.similarity, null);
	// 关键：降级不影响词面层的判定
	assert.equal(v.flagged, true);
});

test('N4 降级：embed 传非函数时短路，绝不去调用它', async () => {
	const v = await detectSemanticBypass({ rules, text: '任意文本', embed: 'not-a-function' });
	assert.equal(v.semantic.status, SEMANTIC_STATUS.degraded, '非函数 embed 按缺失处理');
	assert.equal(v.semantic.note, 'no_embedder');
	assert.equal(v.blocked, false);
});

test('N4 短路必须是"调用前判定"：源码里 embed 的类型检查先于任何调用', async () => {
	// 为什么用源码断言而不是行为断言：把内层检查删掉后，embed=undefined 调用会抛错、
	// 被 catch 兜成 degraded —— 最终状态一模一样（实测：这样改测试仍全绿）。
	// 所以"状态是 degraded"无法区分"短路了"与"调用了但崩了"。
	// 真正能失败的可观察判据是：类型检查语句出现在调用点之前。
	const { readFileSync } = await import('node:fs');
	const src = readFileSync(new URL('../src/semantic.js', import.meta.url), 'utf8');
	const guardAt = src.indexOf("if (typeof embed !== 'function')");
	const callAt = src.indexOf('await Promise.all([embed(text)');
	assert.ok(guardAt > -1, '必须有 embedder 类型检查');
	assert.ok(callAt > -1, '必须能找到调用点');
	assert.ok(guardAt < callAt, '短路判定必须在调用之前（否则就是调用后兜底）');
});

test('N4 降级：embedder 返回坏向量 → unavailable，不瞎算相似度', async () => {
	const bad = await semanticSimilarity({ text: 'x', boundaryKeywords: ['y'], embed: async () => [1, 'oops'] });
	assert.equal(bad.status, SEMANTIC_STATUS.unavailable);
	assert.equal(bad.similarity, null);
});

test('余弦相似度：维度不一致 / 零向量返回 null（不猜）', () => {
	assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), null);
	assert.equal(cosineSimilarity([0, 0], [1, 0]), null);
	assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
	assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('语义层可达阈值时标记（取与边界词的最大相似度）', async () => {
	// 假 embedder：文本与第一个边界词同向，与第二个正交
	const embed = async (t) => (t.includes('危险') ? [1, 0] : t.includes('安全') ? [0, 1] : [1, 0]);
	const v = await detectSemanticBypass(
		{ rules: [{ id: 'r', boundary_keywords: ['危险操作', '安全词'] }], text: '危险', embed },
		{ similarityThreshold: 0.8 },
	);
	assert.equal(v.semantic.status, SEMANTIC_STATUS.ok);
	assert.ok(v.semantic.similarity >= 0.99, '同向向量相似度应接近 1');
	assert.ok(v.reasons.some((r) => r.startsWith('semantic_similarity:')), '超阈值要进理由');
	assert.equal(v.blocked, false);
});

test('语义层未达阈值时不标记（避免误杀）', async () => {
	const embed = async (t) => (t.includes('正交') ? [0, 1] : [1, 0]);
	const v = await detectSemanticBypass(
		{ rules: [{ id: 'r', boundary_keywords: ['边界词'] }], text: '正交', embed },
		{ similarityThreshold: 0.8 },
	);
	assert.equal(v.semantic.similarity, 0);
	assert.ok(!v.reasons.some((r) => r.startsWith('semantic_similarity:')), '低于阈值不该标记');
});

// ——————————————————————————————————————————————
// 判据来源单一
// ——————————————————————————————————————————————

test('词面判据与下行黑名单同语义（包含匹配，不是分词）', () => {
	// 这条钉住"两处判据一致"：若有人把这里改成分词，会与 matchNegativeRules 分裂。
	const out = lexicalOverlap([{ id: 'a', boundary_keywords: ['共享库'] }], '删除共享库文件');
	assert.equal(out.hits.length, 1, '包含匹配应命中');
});
