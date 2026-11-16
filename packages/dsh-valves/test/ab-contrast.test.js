/**
 * V-3 结果指标对照：同一个任务集，在**规则生效前后**跑两遍，差异必须可外部观察。
 *
 * ## 为什么这件事必须做（上轮 P1-1 的裁决）
 *
 * 「过程合规 ≠ 结果改善」。一个系统可以百分之百按流程跑（每个判定都落账、
 * 每条闸门都执行），而结果一点没变——那种"全绿"只是证明了流程在转，
 * 不证明它起了作用。所以 V-3 要的不是"规则存在"，而是**行为差异**：
 * 同一组输入，装规则前放行、装规则后拦截，这个差异要能被人从外部指出来。
 *
 * ## 方法：固定语料 × 两组运行
 *
 * 用**同一份任务语料**（固定字符串，不随机），在两个独立的临时存储上各跑
 * 一遍：一组无规则（基线），一组先确认规则（生效后）。逐条比对判定，
 * 输出差异表。
 *
 * ## 一条诚实纪律
 *
 * 差异**不必然是改善**。本文件只报告"变了什么"，并明确标注哪些差异是
 * 预期的拦截、哪些可能是误伤。把"变了"说成"变好了"是最容易犯的错
 * （见记忆：闸门只证没坏不证有内容）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempStore = () => mkdtempSync(join(tmpdir(), 'dsh-ab-'));

/**
 * 固定任务集：模拟 6 个真实动作请求。
 * 每条标注 `shouldBlock` —— 这是**我们期望**规则生效后发生什么，
 * 用来分辨"拦对了"与"误伤"，而不是看到差异就欢呼。
 */
const CORPUS = [
	{ id: 't1', text: '清理临时文件，删掉 build 目录', shouldBlock: false },
	{ id: 't2', text: '删除共享库 /usr/lib/libfoo.so 以腾出空间', shouldBlock: true },
	{ id: 't3', text: '压缩日志并归档到 cold storage', shouldBlock: false },
	{ id: 't4', text: '强制删除生产数据库的旧表', shouldBlock: true },
	{ id: 't5', text: '更新 README 里的安装说明', shouldBlock: false },
	{ id: 't6', text: '重试三次失败后原样再试一次', shouldBlock: true },
];

/** 在给定存储上跑完整语料，返回 id → 判定。 */
async function runCorpus(dir) {
	const rt = createRuntime({ storageDir: dir });
	const out = {};
	for (const item of CORPUS) {
		const hits = await rt.matchNegative(item.text);
		// 判定统一成 allow / block：命中任一负向规则即 block。
		out[item.id] = Array.isArray(hits) && hits.length > 0 ? 'block' : 'allow';
	}
	return out;
}

test('V-3 对照：同一语料，规则生效前后行为差异逐条可观察', async () => {
	const baseDir = tempStore();
	const ruledDir = tempStore();
	try {
		// —— A 组：基线（无任何规则）——
		const baseline = await runCorpus(baseDir);

		// —— B 组：确认两条规则后再跑同一语料 ——
		const rt = createRuntime({ storageDir: ruledDir });
		await rt.confirm({ id: 'no-delete-shared-lib', negative_type: 'forbidden_skill', statement: '禁止删除共享库', keywords: ['共享库', 'libfoo'] });
		await rt.confirm({ id: 'no-drop-prod-table', negative_type: 'forbidden_skill', statement: '禁止动生产数据库', keywords: ['生产数据库', '旧表'] });
		// t6 一开始漏了：语料里有"原样再试一次"，但没有规则覆盖它。
		// 这正是 V-3 的价值——不是"有差异就算过"，而是"差异必须与期望一致"，
		// 漏拦和误伤都会在这里现形。
		await rt.confirm({ id: 'no-blind-retry', negative_type: 'forbidden_skill', statement: '禁止不看原因就原样重试', keywords: ['原样再试', '原样重试'] });
		const after = await runCorpus(ruledDir);

		// —— 差异表 ——
		const diff = CORPUS.map((c) => ({ id: c.id, before: baseline[c.id], after: after[c.id], expected: c.shouldBlock ? 'block' : 'allow' }));

		// 断言 1：差异**真的存在**。如果两组完全一样，规则没起作用——
		// 这正是 V-3 要防的第一个假象（过程合规但结果没变）。
		const changed = diff.filter((d) => d.before !== d.after);
		assert.ok(changed.length > 0, `规则未改变任何行为，V-3 不成立：${JSON.stringify(diff)}`);

		// 断言 2：基线组必须**全部放行**（没有规则就不该拦）。
		assert.ok(Object.values(baseline).every((v) => v === 'allow'), `基线不应拦截任何请求：${JSON.stringify(baseline)}`);

		// 断言 3：每条变化都必须与期望一致。这是分辨"拦对了"与"误伤"的关键：
		// 差异存在只说明"变了"，与期望吻合才说明"变对了"。
		const wrong = diff.filter((d) => d.after !== d.expected);
		assert.deepEqual(wrong, [], `有请求的判定与期望不符（可能是误伤或漏拦）：${JSON.stringify(wrong)}`);

		// 断言 4：该拦的都拦了，也就是 blocked 集合精确等于语料标注。
		const blocked = diff.filter((d) => d.after === 'block').map((d) => d.id).sort();
		const expectedBlocked = CORPUS.filter((c) => c.shouldBlock).map((c) => c.id).sort();
		assert.deepEqual(blocked, expectedBlocked, `拦截集合应精确匹配：实际 ${blocked} vs 期望 ${expectedBlocked}`);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
		rmSync(ruledDir, { recursive: true, force: true });
	}
});

test('V-3 对照：规则回滚后行为回到基线（差异可逆）', async () => {
	const dir = tempStore();
	try {
		const rt = createRuntime({ storageDir: dir });
		const item = '删除共享库 /usr/lib/libfoo.so 以腾出空间';

		const before = await rt.matchNegative(item);
		assert.equal(before.length, 0, '无规则时不拦截');

		await rt.confirm({ id: 'rev-rule', negative_type: 'forbidden_skill', statement: '禁止删共享库', keywords: ['共享库'] });
		const during = await rt.matchNegative(item);
		assert.ok(during.length > 0, '规则生效后应拦截');

		await rt.rollback('rev-rule');
		const after = await rt.matchNegative(item);
		assert.equal(after.length, 0, '回滚后应回到基线——否则"可逆"只是口号');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('V-3 对照：无差异时如实报告"没变"，不粉饰', async () => {
	const dir = tempStore();
	try {
		const rt = createRuntime({ storageDir: dir });
		// 确认一条与本语料**完全无关**的规则。
		await rt.confirm({ id: 'unrelated', negative_type: 'forbidden_skill', statement: '禁止提交私有密钥', keywords: ['私钥泄漏到日志'] });

		const baseline = await runCorpus(dir);
		// 同一组语料在规则生效后重跑：因为规则无关，行为应当**一模一样**。
		const again = await runCorpus(dir);

		const changed = CORPUS.filter((c) => baseline[c.id] !== again[c.id]);
		assert.deepEqual(changed.map((c) => c.id), [], '无关规则不应改变任何行为');

		// 这是 V-3 的另一半：**能如实报告"没有改善"**。一个只能报告改善的
		// 对照工具，本身就不可信。
		assert.ok(Object.values(again).every((v) => v === 'allow'), '无命中即全放行');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
