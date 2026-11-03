/**
 * 子包 README 要素覆盖检查 —— 每个子包该有的章节，逐项确认。
 *
 * ## 为什么与 verify-subpackages 分开
 *
 * 两个脚本守不同的东西：
 *
 * - `verify-subpackages.mjs` 守**事实**（工具名、探针代号、用例数）——
 *   数字与代码对不上就是错
 * - 本脚本守**结构**（有没有"为什么做"、有没有排错表、有没有借鉴出处）——
 *   缺了章节就是缺了内容
 *
 * 事实错可以自动发现，结构缺只能靠一份明确的清单 —— 所以清单要落成代码，
 * 而不是"下次记得写"。
 *
 * ## 清单的来源
 *
 * 对标本仓成熟 README（dsh-memory-manager 353 行、Print-Workshop 483 行）的
 * 共同要素。每包的清单按它自身的形态定制 —— 聚合包要"为什么做/适合不适合"，
 * 记忆插件要"布局树/数据流图/升降级图"，编排插件要"为什么做/适合不适合"。
 *
 * @module scripts/verify-subpackage-structure.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const pkgs = join(repoRoot, 'packages');

let failures = 0;
const ok = (cond, label) => {
	console.log(`${cond ? '  PASS ' : '  FAIL '}${label}`);
	if (!cond) failures++;
};

/**
 * 每个包必须有的章节。
 *
 * 每项是 [标签, 正则] —— 正则匹配 README 全文即可（不要求精确标题，
 * 因为同义标题也算数；但必须有对应的**内容**）。
 */
const REQUIRED = {
	'dsh-agent-mind': [
		['为什么做（痛点或边界说明）', /先读这一段|为什么做/],
		['适合 / 不适合', /不适合/],
		['工具（mind_signals）', /mind_signals/],
		['探针表', /mind\.ok/],
		['信号覆盖与准确率边界', /信号覆盖与分类准确率/],
		['外部信号贡献', /mind\/register-signal/],
		['旧宿主兜底时序', /老宿主[^\n]*滞后一拍/],
		['开发命令', /npm test/],
		['已知限制', /已知限制/],
	],
	'dsh-clis': [
		['为什么做', /为什么做这个/],
		['五个工具', /clis_run/],
		['漏判分母', /miss_rate/],
		['信号广播', /mind\/register-signal/],
		['两层监督', /自动层/],
		['配置', /config:|allow_writes/],
		['排错表', /排错/],
		['借鉴出处', /借鉴出处/],
		['已知限制', /已知限制/],
	],
	'dsh-meta-framework': [
		['定位声明（诊断非决策）', /诊断工具，不是决策工具/],
		['实测数据', /3\/3 判对/],
		['相对上游的取舍', /相对上游/],
		['真缺口标注', /真缺口/],
		['上游服务的缺口', /META_FRAMEWORK_SERVICE/],
		['重新评估的触发条件', /什么时候该重新评估/],
		['排错表', /排错/],
		['已知限制', /已知限制/],
	],
	'dsh-memory-manager': [
		['记忆布局树', /memory\//],
		['数据流图', /第 0 层/],
		['层级定义表', /\| \*\*器\*\*/],
		['反例表', /反例/],
		['升降级图', /▼/],
		['工具表', /memory_read/],
		['判据说明', /R\d+/],
		['配置项', /memoryRoot/],
		['借鉴出处', /借鉴/],
	],
	'dsh-mind-system': [
		['为什么做', /为什么做这个/],
		['适合 / 不适合', /不适合/],
		['依赖方向图', /依赖方向|ctx\.get/],
		['三种安装形态对比', /三种安装形态/],
		['四家职责', /dsh-agent-mind —— 调度层/],
		['配置', /config:/],
		['排错表', /排错/],
		['已知限制', /已知限制/],
		['借鉴出处', /借鉴出处/],
	],
};

for (const [pkg, checks] of Object.entries(REQUIRED)) {
	console.log(`\n=== ${pkg} ===`);
	let readme = '';
	try {
		readme = readFileSync(join(pkgs, pkg, 'README.md'), 'utf8');
	} catch {
		readme = '';
	}
	ok(readme.length > 0, 'README 存在');
	if (readme.length === 0) continue;
	for (const [label, re] of checks) {
		ok(re.test(readme), label);
	}
	const lines = readme.split('\n').length;
	console.log(`  （${lines} 行 / ${readme.length} 字符）`);
}

console.log(failures === 0 ? '\nverify-subpackage-structure: ALL PASS' : `\nverify-subpackage-structure: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
