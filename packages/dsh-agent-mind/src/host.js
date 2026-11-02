/**
 * 宿主包加载 —— 让本插件能用上宿主提供的 `defineTool`。
 *
 * ## 为什么不能直接 import
 *
 * 插件的 `node_modules` 里没有 `@deepseek-ai/*`（那是宿主自己的依赖），
 * 直接 import 会 ERR_MODULE_NOT_FOUND。
 *
 * ## 为什么不能依赖 memory-manager 的 host.js
 *
 * memory 的 `./src/host.js` 确实提供了 `defineTool`，但依赖它会让
 * mind → memory 形成一条**不该有的依赖**：调度层是给所有插件用的，
 * 不该挂在记忆系统下面（缺 memory 时 mind 仍要能工作）。
 *
 * 所以这里自建一份精简版：只做"从安装目录 require 一个宿主包"这一件事，
 * 约 60 行，不复制 memory 那份的全部能力（panel、消息构造等）。
 *
 * ## 探测顺序
 *
 * 1. `DSH_INSTALL_DIR` / `DSH_ROOT`（显式指定，最可靠）
 * 2. `process.argv[1]` 向上找（宿主入口在 `<root>/node_modules/...`）
 * 3. 已加载模块里找（宿主一定加载过 dsh-tools）
 * 4. `DSH_PROFILE_DIR` 向上找
 * 5. `process.cwd()` 向上找
 *
 * 判定"找到了"的依据只有一条：`<dir>/node_modules/@deepseek-ai/dsh-tools` 存在。
 * 光看目录存在没用 —— `DSH_HOME` 本身也有 node_modules，但不是那份。
 *
 * @module src/host.js
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/** 宿主关键包，用来判定某个目录是不是 DSH 安装根。 */
const MARKER = join('node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');

/**
 * 判定某目录是否是 DSH 安装根。
 *
 * @param {string} dir 候选目录。
 * @returns {string|undefined} 是则返回绝对路径。
 */
function probe(dir) {
	if (typeof dir !== 'string' || dir.length === 0) return undefined;
	const abs = resolve(dir);
	return existsSync(join(abs, MARKER)) ? abs : undefined;
}

/**
 * 从某路径向上逐级探测。
 *
 * @param {string} start 起点。
 * @returns {string|undefined} 找到则返回安装根。
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
 * `createRequire(import.meta.url).resolve()` 走的是**本插件自己的**
 * 解析图，而插件 node_modules 里没有 `@deepseek-ai/*` —— 写它等于写一个
 * 永假分支。真正可行的是两条：
 *
 * 1. 遍历宿主已加载的模块（它一定加载过 dsh-tools），从其位置向上找根
 * 2. 从本文件自己的解析图解析宿主包（常规安装时有效）
 *
 * @returns {string|undefined} 找到则返回安装根。
 */
function probeFromLoadedModules() {
	try {
		// @ts-expect-error —— node:module 的 getBuiltinModule 是 Node 22+ 的 API
		const mod = process.getBuiltinModule('node:module');
		const cache = mod?.require?.cache ?? mod?.Module?._cache;
		if (cache !== undefined && cache !== null) {
			const marker = `node_modules${sep}@deepseek-ai${sep}`;
			for (const filename of Object.keys(cache)) {
				if (!filename.includes(marker)) continue;
				const hit = ascend(dirname(filename));
				if (hit !== undefined) return hit;
			}
		}
	} catch {
		/* 拿不到 require.cache 就试下一条路 */
	}
	// 兜底：从本文件自己的解析图解析宿主包（常规安装形态）
	try {
		const resolved = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools/lib/index.js');
		return ascend(dirname(resolved));
	} catch {
		return undefined;
	}
}

/** 缓存的宿主根。 */
let cachedRoot;

/**
 * 解析 DSH 安装根。
 *
 * @returns {string} 安装根绝对路径。
 * @throws {Error} 全部探测失败。
 */
export function resolveDshRoot() {
	if (cachedRoot !== undefined) return cachedRoot;
	const hit =
		probe(process.env.DSH_INSTALL_DIR) ??
		probe(process.env.DSH_ROOT) ??
		ascend(process.argv[1]) ??
		ascend(process.cwd()) ??
		ascend(process.env.DSH_PROFILE_DIR) ??
		probeFromLoadedModules() ??
		probe(process.env.DSH_HOME);
	if (hit === undefined) {
		throw new Error(
			'无法定位 DSH 安装目录（未在任一候选路径下找到 node_modules/@deepseek-ai/dsh-tools）。' +
				'请设置环境变量 DSH_INSTALL_DIR 指向 DSH 安装目录。',
		);
	}
	cachedRoot = hit;
	return hit;
}

/** 缓存的宿主 require。 */
let hostRequire;

/**
 * 从宿主侧 require 一个包。
 *
 * @param {string} specifier 包名。
 * @returns {any} 该包的导出。
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

/**
 * 取宿主的 `defineTool`。
 *
 * @returns {Function} defineTool。
 */
export function getDefineTool() {
	return loadHost('@deepseek-ai/dsh-tools').defineTool;
}

/**
 * 清除根缓存（仅测试用：缓存是模块级的，会让"改了环境变量却不生效"
 * 变成难查的假失败）。
 *
 * @internal
 */
export function clearRootCache() {
	cachedRoot = undefined;
}
