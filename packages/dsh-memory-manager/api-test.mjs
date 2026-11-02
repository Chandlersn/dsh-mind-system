/**
 * API-route test: drives the panel HTTP handlers with stub req/res objects
 * against the plugin's real (global) memory root.
 *
 * The handlers resolve the memory root server-side, so a client-supplied
 * `?path=` must have no effect — that is one of the assertions below.
 *
 * Requires the Host installation (for `defineTool`): set DSH_INSTALL_DIR when
 * the harness install is not discoverable from this process (see README).
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';

const mod = await import(new URL('./server.js', import.meta.url).href);

// THREE handler instances (5.27.0, adversarial audit):
//   LIVE  — the real global root, NO connection service. Read-only assertions
//           run here; every WRITE route must answer 501 (the fence's degraded
//           branch), which also means this instance can no longer touch user
//           data — the old version retired/activated/deleted a live skill.
//   TEMP  — a throwaway memory root + skillRoot WITH an authenticating
//           connection. All write-channel lifecycle probes run here.
//   GUARD — an instance whose connection REJECTS: proves the fence gates reads
//           too, and its status passes through.
const noop = () => {};
function makeInstance(conn, extraCtx = {}) {
	let routeHandler = null;
	const fakeCtx = {
		tools: { register: () => noop },
		on: () => noop,
		inject(names, fn) {
			fn({
				webServer: {
					register(route) {
						if (route.path === '/api/memory-org') routeHandler = route.handler;
						return noop;
					},
				},
				connection: conn,
				// cordis scoped context = services + effect; effect(fn) runs immediately here.
				effect: (f) => f(),
				...extraCtx,
			});
		},
		systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
		...extraCtx,
	};
	return { fakeCtx, get handler() { return routeHandler; } };
}

// loader/registry shapes so opts.canReload is TRUE (the reload route's real
// capability probe), without ever letting a swap run (cooldown is pre-seeded in
// the one test that touches it).
const LOADER = { internal: { loadCache: new Map() }, async import() { return {}; }, unwrapExports: (m) => m };
const REGISTRY = { get: () => undefined, delete: () => undefined, plugin: () => ({ ctx: { fiber: {} } }) };

const liveInst = makeInstance(undefined); // no connection at all (the degraded host)
mod.apply(liveInst.fakeCtx, {});
if (!liveInst.handler) throw new Error('route was not registered');

// Temp roots for the write probes: a memory root with one source area and a
// skill root — the suite must NEVER touch the real catalog again.
const { mkdtemp, rm: rmTmp } = await import('node:fs/promises');
const osMod = await import('node:os');
const tmpMem = await mkdtemp(path.join(osMod.tmpdir(), 'dsh-api-mem-'));
const tmpSkills = await mkdtemp(path.join(osMod.tmpdir(), 'dsh-api-sk-'));
await writeFile(path.join(tmpMem, 'MEMORY.md'), '# 记忆管理（索引 + 纪律）\n\n## 功能模块索引（functions/）\n\n| 功能域 | 一句话状态 / 待验证 |\n|---|---|\n', 'utf8');
await mkdir(path.join(tmpMem, 'functions'), { recursive: true });
await writeFile(path.join(tmpMem, 'functions', '测试功能.md'), '# 功能域：测试功能\n\n## 当前状态摘要（截至 2026-10-21）\n\n- x\n', 'utf8');
const ALLOW = { requestRejection: () => undefined }; // authenticated caller
const tempInst = makeInstance(ALLOW, { loader: LOADER, registry: REGISTRY });
mod.apply(tempInst.fakeCtx, { memoryRoot: tmpMem, skillRoot: tmpSkills });
if (!tempInst.handler) throw new Error('temp route was not registered');

const DENY = { requestRejection: () => 401 }; // unauthenticated stranger
const guardInst = makeInstance(DENY);
mod.apply(guardInst.fakeCtx, {});

const root = mod.resolveRoot({});
const pluginDir = path.dirname(fileURLToPath(import.meta.url));

function callerOf(handler) {
	async function call(pathname) {
		const url = new URL(pathname, 'http://localhost');
		const req = { url: url.pathname + url.search };
		let captured;
		const res = {
			writeHead(status) {
				captured = { status };
			},
			end(body) {
				captured.body = body;
			},
		};
		await handler(req, res);
		return captured;
	}
	// POST with a JSON body (the panel's write channel). The stub req is an async
	// iterable of one Buffer, mirroring Node's request stream closely enough.
	async function post(pathname, body) {
		const url = new URL(pathname, 'http://localhost');
		const payload = Buffer.from(JSON.stringify(body), 'utf8');
		const req = { method: 'POST', url: url.pathname + url.search, async *[Symbol.asyncIterator]() { yield payload; } };
		let captured;
		const res = {
			writeHead(status) {
				captured = { status };
			},
			end(b) {
				captured.body = b;
			},
		};
		await handler(req, res);
		return captured;
	}
	return { call, post };
}
const { call, post } = callerOf((...a) => liveInst.handler(...a));
const { call: tcall, post: tpost } = callerOf((...a) => tempInst.handler(...a));
const { call: gcall } = callerOf((...a) => guardInst.handler(...a));

let failures = 0;
const ok = (cond, label) => {
	console.log(cond ? `  PASS ${label}` : `  FAIL ${label}`);
	if (!cond) failures++;
};
const encoded = encodeURIComponent;

console.log(`memory root: ${root}`);

const info = await call('/api/memory-org');
ok(info.status === 200 && String(info.body).includes('memory-manager'), 'index info page');

// --- memory root is server-resolved -----------------------------------------
const missingName = await call('/api/memory-org/file');
ok(missingName.status === 400, 'missing name rejected');

const foreignRead = await call(`/api/memory-org/file?path=${encoded(pluginDir)}&name=README.md`);
ok(foreignRead.status !== 200, `client ?path= cannot widen the root (${foreignRead.status})`);

for (const [url, label] of [
	['/api/memory-org/file?zone=../../etc&name=MEMORY.md', 'file zone traversal'],
	['/api/memory-org/list?zone=../../etc', 'list zone traversal'],
	['/api/memory-org/list?zone=legacy', 'unknown zone'],
]) {
	const r = await call(url);
	ok(r.status === 400, `${label} rejected (${r.status})`);
}

const traversal = await call('/api/memory-org/file?name=..%2F..%2FMEMORY.md');
ok(traversal.status === 400, `separator in name rejected (${traversal.status})`);

// --- health / listing --------------------------------------------------------
const real = await call('/api/memory-org/check');
ok(real.status === 200 && JSON.parse(real.body).root === root, 'check on the global memory root');
const parsed = JSON.parse(real.body);
console.log(`    check: initialized=${parsed.initialized} FAIL=${parsed.failCount} WARN=${parsed.warnCount}`);

const list = await call('/api/memory-org/list?zone=functions');
ok(list.status === 200 && Array.isArray(JSON.parse(list.body).files), 'zone listing');

// Daily zone must expose ONLY decision threads — the index (MEMORY.md) belongs
// to its own section and must never show up under 每日.
const daily = await call('/api/memory-org/list?zone=daily');
ok(daily.status === 200, 'daily listing 200');
const dailyFiles = JSON.parse(daily.body).files.map((f) => f.name);
ok(dailyFiles.every((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)), `daily listing holds only dated threads (${dailyFiles.join(', ') || 'empty'})`);
ok(!dailyFiles.includes('MEMORY.md'), 'MEMORY.md excluded from daily zone');
const dailyFile = await call('/api/memory-org/file?zone=daily&name=MEMORY.md');
ok(dailyFile.status === 400, `daily zone refuses the index file (${dailyFile.status})`);

const file = await call('/api/memory-org/file?name=MEMORY.md');
ok(file.status === 200 || file.status === 404, `read MEMORY.md (${file.status})`);
if (file.status === 200) ok(JSON.parse(file.body).text.includes('记忆管理'), 'MEMORY.md content');
else console.log('    （全局根尚未建档——正常，等首次 memory_write 建立）');

// --- skill library (5.24.0: ONE storage — host bundles) ----------------------
// Skills live only as bundles under <dshHome>/skills/<kebab>/SKILL.md. The two
// groups are a VIEW of that one store: `agent_created` bundles are ours
// (结晶技能), everything else is an installed skill (系统技能).
const skillLib = await call('/api/memory-org/skills');
ok(skillLib.status === 200, `/skills answers 200 (${skillLib.status})`);
const sl = JSON.parse(skillLib.body);
ok(Array.isArray(sl.memory) && Array.isArray(sl.host), 'skills payload splits crystallized + system groups');
ok(!('hostDegraded' in sl), 'no hostDegraded field: a missing root just means no bundles there');
const sepRow = (sl.memory ?? []).find((s) => s.name === 'detached-restart');
ok(!!sepRow, 'our crystallized bundle appears in the crystallized group');
if (sepRow) {
	const SK = ['name', 'status', 'scope', 'description', 'kind', 'files'];
	const missSK = SK.filter((k) => !(k in sepRow));
	ok(missSK.length === 0, `crystallized row carries its panel fields (missing: ${missSK.join(',') || 'none'})`);
	ok(sepRow.kind === 'memory' && Array.isArray(sepRow.files) && sepRow.files.some((f) => f.rel === 'SKILL.md'), 'a crystallized skill is a bundle with SKILL.md');
	ok(sepRow.files.some((f) => f.rel === 'scripts/restart-relay.mjs'), 'the bundle file tree carries its scripts');
}
// Host rows are STORAGE bundles: dir bundles with their real file trees.
const scRow = (sl.host ?? []).find((s) => s.name === 'skill-creator');
ok(!!scRow && scRow.kind === 'host', 'the installed skill-creator bundle is listed as a system skill');
if (scRow) {
	ok(scRow.source === 'user-dsh', `host row carries its root source (${scRow.source})`);
	ok(Array.isArray(scRow.files) && scRow.files.some((f) => f.rel === 'SKILL.md') && scRow.files.some((f) => f.rel === 'scripts/quick_validate.py'), `bundle file tree includes SKILL.md + scripts (${scRow.files.length} files)`);
	// Runtime artifacts are not skill assets: this machine really has a
	// __pycache__ inside that bundle (the validator was run), so the LIVE
	// answer — not a fixture — proves the filter.
	ok(!scRow.files.some((f) => /(^|\/)__pycache__\//.test(f.rel) || f.name.endsWith('.pyc')), 'the file tree excludes __pycache__ runtime artifacts');
	ok(!scRow.files.some((f) => /(^|\/)node_modules\//.test(f.rel)), 'the file tree excludes node_modules');
}
// /skill reads a STORED main file; kind picks the root; traversal is a 400.
const memBody = await call(`/api/memory-org/skill?name=detached-restart`);
ok(memBody.status === 200 && JSON.parse(memBody.body).text.includes('Procedure'), 'crystallized skill body reads from its bundle');
ok(JSON.parse(memBody.body).kind === 'memory', 'an agent_created bundle reports kind=memory');
const badName = await call(`/api/memory-org/skill?name=${encoded('../server')}`);
ok(badName.status === 400, 'skill route rejects traversal in the name');
const missHost = await call('/api/memory-org/skill?name=ghost-skill');
ok(missHost.status === 404, 'an unknown bundle is 404');
// /skillfile reads a stored RESOURCE inside a bundle; rel paths are validated
// (no .., no backslash) and resolved server-side from the root.
const pyFile = await call(`/api/memory-org/skillfile?name=skill-creator&file=${encoded('scripts/quick_validate.py')}`);
ok(pyFile.status === 200 && JSON.parse(pyFile.body).text.includes('validate_skill'), 'a stored resource file reads through /skillfile');
const badRel = await call(`/api/memory-org/skillfile?name=skill-creator&file=${encoded('../quick_validate.py')}`);
ok(badRel.status === 400, 'skillfile rejects .. in the relative path');
const badRel2 = await call(`/api/memory-org/skillfile?name=skill-creator&file=${encoded('scripts\\x.py')}`);
ok(badRel2.status === 400, 'skillfile rejects backslashes in the relative path');
// --- panel write channel (5.21.0) --------------------------------------------
// The only mutating route. It runs the memory_skill tool's real executor, so
// the same guards hold; crystallize is deliberately NOT reachable here.
// These assertions use a THROWAWAY bundle and never touch the user's real
// skills AND (5.27.0) never touches the real root: the write probes run on the
// TEMP instance; the live instance must refuse them (no connection = no way to
// tell caller from stranger).
// GET on a write route is 405 ONLY where the caller is allowed to reach it at
// all (the temp instance): on the live instance the fence answers 501 before
// the method check — the order itself is the contract (deny first, parse later).
const getOnly = await tcall('/api/memory-org/skill-action');
ok(getOnly.status === 405, 'skill-action is POST-only (past the fence)');
const liveGetWrite = await call('/api/memory-org/skill-action');
ok(liveGetWrite.status === 501, 'even a GET on a write route is refused before any parsing on a fence-less host');
const fenced = await post('/api/memory-org/skill-action', { action: 'retire', name: 'detached-restart' });
ok(fenced.status === 501, 'a host without the connection service REFUSES panel writes (501, degraded-closed) — the real root is untouchable');
const reloadNoConn = await post('/api/memory-org/reload', {});
ok(reloadNoConn.status === 501, 'reload also degrades closed without connection/loader');
// GUARD: the fence gates READS too — an unauthenticated caller gets the
// rejection status the host's own connection service chose (401), for any seg.
const guardRead = await gcall('/api/memory-org/overview');
ok(guardRead.status === 401, 'an unauthenticated read is rejected with the fence status');
// On the authenticated TEMP instance, the action whitelist and guards apply.
const badAct = await tpost('/api/memory-org/skill-action', { action: 'crystallize', name: 'x' });
ok(badAct.status === 400, 'crystallize is not reachable from the panel (model judgement)');
const noName = await tpost('/api/memory-org/skill-action', { action: 'activate' });
ok(noName.status === 400, 'a missing name is rejected');
const badSlug = await tpost('/api/memory-org/skill-action', { action: 'activate', name: 'Bad_Name' });
ok(badSlug.status === 400, 'a non-kebab name is rejected (it is a bundle dir name)');
// A real lifecycle round trip, on a bundle planted in the TEMP skill root.
const probe = 'api-probe-skill';
const probeDir = path.join(tmpSkills, probe);
await mkdir(probeDir, { recursive: true });
await writeFile(
	path.join(probeDir, 'SKILL.md'),
	`---\nname: ${probe}\ndescription: "当面板写通道回归时使用本技能：临时探针"\nagent_created: true\nscope: global\nstatus: active\n---\n\n# ${probe}\n\n## 何时使用\n\n- x\n\n## 调用步骤\n\n1. a\n2. b\n`,
	'utf8',
);
try {
	const ret = await tpost('/api/memory-org/skill-action', { action: 'retire', name: probe });
	ok(ret.status === 200 && JSON.parse(ret.body).status === 'retired', 'panel retire returns the new status');
	const afterRet = JSON.parse((await tcall('/api/memory-org/skills')).body).memory.find((s) => s.name === probe);
	ok(afterRet.status === 'retired', 'a retired bundle reports its new lifecycle');
	const act = await tpost('/api/memory-org/skill-action', { action: 'activate', name: probe });
	ok(act.status === 200 && JSON.parse(act.body).status === 'active', 'panel activate restores it');
	const afterAct = JSON.parse((await tcall('/api/memory-org/skills')).body).memory.find((s) => s.name === probe);
	ok(afterAct.status === 'active', 'reactivated bundle reports active again');
	const del = await tpost('/api/memory-org/skill-action', { action: 'delete', name: probe });
	ok(del.status === 200, 'panel delete succeeds');
	const fileGone = await stat(path.join(probeDir, 'SKILL.md')).then(() => false, () => true);
	ok(fileGone, 'the bundle file is gone');
	const idxText = await readFile(path.join(tmpMem, 'MEMORY.md'), 'utf8');
	ok(!idxText.includes(probe), 'the temp index carries no dangling row for the deleted skill');
} finally {
	await rm(probeDir, { recursive: true, force: true });
}
const delMissing = await tpost('/api/memory-org/skill-action', { action: 'delete', name: 'no-such-skill-xyz' });
ok(delMissing.status === 400, 'deleting a missing skill is a 400, not a 500');
// reload (5.27.0): POST-only; 501 without connection (asserted above); on the
// temp instance (canReload TRUE, authenticated) a first POST is accepted and
// the 15s ACCEPTANCE cooldown turns the second into 429 — the self-DoS the
// audit flagged is throttled.
const reloadGet = await tcall('/api/memory-org/reload');
ok(reloadGet.status === 405, 'reload is POST-only (past the fence)');
const reload1 = await tpost('/api/memory-org/reload', {});
ok(reload1.status === 202, 'reload accepted on a capable authenticated host');
const reload2 = await tpost('/api/memory-org/reload', {});
ok(reload2.status === 429, `the second POST is throttled, not queued (${reload2.status})`);
// The real loader branch end-to-end: an apply() WITH loader/registry must get a
// reload that actually re-imports. A live host is not available here, so the
// loader is faked with the two primitives the swap really uses (internal.load
// Cache + import/unwrapExports) and a fiber-shaped ctx; the assertion is that
// the fresh module object arrives (cache purge → re-evaluation), not a 501.
{
	const { selfReload } = await import(new URL('./src/reload.js', import.meta.url).href);
	const pkgUrl = new URL('./', import.meta.url).href;
	const entry = new URL('./server.js', import.meta.url).href;
	const { pathToFileURL } = await import('node:url');
	// Seed Node's ESM loadCache shape with THIS package's real module URLs, so the
	// purge has genuine keys to remove (what a loaded plugin looks like).
	const cache = new Map();
	for (const f of ['server.js', 'src/reload.js']) {
		cache.set(new URL(`./${f}`, import.meta.url).href, { id: f });
	}
	const oldApply = () => {};
	const newApply = () => {};
	const importLog = [];
	const loader = {
		internal: { loadCache: cache },
		async import(url) {
			importLog.push(url);
			// unwrapExports in the real host turns the namespace into the exports
			// object; a plugin entry exports apply().
			return { apply: newApply };
		},
		unwrapExports: (m) => m,
	};
	const newFiber = { uid: 'f2', await: async () => {} };
	const oldFiber = {
		uid: 'f1',
		await: async () => {},
		inject: {},
		entry: undefined,
		_config: {},
		parent: { registry: { plugin: () => ({ ctx: { fiber: newFiber } }) } },
	};
	const registry = {
		get: (p) => (p === oldApply ? { fibers: [oldFiber], name: 'dsh-memory-manager', Config: undefined } : undefined),
		delete: () => true,
	};
	const res = await selfReload({ loader, registry, fiber: { ...oldFiber, runtime: { callback: oldApply } } }, { packageUrl: pkgUrl, entryUrl: entry, logger: { info: () => {}, warn: () => {} } });
	ok(res.ok === true && res.fibers === 1, `selfReload completes against a loader-shaped host (ok=${res.ok}${res.error ? ' err=' + res.error : ''})`);
	ok(importLog.length >= 1 && importLog[0].includes('server.js'), 'the entry is re-imported through the host loader');
	ok(!cache.has(entry) || importLog[importLog.length - 1] !== entry, 'a purged cache did not silently serve the old module');
	// The failure path must ROLLBACK: an entry that throws on re-import restores
	// the caches and returns restored:true with the old code still in place.
	const cache2 = new Map([[entry, { id: 'server' }]]);
	const loader2 = { internal: { loadCache: cache2 }, async import() { throw new Error('boom'); }, unwrapExports: (m) => m };
	const failRes = await selfReload({ loader: loader2, registry: { get: () => ({ fibers: [oldFiber] }), delete: () => true }, fiber: { ...oldFiber, runtime: { callback: oldApply } } }, { packageUrl: pkgUrl, entryUrl: entry, logger: { info: () => {}, warn: () => {} } });
	ok(failRes.ok === false && failRes.restored === true && cache2.has(entry), 'a failed re-import restores the cache and reports the rollback');
}

// --- overview / counts -------------------------------------------------------
const idx = await call('/api/memory-org/overview');
ok(idx.status === 200 && Array.isArray(JSON.parse(idx.body)) && JSON.parse(idx.body).length === 1, 'overview returns a single global root');
const o = JSON.parse(idx.body)[0];
console.log(`    overview: title=${o.title} root=${o.root}`);
ok(o.root.endsWith('memory'), 'overview root is the global memory dir');
ok(o.counts && ['functions', 'insights', 'daily', 'capabilities', 'skills'].every((z) => Number.isInteger(o.counts[z])), `overview carries all five zone counts (${JSON.stringify(o.counts)})`);
if (o.counts) {
	const fnList = JSON.parse(list.body).files.length;
	ok(o.counts.functions === fnList, `functions count matches its listing (${o.counts.functions} vs ${fnList})`);
	ok(o.counts.daily === dailyFiles.length, `daily count matches its listing (${o.counts.daily} vs ${dailyFiles.length})`);
}
// Environment block (5.26.0): the overview reports the RUNNING build, both
// stores' locations and the index thresholds — from the server's own truth.
ok(o.env && typeof o.env.version === 'string' && /^\d+\.\d+\.\d+/.test(o.env.version), `env.version is the running semver (${o.env?.version})`);
ok(o.env && typeof o.env.canReload === 'boolean', 'env reports whether the host supports hot reload');
ok(o.env && o.env.memoryRoot && o.env.skillRoot && o.env.skillRoot.replace(/\\/g, '/').includes('/skills'), `env names both stores (${o.env?.memoryRoot} / ${o.env?.skillRoot})`);
ok(o.env && Number.isInteger(o.env.indexBytes) && o.env.indexBytes > 0, `env carries the real index size (${o.env?.indexBytes}B)`);
ok(o.env && o.env.indexComfortBytes > 0 && o.env.indexHardBytes > o.env.indexComfortBytes, 'env thresholds are ordered (comfort < hard)');

// --- search ------------------------------------------------------------------
const search = await call('/api/memory-org/search?q=' + encodeURIComponent('插件'));
ok(search.status === 200 && Array.isArray(JSON.parse(search.body).hits), 'search endpoint returns hits array');
console.log(`    search "插件": ${JSON.parse(search.body).hits.length} hits`);
const shortQ = await call('/api/memory-org/search?q=a');
ok(shortQ.status === 200 && JSON.parse(shortQ.body).hits.length === 0, 'sub-2-char query returns empty');

// --- recall preview (MemOS borrow ②) ---------------------------------------
// Same pipeline the pre-step hook runs, exposed for debugging: "what would this
// input recall, and why". Short queries must not error out (the panel calls it
// on every keystroke-ish interaction).
const prevShort = await call('/api/memory-org/recall-preview?q=a');
ok(prevShort.status === 200 && JSON.parse(prevShort.body).rows.length === 0, 'recall-preview tolerates a sub-2-char query');
const prev = await call('/api/memory-org/recall-preview?q=' + encodeURIComponent('记忆 插件'));
ok(prev.status === 200, `recall-preview 200 (${prev.status})`);
const pv = JSON.parse(prev.body);
ok(Array.isArray(pv.rows) && Array.isArray(pv.tokens), 'recall-preview returns rows + tokens');
console.log(`    recall-preview "记忆 插件": ${pv.rows.length} rows, ${pv.usageSignals ?? 0} usage signals`);
// Contract the panel will read: each row explains itself (reasons) and carries
// the fused score, so ranking is inspectable instead of guessed at.
if (pv.rows.length) {
	const r0 = pv.rows[0];
	ok(typeof r0.href === 'string' && Array.isArray(r0.reasons), 'preview row carries href + reasons');
	ok(typeof r0.fusedScore === 'number', 'preview row carries its fused score');
} else {
	ok(true, 'preview row contract (no hits on this root — shape untested)');
}

// --- response contract the panel client reads --------------------------------
// The panel is a separate half that only sees these JSON shapes; a renamed field
// silently blanks a chip or a snippet (that is how "UI 和系统没匹配上" happens).
// Pin the exact keys both halves agreed on.
const OV_KEYS = ['initialized', 'failCount', 'warnCount', 'results', 'counts'];
const missingOv = OV_KEYS.filter((k) => !(k in o));
ok(missingOv.length === 0, `overview keeps the panel's fields (missing: ${missingOv.join(',') || 'none'})`);
ok(Array.isArray(o.results), 'health findings travel as `results` (not `problems`)');
if (o.results?.length) {
	const rk = ['level', 'rule', 'message'];
	const missR = rk.filter((k) => !(k in o.results[0]));
	ok(missR.length === 0, `each finding keeps level/rule/message (missing: ${missR.join(',') || 'none'})`);
} else console.log('    （当前无体检发现——契约键位仍已断言）');

const hit = JSON.parse(search.body).hits[0];
if (hit) {
	const HK = ['zone', 'name', 'line', 'heading', 'snippet'];
	const missH = HK.filter((k) => !(k in hit));
	ok(missH.length === 0, `search hits keep the panel's fields (missing: ${missH.join(',') || 'none'})`);
	ok(typeof hit.snippet === 'string' && !('text' in hit), 'hit text travels as `snippet` (not `text`)');
} else {
	const empty = await call('/api/memory-org/search?q=' + encodeURIComponent('记忆'));
	const h0 = JSON.parse(empty.body).hits[0];
	ok(!!h0 && ['zone', 'name', 'line', 'heading', 'snippet'].every((k) => k in h0), 'search hits keep zone/name/line/heading/snippet');
}
const listKeys = Object.keys(JSON.parse(list.body).files[0] ?? {});
ok(['name', 'bytes', 'mtime'].every((k) => listKeys.includes(k)), `listing files keep name/bytes/mtime (${listKeys.join(',')})`);
const fileKeys = Object.keys(JSON.parse(file.body));
ok(fileKeys.includes('name') && fileKeys.includes('text'), `file reads keep name/text (${fileKeys.join(',')})`);

// --- 问题收件箱：投递 / 改状态 / 删除 ----------------------------------------
//
// ⚠️ 隔离：收件箱落在 `<DSH_HOME>/storages/memory-inbox.json`，而 DSH_HOME 是
// **调用时**读的环境变量（MemoryInbox.filePath() 每次现算）。所以这里临时把它
// 指向空目录 —— 否则这段测试会读写用户真实的收件箱。
//
// 写入形态直接落文件：收件箱的条目来自插件事件与 memory_inbox 工具，路由本身
// 没有"创建"入口，所以造数据只能写盘。这也让本段成为真正的黑盒路由测试。
const tmpHome = await mkdtemp(path.join(osMod.tmpdir(), 'dsh-api-inbox-'));
const prevHome = process.env.DSH_HOME;
process.env.DSH_HOME = tmpHome;
const stamp = '2026-10-26T00:00:00.000Z';
const seedInbox = async () => {
	await mkdir(path.join(tmpHome, 'storages'), { recursive: true });
	await writeFile(
		path.join(tmpHome, 'storages', 'memory-inbox.json'),
		JSON.stringify({
			version: 1,
			items: {
				fpOpen: { fingerprint: 'fpOpen', from: 'dsh-clis', code: 'x.open', severity: 'warn', message: '未处理的那条', receivedAt: stamp, lastSeenAt: stamp, times: 1, status: 'open' },
				fpDone: { fingerprint: 'fpDone', from: 'agent', code: 'x.done', severity: 'info', message: '已解决的那条', receivedAt: stamp, lastSeenAt: stamp, times: 1, status: 'resolved' },
			},
		}, null, 2),
		'utf8',
	);
};
await seedInbox();

const inboxInst = makeInstance(ALLOW);
const { call: icall, post: ipost } = callerOf((...a) => inboxInst.handler(...a));
mod.apply(inboxInst.fakeCtx, { memoryRoot: tmpMem, skillRoot: tmpSkills });

const inboxList = await icall('/api/memory-org/inbox');
const inboxData = JSON.parse(inboxList.body);
ok(inboxList.status === 200 && inboxData.total === 2, `inbox lists the seeded items (${inboxData.total})`);
ok(inboxData.counts.open === 1 && inboxData.counts.resolved === 1, 'inbox counts items per status');
ok(Array.isArray(inboxData.items) && inboxData.items[0].status === 'open', 'inbox lists unhandled items first');

const filtered = await icall('/api/memory-org/inbox?status=resolved');
ok(JSON.parse(filtered.body).total === 1, 'the status filter narrows the inbox');

// 改状态
const ack = await ipost('/api/memory-org/inbox-action', { fingerprint: 'fpOpen', status: 'acknowledged' });
ok(ack.status === 200 && JSON.parse(ack.body).item.status === 'acknowledged', 'inbox-action updates a status');

// 删除必须显式 op=delete：不带 status 的请求不得把条目删掉（不可逆操作要有明确意图）
const noOp = await ipost('/api/memory-org/inbox-action', { fingerprint: 'fpDone' });
ok(noOp.status === 400, `a write with no status and no delete op is rejected (${noOp.status})`);
const stillThere = await icall('/api/memory-org/inbox');
ok(JSON.parse(stillThere.body).total === 2, 'the rejected write left the inbox untouched');

const del = await ipost('/api/memory-org/inbox-action', { fingerprint: 'fpDone', op: 'delete' });
ok(del.status === 200 && JSON.parse(del.body).deleted === true, 'inbox-action deletes an item on op=delete');
const afterDelete = await icall('/api/memory-org/inbox');
const afterData = JSON.parse(afterDelete.body);
ok(afterData.total === 1 && !afterData.items.some((i) => i.fingerprint === 'fpDone'), 'the deleted item is gone from the inbox');
ok(afterData.counts.resolved === 0, 'deleting also drops it from the status counts');

const delAgain = await ipost('/api/memory-org/inbox-action', { fingerprint: 'fpDone', op: 'delete' });
ok(delAgain.status === 404, `deleting a missing item is a 404 (${delAgain.status})`);

// 删除是持久的（落盘），不是只改了内存视图
const onDisk = JSON.parse(await readFile(path.join(tmpHome, 'storages', 'memory-inbox.json'), 'utf8'));
ok(!('fpDone' in onDisk.items), 'the delete is persisted to disk, not just in memory');

process.env.DSH_HOME = prevHome;
await rmTmp(tmpHome, { recursive: true, force: true });

// --- 文档数字守卫：工具数量与工具表 -------------------------------------------
//
// 工具数量在四处各宣称一次（README 中文/英文、package.json 两个 description），
// 全是**手写的数字**；README 还带一张工具表。每加一个工具就得改四处，
// 人工盯必然漏 —— 本仓库自己的原则就是「对外文档的数字宣称要么机器核对，
// 要么标日期」（insights/文档数字要有机器守卫.md）。
//
// 这里把"注册了什么"与"文档写了什么"对上：数量词比对不一致即失败，
// 工具表则做**成员级**核对（比数量更强，能抓改名与漏删）。
const registered = [];
const countInst = makeInstance(ALLOW, {
	tools: {
		register(def) {
			registered.push(def?.name ?? '');
			return noop;
		},
	},
});
mod.apply(countInst.fakeCtx, { memoryRoot: tmpMem, skillRoot: tmpSkills });
const toolNames = registered.filter(Boolean).sort();

const CN_NUM = { 十: 10, 十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15 };
const EN_NUM = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15 };
const cnWord = Object.keys(CN_NUM).find((k) => CN_NUM[k] === toolNames.length);
const enWord = Object.keys(EN_NUM).find((k) => EN_NUM[k] === toolNames.length);

const readmeCn = await readFile(path.join(pluginDir, 'README.md'), 'utf8');
const readmeEn = await readFile(path.join(pluginDir, 'README.en.md'), 'utf8');
const pkgJson = JSON.parse(await readFile(path.join(pluginDir, 'package.json'), 'utf8'));

ok(cnWord !== undefined, `the test knows the Chinese word for ${toolNames.length} tools`);
ok(readmeCn.includes(`${cnWord}个记忆工具`), `README.md claims ${cnWord} tools, matching the ${toolNames.length} registered`);
// 英文句首会大写（"Thirteen memory tools"），故按小写比对。
ok(readmeEn.toLowerCase().includes(`${enWord} memory tools`), `README.en.md claims ${enWord} tools, matching the ${toolNames.length} registered`);
ok(
	typeof pkgJson.meta?.description === 'string' && pkgJson.meta.description.includes(`${cnWord}个记忆工具`),
	`package.json (meta) claims ${cnWord} tools`,
);
ok(
	typeof pkgJson.description === 'string' && pkgJson.description.includes(`${enWord} memory tools`),
	`package.json (description) claims ${enWord} tools`,
);

// 工具表成员级核对：README 的每一行工具以 `| \`memory_x\` |` 起头。
const documented = [...readmeCn.matchAll(/^\| `(memory_\w+)`/gm)].map((m) => m[1]).sort();
const undocumented = toolNames.filter((n) => !documented.includes(n));
const stale = documented.filter((n) => !toolNames.includes(n));
ok(
	undocumented.length === 0 && stale.length === 0,
	`README's tool table lists exactly the registered tools (undocumented: ${undocumented.join(',') || 'none'}; stale: ${stale.join(',') || 'none'})`,
);

// 注入给模型的纪律文本也是「对外宣称」——它决定模型以为有哪些工具、道在哪一层。
// 它长期写「十二个工具」且只列 12 个名字（漏 memory_dao / memory_inbox），四处文档
// 守卫都不覆盖它，于是新工具落地后模型根本不知道它存在。纳入成员级核对。
ok(
	typeof mod.DISCIPLINE_TEXT === 'string' && mod.DISCIPLINE_TEXT.includes(`${cnWord}个工具`),
	`the injected discipline claims ${cnWord} tools, matching the ${toolNames.length} registered`,
);
const disciplineMissing = toolNames.filter((n) => !mod.DISCIPLINE_TEXT.includes(n));
ok(
	disciplineMissing.length === 0,
	`the discipline names every registered tool (missing: ${disciplineMissing.join(',') || 'none'})`,
);
// 道层的位置必须与实现一致：机制把道放在 dao/，纪律若说「道 = 共识区」，
// 读过纪律的模型会把道写进共识区，正好绕开 memory_dao 的硬闸门。
ok(
	mod.DISCIPLINE_TEXT.includes('dao/') && mod.DISCIPLINE_TEXT.includes('memory_dao'),
	'the discipline points 道 at dao/ and names memory_dao (it used to say 道 = MEMORY.md 共识区)',
);

// 规则范围也是数字宣称：README 两处写「R0–R22」，而 R23 落地后无人同步（本次
// 真实发生）。规则号上限直接从源码里量——新增规则若不改 README，这里就红。
const srcText = await readFile(path.join(pluginDir, 'server.js'), 'utf8');
const ruleNums = [...srcText.matchAll(/add\(\s*'(?:WARN|FAIL)'\s*,\s*'R(\d+)/g)].map((m) => Number(m[1]));
const maxRule = Math.max(...ruleNums);
const claimCn = /R0[–-]R(\d+)/.exec(readmeCn)?.[1];
const claimEn = /R0[–-]R(\d+)/.exec(readmeEn)?.[1];
ok(
	claimCn === String(maxRule) && claimEn === String(maxRule),
	`READMEs claim the same top lint rule the code implements (code R0-R${maxRule}; README.md R0-R${claimCn}; README.en.md R0-R${claimEn})`,
);

console.log(failures === 0 ? 'API ALL PASS' : `${failures} API FAILURES`);
await rmTmp(tmpMem, { recursive: true, force: true });
await rmTmp(tmpSkills, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);