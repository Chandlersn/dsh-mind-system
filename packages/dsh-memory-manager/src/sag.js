/** Read-only fast retrieval from registered SAG roots. Citations retain their source paths. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

/** fast 档默认端点（`sag api` 的监听地址）。 */
export const DEFAULT_SAG_ENDPOINT = 'http://127.0.0.1:24681';

/** SAG 的桌面数据目录：从这里读端口 / 状态，避免写死。 */
export function sagDataDir() {
	const appdata = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
	return join(appdata, 'com.sag.desktop');
}

/**
 * 读 SAG 自己写的 API 配置（端口可能被用户改过，不能写死 24681）。
 * 读不到就回默认值——**读不到不等于服务不存在**，所以不报错。
 */
export function readSagEndpoint() {
	try {
		const raw = readFileSync(join(sagDataDir(), 'http-api.json'), 'utf8');
		const cfg = JSON.parse(raw);
		const port = Number(cfg?.port);
		if (Number.isSafeInteger(port) && port > 0 && port < 65536) {
			return { endpoint: `http://127.0.0.1:${port}`, enabled: cfg?.enabled === true };
		}
	} catch {
		/* not installed / not configured */
	}
	return { endpoint: DEFAULT_SAG_ENDPOINT, enabled: null };
}

/** 一条 API key（`sag api key create` 产出）。从环境变量取，不落盘到记忆根。 */
export function sagApiKeyFromEnv(env = process.env) {
	const k = env.SAG_API_KEY ?? env.DSH_SAG_API_KEY ?? '';
	return typeof k === 'string' && k.trim() ? k.trim() : null;
}

/**
 * Resolve the API key from every legitimate source, in priority order.
 *
 * WHY A FILE SOURCE EXISTS (2026-11-16, decided without restarting the host):
 * a key exported with `[Environment]::SetEnvironmentVariable(..., 'User')` does
 * NOT reach an already-running host — Windows copies the environment block at
 * process start. The alternative was restarting the host (which kills the live
 * session) just to pick up one variable. Reading the key from SAG's own config
 * file means the channel works on the next plugin load instead, and the user
 * never has to time a restart around it.
 *
 * Sources, highest first:
 *   1. `SAG_API_KEY` / `DSH_SAG_API_KEY` env (explicit, wins)
 *   2. `<sag data dir>/api-key` (one line, written by the user or install script)
 * The key is never written into the memory root and never logged.
 */
export function resolveSagApiKey(env = process.env) {
	const fromEnv = sagApiKeyFromEnv(env);
	if (fromEnv) return { key: fromEnv, source: 'env' };
	for (const name of ['api-key', 'api_key', 'key']) {
		try {
			const raw = readFileSync(join(sagDataDir(), name), 'utf8');
			const k = raw.split('\n').map((l) => l.trim()).find((l) => l.startsWith('sag_'));
			if (k) return { key: k, source: `file:${name}` };
		} catch {
			/* not present */
		}
	}
	return { key: null, source: 'none' };
}

/**
 * Resolve the actual `sag` executable and whether a shell is needed.
 *
 * WHY THIS EXISTS (real-host bug, 2026-11-16):
 * on Windows the globally installed CLI is a pair of shims — `sag.cmd` and
 * `sag.ps1` under the node prefix (here D:\nvm\v22.23.3\). There is no `sag.exe`
 * on PATH. `spawn('sag', ...)` WITHOUT a shell cannot execute a `.cmd`, so it
 * fails ENOENT and the service silently never starts — the first real-host run
 * returned exactly `spawn_failed`.
 *
 * Order: (1) explicit option, (2) SAG_BIN env, (3) PATH shim + shell on Windows.
 */
export function resolveSagCommand(options = {}) {
	if (typeof options.bin === 'string' && options.bin.trim()) {
		const explicit = options.bin.trim();
		// An explicit path is taken at face value. A caller who hands us a `.cmd`
		// still needs the shell, so decide by extension rather than assuming.
		return { command: explicit, useShell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(explicit) };
	}
	const envBin = typeof process.env.SAG_BIN === 'string' ? process.env.SAG_BIN.trim() : '';
	if (envBin) {
		return { command: envBin, useShell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(envBin) };
	}
	// On Windows the PATH entry is a .cmd shim → must run through the shell.
	return { command: 'sag', useShell: process.platform === 'win32' };
}

/**
 * 后台拉起 SAG 后台与 HTTP API。**fire-and-forget**：不 await、不抛错。
 *
 * 返回一个 cancel 函数（插件卸载时调用），以及一个 `ready` promise 供测试等待。
 * `sag api start` 自己就是幂等的（已在运行会直接报"运行中"），重复调用安全。
 */
export function startSagService(options = {}) {
	const { command, useShell } = resolveSagCommand(options);
	const timeoutMs = options.timeoutMs ?? 8000;
	let child = null;
	let done = false;

	const ready = new Promise((resolve) => {
		try {
			child = spawn(command, ['api', 'start'], {
				stdio: 'ignore', // 不捕获输出：沙箱下 piped stdio 会 EPERM
				windowsHide: true,
				detached: false,
				// A `.cmd` shim is not an executable image: Windows needs the shell to
				// run it. Without this, spawn fails ENOENT — the real-host bug below.
				shell: useShell,
			});
			child.on('error', () => { if (!done) { done = true; resolve({ ok: false, reason: 'spawn_failed' }); } });
			child.on('exit', (code) => { if (!done) { done = true; resolve({ ok: code === 0 || code === null, reason: code === 0 ? 'started' : `exit_${code}` }); } });
			// 硬超时：进程挂着不退出也不能永远等。
			const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, reason: 'timeout' }); } }, timeoutMs);
			t.unref?.();
		} catch {
			if (!done) { done = true; resolve({ ok: false, reason: 'spawn_threw' }); }
		}
	});

	return {
		ready,
		cancel() {
			try {
				child?.kill?.();
			} catch {
				/* already gone */
			}
		},
	};
}

/** Normalize optional SAG scope filters into bounded string arrays (pure, testable). */
export function normalizeSagScope(options = {}) {
	const clean = (v) => Array.isArray(v)
		? v.filter((p) => typeof p === 'string' && p.trim() && p.length <= 4096).slice(0, 32) : [];
	return { paths: clean(options.paths), exclude: clean(options.exclude) };
}

function pathKey(value) {
	if (typeof value !== 'string' || !value || value.includes('\0')) return null;
	const windows = value.replace(/\//g, '\\');
	if (/^(?:[a-z]:\\|\\\\)/i.test(windows)) {
		const plain = windows.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
		return win32.normalize(plain).toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
	}
	return posix.isAbsolute(value) ? posix.normalize(value).replace(/\/$/, '') : null;
}

async function readSearchBody(response, maxBytes, controller) {
	if (!response.body) return { error: { code: 'bad_response' } };
	const reader = response.body.getReader();
	const parts = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				controller.abort();
				void reader.cancel().catch(() => {});
				return { error: { code: 'response_too_large' } };
			}
			parts.push(value);
		}
	} finally { reader.releaseLock(); }
	try { return JSON.parse(Buffer.concat(parts, bytes).toString('utf8')); }
	catch { return { error: { code: 'bad_response' } }; }
}

export async function sagSearch(query, options = {}) {
	const started = performance.now();
	const timed = (result) => ({ ...result, hostElapsedMs: Math.ceil(performance.now() - started) });
	const fail = (reason) => timed({ ok: false, reason });
	const q = String(query ?? '').trim();
	if (!q) return fail('empty_query');
	if (options.signal?.aborted) return fail('aborted');
	const key = options.apiKey === null ? null : (options.apiKey ?? resolveSagApiKey().key);
	if (!key) return fail('no_key');
	const endpoint = options.endpoint ?? readSagEndpoint().endpoint;
	const limit = Number.isSafeInteger(options.limit) ? Math.min(20, Math.max(1, options.limit)) : 3;
	const { paths, exclude } = normalizeSagScope(options);
	for (const [input, clean] of [[options.paths, paths], [options.exclude, exclude]]) {
		if (input === undefined) continue;
		if (!Array.isArray(input) || input.length !== clean.length || clean.some(p => pathKey(p) === null)) {
			return fail('invalid_scope');
		}
	}
	const allowed = paths.map(pathKey);
	const excluded = exclude.map(pathKey);
	const maxBytes = Math.min(8 * 1024 * 1024, options.maxResponseBytes ?? 8 * 1024 * 1024);
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return fail('bad_arguments');
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
	timer.unref?.();
	try {
		const response = await fetch(`${endpoint}/v1/search`, {
			method: 'POST', redirect: 'error', signal,
			headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
			body: JSON.stringify({ query: q, mode: 'fast', paths, exclude, limit }),
		});
		if (!response.ok) { controller.abort(); return fail(`http_${response.status}`); }
		const body = await readSearchBody(response, maxBytes, controller);
		if (body?.error) return fail(String(body.error.code ?? 'api_error'));
		if (!Array.isArray(body?.results)) return fail('bad_response');
		const results = [];
		for (const row of body.results.slice(0, limit)) {
			const file = pathKey(row?.path);
			if (file === null || typeof row.content !== 'string') return fail('bad_response');
			const contains = dir => file === dir || file.startsWith(`${dir}/`);
			if ((allowed.length && !allowed.some(contains)) || excluded.some(contains)) return fail('scope_mismatch');
			if (row.content) results.push({
				path: row.path, heading: typeof row.heading === 'string' ? row.heading : '', content: row.content,
				startLine: Number.isSafeInteger(row.start_line) ? row.start_line : null,
				endLine: Number.isSafeInteger(row.end_line) ? row.end_line : null,
			});
		}
		return timed({ ok: true, results, elapsedMs: Number.isFinite(body.elapsed_ms) ? body.elapsed_ms : null,
			truncated: body.truncated === true || body.results.length > limit });
	} catch {
		return fail(options.signal?.aborted ? 'aborted' : controller.signal.aborted ? 'timeout' : 'network');
	} finally { clearTimeout(timer); }
}

/** 探测服务是否在线（不检索，只回答问题"能不能用"）。 */
/**
 * SAG index status, cross-checked against the memory root on disk.
 *
 * WHY THE CROSS-CHECK IS THE WHOLE POINT (2026-11-16):
 * after writing a memory there is no way to know whether SAG has picked it up.
 * Searching for it "blind" cannot distinguish three very different states:
 *   · not indexed yet   → the write is fine, the index lags
 *   · indexed but stale → the file changed and the index did not follow
 *   · indexed correctly → the loop is closed
 * The server reports `indexed_files` per root; the caller reports what is
 * actually on disk. Reporting BOTH, and the difference, turns "I hope it
 * worked" into a number. Reporting only SAG's count would hide a lagging index;
 * reporting only the disk count would hide a stalled service.
 *
 * Root matching: SAG returns Windows extended-length paths (`\\?\C:\...`). The
 * prefix is stripped before comparison, otherwise every root looks unmatched.
 */
/**
 * Bounded, read-only count of regular files under an indexed root.
 * Returns null when the root is unreadable, so index health can never be
 * silently reported as "in sync" just because counting failed.
 */
export function countDiskFiles(rootPath, { maxFiles = 20000, skipDirs = ['.git', 'node_modules', '.next', 'target'] } = {}) {
	try {
		// An unreadable root must be unknown (null), NOT 0 — zero would read as
		// "the disk really has no files", a false signal that hides a stalled index.
		if (typeof rootPath !== 'string' || !existsSync(rootPath)) return null;
		let count = 0;
		const walk = (dir, depth) => {
			if (depth > 12 || count > maxFiles) return;
			let entries;
			try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
			for (const e of entries) {
				if (count > maxFiles) return;
				if (e.isDirectory()) {
					if (skipDirs.includes(e.name) || e.name.startsWith('.')) continue;
					walk(join(dir, e.name), depth + 1);
				} else if (e.isFile()) count++;
			}
		};
		walk(rootPath, 0);
		return count > maxFiles ? null : count;
	} catch { return null; }
}

export async function sagStatus(options = {}) {
	const key = options.apiKey === null ? null : (options.apiKey ?? resolveSagApiKey().key);
	const { endpoint } = options.endpoint ? { endpoint: options.endpoint } : readSagEndpoint();
	const controller = typeof AbortController === 'function' ? new AbortController() : null;
	const timer = setTimeout(() => controller?.abort(), options.timeoutMs ?? 4000);
	timer.unref?.();
	let body = null;
	try {
		const res = await fetch(`${endpoint}/v1/status`, {
			method: 'GET',
			headers: key ? { authorization: `Bearer ${key}` } : {},
			...(controller ? { signal: controller.signal } : {}),
		});
		if (!res.ok) return { ok: false, reason: `http_${res.status}` };
		body = await res.json();
	} catch (err) {
		const name = err instanceof Error ? err.name : '';
		return { ok: false, reason: name === 'AbortError' ? 'timeout' : 'network' };
	} finally {
		clearTimeout(timer);
	}
	if (body?.error) return { ok: false, reason: String(body.error.code ?? 'api_error') };
	const roots = (Array.isArray(body?.roots) ? body.roots : []).map((r) => {
		const path = String(r?.path ?? '').replace(/^\\\\\?\\/, '');
		const indexedFiles = Number.isFinite(r?.indexed_files) ? r.indexed_files : null;
		const entry = { path, status: typeof r?.status === 'string' ? r.status : 'unknown', indexedFiles };
		if (options.includeDiskCount === true && indexedFiles !== null) {
			const diskFiles = countDiskFiles(path);
			// null disk count is reported as unknown, never turned into "in sync".
			entry.diskFiles = diskFiles;
			entry.indexLag = diskFiles === null ? null : diskFiles - indexedFiles;
		}
		return entry;
	});
	return {
		ok: true,
		version: typeof body?.version === 'string' ? body.version : null,
		apiEnabled: body?.api?.enabled === true,
		apiRunning: body?.api?.running === true,
		decisionConfigured: body?.decision_configured === true,
		roots,
		endpoint,
	};
}

/**
 * Does one specific memory file appear to be indexed?
 *
 * The check is deliberately conservative: it asks SAG to search for a distinctive
 * phrase from the file and then requires the returned path to MATCH THE TARGET.
 * A hit count alone would be meaningless — fast mode always returns neighbours
 * (measured 2026-11-16: an invented phrase still returned 3 unrelated rows), so
 * "hits > 0" answers nothing. Matching the path is the only honest signal.
 */
export async function sagIsIndexed(filePath, phrase, options = {}) {
	const target = pathKey(filePath);
	const q = String(phrase ?? '').trim();
	if (target === null || !q) return { ok: false, reason: 'bad_arguments' };
	const r = await sagSearch(q, { ...options, limit: options.limit ?? 5 });
	if (!r.ok) return { ok: false, reason: r.reason };
	const found = r.results.some(hit => pathKey(hit.path) === target);
	return { ok: true, indexed: found, searched: r.results.length };
}

/** Is the service answering at all? (no search, just reachability + auth) */
export async function sagPing(options = {}) {
	const key = options.apiKey === null ? null : (options.apiKey ?? resolveSagApiKey().key);
	const { endpoint } = options.endpoint ? { endpoint: options.endpoint } : readSagEndpoint();
	try {
		const res = await fetch(`${endpoint}/v1/search`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
			body: JSON.stringify({ query: 'ping', mode: 'fast', paths: [], limit: 1 }),
			signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(1500) : undefined,
		});
		const body = await res.json().catch(() => null);
		if (body?.error?.code === 'unauthorized') return { online: true, authorized: false };
		if (res.ok && Array.isArray(body?.results)) return { online: true, authorized: true };
		return { online: res.ok, authorized: null };
	} catch {
		return { online: false, authorized: null };
	}
}
