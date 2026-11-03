/**
 * 三级诊断的**真实宿主**接线测试（2026-11-03）。
 *
 * ## 与 policy.test.js 的分工
 *
 * `policy.test.js` 测的是**判断与记账逻辑**（纯函数 + store），跑得快。
 * 这个文件测的是**接线**：用真实的 cordis 与真实的 `dsh-system-prompt`，
 * 走宿主同一条路径，验证"提供的引导"与"观察到的行为"真的有来源，
 * 而不是只有函数能返回正确值。
 *
 * 上一轮踩过的坑就是这种："删掉 assemble 监听器，53/53 仍全绿" ——
 * 纯函数测试区分不了"插件在工作"与"插件什么都没做"。
 *
 * 用法：node --test test/diagnostics.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSH_ROOT = (process.env.DSH_INSTALL_DIR ?? 'D:/dsh').replace(/\/$/, '');
process.env.DSH_INSTALL_DIR ??= DSH_ROOT;

/**
 * ⚠️ 把整个测试文件的 `DSH_HOME` 指到临时目录（2026-11-03 修，重要）。
 *
 * ## 为什么必须在这里设、而不是每个用例里设
 *
 * 插件每判一次处境就会往 `$DSH_HOME/storages/mind-dispatch-samples.jsonl`
 * 追加一行。任何触发 `judgeAndSample` 的测试，只要没覆盖 `DSH_HOME`，
 * 就会**写进用户真实的采样文件**。
 *
 * 实测后果：跑一轮套件往真实文件里塞了 186 行测试数据
 * （文件从 368 涨到 836），而那是"调度还灵不灵"的唯一长期读数 ——
 * 被测试污染的仪表盘会长期误导，且污染来源极难追查。
 *
 * 所以隔离放在**文件顶部、任何 import 之前**：覆盖面是整份文件，
 * 而不是"记得加的那几个用例"。逐个用例加这种隔离，早晚会漏一个。
 */
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'mind-test-home-'));
process.env.DSH_HOME = ISOLATED_HOME;

const hostRequire = createRequire(`${DSH_ROOT}/node_modules/@deepseek-ai/dsh/lib/bin.js`);
const host = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')).href);
const systemPromptMod = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-system-prompt')).href);
const SystemPrompt = systemPromptMod.default ?? systemPromptMod.SystemPrompt;

const mindMod = await import(new URL('../index.js', import.meta.url).href);

/** 宿主真实的工具集（含各处境优先族的成员）。 */
const REAL_TOOLS = [
	'advanced_search', 'clis_classify', 'clis_run', 'edit', 'memory_read',
	'memory_search', 'meta_reframe', 'pwsh', 'read', 'web_fetch', 'web_search', 'write',
];

/** 提供 `tools` 服务的最小宿主实现（mind 的 inject 需要它）。 */
class ToolsService extends host.Service {
	constructor(ctx) {
		super(ctx, 'tools');
		this.registered = [];
	}
	register(tool) {
		this.registered.push(tool);
		return () => {};
	}
}

/**
 * 装一套真实环境。
 *
 * @returns {Promise<{ctx: any, order: Function, tool: Function}>} 上下文、取工具面顺序、取诊断工具。
 */
async function setup() {
	mindMod.__setSituationForTest('unknown');
	const ctx = new host.Context();
	await ctx.plugin(SystemPrompt);
	ctx.plugin(ToolsService);
	ctx.systemPrompt.tools(() => ({
		schemas: REAL_TOOLS.map((n) => ({ name: n, description: `d:${n}`, parameters: {} })),
	}));
	await ctx.plugin(mindMod);
	return {
		ctx,
		order: async (agent) => (await ctx.systemPrompt.assemble(agent === undefined ? {} : { agent, scope: agent })).tools.map((t) => t.name),
		tool: () => ctx.tools.registered.find((t) => t.name === 'mind_signals'),
	};
}

function userMsg(text) {
	return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
}

test('接线：判出 → 提供（guidance 只在真的重排后才出现）', async () => {
	const { ctx, order, tool } = await setup();
	const agent = { id: 'g-1' };
	try {
		ctx.emit('agent/inbox/claimed', { agent, turn: 1, message: userMsg('请审查这个插件有没有隐患') });

		// 还没装配 → 判出了，但不得声称"已提供引导"
		let d = await tool().execute({}, { agent });
		assert.ok(d.diagnosis.decision, '应已作出判定');
		assert.equal(d.diagnosis.guidance, null, '尚未装配 → 不得说已提供引导');

		// 装配 → 引导真的提供了
		const names = await order(agent);
		assert.ok(names[0].startsWith('clis_') || names[0].startsWith('meta_'), `diagnose 族应排前，实际 ${names[0]}`);
		d = await tool().execute({}, { agent });
		assert.equal(d.diagnosis.guidance?.situation, 'diagnose', '装配后应记下已提供的引导');
		assert.equal(d.diagnosis.guidance.tools, REAL_TOOLS.length, '引导应记录重排后的工具数');
	} finally {
		await ctx.fiber.dispose();
	}
});

test('接线：ambiguous 时判出但不提供引导（克制闸门）', async () => {
	const { ctx, order, tool } = await setup();
	const agent = { id: 'g-amb' };
	const baseline = await order(agent);
	try {
		// 构造势均力敌：注册两个同权重、指向不同处境的信号
		const dispatch = await import('../src/dispatch.js');
		dispatch.registerSignal({ name: 'test-tie-a', situation: 'retrieve', weight: 2, words: ['甲甲'] });
		dispatch.registerSignal({ name: 'test-tie-b', situation: 'recall', weight: 2, words: ['乙乙'] });
		try {
			ctx.emit('agent/inbox/claimed', { agent, turn: 1, message: userMsg('甲甲和乙乙') });
			const after = await order(agent);
			assert.deepEqual(after, baseline, 'ambiguous 时工具面必须与基线逐字相同（不凭猜引导）');

			const d = await tool().execute({}, { agent });
			assert.equal(d.diagnosis.decision.ambiguous, true, '应记录 ambiguous');
			assert.equal(d.diagnosis.guidance, null, 'ambiguous 时不得提供引导');
			assert.equal(d.diagnosis.current_situation, 'unknown', '处境应保持 unknown');
		} finally {
			dispatch.__clearSignalsForTest();
		}
	} finally {
		await ctx.fiber.dispose();
	}
});

test('接线：tools/result 观察真的接上了（第三级有来源）', async () => {
	const { ctx, tool } = await setup();
	const agent = { id: 'g-obs' };
	try {
		ctx.emit('agent/inbox/claimed', { agent, turn: 1, message: userMsg('请审查这个问题') });
		await ctx.systemPrompt.assemble({ agent, scope: agent });

		// 宿主在工具执行完成后发 tools/result（scopeTarget(this, exec.agent)）
		ctx.emit('tools/result', { name: 'clis_classify', agent }, { ok: true });

		const d = await tool().execute({}, { agent });
		assert.deepEqual(d.diagnosis.observed.tool_calls, ['clis_classify'], '应观察到工具调用');
		assert.equal(d.diagnosis.observed.followed, true, 'clis_classify 属 diagnose 族 → followed(true)');
	} finally {
		await ctx.fiber.dispose();
	}
});

test('接线：没提供引导时 followed 恒为 null（不是 false）', async () => {
	const { ctx, tool } = await setup();
	const agent = { id: 'g-null' };
	try {
		// 判成 unknown → 不重排 → 不提供引导
		ctx.emit('agent/inbox/claimed', { agent, turn: 1, message: userMsg('嗯') });
		await ctx.systemPrompt.assemble({ agent, scope: agent });
		ctx.emit('tools/result', { name: 'read', agent }, { ok: true });

		const d = await tool().execute({}, { agent });
		assert.equal(d.diagnosis.guidance, null, 'unknown 不提供引导');
		assert.equal(
			d.diagnosis.observed.followed,
			null,
			'没提供引导 → followed 必须是 null（"没观察"≠"没照做"）',
		);
	} finally {
		await ctx.fiber.dispose();
	}
});

test('接线：观察到的行为按 agent 隔离（A 的调用不污染 B）', async () => {
	const { ctx, tool } = await setup();
	const a = { id: 'iso-a' }, b = { id: 'iso-b' };
	try {
		ctx.emit('agent/inbox/claimed', { agent: a, turn: 1, message: userMsg('请审查这个问题') });
		await ctx.systemPrompt.assemble({ agent: a, scope: a });
		ctx.emit('tools/result', { name: 'clis_classify', agent: a }, {});

		ctx.emit('agent/inbox/claimed', { agent: b, turn: 1, message: userMsg('搜一下最新资料') });
		await ctx.systemPrompt.assemble({ agent: b, scope: b });
		ctx.emit('tools/result', { name: 'web_search', agent: b }, {});

		const da = await tool().execute({}, { agent: a });
		const db = await tool().execute({}, { agent: b });
		assert.deepEqual(da.diagnosis.observed.tool_calls, ['clis_classify'], 'A 只看到自己的调用');
		assert.deepEqual(db.diagnosis.observed.tool_calls, ['web_search'], 'B 只看到自己的调用');
		assert.equal(da.diagnosis.current_situation, 'diagnose');
		assert.equal(db.diagnosis.current_situation, 'retrieve');
	} finally {
		await ctx.fiber.dispose();
	}
});

test('接线：探针报出三级各自的代号，且"没照做"不拉红灯', async () => {
	const { ctx } = await setup();
	try {
		ctx.emit('agent/inbox/claimed', { turn: 1, message: userMsg('请审查这个问题') });
		await ctx.systemPrompt.assemble({});
		ctx.emit('tools/result', { name: 'read' }, {}); // read 是 core，不属 diagnose 族

		const probe = mindMod.healthProbe.probe();
		const codes = probe.findings.map((f) => f.code);
		assert.ok(codes.includes('mind.dispatched'), `应报判断级，实际 ${codes.join(', ')}`);
		assert.ok(codes.includes('mind.guidance-issued'), `应报提供级，实际 ${codes.join(', ')}`);
		assert.ok(codes.includes('mind.guidance-not-followed'), `应报观察级，实际 ${codes.join(', ')}`);

		// 关键：这三条都是 info，不得把"模型没照做"升级成故障
		const notFollowed = probe.findings.find((f) => f.code === 'mind.guidance-not-followed');
		assert.equal(notFollowed.severity, 'info', '"模型没照做"不是插件的故障');
		assert.equal(probe.status, 'ok', '不得因此把整体状态拉到 degraded/failing');
	} finally {
		await ctx.fiber.dispose();
	}
});

test('接线：mind_signals 返回的信息不含用户原文', async () => {
	const { ctx, tool } = await setup();
	const agent = { id: 'privacy-check' };
	const secret = '我的密钥是 sk-test-abcdef123456，请审查它';
	try {
		ctx.emit('agent/inbox/claimed', { agent, turn: 1, message: userMsg(secret) });
		await ctx.systemPrompt.assemble({ agent, scope: agent });
		ctx.emit('tools/result', { name: 'clis_classify', agent }, {});

		const d = await tool().execute({}, { agent });
		const serialized = JSON.stringify(d);
		assert.ok(!serialized.includes('sk-test'), '诊断输出不得包含用户原文/凭据');
		assert.ok(!serialized.includes('密钥'), '诊断输出不得包含用户原文');

		// 但该报的指标要在
		assert.equal(typeof d.diagnosis.decision.normalization.chars, 'number');
		assert.deepEqual(d.diagnosis.observed.tool_calls, ['clis_classify']);
	} finally {
		await ctx.fiber.dispose();
	}
});

// ───────────── source.kind 判据：逐类取证（2026-11-03）─────────────

/** 造一条带指定 source 的 user 消息。 */
function sourcedMsg(text, source) {
	return { role: 'user', source, content: [{ type: 'text', text }] };
}

test('source.kind：用户回答提问必须算用户输入（旧判据漏判这一类）', async () => {
	const { ctx, order } = await setup();
	const agent = { id: 'kind-reply' };
	try {
		const baseline = await order(agent);
		// ask_user_question 的回复：用户本人表态，理应影响工具面
		ctx.emit('agent/inbox/claimed', {
			agent, turn: 1,
			message: sourcedMsg('请审查这个方案是否可行', { kind: 'user-question-reply', callId: 'c1', outcome: 'answered' }),
		});
		const after = await order(agent);
		assert.notEqual(after.join(','), baseline.join(','), 'user-question-reply 必须能改变工具面（它是用户说的）');
	} finally {
		await ctx.fiber.dispose();
	}
});

test('source.kind：定时提醒等系统渲染文本不算用户输入', async () => {
	const { ctx, order } = await setup();
	const agent = { id: 'kind-schedule' };
	try {
		const baseline = await order(agent);
		for (const source of [{ kind: 'schedule' }, { kind: 'goal' }, { kind: 'compact-checkpoint' }, { kind: 'skill-invocation' }, { kind: 'runtime-context' }]) {
			ctx.emit('agent/inbox/claimed', {
				agent, turn: 1,
				message: sourcedMsg('请审查这个方案并修改', source),
			});
		}
		assert.deepEqual(await order(agent), baseline, `系统来源不得改变工具面`);
	} finally {
		await ctx.fiber.dispose();
	}
});

test('source.kind：其他 agent 的消息不算用户输入', async () => {
	const { ctx, order } = await setup();
	const agent = { id: 'kind-agents' };
	try {
		const baseline = await order(agent);
		for (const source of [{ kind: 'subagent-settled' }, { kind: 'agent-message' }, { kind: 'team-message' }]) {
			ctx.emit('agent/inbox/claimed', { agent, turn: 1, message: sourcedMsg('请审查并修复', source) });
		}
		assert.deepEqual(await order(agent), baseline, '别的 agent 说的话不得驱动本 agent 的工具面');
	} finally {
		await ctx.fiber.dispose();
	}
});

test('source.kind：subagent 任务注入与真人输入不可区分 —— 这是已知限制', async () => {
	// dsh-subagent 的初始任务注入用 { kind: 'user' }，所以它会被当作
	// 用户意图。这不是疏忽而是取舍：子 agent 的任务是用户任务的分解，
	// 且子 agent 恰恰最需要"先看还是先动手"的判断。
	// 这条测试把那个取舍**钉住**：如果哪天有人改成"排除 subagent"，
	// 这里会红，提醒他去看 README 的那段说明。
	const { ctx, order } = await setup();
	const agent = { id: 'kind-subagent' };
	try {
		const baseline = await order(agent);
		ctx.emit('agent/inbox/claimed', { agent, turn: 1, message: sourcedMsg('请审查这段代码', { kind: 'user' }) });
		assert.notEqual(
			(await order(agent)).join(','),
			baseline.join(','),
			'subagent 的 {kind:"user"} 任务注入会被当作意图（已知且刻意的取舍）',
		);
	} finally {
		await ctx.fiber.dispose();
	}
});

test('一个边界里连发多条用户消息：各自判一次，且 pre-step 不重复采样', async () => {
	// 宿主 claim() 是 `for (const message of claimed) emit(...)`
	// （dsh-agent-loop/lib/index.js:106），一个边界可能连发多条。
	// 旧实现用一个槽只记住最后一条，于是 pre-step 去重时前几条匹配不上
	// → 同一条消息被重复判定、重复采样。
	const { mkdtemp, readFile, rm } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const home = await mkdtemp(join(tmpdir(), 'mind-multi-claim-'));
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	const { ctx } = await setup();
	const agent = { id: 'multi-claim' };
	const first = sourcedMsg('请审查这个方案', { kind: 'user' });
	const second = sourcedMsg('搜一下最新资料', { kind: 'user' });
	try {
		// 同一个 turn、两条消息
		ctx.emit('agent/inbox/claimed', { agent, turn: 1, message: first });
		ctx.emit('agent/inbox/claimed', { agent, turn: 1, message: second });
		// 宿主随后发 pre-step，messages 里带着这两条 → 都不该再判一次
		await ctx.waterfall(
			'agent/pre-step',
			{ agent, turn: 1, messages: [first, second] },
			() => Promise.resolve({ kind: 'enter' }),
		);
		await new Promise((done) => setTimeout(done, 150));
		const raw = await readFile(join(home, 'storages/mind-dispatch-samples.jsonl'), 'utf8');
		const lines = raw.trim().split('\n').filter(Boolean);
		assert.equal(lines.length, 2, `两条消息应各采样一次（共 2 条），实际 ${lines.length} 条`);
	} finally {
		await ctx.fiber.dispose();
		if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
		await rm(home, { recursive: true, force: true });
	}
});
