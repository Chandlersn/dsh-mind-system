/**
 * 入口/运行时/桥集成测试 —— 不依赖宿主安装。
 *
 * 覆盖三件真机才暴露过的事：
 * 1. 运行时每次评估两侧都落账（deny → skipped）；
 * 2. defineTool 加载失败时插件活着、探针点名（不是静默不激活）；
 * 3. memory 桥在服务缺失/抛错时返回 undefined，绝不连累调用方。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRuntime, apply, probe, PROBE_CODES, TOOL_NAMES } from '../index.js';

// 桥的两种布局都要能测：源仓里是兄弟包（../../dsh-memory-manager），
// 合成产物里是兄弟目录（../../memory）。按存在性选，不写死一种。
const here = dirname(fileURLToPath(import.meta.url));
const bridgeCandidates = [
	join(here, '..', '..', 'dsh-memory-manager', 'src', 'valves-bridge.js'),
	join(here, '..', '..', 'memory', 'src', 'valves-bridge.js'),
];
const bridgePath = bridgeCandidates.find((p) => existsSync(p));
if (!bridgePath) throw new Error('找不到 valves-bridge.js（源仓/合成两种布局都没命中）');
const { probeValves, relevantNegativeRules, recordUpwardWrite, upwardEntryFromWrite } = await import(pathToFileURL(bridgePath).href);

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-valves-entry-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 记账是 fire-and-forget，读账前给微任务队列一个落盘机会。 */
async function settle() {
	await new Promise((r) => setTimeout(r, 50));
}

test('运行时：allow/deny 双侧落账，metrics 报 missRate 与分布', async () => {
	const { dir, cleanup } = tempDir();
	try {
		const rt = createRuntime({ storageDir: dir });
		rt.downward('L1', 'L2', { constraints: ['先读再改'] });
		rt.downward('L1', 'L2', {});
		rt.upward('L3', 'L1', { kind: 'positive', rule_type: 'skill' }); // 跳层 → reject
		await settle();
		const m = await rt.metrics();
		assert.equal(m.evaluated, 3);
		assert.equal(m.admitted, 1);
		assert.equal(m.skipped, 2);
		assert.equal(m.byReason.not_concretized, 1);
		assert.equal(m.byReason.non_adjacent_ascent, 1);
		assert.equal(m.negative_rules, 0);
		assert.equal(m.negative_store, 'ok');
	} finally {
		cleanup();
	}
});

test('运行时：确认生效 → 下行黑名单命中（闭环：向上产物改变向下行为）', async () => {
	const { dir, cleanup } = tempDir();
	try {
		const rt = createRuntime({ storageDir: dir });
		const c = await rt.confirm({
			id: 'no-blind-retry', negative_type: 'forbidden_skill',
			statement: '禁止原样重试', keywords: ['原样重试'],
		});
		assert.equal(c.ok, true);
		assert.deepEqual(await rt.matchNegative('计划：原样重试该命令'), ['no-blind-retry']);
		// 闭环判据（F7 的最小形态）：同一输入，确认前 allow、确认后 deny。
		const before = createRuntime({ storageDir: tempDir().dir });
		assert.equal(before.downward('L1', 'L2', { constraints: ['原样重试该命令'] }).action, 'allow');
		const hits = await rt.matchNegative('原样重试该命令');
		assert.equal(rt.downward('L1', 'L2', { constraints: ['原样重试该命令'], negative_rule_hits: hits }).action, 'deny');
	} finally {
		cleanup();
	}
});

test('IV-3 运行时闭环：确认→命中→沉底→放行，且沉底规则仍可查回', async () => {
	const { dir, cleanup } = tempDir();
	try {
		const rt = createRuntime({ storageDir: dir });
		await rt.confirm({
			id: 'stale-guard', negative_type: 'forbidden_skill',
			statement: '过期的禁令', keywords: ['过期令牌'],
		});
		assert.deepEqual(await rt.matchNegative('计划：使用过期令牌'), ['stale-guard']);
		// 命中应写入触发流水（沉底判据的原料）
		const triggers = await rt.sinkCandidates({ windowDays: 90 });
		assert.equal(triggers.triggers_unreadable, false);
		assert.deepEqual(triggers.candidates, [], '刚命中的规则不该出现在沉底候选里');
		// 人工沉底（运行时走票据通道）
		const sunk = await rt.sink(['stale-guard'], { reason: '90 天未触发' });
		assert.equal(sunk.ok, true);
		assert.deepEqual(await rt.matchNegative('计划：使用过期令牌'), [], '沉底后不再拦截');
		const assets = await rt.sunkNegativeRules();
		assert.equal(assets.length, 1, '仍可检索为反例资产');
		assert.equal(assets[0].statement, '过期的禁令');
	} finally {
		cleanup();
	}
});

test('运行时：阈值覆盖传导到判定', () => {
	const { dir, cleanup } = tempDir();
	try {
		const rt = createRuntime({ storageDir: dir, thresholds: { skillMinRepeats: 2 } });
		const d = rt.upward('L3', 'L2', {
			kind: 'positive', rule_type: 'skill', repeats: 2, success_rate: 0.9,
			success_evidence: 'external', evidence: ['t'], verifiable_by: '重放',
		});
		assert.equal(d.action, 'human_gate');
	} finally {
		cleanup();
	}
});

/** 假 ctx：够 apply 用的最小面。 */
function fakeCtx(services = new Map()) {
	return {
		get: (k) => services.get(k),
		provide: (k, v) => services.set(k, v),
		set: (k, v) => services.set(k, v),
		tools: { register: (t) => { fakeCtx.registered.push(t); return () => {}; } },
		logger: () => ({ error: () => {}, warn: () => {} }),
	};
}
fakeCtx.registered = [];

test('apply：加载器失败 → 插件活着、服务已发布、探针点名 tool-missing', () => {
	fakeCtx.registered = [];
	const services = new Map();
	const ctx = fakeCtx(services);
	const { dir, cleanup } = tempDir();
	try {
		apply(ctx, { storageDir: dir }, { loadDefineTool: () => { throw new Error('no host'); } });
		assert.ok(services.get('valves'), '服务发布不依赖 defineTool（memory 桥仍可用）');
		const p = probe();
		assert.equal(p.status, 'failing');
		assert.ok(p.findings.some((f) => f.code === PROBE_CODES.toolMissing));
		assert.ok(p.findings.some((f) => f.message.includes('no host')), '探针必须带真实原因');
	} finally {
		cleanup();
	}
});

test('apply：三工具注册、探针 ok', () => {
	fakeCtx.registered = [];
	const ctx = fakeCtx(new Map());
	const { dir, cleanup } = tempDir();
	try {
		const stubDefineTool = (spec) => spec;
		apply(ctx, { storageDir: dir }, { loadDefineTool: () => stubDefineTool });
		const names = fakeCtx.registered.map((t) => t.name).sort();
		assert.deepEqual(names, Object.values(TOOL_NAMES).sort());
		const p = probe();
		assert.equal(p.status, 'ok');
		assert.ok(p.findings.some((f) => f.code === PROBE_CODES.ok));
	} finally {
		cleanup();
	}
});

test('apply：真实宿主 defineTool 编译全部 schema（宿主方言最严格端）', async () => {
	// harness-test 抓到过的坑：object 参数缺 additionalProperties 声明会被
	// 宿主 JsonSchemaError 拒编——stub 测试全绿也挡不住。这条用真编译器。
	// 数量断言绑定 TOOL_NAMES（单一真值源），加工具不用改这里。
	let realDefine;
	try {
		const { loadDefineTool } = await import('../index.js');
		realDefine = loadDefineTool();
	} catch {
		// 没装宿主的机器上跳过（探针/其余用例仍覆盖装载路径）
		return;
	}
	fakeCtx.registered = [];
	const ctx = fakeCtx(new Map());
	const { dir, cleanup } = tempDir();
	try {
		apply(ctx, { storageDir: dir }, { loadDefineTool: () => realDefine });
		assert.equal(fakeCtx.registered.length, Object.keys(TOOL_NAMES).length, '全部 schema 都必须过宿主编译');
	} finally {
		cleanup();
	}
});

// —— memory 桥 ——

test('桥：无服务/ctx 抛错 → 全 undefined，不抛', async () => {
	assert.equal(probeValves(undefined), undefined);
	assert.equal(probeValves({ get: () => { throw new Error('boom'); } }), undefined);
	assert.equal(probeValves({ get: () => ({}) }), undefined, '形状不完整不算可用');
	assert.equal(await relevantNegativeRules({}, 'text'), undefined);
	assert.equal(recordUpwardWrite({}, { rule_type: 'criterion' }), undefined);
});

test('桥：服务在 → 关键词命中返回规则；upward 留痕走真运行时', async () => {
	const { dir, cleanup } = tempDir();
	try {
		const rt = createRuntime({ storageDir: dir });
		await rt.confirm({ id: 'r1', negative_type: 'forbidden_skill', statement: '禁止 X', keywords: ['关键词甲'] });
		const ctx = { get: (k) => (k === 'valves' ? rt : undefined) };
		const hits = await relevantNegativeRules(ctx, '本轮提到关键词甲的任务');
		assert.equal(hits.length, 1);
		assert.equal(hits[0].id, 'r1');
		assert.deepEqual(await relevantNegativeRules(ctx, '无关'), []);
		const d = recordUpwardWrite(ctx, { rule_type: 'axiom', evidence: ['insights/a.md'], verifiable_by: '人工' });
		assert.equal(d.action, 'human_gate');
		assert.equal(d.reason, 'axiom_human_only');
	} finally {
		cleanup();
	}
});

test('桥：字段映射不编造——缺 verifiable_by 就如实 downgrade 落账', async () => {
	const { dir, cleanup } = tempDir();
	try {
		const rt = createRuntime({ storageDir: dir });
		const ctx = { get: (k) => (k === 'valves' ? rt : undefined) };
		const entry = upwardEntryFromWrite('criterion', { theme: 'x' }, ['functions/a.md']);
		assert.equal(entry.verifiable_by, undefined, '不得编造默认检验方式');
		const d = recordUpwardWrite(ctx, entry);
		assert.equal(d.action, 'downgrade');
		// 显式证据白名单透传
		const e2 = upwardEntryFromWrite('criterion', {
			theme: 'y',
			valve_evidence: { verifiable_by: '对照实验', skill_coverage: 3, scenario_coverage: 2, anti_example_count: 1, predict_rate: 0.7, made_up_key: 1 },
		}, ['functions/b.md']);
		assert.equal(e2.made_up_key, undefined, '白名单外的键不得进账本');
		assert.equal(recordUpwardWrite(ctx, e2).action, 'human_gate');
	} finally {
		cleanup();
	}
});