/**
 * Self hot-reload (5.25.0): replace the running memory-manager server half with
 * the code now on disk — no process restart.
 *
 * Mechanism borrowed from dsh-our-free-model's src/reload.js (studied at
 * version 2.5.3), which mirrors the kernel HMR service's `partialReload`
 * against the same public primitives:
 *
 * 1. snapshot the live fibers and their configs from the plugin registry;
 * 2. purge this package's modules from Node's ESM loadCache (and the CJS
 *    require.cache) — with a generation-query fallback for kernels whose cache
 *    shape defeats the purge (Node 24 replaced the Map subclass);
 * 3. re-import the entry through the host loader so the new source evaluates;
 * 4. dispose the old fibers and re-register the fresh plugin per fiber;
 * 5. on any failure restore the caches and the old registration — the swap
 *    reports whether the previous runtime could be restored.
 *
 * Why we MAY do this where our-free-model is careful about when: the memory
 * plugin's server half holds no long-running state. Its live state is the
 * memory root (disk, read per operation) and the tool registry / recall hook /
 * web route (all re-established by a fresh `apply`). A reload between agent
 * steps replaces them with zero in-flight loss.
 *
 * @module src/reload.js
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire, registerHooks } from 'node:module';

let inFlight = null;
const hooksKey = Symbol.for('dsh-memory-manager.reload-hooks');
const reloadHooks = (globalThis[hooksKey] ??= new Map());

/** Carry the entry's generation into its dependencies when the host hides its cache. */
function enableFreshDependencies(packageUrl) {
	if (reloadHooks.has(packageUrl)) return;
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			const resolved = nextResolve(specifier, context);
			if (!context.parentURL?.startsWith(packageUrl) || !resolved.url.startsWith(packageUrl)) return resolved;
			const generation = new URL(context.parentURL).searchParams.get('dshmm-reload');
			if (generation === null) return resolved;
			const target = new URL(resolved.url);
			target.searchParams.set('dshmm-reload', generation);
			return { ...resolved, url: target.href };
		},
	});
	reloadHooks.set(packageUrl, hook);
}

/** Whether a reload is currently running; guards against overlapping swaps. */
export function isReloading() {
	return inFlight !== null;
}

/** Every loadCache key that lives inside the package. Key comparison tolerates
 *  case and percent-encoding drift between Node's resolver and `new URL`. */
export function packageCacheKeys(loadCache, packageUrl) {
	const base = decodeURIComponent(packageUrl).replace(/\/+$/, '').toLowerCase() + '/';
	const keys = [];
	for (const key of loadCache.keys()) {
		if (typeof key !== 'string') continue;
		let normalized;
		try {
			normalized = decodeURIComponent(key).toLowerCase();
		} catch {
			normalized = key.toLowerCase();
		}
		if (normalized.startsWith(base)) keys.push(key);
	}
	return keys;
}

/**
 * Back up and remove the package's modules from both module caches.
 * Duck-typed on purpose (same reasoning as our-free-model): Node 24+ may not
 * give a real Map, but keys/get/delete still behave like one; where it IS a
 * Map, Map.prototype methods must be used because LoadCache.delete only
 * cleared a type slot.
 */
export function purgeCaches(internal, packageUrl) {
	const backup = { esm: new Map(), cjs: new Map() };
	const cache = internal?.loadCache;
	if (cache !== null && cache !== undefined && typeof cache.keys === 'function' && typeof cache.get === 'function' && typeof cache.delete === 'function') {
		const read = (key) => {
			try {
				return Map.prototype.get.call(cache, key);
			} catch {
				try {
					return cache.get(key);
				} catch {
					return undefined;
				}
			}
		};
		const drop = (key) => {
			try {
				Map.prototype.delete.call(cache, key);
				return;
			} catch {
				/* not a real Map — fall through */
			}
			try {
				cache.delete(key);
			} catch {
				/* best effort */
			}
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
		} catch {
			/* non-file: URL — nothing to purge on the CJS side */
		}
	}
	return backup;
}

/** Put a purge's backup back (rollback path). */
export function restoreCaches(internal, backup) {
	const cache = internal?.loadCache;
	for (const [key, job] of backup.esm) {
		try {
			Map.prototype.set.call(cache, key, job);
		} catch {
			try {
				cache.set(key, job);
			} catch {
				/* best effort */
			}
		}
	}
	const req = createRequire(import.meta.url);
	for (const [filePath, module] of backup.cjs) req.cache[filePath] = module;
}

/**
 * Reload the calling plugin instance in place.
 * @param {object} ctx the context `apply` received
 * @param {{logger?: object, packageUrl?: string, entryUrl?: string}} [options]
 * @returns {Promise<{ok:true,version:string,fibers:number}|{ok:false,error:string,restored:boolean}>}
 */
export function selfReload(ctx, options = {}) {
	if (inFlight !== null) return inFlight;
	inFlight = (async () => {
		const logger = options.logger ?? console;
		const packageUrl = options.packageUrl ?? new URL('../', import.meta.url).href;
		const entryUrl = options.entryUrl ?? new URL('../server.js', import.meta.url).href;
		const loader = ctx.loader;
		const registry = ctx.registry;
		if (loader === undefined || registry === undefined) {
			return { ok: false, error: '本宿主没有 loader/registry，无法热重启（请走进程重启）', restored: false };
		}
		const previous = ctx.fiber?.runtime?.callback;
		if (previous === undefined || previous === null) {
			return { ok: false, error: '没有可重载的 runtime（插件不是常规方式注册的）', restored: false };
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
		logger.info?.(`memory-manager: hot reload purging ${backup.esm.size} cached module(s)`);

		const importFresh = async (url) => loader.unwrapExports(await loader.import(url, () => []));
		let replacement;
		let busted = false;
		try {
			replacement = await importFresh(entryUrl);
			if (replacement === undefined || typeof replacement.apply !== 'function') throw new Error('reloaded module does not export apply()');
			if (backup.esm.size === 0 || replacement === previous || replacement.apply === previous || (typeof previous.apply === 'function' && replacement.apply === previous.apply)) {
				// The cache purge did not take effect on this kernel — force fresh
				// evaluation with a generation query shared by static dependencies.
				enableFreshDependencies(packageUrl);
				const freshUrl = new URL(entryUrl);
				freshUrl.searchParams.set('dshmm-reload', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
				replacement = await importFresh(freshUrl.href);
				busted = true;
				if (replacement === undefined || typeof replacement.apply !== 'function') throw new Error('reloaded module does not export apply()');
				if (replacement === previous || replacement.apply === previous || (typeof previous.apply === 'function' && replacement.apply === previous.apply)) {
					throw new Error('cache invalidation 后拿到的仍是旧插件');
				}
			}
		} catch (error) {
			restoreCaches(internal, backup);
			return { ok: false, error: `重新 import 失败，旧代码仍在运行（${error?.message ?? error}）`, restored: true };
		}
		globalThis[Symbol.for('dsh-memory-manager.last-reload')] = { at: Date.now(), purged: backup.esm.size, busted };

		// Await the OLD fibers' teardown with allSettled (not all): Promise.all
		// rejects on the FIRST throwing dispose and then continues registering the
		// new code while SIBLING fibers are still unloading — the same race that
		// makes a later rollback collide with half-dead registrations.
		try {
			registry.delete(previous);
			await Promise.allSettled(fibers.map(({ fiber }) => fiber.await()));
		} catch (error) {
			logger.warn?.(`memory-manager: hot reload dispose reported ${error?.message ?? error}`);
		}
		try {
			const created = [];
			for (const { fiber, entry, config } of fibers) {
				const registered = fiber.parent.registry.plugin(replacement, config);
				const fresh = registered.ctx.fiber;
				if (entry !== undefined) {
					fresh.entry = entry;
					entry.fiber = fresh;
				}
				created.push(fresh);
			}
			await Promise.allSettled(created.map((fiber) => fiber.await()));
			logger.info?.(`memory-manager: hot reload complete, ${created.length} fiber(s) re-registered`);
			const version = await new Promise((res) => {
				try {
					res(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
				} catch {
					res('');
				}
			});
			return { ok: true, version: String(version), fibers: created.length };
		} catch (error) {
			restoreCaches(internal, backup);
			// SETTLE the replacement before restoring the old code (the kernel HMR's
			// partialReload does exactly this). registry.delete only drops the table
			// entry synchronously and QUEUES each fiber's async dispose; without the
			// await, re-registering the old plugin can collide with still-live
			// registrations of the NEW one — dsh-tools throws
			// `tool "X" is already registered` mid-rollback and the restore itself
			// fails (restored:false), which is precisely the availability we are
			// trying to claw back.
			try {
				const gone = registry.delete(replacement);
				const replacementFibers = gone?.fibers ?? gone?.runtime?.fibers;
				if (replacementFibers) await Promise.allSettled([...replacementFibers].map((f) => f.await()));
			} catch {
				/* may never have started */
			}
			try {
				const restored = [];
				for (const { fiber, entry, plugin, config } of fibers) {
					const registered = fiber.parent.registry.plugin(plugin, config);
					const fresh = registered.ctx.fiber;
					if (entry !== undefined) {
						fresh.entry = entry;
						entry.fiber = fresh;
					}
					restored.push(fresh);
				}
				await Promise.allSettled(restored.map((fiber) => fiber.await()));
				return { ok: false, error: `新代码启动失败，旧版本已恢复（${error?.message ?? error}）`, restored: true };
			} catch (restoreError) {
				return { ok: false, error: `新代码启动失败（${error?.message ?? error}）；旧代码恢复也失败（${restoreError?.message ?? restoreError}）——请重启进程`, restored: false };
			}
		}
	})();
	// THE OUTCOME IS READABLE AFTERWARD (5.27.0): the route answers 202 and the
	// swap runs detached, so a swallowed .catch left the panel showing "reloaded"
	// even when it failed. Every terminal result lands here; /overview surfaces it
	// as env.lastReload so the client (or a human) can tell success from rollback.
	return inFlight.then((res) => {
		globalThis[Symbol.for('dsh-memory-manager.last-reload')] = { ...(globalThis[Symbol.for('dsh-memory-manager.last-reload')] ?? {}), at: Date.now(), ok: res.ok, error: res.error ?? '', restored: res.restored ?? false, version: res.version ?? '' };
		return res;
	}).finally(() => {
		inFlight = null;
	});
}
