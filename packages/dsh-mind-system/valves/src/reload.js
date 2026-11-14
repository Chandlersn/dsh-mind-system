/**
 * Self hot-reload for the valves plugin (2026-11-14).
 *
 * WHY THIS EXISTS
 * ---------------
 * memory-manager has had a hot-reload route since 5.25.0; valves did not. That
 * asymmetry meant every one-line valves change required killing the host
 * process, even though valves' server half holds exactly the same kind of
 * state as memory's: nothing live beyond the storage dir (read from disk per
 * call) plus the tool registrations a fresh `apply` rebuilds. The cost was paid
 * repeatedly during the P0-1/P0-3 work, and a restart also invalidates the
 * user's open panel token, so it is a real UX cost, not just a developer
 * annoyance.
 *
 * WHY NOT REUSE memory's src/reload.js
 * ------------------------------------
 * That implementation is generic enough (packageUrl / entryUrl options), but
 * importing it would make valves depend on dsh-memory-manager — a reverse
 * dependency the project's direction discipline forbids, and one that would
 * make "install valves without memory" impossible. This is a trimmed port of
 * the same mechanism, deliberately kept small; the swap invariants it relies on
 * are documented below and covered by tests.
 *
 * THE SWAP MUST BE ALL-OR-NOTHING
 * -------------------------------
 * 1. snapshot the live fibers and their configs;
 * 2. purge this package's modules from both caches (ESM loadCache + CJS);
 * 3. re-import through the host loader, with a generation-query fallback for
 *    kernels whose cache shape defeats the purge;
 * 4. dispose the old fibers and register the fresh plugin per fiber;
 * 5. if anything above fails, restore the caches AND the old registration —
 *    reporting honestly whether that restore succeeded.
 *
 * Step 5 is the part worth being careful about: `registry.delete` only drops
 * the table entry synchronously and queues each fiber's async dispose, so the
 * replacement must be awaited before restoring, or re-registering the old
 * plugin collides with still-live registrations of the new one.
 *
 * @module src/reload
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire, registerHooks } from 'node:module';

let inFlight = null;
const hooksKey = Symbol.for('dsh-valves.reload-hooks');
const reloadHooks = (globalThis[hooksKey] ??= new Map());

/** Carry the entry's generation into its dependencies when the host hides its cache. */
function enableFreshDependencies(packageUrl) {
	if (reloadHooks.has(packageUrl)) return;
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			const resolved = nextResolve(specifier, context);
			if (!context.parentURL?.startsWith(packageUrl) || !resolved.url.startsWith(packageUrl)) return resolved;
			const generation = new URL(context.parentURL).searchParams.get('dshv-reload');
			if (generation === null) return resolved;
			const target = new URL(resolved.url);
			target.searchParams.set('dshv-reload', generation);
			return { ...resolved, url: target.href };
		},
	});
	reloadHooks.set(packageUrl, hook);
}

/** Whether a reload is currently running (guards overlapping swaps). */
export function isReloading() {
	return inFlight !== null;
}

/** Every loadCache key that lives inside the package, tolerant of case/encoding drift. */
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

/** Back up and drop the package's modules from both caches (duck-typed). */
export function purgeCaches(internal, packageUrl) {
	const backup = { esm: new Map(), cjs: new Map() };
	const cache = internal?.loadCache;
	if (cache && typeof cache.keys === 'function' && typeof cache.get === 'function' && typeof cache.delete === 'function') {
		const read = (key) => {
			try { return Map.prototype.get.call(cache, key); } catch { try { return cache.get(key); } catch { return undefined; } }
		};
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
		} catch { /* non-file: URL */ }
	}
	return backup;
}

/** Put a purge's backup back (rollback path). */
export function restoreCaches(internal, backup) {
	const cache = internal?.loadCache;
	for (const [key, job] of backup.esm) {
		try { Map.prototype.set.call(cache, key, job); } catch { try { cache.set(key, job); } catch { /* best effort */ } }
	}
	const req = createRequire(import.meta.url);
	for (const [filePath, module] of backup.cjs) req.cache[filePath] = module;
}

/**
 * Reload the calling plugin instance in place.
 *
 * @param {object} ctx the context `apply` received (needs loader + registry).
 * @param {{logger?: object, packageUrl?: string, entryUrl?: string}} [options]
 * @returns {Promise<{ok:true,version:string,fibers:number}|{ok:false,error:string,restored:boolean}>}
 */
export function selfReload(ctx, options = {}) {
	if (inFlight !== null) return inFlight;
	inFlight = (async () => {
		const logger = options.logger ?? console;
		const packageUrl = options.packageUrl ?? new URL('../', import.meta.url).href;
		const entryUrl = options.entryUrl ?? new URL('../index.js', import.meta.url).href;
		const loader = ctx.loader;
		const registry = ctx.registry;
		if (loader === undefined || registry === undefined) {
			return { ok: false, error: '本宿主没有 loader/registry，无法热重启（请走进程重启）', restored: false };
		}
		const previous = ctx.fiber?.runtime?.callback;
		if (previous === undefined || previous === null) {
			return { ok: false, error: '没有可重载的 runtime（插件不是常规方式注册的）', restored: false };
		}
		const runtimeEntry = registry.get(previous);
		const fibers = [...(runtimeEntry?.fibers ?? [])].map((fiber) => {
			const entry = fiber.entry?.fiber?.uid === fiber.uid ? fiber.entry : undefined;
			const plugin = typeof previous === 'function'
				? { apply: previous, inject: { ...fiber.inject }, Config: runtimeEntry.Config, name: runtimeEntry.name }
				: previous;
			return { fiber, entry, plugin, config: entry === undefined ? fiber._config : entry.options.config };
		});
		if (fibers.length === 0) return { ok: false, error: 'runtime 没有活纤维', restored: false };

		const internal = loader.internal;
		const backup = purgeCaches(internal, packageUrl);
		logger.info?.(`valves: hot reload purging ${backup.esm.size} cached module(s)`);

		const importFresh = async (url) => loader.unwrapExports(await loader.import(url, () => []));
		let replacement;
		let busted = false;
		try {
			replacement = await importFresh(entryUrl);
			if (replacement === undefined || typeof replacement.apply !== 'function') throw new Error('reloaded module does not export apply()');
			if (backup.esm.size === 0 || replacement === previous || replacement.apply === previous || (typeof previous.apply === 'function' && replacement.apply === previous.apply)) {
				// Cache purge did not take effect on this kernel: force fresh evaluation.
				enableFreshDependencies(packageUrl);
				const freshUrl = new URL(entryUrl);
				freshUrl.searchParams.set('dshv-reload', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
		globalThis[Symbol.for('dsh-valves.last-reload')] = { at: Date.now(), purged: backup.esm.size, busted };

		try {
			registry.delete(previous);
			await Promise.allSettled(fibers.map(({ fiber }) => fiber.await()));
		} catch (error) {
			logger.warn?.(`valves: hot reload dispose reported ${error?.message ?? error}`);
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
			logger.info?.(`valves: hot reload complete, ${created.length} fiber(s) re-registered`);
			const version = (() => {
				try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? ''; } catch { return ''; }
			})();
			return { ok: true, version: String(version), fibers: created.length };
		} catch (error) {
			restoreCaches(internal, backup);
			// Settle the replacement BEFORE restoring: registry.delete only queues
			// async dispose, and re-registering the old plugin against still-live
			// new registrations throws "tool already registered", which would make
			// the restore itself fail — the opposite of the availability we want.
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
	return inFlight.then((res) => {
		globalThis[Symbol.for('dsh-valves.last-reload')] = {
			...(globalThis[Symbol.for('dsh-valves.last-reload')] ?? {}),
			at: Date.now(), ok: res.ok, error: res.error ?? '', restored: res.restored ?? false, version: res.version ?? '',
		};
		return res;
	}).finally(() => { inFlight = null; });
}
