/**
 * III-7 定时巡检测试。
 *
 * 三条核心判据：
 * 1. 巡检结论必须**落盘**（跑了没跑、查到什么，都要留在文件里）
 * 2. **失败也要落盘** —— 否则"没跑"与"跑了没问题"在文件系统里长得一样
 * 3. 靠**上次报告时间**判断该不该跑（interval 会因重启重置，只看定时器会漏）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	weeklyPrinciplePatrol, quarterlyLayerPatrol,
	writePatrolReport, readLatestPatrolReport, isPatrolDue,
	patrolReportPath, PATROL_DIR, PATROL_PERIODS, clampTimerDelay, MAX_TIMER_DELAY_MS,
} from '../src/patrol.js';

function sandbox() {
	return mkdtempSync(join(tmpdir(), 'dsh-valves-patrol-'));
}

// ——————————————————————————————————————————————
// 周级原则巡检
// ——————————————————————————————————————————————

test('周级：零引用原则被列出，但注记"可能正常"（不自动判死）', () => {
	const out = weeklyPrinciplePatrol({
		principles: [
			{ id: 'p-used', refs: 12, antiExamples: 2 },
			{ id: 'p-zero', refs: 0, antiExamples: 0 },
			{ id: 'p-new', refs: 0, antiExamples: 1 },
		],
	});
	assert.equal(out.summary.principles, 3);
	assert.equal(out.summary.zero_reference, 2);
	assert.equal(out.summary.with_anti_examples, 2);
	const zero = out.findings.find((f) => f.principle_id === 'p-zero');
	assert.equal(zero.kind, 'zero_reference');
	// 判据不能越权：零引用不等于失效，巡检只报告不裁决。
	assert.ok(zero.note.includes('可能是新原则'), '必须说明零引用可能是正常状态');
});

test('周级：引用数达标的原则不出现在 findings 里', () => {
	const out = weeklyPrinciplePatrol({ principles: [{ id: 'ok', refs: 5, antiExamples: 0 }] });
	assert.equal(out.findings.length, 0);
});

test('周级：缺 id 的条目跳过（不造假条目）', () => {
	const out = weeklyPrinciplePatrol({ principles: [{ refs: 0 }, { id: '  ', refs: 0 }] });
	assert.equal(out.summary.principles, 0);
	assert.deepEqual(out.findings, []);
});

// ——————————————————————————————————————————————
// 季度层结构巡检
// ——————————————————————————————————————————————

test('季度：空层被列出并说明两种可能（未沉积 / 断链）', () => {
	const out = quarterlyLayerPatrol({ layers: ['L0', 'L1', 'L2', 'L3'], counts: { L0: 1, L1: 2, L2: 0, L3: 5 } });
	assert.equal(out.summary.empty, 1);
	const empty = out.findings.find((f) => f.kind === 'empty_layer');
	assert.equal(empty.layer, 'L2');
	assert.ok(empty.note.includes('断链'), '要说清空层既可能是没沉积，也可能是断链');
});

test('季度：失衡判定有最小样本门槛（总数 <10 时不判）', () => {
	const small = quarterlyLayerPatrol({ layers: ['A', 'B'], counts: { A: 9, B: 0 } });
	assert.equal(small.summary.skipped_balance_check, true);
	assert.ok(!small.findings.some((f) => f.kind === 'imbalanced_layer'));

	const big = quarterlyLayerPatrol({ layers: ['A', 'B'], counts: { A: 95, B: 5 } });
	assert.equal(big.summary.skipped_balance_check, false);
	assert.ok(big.findings.some((f) => f.kind === 'imbalanced_layer'), '95% 应判失衡');
});

test('季度：全部正常时没有 findings', () => {
	const out = quarterlyLayerPatrol({ layers: ['A', 'B'], counts: { A: 6, B: 6 } });
	assert.equal(out.findings.length, 0);
});

// ——————————————————————————————————————————————
// 落盘
// ——————————————————————————————————————————————

test('报告落盘到 mind-patrol/<kind>-<date>.json', async () => {
	const dir = sandbox();
	try {
		const r = await writePatrolReport(dir, { kind: 'weekly', at: '2026-11-10T02:00:00.000Z', ok: true, findings: [] });
		assert.equal(r.ok, true);
		assert.ok(existsSync(r.path), '报告文件必须真的存在');
		assert.ok(r.path.includes(PATROL_DIR));
		const parsed = JSON.parse(readFileSync(r.path, 'utf8'));
		assert.equal(parsed.kind, 'weekly');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('失败也要落盘（"没跑"与"跑了没问题"必须能区分）', async () => {
	const dir = sandbox();
	try {
		await writePatrolReport(dir, {
			kind: 'weekly', at: new Date().toISOString(), ok: false, error: '账本读取失败',
		});
		const latest = await readLatestPatrolReport(dir, 'weekly');
		assert.equal(latest.ok, false, '失败报告要能读回');
		assert.equal(latest.error, '账本读取失败');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('同日重跑覆盖：同一天不需要两份报告', async () => {
	const dir = sandbox();
	try {
		const at = '2026-11-10T02:00:00.000Z';
		const a = await writePatrolReport(dir, { kind: 'weekly', at, ok: true, findings: [] });
		const b = await writePatrolReport(dir, { kind: 'weekly', at, ok: true, findings: [{ x: 1 }] });
		assert.equal(a.path, b.path, '同一天同一类型应写同一个文件');
		const parsed = JSON.parse(readFileSync(b.path, 'utf8'));
		assert.equal(parsed.findings.length, 1, '后写的覆盖前写的');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('没有报告时 readLatestPatrolReport 返回 null（不伪造空报告）', async () => {
	const dir = sandbox();
	try {
		assert.equal(await readLatestPatrolReport(dir, 'weekly'), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('不同类型互不干扰（weekly 与 quarterly 各读各的）', async () => {
	const dir = sandbox();
	try {
		await writePatrolReport(dir, { kind: 'weekly', at: '2026-11-10T02:00:00.000Z', ok: true, findings: [] });
		await writePatrolReport(dir, { kind: 'quarterly', at: '2026-11-10T03:00:00.000Z', ok: true, findings: [{ y: 2 }] });
		const w = await readLatestPatrolReport(dir, 'weekly');
		const q = await readLatestPatrolReport(dir, 'quarterly');
		assert.equal(w.findings.length, 0);
		assert.equal(q.findings.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ——————————————————————————————————————————————
// 补跑判据：只看定时器会漏
// ——————————————————————————————————————————————

test('isPatrolDue：从未跑过 → 该跑', () => {
	assert.equal(isPatrolDue(null, PATROL_PERIODS.weeklyMs), true);
});

test('isPatrolDue：报告时间无法解析 → 该跑（宁多跑一次，不静默停摆）', () => {
	assert.equal(isPatrolDue({ at: 'not-a-date' }, PATROL_PERIODS.weeklyMs), true);
	assert.equal(isPatrolDue({}, PATROL_PERIODS.weeklyMs), true);
});

test('isPatrolDue：未到周期 → 不跑；已过周期 → 跑', () => {
	const now = new Date('2026-11-10T00:00:00.000Z');
	const recent = { at: '2026-11-09T00:00:00.000Z' };  // 1 天前
	const old = { at: '2026-10-01T00:00:00.000Z' };     // 40 天前
	assert.equal(isPatrolDue(recent, PATROL_PERIODS.weeklyMs, now), false);
	assert.equal(isPatrolDue(old, PATROL_PERIODS.weeklyMs, now), true);
});

// ——————————————————————————————————————————————
// runtime.patrol 的失败路径（不只是 writePatrolReport 本身）
// ——————————————————————————————————————————————

test('runtime.patrol 失败时也落盘：文件里必须有 ok:false 的记录', async () => {
	const { createRuntime } = await import('../index.js');
	const dir = sandbox();
	try {
		const rt = createRuntime({ storageDir: dir });
		// 传一个会让巡检内部计算抛错的结构（principles 的 getter 抛错）
		const boom = {
			get principles() { throw new Error('账本结构坏了'); },
		};
		const r = await rt.patrol('weekly', boom);
		assert.equal(r.ok, false, '失败要如实返回 ok:false');
		assert.equal(r.error, '账本结构坏了');
		// 关键：磁盘上必须有这份失败报告 —— 否则"没跑"与"跑了没问题"无法区分
		const onDisk = await readLatestPatrolReport(dir, 'weekly');
		assert.ok(onDisk !== null, '失败报告必须落盘');
		assert.equal(onDisk.ok, false);
		assert.equal(onDisk.error, '账本结构坏了');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('runtime.patrol 成功时写报告并记一笔账本', async () => {
	const { createRuntime } = await import('../index.js');
	const dir = sandbox();
	try {
		const rt = createRuntime({ storageDir: dir });
		const r = await rt.patrol('weekly', { principles: [{ id: 'p1', refs: 0, antiExamples: 0 }] });
		assert.equal(r.ok, true);
		assert.equal(r.findings.length, 1);
		assert.ok(r.report_path, '要回传报告路径');
		const onDisk = await readLatestPatrolReport(dir, 'weekly');
		assert.equal(onDisk.ok, true);
		assert.equal(onDisk.summary.principles, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ——————————————————————————————————————————————
// 32 位定时器上限（真机烟测抓到的 bug）
// ——————————————————————————————————————————————

test('clampTimerDelay：90 天必须被夹到 32 位上限内（否则 Node 压成 1ms 变忙循环）', () => {
	// 真机实测：TimeoutOverflowWarning: 7776000000 does not fit into 32-bit
	// signed integer → "Timeout duration was set to 1"，季度巡检成了每毫秒一次。
	assert.ok(PATROL_PERIODS.quarterlyMs > MAX_TIMER_DELAY_MS, '前提：90 天确实超上限');
	const clamped = clampTimerDelay(PATROL_PERIODS.quarterlyMs);
	assert.equal(clamped, MAX_TIMER_DELAY_MS, '要被夹到上限');
	assert.ok(clamped <= 2_147_483_647, '必须能塞进 32 位有符号整数');
});

test('clampTimerDelay：周级 7 天本就合法，不该被改', () => {
	assert.equal(clampTimerDelay(PATROL_PERIODS.weeklyMs), PATROL_PERIODS.weeklyMs);
});

test('clampTimerDelay：非正数/非法值给最小合法延时（绝不返回 0 或 NaN）', () => {
	for (const bad of [0, -1, NaN, Infinity, undefined]) {
		const got = clampTimerDelay(bad);
		assert.ok(Number.isFinite(got) && got >= 1, `${String(bad)} → ${got} 应为 ≥1 的有限数`);
	}
});

// ——————————————————————————————————————————————
// 空输入不得报 clean（真机第一份报告抓到的假绿）
// ——————————————————————————————————————————————

test('空原则清单的巡检结果不含任何"查过"的证据，调用方不得据此报 clean', () => {
	// 真机第一份报告是 `principles: 0, findings: [], ok: true` —— 看起来像
	// "查了，没问题"，实际它**一条原则都没检查**。这正是"绿灯不携带信息"。
	// 判据层如实返回 0/0；把这种结果说成 clean 的是调用方，所以短路在 apply。
	const empty = weeklyPrinciplePatrol({ principles: [] });
	assert.equal(empty.summary.principles, 0);
	assert.deepEqual(empty.findings, []);
	// 关键对照：这才是真的"查过且没问题"——检查了 N>0 条，零引用为 0
	const real = weeklyPrinciplePatrol({ principles: [{ id: 'p', refs: 9, antiExamples: 0 }] });
	assert.equal(real.summary.principles, 1);
	assert.deepEqual(real.findings, []);
});

test('runtime.patrol 对空清单如实返回 0/0（判据层不撒谎，clean 与否由调用方判）', async () => {
	const { createRuntime } = await import('../index.js');
	const dir = sandbox();
	try {
		const rt = createRuntime({ storageDir: dir });
		const r = await rt.patrol('weekly', { principles: [] });
		assert.equal(r.ok, true);
		assert.equal(r.summary.principles, 0, '如实报 0 条原则');
		assert.equal(r.findings.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('apply 的巡检在没拿到原则清单时落盘 no_input，绝不落 clean', async () => {
	// 这条必须走 apply（真机路径），因为短路写在 apply 的 runPatrol 里。
	// 只测判据层会漏掉它——实测该变异就是这样存活的。
	const { apply } = await import('../index.js');
	const dir = sandbox();
	try {
		const ctx = {
			logger: () => ({ info() {}, warn() {}, error() {} }),
			provide() {}, set() {}, on() {},
			tools: { register: () => () => {} },
		};
		// P0-1：磁盘枚举接入后，no_input 只在「沙箱里确实没有 insights/」时触发。
		// 显式传空数组（人工指定受检面为空）保持原语义。
		apply(ctx, { storageDir: dir, patrol: { enabled: true, principles: [], memoryRoot: join(dir, 'memory') } }, { loadDefineTool: () => (s) => s });
		await new Promise((r) => setTimeout(r, 250));

		const onDisk = await readLatestPatrolReport(dir, 'weekly');
		assert.ok(onDisk !== null, '必须落一份报告（哪怕是"没跑成"）');
		assert.equal(onDisk.ok, false, '没查任何原则不能报 ok:true');
		assert.equal(onDisk.error, 'no_input', '要明确说"没有输入"，而不是 clean');
		assert.ok(String(onDisk.note ?? '').includes('不是 clean'), '要写清这不是 clean');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('P0-1：配置没给原则清单时从磁盘枚举 insights/，周检真的查了东西', async () => {
	// 真机路径：定时器每 7 天跑一次，但没人传 principles → 过去永远 no_input
	// 空转。原则的来源本来就在盘上：文件名=ID，账本 principle_refs=引用数。
	const { apply } = await import('../index.js');
	const { mkdirSync, writeFileSync } = await import('node:fs');
	const dir = sandbox();
	const memory = join(dir, 'memory');
	const insights = join(memory, 'insights');
	try {
		mkdirSync(insights, { recursive: true });
		mkdirSync(join(dir, 'storages'), { recursive: true });
		writeFileSync(join(insights, '判据甲.md'), '# 判据甲\n\n原则正文。\n', 'utf8');
		writeFileSync(join(insights, '判据乙.md'), '> ⚠️ 已被取代：并入判据甲\n\n旧文。\n', 'utf8');
		// Ledger rows: one explicit ref to 判据甲.
		writeFileSync(join(dir, 'mind-valves.jsonl'),
			`${JSON.stringify({ t: new Date().toISOString(), gate: 'x', outcome: 'admitted', principle_refs: ['判据甲'] })}\n`, 'utf8');
		const ctx = {
			logger: () => ({ info() {}, warn() {}, error() {} }),
			provide() {}, set() {}, on() {},
			tools: { register: () => () => {} },
		};
		// No patrol.principles at all — the disk enumeration must kick in.
		apply(ctx, { storageDir: dir, patrol: { enabled: true, memoryRoot: memory } }, { loadDefineTool: () => (s) => s });
		await new Promise((r) => setTimeout(r, 250));

		const onDisk = await readLatestPatrolReport(dir, 'weekly');
		assert.ok(onDisk !== null, '必须落报告');
		assert.equal(onDisk.error, undefined, '磁盘有原则时不得再报 no_input');
		assert.equal(onDisk.ok, true);
		assert.equal(onDisk.summary.principles, 1, '只数存活的：已取代的判据乙不进受检面');
		assert.equal(onDisk.summary.zero_reference, 0, '账本引用了判据甲，零引用应为 0');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('P0-1：insights/ 不存在是正常初始态(absent)；存在但是文件=根坏了，报错不称没有', async () => {
	const { readPrinciplesFromDisk } = await import('../src/patrol.js');
	const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
	const base = await mkdtemp(join(tmpdir(), 'dsh-patrol-disk-'));
	try {
		// a) genuinely absent -> absent, ok (uninitialized root is a real state)
		const r1 = await readPrinciplesFromDisk(join(base, 'nope'), []);
		assert.equal(r1.ok, true);
		assert.equal(r1.absent, true);
		// b) insights exists as a FILE -> broken root, must be an error
		const brokenDir = join(base, 'broken');
		await mkdir(brokenDir, { recursive: true });
		await writeFile(join(brokenDir, 'insights'), 'not a directory');
		const r2 = await readPrinciplesFromDisk(brokenDir, []);
		assert.equal(r2.ok, false, '读坏了不能说成没有');
		assert.equal(r2.absent, undefined);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test('P0-1：阀门证据节的「- 证据：」行计为反例，量化行不算', async () => {
	const { readPrinciplesFromDisk } = await import('../src/patrol.js');
	const { mkdirSync, writeFileSync } = await import('node:fs');
	const dir = sandbox();
	try {
		const insights = join(dir, 'insights');
		mkdirSync(insights, { recursive: true });
		writeFileSync(join(insights, '成对报.md'), [
			'# 成对报',
			'',
			'## 阀门证据',
			'',
			'- 可检验路径：对照实验。',
			'- 量化：{"anti_example_count":99}',
			'- 证据：functions/甲.md 2026-11-02：弱化闸门读数更优',
			'- 证据：functions/乙.md：指标落地',
			'',
			'## 边界',
			'',
			'- 不适用场景。',
		].join('\n'), 'utf8');
		const r = await readPrinciplesFromDisk(dir, []);
		assert.equal(r.principles.length, 1);
		// Counted from concrete evidence lines, not the self-declared number.
		assert.equal(r.principles[0].antiExamples, 2);
		assert.equal(r.principles[0].refs, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ——————————————————————————————————————————————
// 周检提醒待决策候选（2026-11-10 用户要求）
// ——————————————————————————————————————————————

test('readPendingAxiomCandidates：dao/ 在但没有 _candidates → 空列表，不是错误', async () => {
	const { readPendingAxiomCandidates } = await import("../src/patrol.js");
	const { mkdirSync } = await import("node:fs");
	const dir = sandbox();
	try {
		mkdirSync(join(dir, "dao"), { recursive: true });
		const r = await readPendingAxiomCandidates(dir);
		assert.equal(r.ok, true);
		assert.deepEqual(r.candidates, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('readPendingAxiomCandidates：dao/ 本身不可读 → 报错而非"零候选"（读坏了不能说成没有）', async () => {
	const { readPendingAxiomCandidates } = await import("../src/patrol.js");
	const dir = sandbox(); // 空目录：连 dao/ 都没有
	try {
		const r = await readPendingAxiomCandidates(dir);
		assert.equal(r.ok, false, '记忆根不可读不能伪装成「没有候选」');
		assert.match(String(r.error), /dao/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('readPendingAxiomCandidates：读出候选的命题与来源法数', async () => {
	const { readPendingAxiomCandidates } = await import("../src/patrol.js");
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const dir = sandbox();
	try {
		const candDir = join(dir, "dao", "_candidates");
		mkdirSync(candDir, { recursive: true });
		writeFileSync(join(candDir, "演示候选.md"), [
			"# 候选公理 · 演示候选",
			"",
			"## 命题",
			"",
			"信号需要一条它无法伪造的退路。",
			"",
			"## 来源法",
			"",
			"- [法一](../insights/法一.md)",
			"- [法二](../insights/法二.md)",
			"- [法三](../insights/法三.md)",
			"- [法四](../insights/法四.md)",
			"- [法五](../insights/法五.md)",
			"",
		].join("\n"), "utf8");
		const r = await readPendingAxiomCandidates(dir);
		assert.equal(r.ok, true);
		assert.equal(r.candidates.length, 1);
		assert.equal(r.candidates[0].name, "演示候选");
		assert.match(r.candidates[0].proposition, /无法伪造的退路/);
		assert.equal(r.candidates[0].source_count, 5);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('readPendingAxiomCandidates：目录存在但读失败 → 如实报错，不假装零候选', async () => {
	const { readPendingAxiomCandidates } = await import("../src/patrol.js");
	const { writeFileSync } = await import("node:fs");
	const dir = sandbox();
	try {
		// 把 _candidates 造成文件而非目录 → readdir 抛 ENOTDIR
		writeFileSync(join(dir, "dao"), "not a dir", "utf8");
		const r = await readPendingAxiomCandidates(dir);
		assert.equal(r.ok, false, "读失败不能伪装成空列表");
		assert.ok(r.error);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
