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
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 测试要 `createRequire` 到宿主自己的 node_modules，靠 `DSH_INSTALL_DIR`。
 *
 * 2026-11-04：原先各测试文件各写一份 `?? 'D:/dsh'` 兜底 —— 那是 Windows
 * 专用路径，非 Windows 且未设环境变量时 `createRequire` 会在任何断言之前
 * 抛 ERR_INVALID_ARG_VALUE，报错还看不出是路径问题（审查发现 #9）。
 *
 * 这里统一处理：优先显式环境变量；否则走生产代码 `resolveDshRoot()` 的探测链
 * （真机从 dsh 启动时能找到）。两者都失败时不硬崩，而是给一句可操作的指引 ——
 * 让"没配环境"与"测试真失败"在输出里可区分，而不是一起崩在 createRequire 里。
 */
async function resolveInstallDir() {
  if (process.env.DSH_INSTALL_DIR) return process.env.DSH_INSTALL_DIR;
  if (process.env.DSH_ROOT) return process.env.DSH_ROOT;
  try {
    const host = await import(pathToFileURL(join(pkgRoot, 'mind', 'src', 'host.js')).href);
    return host.resolveDshRoot();
  } catch {
    console.error('[run-all] DSH install root not found (no DSH_INSTALL_DIR / DSH_ROOT, probe chain failed).');
    console.error('[run-all] Set DSH_INSTALL_DIR to the directory containing dsh.cmd, e.g. D:/dsh on this machine.');
    return null;
  }
}

const installDir = await resolveInstallDir();
const childEnv = installDir === null
  ? { ...process.env }
  : { ...process.env, DSH_INSTALL_DIR: installDir };

const suites = [
  // 合成自身：清单/patch/探针契约
  { name: 'mind-system', files: readdirSync(join(pkgRoot, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => `test/${f}`) },
  // clis：无独立测试目录（其契约由 mind-system 清单测试 + mind 的接口测试覆盖）
  { name: 'agent-mind', files: readdirSync(join(pkgRoot, 'mind', 'test')).filter((f) => f.endsWith('.test.js')).map((f) => `mind/test/${f}`) },
  { name: 'meta-framework', files: readdirSync(join(pkgRoot, 'meta', 'test')).filter((f) => f.endsWith('.test.js')).map((f) => `meta/test/${f}`) },
  { name: 'valves', files: readdirSync(join(pkgRoot, 'valves', 'test')).filter((f) => f.endsWith('.test.js')).map((f) => `valves/test/${f}`) },
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
    env: childEnv,
  });
  if (r.status !== 0) {
    console.error(`[${name}] FAILED (exit ${r.status})`);
    failed++;
  }
}

// memory 的三个手写断言脚本（相对自身目录可移植）
for (const script of ['memory/harness-test.mjs', 'memory/api-test.mjs', 'memory/ui-test.mjs']) {
  console.log(`[${script}]`);
  const r = spawnSync(process.execPath, [script], { cwd: pkgRoot, stdio: 'inherit', env: childEnv });
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
