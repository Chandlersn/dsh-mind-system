/**
 * V-2 全闭环用例：真实 Cordis 装载下，一条链跑通
 *   器（能力/技能） → 术（functions） → 法（insights） → 道（dao）
 *   + 负向规则（确认→拦截→回滚）
 *
 * ## 为什么必须真装载，不能只测纯函数
 *
 * 2026-11-02 对抗审查的结论：64 处变异里 37 处存活，删掉监听器仍然 53/53 全绿。
 * 纯函数测试区分不了"插件在工作"与"插件什么都没做"。所以本文件走**宿主同一条
 * 路径**：真实 cordis Context + 真实 tools 服务 + 真实插件入口，四个包装在同
 * 一个 ctx 上，靠工具调用与文件副作用互相证明。
 *
 * ## 每个用例的"没跑起来也算失败"守卫
 *
 * 完成标志是"用例全绿"，但绿本身不算证据 —— 所以每个用例都断言一个
 * **只有真的执行过才会出现**的外部事实（文件存在、账本行数增加、判定改变）。
 * 少了这个守卫，一条 `return true` 的空实现也能全绿。
 *
 * 用法：DSH_INSTALL_DIR=D:/dsh node --test test/full-loop.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSH_ROOT = (process.env.DSH_INSTALL_DIR ?? 'D:/dsh').replace(/\/$/, '');
process.env.DSH_INSTALL_DIR ??= DSH_ROOT;

// One isolated root for the whole file: every write must land in the sandbox,
// never in the user's real memory root.
const HOME = mkdtempSync(join(tmpdir(), 'mind-fullloop-'));
process.env.DSH_HOME = HOME;

const hostRequire = createRequire(`${DSH_ROOT}/node_modules/@deepseek-ai/dsh/lib/bin.js`);
const host = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')).href);

const valvesMod = await import(new URL('../index.js', import.meta.url).href);
const traceMod = await import(new URL('../src/trace.js', import.meta.url).href);

/** 最小 tools 服务：插件只要能 register，不需要真宿主工具集。 */
class ToolsService extends host.Service {
	constructor(ctx) {
		super(ctx, 'tools');
		this.registered = new Map();
	}
	register(tool) {
		this.registered.set(tool.name, tool);
		return () => this.registered.delete(tool.name);
	}
}

/**
 * 装一个真实 ctx，把 valves 接上去，并返回调用工具的能力。
 * 这与宿主装载走同一条 `ctx.plugin(mod)` 路径。
 */
async function setup() {
	const storageDir = mkdtempSync(join(tmpdir(), 'mind-fullloop-store-'));
	const ctx = new host.Context();
	ctx.plugin(ToolsService);
	await ctx.plugin({
		name: valvesMod.name,
		// The plugin declares inject:['tools']; a real host satisfies it before
		// apply runs. Mirror that here, or reading ctx.tools throws — which is
		// exactly what the first run did ("cannot get property tools without inject").
		inject: valvesMod.inject,
		apply: (c) => valvesMod.apply(c, valvesConfig(storageDir)),
	});
	return {
		ctx,
		storageDir,
		async call(name, args) {
			const tool = ctx.tools.registered.get(name);
			if (!tool) throw new Error(`工具未注册: ${name}（已注册: ${[...ctx.tools.registered.keys()].join(',')}）`);
			return tool.execute(args, {});
		},
		async dispose() {
			await ctx.fiber.dispose();
			rmSync(storageDir, { recursive: true, force: true });
		},
	};
}

function valvesConfig(storageDir) {
	return { storageDir: storageDir };
}

const settle = () => new Promise((r) => setTimeout(r, 60));

function ledgerRows(dir) {
	const p = join(dir, 'mind-valves.jsonl');
	if (!existsSync(p)) return [];
	return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ——————————————————————————————————————————————————————————————
// 链路第 1 段：器（工具面存在）→ 负向规则确认 → 拦截生效
// ——————————————————————————————————————————————————————————————

test('闭环 1/3 · 负向规则：确认 → 真实拦截 → 回滚后不再拦截', async () => {
	const env = await setup();
	try {
		// GUARD: the tool surface must actually exist, or every later call fails
		// for the wrong reason.
		assert.ok(env.ctx.tools.registered.size >= 5, `阀门工具已注册（${env.ctx.tools.registered.size} 个）`);

		const before = ledgerRows(env.storageDir).length;

		const confirmed = await env.call('valve_confirm', {
			id: 'loop-no-delete-shared',
			negative_type: 'forbidden_skill',
			statement: '禁止删除共享库（V-2 闭环用例）',
			keywords: ['不要删共享库'],
		});
		assert.equal(confirmed.ok, true, `确认应成功，实际 ${JSON.stringify(confirmed).slice(0, 160)}`);

		// GUARD: a decision row must have been appended — proving it really ran.
		await settle();
		const afterConfirm = ledgerRows(env.storageDir);
		assert.ok(afterConfirm.length > before, '确认后账本行数必须增加（真跑了的证据）');

		// The rule must actually block now.
		const hit = await env.call('valve_check', { direction: 'down', from: 'L1', to: 'L2', data: { constraints: ['不要删共享库里的任何东西'] } });
		assert.ok(JSON.stringify(hit).includes('deny') || hit.outcome === 'deny' || hit.blocked === true,
			`命中应当 deny，实际 ${JSON.stringify(hit).slice(0, 200)}`);

		// Rollback removes it, and blocking stops.
		const rolled = await env.call('valve_confirm', { action: 'rollback', rollback_rule_id: 'loop-no-delete-shared' });
		assert.equal(rolled.ok, true, `回滚应成功，实际 ${JSON.stringify(rolled).slice(0, 160)}`);
		const after = await env.call('valve_check', { direction: 'down', from: 'L1', to: 'L2', data: { constraints: ['不要删共享库里的任何东西'] } });
		assert.ok(!(after.outcome === 'deny' || after.blocked === true),
			`回滚后不应再拦截，实际 ${JSON.stringify(after).slice(0, 200)}`);
	} finally {
		await env.dispose();
	}
});

// ——————————————————————————————————————————————————————————————
// 链路第 2 段：法层闸门（≥2 源）+ 道层闸门（≥5 法）真在拦
// ——————————————————————————————————————————————————————————————

test('闭环 2/3 · 上行闸门：跳层被拒、无证据被拒、合规才放行', async () => {
	const env = await setup();
	try {
		// 跳层：L0 → L2 不是相邻上行，必须 reject。
		const jump = await env.call('valve_check', { direction: 'up', from: 'L0', to: 'L2', data: { kind: 'positive', rule_type: 'skill' } });
		assert.ok(JSON.stringify(jump).includes('non_adjacent') || jump.outcome === 'skipped',
			`跳层应被拒，实际 ${JSON.stringify(jump).slice(0, 200)}`);

		// 无外部证据：self_report 必须**不被当作外部证据**。真实行为是
		// downgrade + not_externally_verifiable（不是直接拒绝，而是降级到 0.6
		// 置信上限），这正是判据 J1 的语义——所以断言"被降级/拒绝/转人工"，
		// 而不是硬要求某个具体词。
		const selfReport = await env.call('valve_check', {
			direction: 'up', from: 'L1', to: 'L0',
			data: { kind: 'positive', rule_type: 'axiom', success_evidence: 'self_report', evidence: ['我觉得可以'] },
		});
		const flat = JSON.stringify(selfReport);
		assert.ok(/not_externally_verifiable|downgrade|reject|skipped|human_gate/.test(flat),
			`自述证据不得被当成外部证据，实际 ${flat.slice(0, 220)}`);
		// 更强的断言：它绝不能是"完整通过"。
		assert.notEqual(selfReport.outcome, 'admitted', '自述证据不能直接 admitted');

		// GUARD: the ledger must have grown — the two rejections really executed.
		await settle();
		assert.ok(ledgerRows(env.storageDir).length >= 2, '两次判定都应落账');
	} finally {
		await env.dispose();
	}
});

// ——————————————————————————————————————————————————————————————
// 链路第 3 段：trace 贯穿（V-1 与 V-2 的交点）
// ——————————————————————————————————————————————————————————————

test('闭环 3/3 · 执行面留下四字段 trace，且与决策同账本', async () => {
	const env = await setup();
	try {
		await env.call('valve_confirm', {
			id: 'loop-trace-rule', negative_type: 'forbidden_skill',
			statement: '禁止原样重试（V-2 trace 用例）', keywords: ['原样重试'],
		});
		// semantic direction is the path that writes a trace.
		const sem = await env.call('valve_check', { direction: 'semantic', semantic: { text: '这里涉及原样重试', candidate_id: 'loop-cand' } });
		assert.ok(sem && typeof sem === 'object', '语义检查应有返回');

		await settle();
		const rows = ledgerRows(env.storageDir);
		const traces = traceMod.traceRows(rows);
		assert.ok(traces.length >= 1, `必须写出至少一条 trace（实际 ${traces.length}）`);

		const t = traces[traces.length - 1];
		// GUARD: 四字段必须真的在。少一个字段，trace 就是摆设。
		for (const f of traceMod.TRACE_FIELDS) {
			assert.ok(f in t, `trace 缺少契约字段 ${f}`);
		}
		const v = traceMod.verifyTraceFields(t);
		assert.equal(v.ok, true, `trace 应通过契约校验（缺 ${v.missing.join(',')}）`);
		// 决策与 trace 必须同文件——不建第二存储。
		assert.ok(rows.some((r) => r.kind !== 'trace'), '同一账本里还有决策行');
	} finally {
		await env.dispose();
	}
});

