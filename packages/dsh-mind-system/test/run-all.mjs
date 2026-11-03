/**
 * 合成包的统一测试入口：跑四家成员 + 合成自身的全部测试。
 *
 * ## 为什么不用一个 glob
 *
 * 四家的测试原来长在四个仓库里，约定不同：
 * mind / meta 用 `test/*.test.js`（node:test），
 * memory 用 `tests/*.test.js` + 三个手写断言脚本（harness/api/ui-test.mjs）。
 * 合成后保持各自目录不动（mind/ meta/ memory/），由这里逐套调度，
 * 一套失败立即非零退出——CI 与本地同一条命令。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const suites = [
  // 合成自身：清单/patch/探针契约
  { name: 'mind-system', files: readdirSync(join(pkgRoot, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => `test/${f}`) },
  // clis：无独立测试目录（其契约由 mind-system 清单测试 + mind 的接口测试覆盖）
  { name: 'agent-mind', files: readdirSync(join(pkgRoot, 'mind', 'test')).filter((f) => f.endsWith('.test.js')).map((f) => `mind/test/${f}`) },
  { name: 'meta-framework', files: readdirSync(join(pkgRoot, 'meta', 'test')).filter((f) => f.endsWith('.test.js')).map((f) => `meta/test/${f}`) },
  { name: 'memory-manager tests/', files: readdirSync(join(pkgRoot, 'memory', 'tests')).filter((f) => f.endsWith('.test.js')).map((f) => `memory/tests/${f}`) },
];

let failed = 0;
for (const { name, files } of suites) {
  if (files.length === 0) {
    console.log(`[${name}] no test files — SKIP`);
    continue;
  }
  console.log(`[${name}] node --test ${files.length} files`);
  const r = spawnSync(process.execPath, ['--test', ...files], {
    cwd: pkgRoot,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error(`[${name}] FAILED (exit ${r.status})`);
    failed++;
  }
}

// memory 的三个手写断言脚本（相对自身目录可移植）
for (const script of ['memory/harness-test.mjs', 'memory/api-test.mjs', 'memory/ui-test.mjs']) {
  console.log(`[${script}]`);
  const r = spawnSync(process.execPath, [script], { cwd: pkgRoot, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[${script}] FAILED (exit ${r.status})`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\nrun-all: ${failed} suite(s) FAILED`);
  process.exit(1);
}
console.log('\nrun-all: ALL PASS');
