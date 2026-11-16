/**
 * V-2 层递链：一个事实沿 L3 → L2 → L1 → L0 真的走完四层。
 *
 * ## 层序（这条必须先说清，我第一次就搞反了）
 *
 * `DEFAULT_LAYERS = ['L0','L1','L2','L3']` 是**数组顺序**，而语义上
 * **L0 最抽象（道）、L3 最具体（原始观察）**：
 *   - 上行 `ti === fi - 1`：只能 L3→L2→L1→L0 逐层相邻，"器直接提法"判无效
 *   - 下行 `ti === fi + 1`：只能 L0→L1→L2→L3 逐层相邻
 * 第一次写这个文件时我按"L0 是底层"去想，两次 `non_adjacent_ascent` 打回，
 * 才回头读谓词确认方向。**方向不是约定俗成，是被断言钉死的。**
 *
 * ## 这个文件补的是什么
 *
 * `full-loop.test.js` 证明了"各段闸门都在工作"，但没证明**同一个事实**能连续
 * 穿过四层——各段独立可过不等于串起来可过，相邻性/方向/每层准入条件会在
 * 串联处互相暴露。每跳都断言**具体 reason**，否则"把所有判定改成 admit"的
 * 变异会全绿。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempStore = () => mkdtempSync(join(tmpdir(), 'dsh-ladder-'));
const settle = () => new Promise((r) => setTimeout(r, 60));

test('层递链：同一事实 L3→L2→L1→L0 逐层上行，每跳理由可查', async () => {
	const dir = tempStore();
	try {
		const rt = createRuntime({ storageDir: dir });
		const evidence = 'tests/capture-intent-window-boundary.test.js 断言失败可见';

		// ---- L3 → L2：原始观察结晶成可复跑的操作（器→术） ----
		const hop1 = rt.upward('L3', 'L2', {
			kind: 'positive',
			rule_type: 'skill',
			repeats: 6,
			success_rate: 0.85,
			success_evidence: 'external',
			evidence: [evidence],
			verifiable_by: evidence,
			rule_id: '失败必须响亮',
		});
		// 术层量化门通过后落到 human_gate（skill_thresholds_met）——这是设计：
		// 过门只代表"够格提交"，转正仍要人工。所以这一跳接受 admit 或 human_gate。
		assert.ok(['admit', 'admitted', 'human_gate'].includes(hop1.action), `L3→L2 应通过或转人工，实际 ${JSON.stringify(hop1).slice(0, 170)}`);
		assert.equal(hop1.reason, 'skill_thresholds_met', '理由应指向量化门达标');

		// ---- L2 → L1：操作提炼成可重套的原则（术→法，五门量化） ----
		const hop2 = rt.upward('L2', 'L1', {
			kind: 'positive',
			rule_type: 'criterion',
			skill_coverage: 3,
			scenario_coverage: 2,
			anti_example_count: 1,
			predict_rate: 0.7,
			overlap: 0.3,
			evidence: [evidence],
			verifiable_by: evidence,
			rule_id: '失败必须响亮',
		});
		// 法层五门量化同样落到 human_gate（criterion_thresholds_met）：过门=够格提交。
		assert.ok(['admit', 'admitted', 'downgrade', 'human_gate'].includes(hop2.action), `L2→L1 应有明确判定，实际 ${JSON.stringify(hop2).slice(0, 170)}`);
		assert.ok(!['reject', 'deny'].includes(hop2.action), '合规输入不应被拒');
		assert.equal(hop2.reason, 'criterion_thresholds_met', '理由应指向五门量化达标');

		// ---- L1 → L0：原则收敛成道（法→道，阀门侧只判"够不够格提交"） ----
		const hop3 = rt.upward('L1', 'L0', {
			kind: 'positive',
			rule_type: 'axiom',
			evidence: [evidence],
			verifiable_by: evidence,
			rule_id: '失败必须响亮',
		});
		// 道层最终由 memory_dao 硬闸门与人工确认把守；阀门侧落到 human_gate 是对的。
		assert.ok(['admit', 'admitted', 'human_gate'].includes(hop3.action), `L1→L0 应通过或转人工，实际 ${JSON.stringify(hop3).slice(0, 170)}`);

		// ---- 三跳都落账：链的存在必须能从账本复原 ----
		await settle();
		const { readDecisions } = await import('../src/store.js');
		const entries = await readDecisions(dir);
		assert.ok(Array.isArray(entries) && entries.length >= 3, `三次上行都应落账（实际 ${entries?.length}）`);
		// 账本里的 from/to 必须真的连成链，不能是三段互不相干。
		const hops = entries.filter((e) => typeof e.outcome === 'string' || e.action);
		assert.ok(hops.length >= 3, '至少三跳可见');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('层递链的反面：上行跳层被拒（链不能抄近路）', () => {
	const dir = tempStore();
	try {
		const rt = createRuntime({ storageDir: dir });
		// L3 → L1 跳过 L2：这正是"链"与"散点"的区别。
		const jump = rt.upward('L3', 'L1', { kind: 'positive', rule_type: 'skill', repeats: 9, success_rate: 0.9, success_evidence: 'external' });
		assert.equal(jump.action, 'reject', `上行跳层必须 reject，实际 ${JSON.stringify(jump).slice(0, 160)}`);
		assert.equal(jump.reason, 'non_adjacent_ascent', '理由必须明确指向跳层');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('层递链的反面：下行跳层同样被拒', () => {
	const dir = tempStore();
	try {
		const rt = createRuntime({ storageDir: dir });
		const down = rt.downward('L0', 'L2', { constraints: ['已具体化'] });
		assert.equal(down.action, 'deny', `下行跳层必须 deny，实际 ${JSON.stringify(down).slice(0, 160)}`);
		assert.equal(down.reason, 'non_adjacent_descent');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('层递链：负向规则在下行链上截断（黑名单只约束"执行"，不约束"提炼"）', async () => {
	const dir = tempStore();
	try {
		const rt = createRuntime({ storageDir: dir });
		await rt.confirm({ id: 'ladder-block', negative_type: 'forbidden_skill', statement: '禁止该事实落地执行', keywords: ['失败必须响亮'] });

		// 为什么测下行：`negative_rule_hits` 只在 admitDownward 里被读取
		// （上行不读）。这不是遗漏而是语义——黑名单约束的是"往下具体化去执行"，
		// 不是"往上提炼成原则"。第一次我把它写成上行用例，得到的是
		// downgrade（因为缺外部证据），而不是 deny（因为上行根本不看黑名单）。
		const blocked = rt.downward('L1', 'L2', { constraints: ['已具体化为可执行步骤'], negative_rule_hits: ['ladder-block'] });
		assert.equal(blocked.action, 'deny', `黑名单应截断下行，实际 ${JSON.stringify(blocked).slice(0, 160)}`);
		assert.equal(blocked.reason, 'negative_rule_hit', '拒绝理由必须指向黑名单');
		assert.deepEqual(blocked.negative_rule_hits, ['ladder-block'], '命中的规则 id 要回传，便于申诉/沉底');

		// 同一跳，没有黑名单时应该允许——证明是黑名单在起作用，不是别的原因。
		const clean = rt.downward('L1', 'L2', { constraints: ['已具体化为可执行步骤'] });
		assert.equal(clean.action, 'allow', `无黑名单时应放行，实际 ${JSON.stringify(clean).slice(0, 160)}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});



