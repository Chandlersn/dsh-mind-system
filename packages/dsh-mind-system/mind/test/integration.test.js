/**
 * 宿主接线集成测试（2026-11-02 对抗式审查补）。
 *
 * ## 为什么必须有这个文件
 *
 * 审查的变异测试结论：64 处变异里 37 处**存活**。最要命的三处 ——
 *
 * - 删掉 `agent/pre-step` 监听器 → 53/53 全绿
 * - 删掉 `system-prompt/assemble` 监听器 → 53/53 全绿
 * - 删掉 `recordSample` 调用 → 53/53 全绿
 *
 * 也就是说旧套件**区分不了"插件在工作"与"插件什么都没做"**。
 * 它测的是纯函数，没测插件与宿主之间的接线。
 *
 * ## 这个文件测什么
 *
 * 真实装载 cordis + 真实的 `dsh-system-prompt` 服务，走**宿主同一条路径**：
 *
 * 1. `agent/inbox/claimed` → 判处境 → `system-prompt/assemble` → 工具面被重排
 * 2. 工具面在**第 1 步**就生效（不是滞后一拍）
 * 3. 一个 turn 内工具面**只变一次**（不抖）
 * 4. 判不出处境时，工具面与"不装本插件"逐字相同
 * 5. 重排**不减少任何工具**（能力零损失）
 * 6. 探针在各状态下报出正确的代号
 *
 * 用法：node --test test/integration.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const DSH_ROOT = (process.env.DSH_INSTALL_DIR ?? 'D:/dsh').replace(/\/$/, '');

/** 从宿主侧解析 cordis —— Service 身份必须与宿主一致。 */
const hostRequire = createRequire(`${DSH_ROOT}/node_modules/@deepseek-ai/dsh/lib/bin.js`);
const host = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')).href);
const systemPromptMod = await import(
	pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-system-prompt')).href
);
const SystemPrompt = systemPromptMod.default ?? systemPromptMod.SystemPrompt;

const mindMod = await import(new URL('../index.js', import.meta.url).href);

/** 宿主真实的工具集（本机装的工具名）。 */
const REAL_TOOLS = [
	'advanced_search', 'ask_user_question', 'clis_classify', 'clis_metrics', 'clis_plan',
	'clis_probe', 'clis_run', 'domain_search', 'edit', 'glob', 'grep', 'memory_read',
	'memory_search', 'meta_reframe', 'multi_search', 'present', 'pwsh', 'read', 'skill',
	'subagent', 'todo_write', 'web_fetch', 'web_search', 'workflow', 'write',
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
 * ⚠️ 每个用例开始前必须重置模块级状态：`src/situation.js` 的当前处境是
 * **模块级**的，上一个用例判出的处境会留在下一个用例里 —— 那正是审查
 * 查出的"工具面在 turn 内抖动"的同一种机制，出现在测试之间。
 *
 * @returns {Promise<{ctx: any, order: () => Promise<string[]>}>} 上下文与取工具面顺序的函数。
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
		order: async () => (await ctx.systemPrompt.assemble({})).tools.map((t) => t.name),
	};
}

/** 造一条 user 消息。 */
function userMsg(text) {
	return { role: 'user', content: [{ type: 'text', text }] };
}

test('接线：agent/inbox/claimed → 判处境 → assemble 真的重排了工具面', async () => {
	const { ctx, order } = await setup();
	try {
		const before = await order();

		// 宿主次序：claim() 发 inbox/claimed → 然后 assemble()
		ctx.emit('agent/inbox/claimed', { message: userMsg('你调用心智系统插件对自身进行对抗式审查'), turn: 1 });

		const after = await order();
		assert.notEqual(after.join(','), before.join(','), '判出处境后工具面必须真的变了（不是空转）');
		assert.ok(
			after[0].startsWith('clis_') || after[0].startsWith('meta_'),
			`diagnose 处境下判结构工具应排首位，实际 ${after[0]}`,
		);
	} finally {
		await ctx.fiber.dispose();
	}
});

test('接线：重排在第 1 步就生效（不是滞后一拍 —— 这是审查查出的核心缺陷）', async () => {
	const { ctx, order } = await setup();
	try {
		const baseline = (await order()).join(',');
		// 第 1 步：用户输入到达 → 紧接着 assemble
		ctx.emit('agent/inbox/claimed', { message: userMsg('帮我审查一下这个插件有没有隐患'), turn: 1 });
		const step1 = (await order()).join(',');
		assert.notEqual(
			step1,
			baseline,
			'第 1 步（模型首次回应用户、决定用哪个工具的那一步）必须已有调度效果',
		);
	} finally {
		await ctx.fiber.dispose();
	}
});

test('接线：一个 turn 内工具面只变一次（不抖 —— 抖会触发宿主请求序列重启）', async () => {
	const { ctx, order } = await setup();
	try {
		const baseline = (await order()).join(',');
		ctx.emit('agent/inbox/claimed', { message: userMsg('帮我审查一下这个插件'), turn: 1 });
		const step1 = (await order()).join(',');
		assert.notEqual(step1, baseline, '第 1 步必须已生效');

		// 第 2 步起 inbox 为空 → 宿主不再发 claimed（claimed 数组为空）。
		// 但即使发了一个空消息，处境也不该被重置。
		ctx.emit('agent/inbox/claimed', { message: { role: 'user', content: [] }, turn: 1 });
		const step2 = (await order()).join(',');
		assert.equal(step2, step1, '空输入不得把工具面抖回默认顺序（会让宿主重启请求序列）');

		// 第 3 步同样
		ctx.emit('agent/inbox/claimed', { message: { role: 'user', content: [] }, turn: 1 });
		const step3 = (await order()).join(',');
		assert.equal(step3, step1, '工具面在 turn 内必须稳定');
	} finally {
		await ctx.fiber.dispose();
	}
});

test('接线：判不出处境时，工具面与"不装本插件"逐字相同', async () => {
	// 基线：只装 systemPrompt + 工具，不装本插件
	const ctxBase = new host.Context();
	await ctxBase.plugin(SystemPrompt);
	ctxBase.plugin(ToolsService);
	ctxBase.systemPrompt.tools(() => ({
		schemas: REAL_TOOLS.map((n) => ({ name: n, description: `d:${n}`, parameters: {} })),
	}));
	const baseline = (await ctxBase.systemPrompt.assemble({})).tools.map((t) => t.name).join(',');
	await ctxBase.fiber.dispose();

	const { ctx, order } = await setup();
	try {
		// 判不出处境的输入
		ctx.emit('agent/inbox/claimed', { message: userMsg('嗯'), turn: 1 });
		const actual = (await order()).join(',');
		assert.equal(actual, baseline, '判不出处境时必须原样返回（宁可不动，也不要凭空猜）');
	} finally {
		await ctx.fiber.dispose();
	}
});

test('接线：重排不减少任何工具（能力零损失）', async () => {
	const { ctx, order } = await setup();
	try {
		ctx.emit('agent/inbox/claimed', { message: userMsg('帮我审查一下有没有隐患'), turn: 1 });
		const after = await order();
		assert.equal(after.length, REAL_TOOLS.length, `工具数不得减少，实际 ${after.length} vs ${REAL_TOOLS.length}`);
		assert.deepEqual(
			[...after].sort(),
			[...REAL_TOOLS].sort(),
			'工具集合不得改变（只重排，不删）',
		);
	} finally {
		await ctx.fiber.dispose();
	}
});

test('接线：探针在各状态下报出正确的代号', async () => {
	const { ctx } = await setup();
	try {
		const probe = mindMod.healthProbe.probe();
		const codes = probe.findings.map((f) => f.code);
		assert.ok(codes.includes('mind.ok'), `装载后应报 mind.ok，实际 ${codes.join(', ')}`);
		assert.ok(!codes.includes('mind.not-loaded'), '装载后不得报 not-loaded');

		// 判出处境后应报 dispatched
		ctx.emit('agent/inbox/claimed', { message: userMsg('帮我审查一下'), turn: 1 });
		const probe2 = mindMod.healthProbe.probe();
		const codes2 = probe2.findings.map((f) => f.code);
		assert.ok(
			codes2.includes('mind.dispatched'),
			`命中信号后应报 mind.dispatched，实际 ${codes2.join(', ')}`,
		);
		assert.ok(!codes2.includes('mind.no-signal'), '命中后不得同时报 no-signal');
	} finally {
		await ctx.fiber.dispose();
	}
});

test('接线：分节真的进了装配结果（不是只调用了 section()）', async () => {
	const { ctx } = await setup();
	try {
		const assembly = await ctx.systemPrompt.assemble({});
		const names = assembly.sections.map((s) => s.name);
		assert.ok(names.includes('mind:orchestration'), `分节应出现在装配里，实际 ${names.join(', ')}`);
		const mine = assembly.sections.find((s) => s.name === 'mind:orchestration');
		assert.ok((mine?.text ?? '').length > 200, '分节正文非空');
		assert.ok((mine?.text ?? '').includes('判断顺序'), '分节含判断顺序标志句');
		assert.ok(!(mine?.text ?? '').includes('{{'), '正文没有被变量插值破坏');
	} finally {
		await ctx.fiber.dispose();
	}
});

test('scripts/verify-assembly.mjs 必须全绿（它是仓库里最强的判据，之前 5 项 FAIL 却没人看见）', async () => {
	// ⚠️ 旧版这个脚本不在测试套件里 —— 它实跑 5 项 FAIL（分节不在装配、
	// 重排是空转），原因是没有提供 tools 服务 → 插件 apply() 未激活。
	// 把它接进套件，这类失败就不再可能"存在但无人知晓"。
	//
	// ⚠️ 必须用**绝对路径**且 cwd 设到包目录：脚本内部用相对路径解析
	// `../index.js`，cwd 一变就找不到模块（表现为 import 失败而非断言失败）。
	const { execFileSync } = await import('node:child_process');
	const { fileURLToPath } = await import('node:url');
	const { dirname, join } = await import('node:path');
	const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
	const script = join(pkgRoot, 'scripts', 'verify-assembly.mjs');
	try {
		const out = execFileSync(process.execPath, [script], { encoding: 'utf8', cwd: pkgRoot });
		assert.ok(out.includes('VERIFY OK'), `verify-assembly.mjs 必须全绿，实际输出：\n${out}`);
	} catch (error) {
		assert.fail(`verify-assembly.mjs 失败：\n${error.stdout ?? ''}${error.stderr ?? ''}`);
	}
});
