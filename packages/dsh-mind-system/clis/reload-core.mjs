
// 智能热重载内核 —— 照搬 memory-manager src/reload.js（源自 dsh-our-free-model
// 2.5.3，与内核 HMR 同一套公开原语）。详见该文件头注释。
//
// ⚠️ 改这个文件必须同时提升 CORE_VERSION（下方常量）。写入方按版本号比较，
// **版本低的不会覆盖版本高的** —— 这是"首轮自举不需要重启"的关键：
// 旧监视器想用旧内核覆盖磁盘上的新内核时会被拒绝。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire, registerHooks } from 'node:module';

/** 内核版本：每次改动内核语义都要 +1，且必须与宿主侧 CORE_VERSION 同步。 */
export const CORE_VERSION = 2;

let inFlight = null;
const hooksKey = Symbol.for('dsh-clis.reload-hooks');
const reloadHooks = (globalThis[hooksKey] ??= new Map());

function enableFreshDependencies(packageUrl) {
	if (reloadHooks.has(packageUrl)) return;
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			const resolved = nextResolve(specifier, context);
			if (!context.parentURL?.startsWith(packageUrl) || !resolved.url.startsWith(packageUrl)) return resolved;
			const generation = new URL(context.parentURL).searchParams.get('dshclis-reload');
			if (generation === null) return resolved;
			const target = new URL(resolved.url);
			target.searchParams.set('dshclis-reload', generation);
			return { ...resolved, url: target.href };
		},
	});
	reloadHooks.set(packageUrl, hook);
}

export function purgeCaches(internal, packageUrl) {
	const backup = { esm: new Map(), cjs: new Map() };
	const cache = internal?.loadCache;
	if (cache !== null && cache !== undefined && typeof cache.keys === 'function' && typeof cache.get === 'function' && typeof cache.delete === 'function') {
		const read = (key) => { try { return Map.prototype.get.call(cache, key); } catch { try { return cache.get(key); } catch { return undefined; } } };
		const drop = (key) => {
			try { Map.prototype.delete.call(cache, key); return; } catch { /* not a real Map */ }
			try { cache.delete(key); } catch { /* best effort */ }
		};
		for (const key of packageCacheKeys(cache, packageUrl)) {
			backup.esm.set(key, read(key));
			drop(key);
		}
	}
	const req = createRequire(import.meta.url);
	for (const key of backup.esm.keys()) {
		try {
			const filePath = fileURLToPath(key);
			if (req.cache[filePath] !== undefined) {
				backup.cjs.set(filePath, req.cache[filePath]);
				delete req.cache[filePath];
			}
		} catch { /* non-file URL */ }
	}
	return backup;
}

function packageCacheKeys(cache, packageUrl) {
	const keys = [];
	for (const key of cache.keys()) {
		if (typeof key === 'string' && key.startsWith(packageUrl)) keys.push(key);
	}
	return keys;
}

export function restoreCaches(internal, backup) {
	const cache = internal?.loadCache;
	for (const [key, job] of backup.esm) {
		try { Map.prototype.set.call(cache, key, job); } catch { try { cache.set(key, job); } catch { /* best effort */ } }
	}
	const req = createRequire(import.meta.url);
	for (const [filePath, module] of backup.cjs) req.cache[filePath] = module;
}

export async function selfReload(ctx, options = {}) {
	if (inFlight !== null) return inFlight;
	inFlight = (async () => {
		const logger = options.logger ?? console;
		const packageUrl = options.packageUrl;
		const entryUrl = options.entryUrl;
		const loader = ctx.loader;
		const registry = ctx.registry;
		if (loader === undefined || registry === undefined) {
			return { ok: false, error: '本宿主没有 loader/registry', restored: false };
		}
		const previous = ctx.fiber?.runtime?.callback;
		if (previous === undefined || previous === null) {
			return { ok: false, error: '没有可重载的 runtime', restored: false };
		}
		const runtime = registry.get(previous);
		const fibers = [...(runtime?.fibers ?? [])].map((fiber) => {
			const entry = fiber.entry?.fiber?.uid === fiber.uid ? fiber.entry : undefined;
			const plugin = typeof previous === 'function' ? { apply: previous, inject: { ...fiber.inject }, Config: runtime.Config, name: runtime.name } : previous;
			return { fiber, entry, plugin, config: entry === undefined ? fiber._config : entry.options.config };
		});
		if (fibers.length === 0) return { ok: false, error: 'runtime 没有活纤维', restored: false };

		const internal = loader.internal;
		const backup = purgeCaches(internal, packageUrl);

		const importFresh = async (url) => loader.unwrapExports(await loader.import(url, () => []));
		let replacement;
		try {
			replacement = await importFresh(entryUrl);
			if (replacement === undefined || typeof replacement.apply !== 'function') throw new Error('reloaded module does not export apply()');
			if (backup.esm.size === 0 || replacement === previous || replacement.apply === previous || (typeof previous.apply === 'function' && replacement.apply === previous.apply)) {
				enableFreshDependencies(packageUrl);
				const freshUrl = new URL(entryUrl);
				freshUrl.searchParams.set('dshclis-reload', String(Date.now()) + '-' + Math.random().toString(36).slice(2));
				replacement = await importFresh(freshUrl.href);
				if (replacement === undefined || typeof replacement.apply !== 'function') throw new Error('reloaded module does not export apply()');
				if (replacement === previous || replacement.apply === previous || (typeof previous.apply === 'function' && replacement.apply === previous.apply)) {
					throw new Error('cache invalidation 后拿到的仍是旧插件');
				}
			}
		} catch (error) {
			restoreCaches(internal, backup);
			return { ok: false, error: String(error?.message ?? error), restored: true };
		}

		try {
			registry.delete(previous);
			await Promise.allSettled(fibers.map(({ fiber }) => fiber.await()));
		} catch (error) {
			logger.warn?.('clis: hot reload dispose reported ' + String(error?.message ?? error));
		}
		try {
			const created = [];
			for (const { fiber, entry, config } of fibers) {
				const registered = fiber.parent.registry.plugin(replacement, config);
				const fresh = registered.ctx.fiber;
				if (entry !== undefined) { fresh.entry = entry; entry.fiber = fresh; }
				created.push(fresh);
			}
			await Promise.allSettled(created.map((fiber) => fiber.await()));
			return { ok: true, fibers: created.length };
		} catch (error) {
			restoreCaches(internal, backup);
			try {
				const gone = registry.delete(replacement);
				const replacementFibers = gone?.fibers ?? gone?.runtime?.fibers;
				if (replacementFibers) await Promise.allSettled([...replacementFibers].map((f) => f.await()));
			} catch { /* may never have started */ }
			try {
				const restored = [];
				for (const { fiber, entry, plugin, config } of fibers) {
					const registered = fiber.parent.registry.plugin(plugin, config);
					const fresh = registered.ctx.fiber;
					if (entry !== undefined) { fresh.entry = entry; entry.fiber = fresh; }
					restored.push(fresh);
				}
				await Promise.allSettled(restored.map((fiber) => fiber.await()));
				return { ok: false, error: String(error?.message ?? error), restored: true };
			} catch (restoreError) {
				return { ok: false, error: String(restoreError?.message ?? restoreError), restored: false };
			}
		}
	})();
	return inFlight.finally(() => { inFlight = null; });
}

/**
 * 按 entry 换装（四个组件各一条 entry，只换包根换不到它们）。
 *
 * 走 loader 自己的重启路径：entry.update({}, false, true) —— force 让它在
 * options 未变时也触发 partial-dispose → 重新 import → 按 moduleNamespace
 * 换注册。与宿主 HMR 同一条路径，比自己手搓 fiber 更不容易漏。
 *
 * 某条 entry 不存在（用户关了组件）就跳过，不算失败。
 *
 * @param ctx 插件上下文（需要 loader）。
 * @param options.packageUrl 本包目录的 file:// URL（带尾斜杠）。
 * @param options.entries [{ name, file }]：要换装的入口。
 * @param options.logger 日志。
 * @returns { ok, reloaded, error? }。
 */
export async function reloadEntries(ctx, options = {}) {
	const logger = options.logger ?? console;
	const loader = ctx.loader;
	if (loader === undefined || typeof loader.entries !== 'function') {
		return { ok: false, error: '本宿主没有 loader.entries', reloaded: 0 };
	}
	const wanted = new Set((options.entries ?? []).map((item) => item.name));
	if (wanted.size === 0) return { ok: true, reloaded: 0 };

	// 先收集目标 entry（不要边遍历边改，loader 的 entries() 是生成器）。
	const targets = [];
	for (const entry of loader.entries()) {
		const name = entry?.options?.name;
		if (typeof name === 'string' && wanted.has(name)) targets.push(entry);
	}
	if (targets.length === 0) {
		// 组件全被用户关掉了：不是错误。
		return { ok: true, reloaded: 0 };
	}

	// 清本包模块缓存 —— 不清的话 entry.init() 重新 import 拿到的还是旧模块。
	const internal = loader.internal;
	if (internal !== undefined) purgeCaches(internal, options.packageUrl);

	let reloaded = 0;
	for (const entry of targets) {
		try {
			// 为什么要 dispose 再 init，而不是 entry.update({}, false, true)：
			// force 只让 update 走到 _patchContext([])，那一步只更新 config，
			// **不会重新 import 模块** —— 实测 entry.update 之后真机行为毫无变化
			// （2026-10-30：带探针标记的组件已落盘、PID 未变，但 trace note
			// 里没有标记，证明组件模块根本没被重新求值）。
			// 必须先拆掉旧 fiber，再让 loader 走完整的 _init()（import → 换注册）。
			const previous = entry.fiber;
			if (previous !== undefined && previous !== null) {
				previous.dispose();
				try { await previous.await(); } catch { /* 卸载期错误不影响换装 */ }
			}
			await entry.init();
			reloaded += 1;
		} catch (error) {
			return { ok: false, error: String(error?.message ?? error), reloaded };
		}
	}
	logger.info?.('clis: 已换装 ' + reloaded + ' 个组件入口');
	return { ok: true, reloaded };
}
