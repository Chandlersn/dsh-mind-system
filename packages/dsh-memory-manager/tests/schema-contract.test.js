/**
 * 工具契约测试：把每个工具的定义交给**宿主真实的 output 校验器**跑一遍。
 *
 * 为什么单独一套：七套既有测试里 tools.register 都被换成 stub（只收名字，
 * 或直接 noop），defineTool 产出的 output.schema 从未被 validateJsonSchemaValue
 * 校验过。结果 2026-11-05 出现「七套全绿，真机 7/9 个分支回执被宿主拒收」：
 * SELF_CHECK_SCHEMA 顶层多写了 required:true，宿主把它理解成「selfCheck 必填」，
 * memory_skill 的 items[].owned 又没声明。这是 5.11.3（trust）之后同类缺陷
 * 第三次重演 —— 光补字段不够，必须有一条断言真的走宿主的校验路径。
 *
 * 判据（法「闸门只证没坏不证有内容」）：正向断言「该出现的分支能通过」+
 * 反向断言「不完整 selfCheck 仍被拒」+ 「没有任何工具把 selfCheck 列为顶层必填」。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');

// 定位宿主：先用本包自己的解析器（与 server.js 同源），找不到就明确跳过。
const { resolveDshRoot } = await import(pathToFileURL(path.join(pkgDir, 'src/host.js')).href);
let hostRoot;
try {
	hostRoot = resolveDshRoot(process.env.DSH_INSTALL_DIR);
} catch (err) {
	console.log(`SKIP schema-contract: 找不到 DSH 宿主安装 —— ${err.message}`);
	console.log('      真跑：DSH_INSTALL_DIR=<宿主目录>；要它成为硬失败：DSH_REQUIRE_HOST=1。');
	process.exit(process.env.DSH_REQUIRE_HOST === '1' ? 1 : 0);
}

const hostEntry = path.join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib/index.js');
const require = createRequire(hostEntry);
const { validateJsonSchemaValue } = require(hostEntry);

const mod = await import(pathToFileURL(path.join(pkgDir, 'server.js')).href);

// 捕获 defineTool 定义：apply() 需要 ctx，但工具注册只是把定义交出来。
const captured = [];
const noop = () => {};
const fakeCtx = {
	tools: { register: (def) => { captured.push(def); return noop; } },
	on: () => noop,
	inject: (names, fn) => fn({
		webServer: { register: () => noop },
		systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
		connection: undefined,
		effect: (f) => f(),
	}),
	effect: (f) => f(),
	systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
};
mod.apply(fakeCtx, {});

const completeSelfCheck = {
	ok: true,
	layer: '器',
	relPath: 'capabilities/x.md',
	findings: [],
	notes: [],
};

// 各 action 分支的代表性返回形状（逐字对照 server.js 里的 return / items.push）。
// 新增分支时必须在这里补一条，否则该分支不会被契约覆盖。
const SAMPLES = {
	memory_capability: {
		list: { action: 'list', items: [{ name: 'x', kind: 'cli', summary: 's', invocation: 'i', updated: '2026-01-01' }], warnings: [] },
		read: { action: 'read', file: 'p', items: [], content: 'text', warnings: [] },
		record: { action: 'record', file: 'p', created: true, items: [{ name: 'x', kind: 'cli', summary: 's', invocation: 'i', updated: '2026-01-01' }], selfCheck: completeSelfCheck, warnings: [] },
	},
	memory_skill: {
		candidates: { action: 'candidates', candidates: [{ href: 'functions/x.md', uses: 6, positives: 1, badRate: 0, flips: 0 }], items: [], warnings: [] },
		list: { action: 'list', items: [{ name: 'x', status: 'active', summary: 's', updated: '2026-01-01', scope: 'global', owned: true, published: true }], warnings: [] },
		read: { action: 'read', file: 'p', items: [], content: 'text', warnings: [] },
		crystallize: { action: 'crystallize', file: 'p', created: true, status: 'candidate', items: [{ name: 'x', status: 'candidate', summary: 's', updated: '2026-01-01' }], selfCheck: { ...completeSelfCheck, layer: '技能', relPath: 'skills/x/SKILL.md' }, warnings: [] },
		activate: { action: 'activate', file: 'p', status: 'active', items: [{ name: 'x', status: 'active', summary: 's', updated: '2026-01-01' }], warnings: [] },
		delete: { action: 'delete', file: 'p', status: 'deleted', items: [], warnings: [] },
	},
};

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

// ① 没有任何工具把 selfCheck 列为顶层必填（这是 2026-11-05 事故的直接判据）。
const forced = captured
	.filter((d) => d?.output?.schema?.required?.includes('selfCheck'))
	.map((d) => d.name);
ok(forced.length === 0, `selfCheck 不应是任何工具的顶层必填，实际：${forced.join(', ') || '（无）'}`);

// ② 每个被覆盖的分支都必须通过宿主真实校验器。
for (const def of captured) {
	const schema = def?.output?.schema;
	if (!schema) continue;
	const samples = SAMPLES[def.name];
	if (!samples) continue;
	for (const [branch, value] of Object.entries(samples)) {
		const violations = validateJsonSchemaValue(schema, value, 'value');
		ok(violations.length === 0, `${def.name}(${branch}) 回执被宿主拒收：${violations.join(' | ')}`);
	}
}

// ③ 反向：selfCheck 的内部结构仍是硬约束，不能因为「改成可选」就全放开。
const cap = captured.find((d) => d.name === 'memory_capability');
ok(!!cap, 'memory_capability 已注册');
const incomplete = {
	action: 'record', file: 'p', created: true, items: [], warnings: [],
	selfCheck: { ok: true },
};
const badViolations = validateJsonSchemaValue(cap.output.schema, incomplete, 'value');
ok(badViolations.some((v) => v.includes('selfCheck.layer')), '不完整的 selfCheck 仍应被宿主拒绝（内部结构未被削弱）');

// ④ healthProbe 必须是带 probe() 的对象（协作层监督读 ns.healthProbe.probe）。
ok(typeof mod.healthProbe === 'object' && mod.healthProbe !== null, 'healthProbe 导出为对象而非工厂函数');
ok(typeof mod.healthProbe?.probe === 'function', 'healthProbe.probe 是可调用方法');
const probeResult = await mod.healthProbe.probe();
ok(probeResult?.plugin === 'dsh-memory-manager', 'probe() 返回 plugin 标识');
ok(Array.isArray(probeResult?.findings), 'probe() 返回 findings 数组');

// ⑤ 反向：探针自身失败必须转成 error finding，绝不抛错。
const { createHealthProbe } = await import(pathToFileURL(path.join(pkgDir, 'health-inbox.js')).href);
const broken = createHealthProbe({
	runHealthCheck: async () => { throw new Error('disk blew up'); },
	resolveRoot: () => '/nonexistent',
	opts: {},
});
let thrown = false;
let brokenResult;
try { brokenResult = await broken.probe(); } catch { thrown = true; }
ok(!thrown, 'probe() 内部异常不得抛给监督层');
ok(brokenResult?.status === 'failing' && brokenResult?.findings?.[0]?.severity === 'error', '内部异常转成 severity:error 的 finding');
ok(brokenResult?.findings?.[0]?.code === 'memory.probe-error', '探针错误 code 稳定可去重');

console.log(`schema-contract: ${n} assertions PASS`);
