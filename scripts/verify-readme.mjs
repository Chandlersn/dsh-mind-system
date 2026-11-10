/**
 * README 数字校验 —— 文档里的每个数字都要对得上代码。
 *
 * ## 为什么需要这个
 *
 * README 里写了工具数、判据数、测试数、代码行数、门槛值 —— 这些**会过期**。
 * 一旦过期，README 就变成"看起来有据、实际已失效"的文档 ——
 * 而"写进文档的约束等于没有约束"这条自我约束，同样适用于文档里的数字。
 *
 * 所以数字不靠人记：**这个脚本从源码里数出来，与 README 里写的比对**，
 * 对不上就非零退出。改代码忘了改 README（或反之）会被它挡住。
 *
 * ## 它守什么
 *
 * 1. **工具清单**：每个注册的工具名都要出现在**它自己包**的 README 里
 *    （根 README 不重列工具总表 —— 同一张表两处维护，必然漂）
 * 2. **判据数**：memory_check 实际检查的判据数 = README 声称的
 * 3. **门槛值**：术块 900 / 概括 110 / 法 ≥2 / 道 ≥5 —— 从 constants 与
 *    layer-gate 里读，与 README 比对
 * 4. **内置信号数**：dispatch.js 里实际注册的信号数
 * 5. **测试规模**：从测试目录数；README 写了数字时比对，未写则仅展示
 * 6. **代码规模**：从源码数；README 写了数字时比对，未写则仅展示
 *
 * @module scripts/verify-readme.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
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
const read = (p) => {
	try {
		return readFileSync(p, 'utf8');
	} catch {
		return '';
	}
};

const readme = read(join(repoRoot, 'README.md'));
ok(readme.length > 0, 'README 存在');

// ---------------------------------------------------------------------------
console.log('\n--- 1. 工具清单：每个注册的工具都要在自己包的 README 里 ---');
// 清单只维护一处：各包 README。根 README 重列一张总表，就得两处同步 ——
// 而"写进文档的约束等于没有约束"，何况同一张表写两遍。
ok(!/^## 工具总表/m.test(readme), '根 README 不重列工具总表（清单归各包 README）');
const toolSpecs = [
	['dsh-agent-mind', 'index.js', /name:\s*'(mind_\w+)'/g],
	['dsh-clis', 'index.js', /name:\s*"(clis_\w+)"/g],
	['dsh-meta-framework', 'src/tools.js', /TOOL_NAME\s*=\s*'(\w+)'/g],
	['dsh-memory-manager', 'server.js', /name:\s*'(memory_\w+)'/g],
	['dsh-valves', 'index.js', /'(valve_\w+)'/g],
];
let toolTotal = 0;
for (const [pkg, file, re] of toolSpecs) {
	const src = read(join(pkgs, pkg, file));
	const names = [...new Set([...src.matchAll(re)].map((m) => m[1]))];
	toolTotal += names.length;
	const pkgReadme = read(join(pkgs, pkg, 'README.md'));
	for (const n of names) {
		ok(pkgReadme.includes(n), `${n} 在 ${pkg}/README.md 里`);
	}
}
console.log(`  · ${toolSpecs.length} 包共 ${toolTotal} 个工具，逐个出处见各包 README`);

// ---------------------------------------------------------------------------
console.log('\n--- 2. 判据数（memory_check 与联邦检查）---');
const mm = read(join(pkgs, 'dsh-memory-manager', 'server.js'));
const healthStart = mm.indexOf('async function checkLinks(');
const healthEnd = mm.indexOf('function panelizeHealth(', healthStart);
ok(healthStart >= 0 && healthEnd > healthStart, '体检与共享检查函数范围可定位');
const healthSource = healthStart >= 0 && healthEnd > healthStart ? mm.slice(healthStart, healthEnd) : '';
const federationStart = mm.indexOf('function memoryFederationTool(');
const federationEnd = mm.indexOf('function memoryCapabilityTool(', federationStart);
ok(federationStart >= 0 && federationEnd > federationStart, '联邦检查函数范围可定位');
const federationSource = federationStart >= 0 && federationEnd > federationStart ? mm.slice(federationStart, federationEnd) : '';
const codes = [...new Set([...(healthSource + federationSource).matchAll(/add\(\s*'(?:WARN|FAIL|INFO)'\s*,\s*'([^']+)'/g)].map((m) => m[1]))];
const claimedCriteria = Number(/### memory-manager · (\d+) 条/.exec(readme)?.[1] ?? -1);
ok(claimedCriteria === codes.length, `README 声称 ${claimedCriteria} 条判据 = 实际 ${codes.length}`);
// 每个代号都要在判据总表里出现
for (const c of codes) {
	ok(readme.includes(`\`${c}\``), `判据代号 ${c} 在 README 判据总表里`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 3. 门槛值（从代码读，与 README 比对）---');
const cst = read(join(pkgs, 'dsh-memory-manager', 'src', 'constants.js'));
const gate = read(join(pkgs, 'dsh-memory-manager', 'src', 'layer-gate.js'));
const blockMax = cst.match(/MAX_BLOCK_CHARS\s*=\s*(\d+)/)?.[1];
const rowMax = cst.match(/MAX_ROW_SUMMARY_CHARS\s*=\s*(\d+)/)?.[1];
const faMin = gate.match(/MIN_FA_SOURCES\s*=\s*(\d+)/)?.[1];
const daoMin = gate.match(/MIN_DAO_SOURCES\s*=\s*(\d+)/)?.[1];
ok(readme.includes(`≤ ${blockMax} 字`), `术块上限 ${blockMax} 字与 README 一致`);
ok(readme.includes(`≤ ${rowMax} 字`), `概括上限 ${rowMax} 字与 README 一致`);
ok(readme.includes(`≥ ${faMin} 个**无关**来源域`), `法来源下限 ${faMin} 与 README 一致`);
ok(readme.includes(`≥ ${daoMin} 条法萃取`), `道来源下限 ${daoMin} 与 README 一致`);

// ---------------------------------------------------------------------------
console.log('\n--- 4. 内置信号数 ---');
const dispatch = read(join(pkgs, 'dsh-agent-mind', 'src', 'dispatch.js'));
// 只数 BUILTIN_SIGNALS 数组里的条目（owner: 'mind' 紧跟 name: '...'）。
// 旧写法是硬编码名字白名单（no-effect|need-*|do-it|intent-*），于是新增一族
// 信号不会被计数——README 说要改数字，守卫却仍按旧数比对，两边一起错。
// 现在按结构数：BUILTIN_SIGNALS 内每个 `name: '<x>'` 都算一条内置信号。
const builtinBlock = dispatch.slice(
	dispatch.indexOf('const BUILTIN_SIGNALS'),
	dispatch.indexOf('const registry') === -1 ? undefined : dispatch.indexOf('const registry'),
);
const sigCount = (builtinBlock.match(/^\s{4}name:\s*'[\w-]+'/gm) ?? []).length;
const claimedSig = Number(/内置 (\d+) 条信号/.exec(readme)?.[1] ?? -1);
ok(claimedSig === sigCount, `README 声称 ${claimedSig} 条信号 = 实际 ${sigCount}`);

// ---------------------------------------------------------------------------
console.log('\n--- 5. 测试规模 ---');
function countTests(pkg, dir) {
	let files = 0;
	let cases = 0;
	try {
		for (const f of readdirSync(join(pkgs, pkg, dir))) {
			if (!/\.test\.(js|mjs)$/.test(f)) continue;
			files += 1;
			const c = read(join(pkgs, pkg, dir, f));
			cases += Math.max(
				(c.match(/^\s*ok\(/gm) ?? []).length,
				(c.match(/^\s*(test|it)\(/gm) ?? []).length,
			);
		}
	} catch {
		/* 没有该目录 */
	}
	return { files, cases };
}
const am = countTests('dsh-agent-mind', 'test');
const mmT = countTests('dsh-memory-manager', 'tests');
const amRow = /`dsh-agent-mind` \| (\d+) \| (\d+)/.exec(readme);
const mmRow = /`dsh-memory-manager` \| (\d+) \| (\d+)/.exec(readme);
if (amRow) ok(Number(amRow[1]) === am.files && Number(amRow[2]) === am.cases, `agent-mind 静态测试规模声明与源码一致`);
else console.log(`  · README 未声明 agent-mind 静态测试规模（源码扫描 ${am.files} 文件/${am.cases} 个显式用例，仅供参考）`);
if (mmRow) ok(Number(mmRow[1]) === mmT.files && Number(mmRow[2]) === mmT.cases, `memory 静态测试规模声明与源码一致`);
else console.log(`  · README 未声明 memory 静态测试规模（源码扫描 ${mmT.files} 文件/${mmT.cases} 个显式用例，仅供参考）`);

// ---------------------------------------------------------------------------
console.log('\n--- 6. 代码规模 ---');
function countLines(pkg, files) {
	let n = 0;
	let okCount = 0;
	for (const f of files) {
		const c = read(join(pkgs, pkg, f));
		if (c.length === 0) continue;
		n += c.split('\n').length;
		okCount += 1;
	}
	return { okCount, n };
}
const LINES = {
	'dsh-agent-mind': [
		'src/dispatch.js', 'src/hitrate.js', 'src/sampling.js', 'src/orchestrate.js',
		'src/mind.js', 'src/host.js', 'src/situation.js', 'index.js',
		'test/dispatch.test.js', 'test/hitrate.test.js', 'test/sampling.test.js',
		'test/interfaces.test.js', 'test/mind.test.js', 'test/orchestrate.test.js',
		'test/integration.test.js', 'test/regressions.test.js', 'test/review-fixes.test.js',
		// 2026-11-03 补：这几个文件此前漏在清单外，导致"代码规模"只数了 17 个文件、
		// 少报几百行。**清单漏项本身就是数字失真的来源** —— 校验通过也说明不了
		// README 是对的，只能说"清单里那些文件数对了"。
		'test/policy.test.js', 'test/diagnostics.test.js', 'scripts/verify-assembly.mjs',
	],
	'dsh-meta-framework': [
		'index.js', 'src/tools.js', 'src/health.js', 'src/host.js', 'src/clis.js',
		'test/entry.test.js', 'test/health.test.js', 'test/tools.test.js',
		'test/host.test.js', 'test/clis-rule.test.js',
	],
	'dsh-memory-manager': ['server.js', 'src/layer-gate.js', 'src/layer-selfcheck.js', 'src/dao-shape.js'],
};
for (const [pkg, files] of Object.entries(LINES)) {
	const r = countLines(pkg, files);
	const row = new RegExp(`\`${pkg}\` \\| \\d+ 文件? / (\\d+) 行`).exec(readme);
	if (row) ok(Number(row[1]) === r.n, `${pkg} 静态行数声明与源码一致`);
	else console.log(`  · README 未声明 ${pkg} 静态行数（指定文件扫描 ${r.okCount} 文件/${r.n} 行，仅供参考）`);
}

console.log(failures === 0 ? '\nverify-readme: ALL PASS' : `\nverify-readme: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
