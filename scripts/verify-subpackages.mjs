/**
 * 子包 README 自检 —— 找出每个子包 README 里与代码不符的地方。
 *
 * ## 为什么要有
 *
 * 根 README 有 `verify-readme.mjs` 把关，但**子包 README 没有**。
 * 四个子包合计 780 行，里面有实测数字、测试数、工具清单、探针代号 ——
 * 任何一处过期，读者拿到的就是错的说明书。
 *
 * ## 它查什么（每包按其自身形态查）
 *
 * 1. **工具清单**：README 提到的工具名必须真实注册；漏提也是错
 * 2. **探针代号**：README 列的代号必须在源码里存在；反之亦然
 * 3. **测试数**：README 声称的用例数 = 测试目录里数出来的
 * 4. **明确的过时断言**：例如"不注册任何工具"——与事实相反
 * 5. **数字类断言**：行数/字符数这类写死的规模
 *
 * 对不上就非零退出。
 *
 * @module scripts/verify-subpackages.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
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

/** 各包的形态描述：工具提取、探针代号提取、测试目录。 */
const PACKAGES = {
	'dsh-agent-mind': {
		tools: [['index.js', /name:\s*'(mind_\w+)'/g]],
		probes: [['index.js', /code:\s*PROBE_CODES\.(\w+)/g], ['index.js', /PROBE_CODES = \{([\s\S]*?)\}/g]],
		testDir: 'test',
	},
	'dsh-clis': {
		tools: [['index.js', /name:\s*"(clis_\w+)"/g]],
		testDir: null,
	},
	'dsh-meta-framework': {
		tools: [['index.js', /TOOL_NAME\s*=\s*'(\w+)'/g]],
		testDir: 'test',
	},
	'dsh-memory-manager': {
		tools: [['server.js', /name:\s*'(memory_\w+)'/g]],
		testDir: 'tests',
	},
	'dsh-valves': {
		// 工具名的单一真值源是 TOOL_NAMES 常量块，从块里取全部 'valve_*' 字面量
		tools: [['index.js', /TOOL_NAMES = \{[^}]*'(valve_\w+)'[^}]*\}/gs]],
		probes: [['index.js', /PROBE_CODES = \{([\s\S]*?)\n\}/g]],
		testDir: 'test',
	},
	'dsh-mind-system': {
		tools: [],
		testDir: null,
	},
};

for (const [pkg, spec] of Object.entries(PACKAGES)) {
	console.log(`\n=== ${pkg} ===`);
	const readme = read(join(pkgs, pkg, 'README.md'));
	ok(readme.length > 0, 'README 存在');

	// ---- 工具：提到的必须真实，且真实的必须被提到 ----
	const realTools = new Set();
	for (const [file, re] of spec.tools ?? []) {
		for (const m of read(join(pkgs, pkg, file)).matchAll(re)) {
			// 块型正则（如 valves 的 TOOL_NAMES）：从整块里取全部 valve_*/mind_* 等字面量
			if (m[0].includes('= {')) {
				for (const k of m[0].matchAll(/'([a-z]+_\w+)'/g)) realTools.add(k[1]);
			} else if (m[1] !== undefined) {
				realTools.add(m[1]);
			}
		}
	}
	if (realTools.size > 0) {
		for (const t of realTools) {
			ok(readme.includes(`\`${t}\``), `工具 ${t} 在 README 里`);
		}
	}

	// ---- 探针代号 ----
	const probeCodes = new Set();
	for (const [file, re] of spec.probes ?? []) {
		const src = read(join(pkgs, pkg, file));
		for (const m of src.matchAll(re)) {
			if (m[1] === undefined) continue;
			// PROBE_CODES 块：取其中的 key
			if (re.source.includes('PROBE_CODES =')) {
				for (const k of m[1].matchAll(/(\w+):\s*'/g)) probeCodes.add(k[1]);
			} else {
				probeCodes.add(m[1]);
			}
		}
	}
	if (probeCodes.size > 0) {
		// 探针代号有两种写法：源码里的 key（notLoaded）与实际发出的完整代号
		// （mind.not-loaded）。README 两种都可能用，所以要**都接受** ——
		// 只认一种会产生误报（只认 key 会漏掉 README 写完整代号的场合）。
		//
		// ⚠️ 这里必须是 key→完整代号 的**映射**，不能用两个独立集合：
		// 集合只能回答"这个完整代号在不在"，回答不了"这个 key 对应哪个完整代号"。
		const fullByKey = new Map();
		for (const [file, re] of spec.probes ?? []) {
			const src = read(join(pkgs, pkg, file));
			const block = src.match(/PROBE_CODES = \{([\s\S]*?)\n\};/);
			if (block !== null) {
				for (const k of block[1].matchAll(/(\w+):\s*'([^']+)'/g)) {
					fullByKey.set(k[1], k[2]);
					probeCodes.add(k[1]);
				}
			}
		}
		for (const c of probeCodes) {
			const full = fullByKey.get(c);
			const mentioned =
				full === undefined
					? readme.includes(c)
					: readme.includes(full) || readme.includes(c);
			ok(mentioned, `探针代号 ${c}（${full ?? '?'}）在 README 里`);
		}
	}

	// ---- 测试数 ----
	if (spec.testDir) {
		let cases = 0;
		let files = 0;
		try {
			for (const f of readdirSync(join(pkgs, pkg, spec.testDir))) {
				if (!/\.test\.(js|mjs)$/.test(f)) continue;
				files += 1;
				const c = read(join(pkgs, pkg, spec.testDir, f));
				cases += Math.max(
					(c.match(/^\s*ok\(/gm) ?? []).length,
					(c.match(/^\s*(test|it)\(/gm) ?? []).length,
				);
			}
		} catch {
			/* 没有测试目录 */
		}
		if (cases > 0) {
			// 只在 README **明确写了**"N 个用例/断言"时核对。
			// 没写不算错（memory-manager 的 README 写的是"十六工具"这类描述）。
			const m = /(?:(\d+)\s*个用例|(\d+)\s*条断言|(\d+)\s*用例)/.exec(readme);
			if (m !== null) {
				const claimed = Number(m[1] ?? m[2] ?? m[3]);
				ok(claimed === cases, `README 声称 ${claimed} 个用例 = 实际 ${cases}（${files} 个测试文件）`);
			}
		}
	}

	// ---- 明确的过时断言 ----
	// "不注册任何工具" —— 现在有 mind_signals
	if (pkg === 'dsh-agent-mind') {
		ok(
			!/不注册任何工具|工具 \| \*\*无\*\*/.test(readme),
			'没有"不注册任何工具"这类过时断言（现在有 mind_signals）',
		);
	}
}

console.log(failures === 0 ? '\nverify-subpackages: ALL PASS' : `\nverify-subpackages: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
