/**
 * DSH 宿主包加载。
 *
 * ## 为什么不能直接 `import '@deepseek-ai/cordis'`
 *
 * 插件的 `node_modules` 里没有 `@deepseek-ai/*`（那是宿主自己的依赖）。
 * 直接 import 会在加载时报 ERR_MODULE_NOT_FOUND。
 *
 * 必须从 **DSH 安装目录** 的 node_modules 里 require。这个目录不能写死
 * `D:\dsh` —— 换机器就废。按下面顺序探测，任一个命中即可：
 *
 * 1. `DSH_INSTALL_DIR` / `DSH_ROOT` / `DSH_HOME`（显式指定，最可靠）
 * 2. `process.argv[1]` 向上找（宿主进程的入口在 `<root>/node_modules/...`）
 * 3. 已加载模块里找（宿主自己一定加载过 cordis）
 * 4. `DSH_PROFILE_DIR` 向上找
 * 5. `process.cwd()` 向上找
 *
 * 判定"找到了"的依据只有一条：`<dir>/node_modules/@deepseek-ai/cordis` 存在。
 * 光看目录存在没用 —— DSH_HOME 本身也有 node_modules，但不是那份。
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * 宿主关键包，用来判定某个目录是不是 DSH 安装根。
 *
 * **判到 `package.json` 而不是只判目录存在**：一个半装坏/残留的空目录
 * 会被"只判目录"的版本误认为安装根，然后 `loadHost` 才在很远的地方失败，
 * 排查成本很高。参照实现 dsh-clis 也是判到 package.json。
 */
const MARKER = join('node_modules', '@deepseek-ai', 'cordis', 'package.json');

/**
 * 判断目录是否是 DSH 安装根。
 *
 * @param dir — 候选目录。
 * @returns 是则返回该目录的绝对路径。
 */
function probe(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return undefined;
  const abs = resolve(dir);
  return existsSync(join(abs, MARKER)) ? abs : undefined;
}

/**
 * 从某个路径向上逐级探测。
 *
 * @param start — 起点（文件或目录）。
 * @returns 找到的 DSH 安装根。
 */
function ascend(start) {
  if (typeof start !== 'string' || start.length === 0) return undefined;
  let dir = resolve(start);
  for (;;) {
    const hit = probe(dir);
    if (hit !== undefined) return hit;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * 在已加载的模块里找宿主根。
 *
 * ## 为什么不能用 `createRequire(...).resolve()`
 *
 * 最初写的是 `createRequire(import.meta.url).resolve('@deepseek-ai/cordis')`，
 * 实测**永远失败**（MODULE_NOT_FOUND）—— `resolve` 只沿**插件自己**的
 * 解析图上溯，而插件 node_modules 里根本没有 `@deepseek-ai/*`
 * （这正是本文件开头说的那件事）。写了个永假分支，等于没有。
 *
 * ## 正确做法：遍历已加载模块
 *
 * 宿主运行时一定加载过 cordis，那些模块的文件名里带
 * `node_modules/@deepseek-ai/`。从它们的位置向上找安装根，才是真的证据。
 *
 * 用 `process.getBuiltinModule('node:module')` 取 CommonJS 的 module 对象：
 * DSH 宿主是 CJS 入口，它的 `require.cache` 里一定包含这些模块。
 * 拿不到 cache 时返回 undefined，不抛错（这一档只是候选，不该拖垮流程）。
 *
 * @returns 找到的 DSH 安装根。
 */
function probeFromLoadedModules() {
  try {
    const mod = process.getBuiltinModule('node:module');
    const cache = mod?.require?.cache ?? mod?.Module?._cache;
    if (cache === undefined || cache === null) return undefined;

    const marker = `node_modules${sep}@deepseek-ai${sep}`;
    for (const filename of Object.keys(cache)) {
      if (!filename.includes(marker)) continue;
      const hit = ascend(dirname(filename));
      if (hit !== undefined) return hit;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 缓存的宿主根。 */
let cachedRoot;

/**
 * 清除解析缓存。
 *
 * 生产代码不需要调它 —— 缓存的意义就是"一次解析、多次复用"。
 * 存在的唯一原因是**测试**：缓存是模块级的，用例之间会互相污染，
 * 导致"改了环境变量却不生效"这种难查的假失败。
 *
 * @internal
 */
export function clearRootCache() {
  cachedRoot = undefined;
}

/**
 * 解析 DSH 安装根。
 *
 * 探测顺序有讲究：**先看能直接证明的，再看要猜的**。
 *
 * 1. `DSH_INSTALL_DIR` / `DSH_ROOT` —— 显式指定，最可靠
 * 2. `process.argv[1]` 向上找 —— 宿主进程入口就在 `<root>/node_modules/...`
 * 3. 已加载模块 —— 宿主一定加载过 cordis
 * 4. `DSH_PROFILE_DIR` 向上找 —— profile 在 `<root>` 同级的某些布局下有效
 * 5. `process.cwd()` 向上找 —— 最后兜底
 *
 * **`DSH_HOME` 排在后面，且要单独判**：它是**数据目录**（`~/.dsh`），
 * 不是安装目录。实测这台机器上 `DSH_HOME=C:\Users\lyq\.dsh`，
 * 而真实安装在 `D:\dsh` —— 把 DSH_HOME 当安装根会直接判错。
 * 但它也可能是安装根（有人装在同一处），所以仍保留为候选，只是靠后。
 *
 * @returns 安装根绝对路径。
 * @throws Error 全部探测失败时（消息里给出该设哪个环境变量）。
 */
export function resolveDshRoot() {
  if (cachedRoot !== undefined) return cachedRoot;

  const hit =
    probe(process.env.DSH_INSTALL_DIR) ??
    probe(process.env.DSH_ROOT) ??
    ascend(process.argv[1]) ??
    probeFromLoadedModules() ??
    ascend(process.env.DSH_PROFILE_DIR) ??
    ascend(process.cwd()) ??
    // DSH_HOME 放最后：它通常是数据目录而非安装目录
    probe(process.env.DSH_HOME);

  if (hit === undefined) {
    throw new Error(
      '无法定位 DSH 安装目录（未在任一候选路径下找到 node_modules/@deepseek-ai/cordis）。' +
        '请设置环境变量 DSH_INSTALL_DIR 指向 DSH 安装目录（通常是包含 dsh.cmd 的那一级）。',
    );
  }

  cachedRoot = hit;
  return hit;
}

/** 缓存宿主 require。 */
let hostRequire;

/**
 * 从宿主侧加载一个包。
 *
 * @param specifier — 包名。
 * @returns 该包的导出。
 */
export function loadHost(specifier) {
  if (hostRequire === undefined) {
    const root = resolveDshRoot();
    // 借一个不存在的文件造 require —— 只要它的目录在宿主根下，
    // 解析就会走宿主自己的 node_modules。
    hostRequire = createRequire(join(root, 'node_modules', 'noop.cjs'));
  }
  return hostRequire(specifier);
}
