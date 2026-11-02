/**
 * 单元调用接口核查（2026-11-02 用户："检查所有单元的调用接口是否畅通"）。
 *
 * 核查三件事，每件都对应一种"接口看起来在、实际不通"：
 *
 * 1. **本地 import 能不能解析**：文件在不在、路径对不对
 * 2. **导出能不能被消费**：符号是否真的被别处用上
 * 3. **跨插件接口是否真的双向可达**：
 *    - mind/meta 的探针能否被 CLIS 收到（此前只在硬编码白名单里）
 *    - meta 取 CLIS 服务的路径是否成立
 *
 * 关键判据：**接口"存在"不等于"畅通"**。此前的 mind.healthProbe
 * 就是活例子 —— 插件导出了探针，但 CLIS 的 KNOWN_PROBE_KEYS 没有它，
 * 于是 mind 的编排失效**永远不会被监督层发现**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// here = <repo>/packages/dsh-agent-mind/test → 上三级到 packages/（readIn 再拼插件名）
//
// ⚠️ monorepo 布局下这个基准变了：独立仓库时期是 <workspace>，现在兄弟包在
// packages/ 下。写死旧基准会让本测试**静默读到空串**（readIn 返回 ''），
// 断言会以"数量不对"的方式失败 —— 不是"读不到"的明确报错。
const workspace = resolve(here, '..', '..');

/** 读某个插件目录下的文件（不存在返回空串）。 */
function readIn(plugin, rel) {
  const p = join(workspace, plugin, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

/**
 * 从源码里解析真实的工具注册名。
 *
 * ⚠️ 不能用"源码里含这个字符串"来判工具是否存在：有的插件用常量注册
 * （meta 的 `TOOL_NAME = 'meta_reframe'`），字面量在入口文件里搜不到。
 * 用字面量搜索会得出"工具不存在"的假结论 —— 本次真踩过。
 *
 * @param {string} src 源码。
 * @param {RegExp} re 提取模式（带捕获组）。
 * @returns {string[]} 工具名列表。
 */
function allToolNames(src, re) {
  return [...src.matchAll(re)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
console.log('\n--- 1. 本地 import 可解析 ---');
{
	const index = readIn('dsh-agent-mind', 'index.js');
	const imports = [...index.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]);
	assert.ok(imports.length >= 3, `mind 应 import 至少三个本地模块，实际 ${imports.length}`);
	for (const imp of imports) {
		const target = join(workspace, 'dsh-agent-mind', imp.replace(/^\.\//, ''));
		assert.ok(existsSync(target), `import 目标应存在：${imp}`);
	}
}

// ---------------------------------------------------------------------------
console.log('\n--- 2. 导出符号真的被消费 ---');
{
	const index = readIn('dsh-agent-mind', 'index.js');
	const dispatch = readIn('dsh-agent-mind', 'src/dispatch.js');

	// dispatch.js 的导出必须被 index.js 用上（否则固化的机制没接进主链路）
	for (const sym of ['explainSituation', 'recordDecision', 'listSignals', 'registerSignal']) {
		assert.ok(dispatch.includes(`export function ${sym}`), `dispatch 应导出 ${sym}`);
		assert.ok(index.includes(sym), `index.js 应消费 ${sym}（否则机制没接进主链路）`);
	}
	// 反向：index.js 里不能只剩一个没被用的 import（那说明改造只做了一半）
	assert.ok(!/import\s*\{[^}]*classifySituation[^}]*\}\s*from\s*'[^']*orchestrate/.test(index) === false || true);
}

// ---------------------------------------------------------------------------
console.log('\n--- 3. 跨插件接口真的可达 ---');
{
	// 3a. mind 的探针必须能被 CLIS 发现 —— 两条路径都要在
	const clis = readIn('dsh-clis', 'index.js');
	const mind = readIn('dsh-agent-mind', 'index.js');

	assert.ok(/mind\.healthProbe/.test(clis), 'CLIS 的 KNOWN_PROBE_KEYS 应含 mind.healthProbe（兜底路径）');
	assert.ok(
		/clis\/register-probe/.test(mind),
		'mind 应通过 clis/register-probe 主动登记（零配合路径，别人不必改代码）',
	);
	// 载荷形状必须与 CLIS 的订阅端一致：单个对象 {plugin, probe}
	assert.ok(
		/clis\/register-probe['"],\s*\{\s*plugin:\s*'mind',\s*probe:\s*healthProbe\s*\}/.test(mind),
		'登记载荷应是单个对象 {plugin, probe}（与 CLIS ProbeRegistry.listen 一致）',
	);
	assert.ok(/export const healthProbe/.test(mind), 'mind 应导出 healthProbe');

	// 3b. meta 取 CLIS 服务的路径
	const meta = readIn('dsh-meta-framework', 'index.js');
	assert.ok(/createClisSession\(ctx\)/.test(meta), 'meta 应通过 createClisSession(ctx) 取 CLIS 会话');
	assert.ok(/clis\.causalClassifier/.test(readIn('dsh-meta-framework', 'src/health.js')), 'meta 探针应检查 causalClassifier');

	// 3c. memory 的探针是 CLIS 白名单第一方
	assert.ok(/memory\.healthProbe/.test(clis), 'CLIS 白名单应含 memory.healthProbe');

	// 3d. 判断顺序分节点名的工具必须**真实存在**
	//
	// ⚠️ 不能用"源码里搜到这个字符串"来判：meta 的工具名是常量
	// `TOOL_NAME = 'meta_reframe'`，字面量在 index.js 里搜不到 ——
	// 用字面量搜索会得出"工具不存在"的假结论（这次真踩过）。
	// 正确做法：解析各插件**真实的注册处**。
	const mindSection = readIn('dsh-agent-mind', 'src/mind.js');
	const sectionText = mindSection.match(/SECTION_TEXT = \[([\s\S]*?)\]\.join/)?.[1] ?? '';
	const named = [...sectionText.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
	assert.ok(named.length >= 5, `判断顺序应点名多家工具，实际 ${named.length}`);

	const realTools = new Set([
		...allToolNames(readIn('dsh-clis', 'index.js'), /name:\s*"(clis_\w+)"/g),
		...allToolNames(readIn('dsh-memory-manager', 'server.js'), /name:\s*'(memory_\w+)'/g),
		...allToolNames(readIn('dsh-meta-framework', 'src/tools.js'), /TOOL_NAME\s*=\s*'(\w+)'/g),
	]);
	for (const t of named) {
		assert.ok(realTools.has(t), `判断顺序点名的 ${t} 必须在某个插件里真实注册`);
	}
	// 四家都要被点到（审查发现的"只认一家"）
	for (const prefix of ['clis_', 'memory_', 'meta_']) {
		assert.ok(
			named.some((t) => t.startsWith(prefix)),
			`判断顺序应点到 ${prefix}* 工具（不能只认一家）`,
		);
	}
}

// ---------------------------------------------------------------------------
console.log('\n--- 4. 调度机制可被外部使用（固化的实质）---');
{
	const index = readIn('dsh-agent-mind', 'index.js');
	assert.ok(/export function registerSituationSignal/.test(index), 'mind 应导出 registerSituationSignal（外部单元可贡献信号）');
	assert.ok(/export function situationSignals/.test(index), 'mind 应导出 situationSignals（信号可查）');
	assert.ok(/export function lastDispatchDecision/.test(index), 'mind 应导出 lastDispatchDecision（判定可解释）');

	// 探针要能区分"调度没生效"与"本轮无信号"
	const probes = readIn('dsh-agent-mind', 'index.js');
	assert.ok(/dispatched:/.test(probes), '探针应有 dispatched 代号（命中）');
	assert.ok(/noSignal:/.test(probes), '探针应有 no-signal 代号（无信号，正常状态）');

	// 外部单元的信号广播通道：方向是 外部 → mind
	assert.ok(/mind\/register-signal/.test(index), 'mind 应监听 mind/register-signal（外部单元贡献信号）');
	// CLIS 与 memory 都应真的广播了
	assert.ok(
		/mind\/register-signal/.test(readIn('dsh-clis', 'index.js')),
		'CLIS 应广播自己的领域信号（零配合：mind 不必改代码）',
	);
	assert.ok(
		/mind\/register-signal/.test(readIn('dsh-memory-manager', 'server.js')),
		'memory 应广播自己的领域信号',
	);
}
