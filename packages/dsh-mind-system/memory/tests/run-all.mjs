/**
 * 统一测试入口：先定位 DSH 宿主安装，再以真实环境串行跑全部套件。
 *
 * 为什么需要它：harness-test.mjs / api-test.mjs 在找不到宿主时默认 SKIP，
 * 于是 `npm test` 会在 400+ 条集成断言一条没跑的情况下报"全绿"（2026-11-05
 * 审查实测）。SKIP 本身有可移植价值（没装宿主的机器不该硬崩），但交付信号
 * 必须诚实：这里显式探测宿主并注入 DSH_INSTALL_DIR，找不到时明确失败，
 * 而不是让两套大测试静默跳过。
 *
 * 探测顺序（不硬编码任何机器路径）：
 *   1. DSH_INSTALL_DIR / DSH_ROOT 环境变量
 *   2. DSH_PROFILE_DIR 的上溯（profile 的 node_modules 里通常没有 @deepseek-ai/*）
 *   3. 从本进程 argv[1] / cwd 上溯
 *   4. 与 profile 同级的常见安装目录（<home>/.dsh, <home>/dsh, …）
 * 判据统一用 src/host.js 的 resolveDshRoot —— 与生产代码同一套发现逻辑。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');
const { resolveDshRoot, looksLikeDshRoot } = await import(pathToFileURL(path.join(pkgDir, 'src/host.js')).href);

function findHost() {
	const candidates = [
		process.env.DSH_INSTALL_DIR,
		process.env.DSH_ROOT,
		process.env.DSH_PROFILE_DIR,
		process.cwd(),
		path.join(homedir(), '.dsh'),
		path.join(homedir(), 'dsh'),
	];
	// 宿主常装在某个盘根下的 dsh/ 或 deepseek-harness/，与 profile 不同盘。
	// 扫描所有存在的盘符根目录（不硬编码具体盘符），用生产同一套 marker 判定。
	for (let letter = 65; letter <= 90; letter++) {
		const drive = `${String.fromCharCode(letter)}:\\`;
		if (!existsSync(drive)) continue;
		for (const dir of ['dsh', 'deepseek-harness']) candidates.push(path.join(drive, dir));
	}
	for (const candidate of candidates) {
		if (!candidate) continue;
		if (looksLikeDshRoot(candidate)) return path.resolve(candidate);
		try {
			const found = resolveDshRoot(candidate);
			if (looksLikeDshRoot(found)) return found;
		} catch { /* 继续下一个候选 */ }
	}
	return undefined;
}

const host = findHost();
if (!host) {
	console.error('FAIL run-all: 找不到 DSH 宿主安装，集成测试无法真实运行。');
	console.error('     设置 DSH_INSTALL_DIR=<宿主目录> 后重试；不要用 SKIP 伪装成全绿。');
	process.exit(1);
}

console.log(`run-all: 宿主 = ${host}`);
const env = { ...process.env, DSH_INSTALL_DIR: host, DSH_REQUIRE_HOST: '1' };

const suites = [
	'tests/layer-gate.test.js',
	'tests/layer-selfcheck.test.js',
	'tests/dao-shape.test.js',
	'tests/coverage.test.js',
	'tests/schema-contract.test.js',
	'tests/check-inbox-loop.test.js',
	'tests/recall-combined.test.js',
	'harness-test.mjs',
	'api-test.mjs',
	'ui-test.mjs',
];

let failed = 0;
for (const suite of suites) {
	console.log(`\n>>> ${suite}`);
	const r = spawnSync(process.execPath, [suite], { cwd: pkgDir, env, stdio: 'inherit' });
	if (r.status !== 0) {
		console.error(`<<< ${suite} FAILED (exit ${r.status ?? 'signal'})`);
		failed++;
	}
}
console.log(failed === 0 ? '\nrun-all: ALL SUITES PASS' : `\nrun-all: ${failed} SUITE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
