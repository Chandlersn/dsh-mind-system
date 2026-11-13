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
	'tests/inbox-concurrency.test.js',
	'tests/inbox-multi-instance.test.js',
	'tests/inbox-identity.test.js',
	'tests/inbox-producer.test.js',
	'tests/inbox-tracking-failure.test.js',
	'tests/root-transaction.test.js',
	'tests/memory-concurrency.test.js',
	'tests/panel-concurrency.test.js',
	'tests/dao-archive-safety.test.js',
	'tests/supersede-safety.test.js',
	'tests/rename-reference-safety.test.js',
	'tests/resolve-safety.test.js',
	'tests/recall-candidate.test.js',
	'tests/recall-eligibility.test.js',
	'tests/recall-admission.test.js',
	'tests/recall-deadline.test.js',
	'tests/rename-safety.test.js',
	'tests/write-rename-uncertain.test.js',
	'tests/write-staging-exclusive.test.js',
	'tests/rename-target-uncertain.test.js',
	'tests/rename-staging-uncertain.test.js',
	'tests/delete-uncertain.test.js',
	'tests/rename-delete-uncertain.test.js',
	'tests/panel-write-partial.test.js',
	'tests/panel-stage-cleanup.test.js',
	'tests/panel-staging-collision.test.js',
	'tests/panel-cleanup-ack-lost.test.js',
	'tests/client-action-reconcile.test.js',
	// 写入溯源（R26）+ 写入口守卫：不接进来的测试等于没跑（2026-11-10）。
	'tests/write-ledger.test.js',
	'tests/ledger-delete-pairing.test.js',
	'tests/daily-ledger-key.test.js',
	'tests/daily-capture-audit.test.js',
	'tests/daily-capture-alias.test.js',
	'tests/daily-capture-concurrency.test.js',
	'tests/daily-raw-protection.test.js',
	'tests/daily-editor-ledger-boundary.test.js',
	'tests/daily-archive.test.js',
	'tests/r10-daily-unknown.test.js',
	'tests/r10-link-stat-unknown.test.js',
	'tests/stat-exists-safety.test.js',
	'tests/skill-history-exclusive.test.js',
	'tests/r16-path-unknown.test.js',
	'tests/health-existence-unknown.test.js',
	'tests/health-check-read-unknown.test.js',
	'tests/health-orphan-read-unknown.test.js',
	'tests/health-zone-read-unknown.test.js',
	'tests/health-other-unknown.test.js',
	'tests/health-skill-read-unknown.test.js',
	'tests/health-dao-partial-unknown.test.js',
	'tests/read-if-exists-safety.test.js',
	'tests/read-failure-write-protection.test.js',
	'tests/federation-check-readonly.test.js',
	'tests/capture-baseline.test.js',
	'tests/capture-intent.test.js',
	'tests/capture-intent-replacement.test.js',
	'tests/capture-journal.test.js',
	'tests/capture-mutex.test.js',
	'tests/capture-events.test.js',
	'tests/capture-status.test.js',
	'tests/capture-service.test.js',
	'tests/capture-hook-status.test.js',
	'tests/capture-crash.test.js',
	'tests/capture-metadata-guard.test.js',
	'tests/client-capture-status.test.js',
	'tests/staging-ownership-after-commit.test.js',
	'tests/write-failure.test.js',
	'tests/write-intent.test.js',
	'tests/write-guard.test.js',
	'tests/recall-combined.test.js',
	'tests/recall-optional-budget.test.js',
	'tests/recall-budget-failure.test.js',
	'tests/recall-budget-metrics.test.js',
	'tests/recall-relevance.test.js',
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
