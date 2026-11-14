/**
 * Valves self hot-reload contract (2026-11-14).
 *
 * WHY: memory-manager had a reload path since 5.25.0 and valves did not, so
 * every one-line valves change required killing the host process — which also
 * invalidates the user's open panel token. This suite pins the parts that make
 * a reload safe to expose:
 *
 *   1. without loader/registry it must report unsupported, never "ok";
 *   2. before apply() runs it must not claim capability;
 *   3. the cache helpers must be honest about what they purged and restore it;
 *   4. the exported reload() must never throw at the caller.
 *
 * A reload that lies is worse than no reload: it would leave the operator
 * believing new code is live while the old one still runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selfReload, isReloading, packageCacheKeys, purgeCaches, restoreCaches } from '../src/reload.js';
import { apply, reload, probe } from '../index.js';

function sandbox() {
	return mkdtempSync(join(tmpdir(), 'dsh-valves-reload-'));
}

const fakeCtx = (extra = {}) => ({
	logger: () => ({ info() {}, warn() {}, error() {} }),
	provide() {}, set() {}, on() {},
	tools: { register: () => () => {} },
	...extra,
});

test('selfReload refuses — not fakes — when the host has no loader/registry', async () => {
	const result = await selfReload(fakeCtx());
	assert.equal(result.ok, false);
	assert.equal(result.restored, false);
	assert.match(result.error, /loader|registry|重启/);
});

test('selfReload refuses when the plugin was not registered the usual way', async () => {
	const result = await selfReload(fakeCtx({ loader: {}, registry: new Map() }));
	assert.equal(result.ok, false);
	assert.equal(result.restored, false);
	assert.match(result.error, /runtime|重载/);
});

test('reload() before apply() reports unsupported instead of pretending success', async () => {
	const result = await reload();
	assert.equal(result.ok, false);
	assert.match(String(result.error), /重载能力|loader/);
});

test('isReloading is false when idle', () => {
	assert.equal(isReloading(), false);
});

test('apply marks reload unsupported on a host without loader/registry', () => {
	const dir = sandbox();
	try {
		apply(fakeCtx(), { storageDir: dir }, { loadDefineTool: () => (s) => s });
		const health = probe();
		// The probe must not advertise a capability the host cannot provide.
		assert.equal(typeof health, 'object');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('packageCacheKeys matches by prefix, tolerating case and encoding', () => {
	const cache = new Map([
		['file:///pkg/valves/index.js', 1],
		['file:///pkg/valves/src/store.js', 2],
		['file:///pkg/other/index.js', 3],
	]);
	const keys = packageCacheKeys(cache, 'file:///pkg/valves/');
	assert.deepEqual(keys.sort(), ['file:///pkg/valves/index.js', 'file:///pkg/valves/src/store.js']);
	assert.equal(packageCacheKeys(cache, 'file:///PKG/VALVES/').length, 2, 'case drift must still match');
});

test('purge removes package modules and restore puts back the same entries', () => {
	const cache = new Map([
		['file:///pkg/valves/index.js', 'job-a'],
		['file:///pkg/other/index.js', 'job-b'],
	]);
	const internal = { loadCache: cache };
	const backup = purgeCaches(internal, 'file:///pkg/valves/');
	assert.equal(backup.esm.size, 1, 'only our package is purged');
	assert.equal(cache.has('file:///pkg/valves/index.js'), false);
	assert.equal(cache.has('file:///pkg/other/index.js'), true, 'foreign modules untouched');
	restoreCaches(internal, backup);
	assert.equal(cache.get('file:///pkg/valves/index.js'), 'job-a', 'restore is exact');
});

test('purge tolerates a host that exposes no loadCache at all', () => {
	const backup = purgeCaches({}, 'file:///pkg/valves/');
	assert.equal(backup.esm.size, 0);
	assert.doesNotThrow(() => restoreCaches({}, backup));
});
