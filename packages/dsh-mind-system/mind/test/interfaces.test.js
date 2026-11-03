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
 *
 * ## ⚠️ 2026-11-02 对抗式审查后重写
 *
 * 旧版这个文件用**源码文本匹配**判断接口是否被消费，例如：
 *
 * ```js
 * assert.ok(index.includes(sym), `index.js 应消费 ${sym}`);
 * ```
 *
 * 那只证明"文件里出现过这个词"，不证明"它被调用了"。更糟的是第 75 行：
 *
 * ```js
 * assert.ok(!/…/.test(index) === false || true);   // ← X || true 恒真
 * ```
 *
 * `X || true` 永远为真 —— 这条断言**什么都没检查**。而它本意是抓未使用的
 * import，而 `index.js:24` 确实 import 了从不使用的 `classifySituation`。
 *
 * 现在改为**真正 import 并调用**导出的 API：导出被删或变成空操作，
 * 测试必须变红。恒真断言已删除，替换为真实的"没有未使用的 import"检查。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  explainSituation,
  registerSignal,
  listSignals,
  recordDecision,
  lastDecisionOf,
} from '../src/dispatch.js';
import {
  judge,
  currentSituationOf,
  lastDecisionOf as situationLastDecisionOf,
  __resetSituationForTest,
} from '../src/situation.js';

const here = dirname(fileURLToPath(import.meta.url));
// here = <repo>/packages/dsh-agent-mind/test → 上两级到 packages/（readIn 再拼插件名）
//
// ⚠️ monorepo 布局下这个基准变了：独立仓库时期是 <workspace>，现在兄弟包在
// packages/ 下。写死旧基准会让本测试**静默读到空串**（readIn 返回 ''），
// 断言会以"数量不对"的方式失败 —— 不是"读不到"的明确报错。
const workspace = resolve(here, '..', '..');

/** 读某个插件目录下的文件（不存在返回空串）。 */
const MEMBER_DIR = { 'dsh-agent-mind': 'mind', 'dsh-clis': 'clis', 'dsh-meta-framework': 'meta', 'dsh-memory-manager': 'memory' };
function readIn(plugin, rel) {
  const dir = MEMBER_DIR[plugin] ?? plugin;
  const p = join(workspace, dir, rel);
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
test('1. 本地 import 可解析', () => {
	const index = readIn('dsh-agent-mind', 'index.js');
	const imports = [...index.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]);
	assert.ok(imports.length >= 3, `mind 应 import 至少三个本地模块，实际 ${imports.length}`);
	for (const imp of imports) {
		const target = join(workspace, MEMBER_DIR['dsh-agent-mind'], imp.replace(/^\.\//, ''));
		assert.ok(existsSync(target), `import 目标应存在：${imp}`);
	}
});

test('2. dispatch 的导出真的被消费（调用得出结果，不只是文件里出现过这个词）', () => {
	// 真正调用，而不是 grep 源码文本 —— 导出被改成空操作时这里必须变红。
	const dispose = registerSignal({
		name: 'iface-probe',
		situation: 'diagnose',
		owner: 'test',
		weight: 9,
		words: ['接口探测词'],
	});
	try {
		assert.ok(listSignals().some((s) => s.name === 'iface-probe'), 'registerSignal 必须让信号出现在 listSignals 里');
		const d = explainSituation('这里有接口探测词');
		assert.equal(d.situation, 'diagnose', 'explainSituation 必须真的用上注册信号');
		assert.ok(d.hits.includes('iface-probe'), '命中的信号名必须可查');
	} finally {
		dispose();
	}
	assert.ok(!listSignals().some((s) => s.name === 'iface-probe'), '注销后信号必须消失');

	// recordDecision / lastDecisionOf 是一对，必须真的能往返。
	const decision = explainSituation('接口往返测试');
	recordDecision(decision);
	const back = lastDecisionOf();
	assert.equal(back.situation, decision.situation, 'lastDecisionOf 必须读回刚写的判定');
	assert.deepEqual(back.hits, decision.hits);
});

test('3. situation 模块：导出可被消费，空输入不覆盖已有处境', () => {
	__resetSituationForTest();
	assert.equal(currentSituationOf(), 'unknown', '初始处境必须是 unknown');

	judge('帮我改一下这个文件');
	assert.equal(currentSituationOf(), 'execute', '有输入时处境必须更新');

	// 空输入不覆盖：宿主第 2 步起 inbox 为空，那是"这一轮没新输入"，
	// 不是"用户没表达任何处境"。若让它重置，工具面会在 turn 中途抖回去。
	judge('');
	assert.equal(currentSituationOf(), 'execute', '空输入不得把已有处境重置掉');

	const d = situationLastDecisionOf();
	assert.ok(d !== null, '判定必须被记账');
	assert.equal(d.unknown, true, '空输入的判定本身是 unknown');
});

test('4. 没有未使用的 import（旧版的恒真断言替换成真检查）', () => {
	const index = readIn('dsh-agent-mind', 'index.js');
	const importRe = /import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g;
	for (const m of index.matchAll(importRe)) {
		const names = m[1]
			.split(',')
			.map((s) => s.trim().split(/\s+as\s+/)[0].trim())
			.filter((s) => s.length > 0);
		const body = index.slice(0, m.index) + index.slice(m.index + m[0].length);
		for (const name of names) {
			const used = new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`).test(body);
			assert.ok(used, `index.js import 了 ${name} 但从未使用（未使用的 import 会掩盖改造只做了一半）`);
		}
	}
});

test('5. 跨插件接口真的可达', () => {
	// 5a. mind 的探针必须能被 CLIS 发现 —— 两条路径都要在
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

	// 5b. meta 取 CLIS 服务的路径
	const meta = readIn('dsh-meta-framework', 'index.js');
	assert.ok(/createClisSession\(ctx\)/.test(meta), 'meta 应通过 createClisSession(ctx) 取 CLIS 会话');
	assert.ok(/clis\.causalClassifier/.test(readIn('dsh-meta-framework', 'src/health.js')), 'meta 探针应检查 causalClassifier');

	// 5c. memory 的探针是 CLIS 白名单第一方
	assert.ok(/memory\.healthProbe/.test(clis), 'CLIS 白名单应含 memory.healthProbe');

	// 5d. 判断顺序分节点名的工具必须**真实存在**
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
});

test('6. 调度机制可被外部使用（固化的实质）', () => {
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
});
