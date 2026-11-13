/**
 * Small shared helpers: dates, atomic file writes, slugs, iteration-block
 * parsing and memory-root resolution. No Host dependency.
 */
import { readFile, writeFile, rename, mkdir, stat, lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from './secrets.js';

const pad2 = (n) => String(n).padStart(2, '0');

export function localDateStr(d = new Date()) {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function normDate(s) {
	return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? s.trim() : localDateStr();
}

export const byteLen = (s) => Buffer.byteLength(s, 'utf8');

/** Code-point length: CJK counts as 1, unlike byteLen. */
export const charLen = (s) => [...String(s ?? '')].length;

/** One-line, table-safe cell text. */
export function oneLine(s) {
	return String(s ?? '').replace(/\|/g, '／').replace(/\r?\n/g, ' ').trim();
}

export async function readIfExists(p) {
	try {
		return await readFile(p, 'utf8');
	} catch (readError) {
		if (readError?.code !== 'ENOENT' && readError?.code !== 'ENOTDIR') throw readError;
		const unknown = (cause) => {
			const error = new Error(`无法确认读取路径是否真正不存在：${String(p)}；请核查后再写入。`, { cause });
			error.code = 'MEMORY_READ_STATE_UNKNOWN';
			error.readError = readError;
			return error;
		};
		try {
			// lstat does not follow the last entry: a dangling link is not absence.
			await lstat(p);
		} catch (cause) {
			if (cause?.code !== 'ENOENT' && cause?.code !== 'ENOTDIR') throw unknown(cause);
			// lstat of a descendant also reports ENOENT for a dangling ancestor.
			// Verify the nearest existing ancestor resolves before accepting absence.
			let current;
			try {
				const value = p instanceof URL ? (await import('node:url')).fileURLToPath(p) : p;
				if (typeof value !== 'string') throw new TypeError('unsupported path for absence verification');
				current = path.dirname(path.resolve(value));
			} catch (error) { throw unknown(error); }
			for (;;) {
				try { await lstat(current); }
				catch (error) {
					if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw unknown(error);
					const parent = path.dirname(current);
					if (parent === current) throw unknown(error);
					current = parent;
					continue;
				}
				// An existing ancestor must resolve to a directory; a regular-file
				// ancestor is a broken path structure, not a new writable leaf.
				try {
					await realpath(current);
					if (!(await stat(current)).isDirectory()) throw new Error('nearest existing ancestor is not a directory');
				} catch (error) { throw unknown(error); }
				return undefined;
			}
		}
		throw unknown(readError);
	}
}

/**
 * Serialize read-modify-write on one file (5.27.0, adversarial audit #3).
 * writeText's atomic rename protects READERS from a torn file, but a whole
 * read→改→write SEQUENCE is not atomic: two writers of MEMORY.md (memory_index,
 * a skill lifecycle's syncIndexRow, the panel's delete, memory_rename) each read
 * the same old text, and whoever renames LAST silently erases the other's row.
 * The host runs sessions in one process with overlapping awaits, so this is a
 * real interleave, not a theoretical one.
 *
 * A per-resolved-path promise chain: every writer of the same file waits for
 * the previous one to finish before it reads. Same-process coverage is the
 * point (cross-process would need an OS lock — out of scope, and the tool
 * description no longer implies atomic==safe). The chain self-clears when a
 * path's tail settles, so it never grows unbounded.
 */
const pathTails = new Map();
function enqueuePath(tails, key, fn) {
	const prev = tails.get(key) ?? Promise.resolve();
	// The next writer queues behind THIS one whether or not this one rejects.
	const run = prev.then(fn, fn);
	// Keep the tail alive for a follower, then drop the entry once settled.
	tails.set(key, run);
	run.then(
		() => {
			if (tails.get(key) === run) tails.delete(key);
		},
		() => {
			if (tails.get(key) === run) tails.delete(key);
		},
	);
	return run;
}
export function withPathLock(p, fn) {
	return enqueuePath(pathTails, path.resolve(p), fn);
}

// Separate from pathTails: callers may hold withPathLock across their entire
// read-modify-write and then call writeText. Reusing that queue would deadlock.
// This queue protects only each write's rename + ledger append, within one process.
const writeCommitTails = new Map();
export async function withWriteCommitLock(p, fn) {
	// Resolve the parent, not the final leaf: rename replaces the directory entry
	// (which itself could be a symlink). This joins directory aliases to one queue.
	const parent = await realpath(path.dirname(path.resolve(p)));
	let key = path.join(parent, path.basename(p));
	if (process.platform === 'win32') key = key.toLowerCase();
	return enqueuePath(writeCommitTails, key, fn);
}

/**
 * Write text atomically: a crash or a reader can never observe a partial file.
 * `rename` replaces the destination in one step (Node uses MOVEFILE_REPLACE_
 * EXISTING on Windows). If the call fails, the replacement outcome is unknown;
 * callers must inspect disk and ledger instead of blindly repeating it.
 *
 * MEMORY DEFENCE: every markdown write funnels through here, so tier-1
 * credentials are redacted at the choke point. (The .usage.jsonl ledger is the
 * ONE writer that appends directly — it redacts its note inside usage.js;
 * appendUsage is not a markdown write and keeps O(1) append semantics.)
 * The returned `{ hits }` lets callers surface what changed in the tool receipt;
 * callers that ignore the return value keep working. Callers using a configured
 * memory root must pass `{ memoryRoot: root }`; otherwise only the default root
 * is considered for the write ledger. `options.tool` names the writer in the
 * ledger (default 'memory-manager'); the daily-archive channel passes
 * 'daily-archive' so its writes are traceable. For a tracked target, a ledger
 * failure after replacement throws MEMORY_LEDGER_APPEND_FAILED with
 * fileWritten=true: the operation is partially complete, and blindly retrying
 * can duplicate work.
 */
export async function writeText(p, content, options = {}) {
	if (options?.memoryRoot !== undefined && (typeof options.memoryRoot !== 'string' || !options.memoryRoot.trim())) {
		throw new TypeError('memoryRoot must be a non-empty path');
	}
	const { text, hits } = redactSecrets(content);
	await mkdir(path.dirname(p), { recursive: true });
	return withWriteCommitLock(p, async () => {
		// Reject an untracked commit state before creating any staging path.
		await checkTrackedWriteIntent(p, options?.memoryRoot);
		const tmp = `${p}.tmp-${randomUUID()}`;
		try {
			await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
		} catch (cause) {
			// An unacknowledged creation may belong to another process.
			throw new MemoryStageOutcomeUnknown(tmp, cause);
		}
		try {
			try { await rename(tmp, p); }
			catch (cause) { const err = new MemoryWriteCommitUnknown(p, cause); err.ledgerStatus = 'not_attempted'; throw err; }
			await recordTrackedWrite(p, text, options?.memoryRoot, options?.tool);
			let stagePresent = false;
			try { await lstat(tmp); stagePresent = true; }
			catch (cause) {
				if (cause?.code !== 'ENOENT') {
					const err = new Error(`目标已写入，但暂存路径无法检查（${tmp}）；请先核对，不要盲目重试。`, { cause });
					err.code = 'MEMORY_STAGE_PATH_UNKNOWN'; err.fileWritten = true; err.ledgerStatus = 'unknown'; throw err;
				}
			}
			if (stagePresent) {
				const err = new Error(`目标已写入，原暂存路径现有文件（${tmp}），归属未知；请先核对，不要盲目重试。`);
				err.code = 'MEMORY_STAGE_PATH_UNKNOWN'; err.fileWritten = true; err.ledgerStatus = 'unknown'; throw err;
			}
			return { hits };
		} catch (err) {
			// Creation did not give us a perpetual right to unlink this pathname.
			// After rename, even its continued existence could mean reuse by another.
			err.cleanupStatus = 'unknown';
			err.stagePath = tmp;
			err.message += ` 暂存路径状态未知（${tmp}），未自动清理；请先核对，不要盲目重试。`;
			throw err;
		}
	});
}

/** Refuse tracked replacements if their ledger is unknown or deletion is pending. */
async function checkTrackedWriteIntent(absPath, memoryRoot) {
	const { isTracked, ledgerKey, readLedger, LEDGER_REL } = await import('./write-ledger.js');
	const configuredRoot = memoryRoot === undefined ? resolveRoot({}) : path.resolve(memoryRoot);
	const logicalKey = ledgerKey(configuredRoot, path.resolve(absPath));
	let root;
	try {
		root = await realpath(configuredRoot);
	} catch (cause) {
		// Unrelated paths still work when the default memory root does not exist.
		// A logically tracked path must not be replaced when its root is unknown.
		const logicalParts = logicalKey.split('/');
		const logicalTracked = isTracked(logicalKey) || (process.platform === 'win32' && logicalParts.length > 1 && isTracked([logicalParts[0].toLowerCase(), ...logicalParts.slice(1)].join('/')));
		if (logicalTracked) throw new Error(`记忆根无法解析，未写入 ${logicalKey}`, { cause });
		return;
	}
	// rename replaces the leaf itself, even when that leaf is a symbolic link.
	// Resolve the directory instead, just as withWriteCommitLock does.
	const parent = await realpath(path.dirname(path.resolve(absPath)));
	const key = ledgerKey(root, path.join(parent, path.basename(absPath)));
	if (!isTracked(key)) {
		// Windows compares directory names case-insensitively, whereas isTracked
		// and ledger keys are case-sensitive. Never silently bypass an aliased
		// tracked zone that the recorder cannot represent consistently.
		const parts = key.split('/');
		if (process.platform === 'win32' && parts.length > 1 && isTracked([parts[0].toLowerCase(), ...parts.slice(1)].join('/'))) {
			throw new Error(`受管目录大小写无法与账本口径一致，未写入 ${key}`);
		}
		return;
	}
	let ledger = await readLedger(root);
	// readLedger treats ENOENT as an absent ledger, but a dangling ledger
	// symlink also reads as ENOENT and is not evidence of an empty history.
	if (ledger instanceof Map && ledger.size === 0) {
		const ledgerPath = path.join(root, LEDGER_REL);
		try {
			const entry = await lstat(ledgerPath);
			if (entry.isSymbolicLink()) {
				try { await stat(ledgerPath); } catch { ledger = undefined; }
			}
		} catch (err) {
			if (err?.code !== 'ENOENT') ledger = undefined;
		}
	}
	if (ledger === undefined) {
		const err = new Error(`写入账本不可读或损坏，未写入 ${key}`);
		err.code = 'MEMORY_LEDGER_UNREADABLE';
		err.fileWritten = false;
		throw err;
	}
	const pending = process.platform === 'win32'
		? [...ledger].some(([recorded, entry]) => recorded.toLowerCase() === key.toLowerCase() && entry.op === 'delete_intent')
		: ledger.get(key)?.op === 'delete_intent';
	if (pending) {
		const err = new Error(`${key} 存在未完成删除意图，未写入；请先核对并处理该意图`);
		err.code = 'MEMORY_DELETE_INTENT_PENDING';
		err.fileWritten = false;
		throw err;
	}
}

/** A failed stage write may have created bytes or encountered an existing path. */
export class MemoryStageOutcomeUnknown extends Error {
	constructor(stagingPath, cause) {
		super(`暂存文件创建或写入结果未知：${stagingPath}；目标尚未替换，请先核对暂存路径，不要盲目删除或重试。${cause ? ` 原因：${redactSecrets(String(cause.message ?? cause)).text}` : ''}`, cause ? { cause } : undefined);
		this.name = 'MemoryStageOutcomeUnknown';
		this.code = 'MEMORY_STAGE_OUTCOME_UNKNOWN';
		this.fileWritten = false;
		this.stagingPath = path.resolve(stagingPath);
	}
}

/** Replacement may have happened even though the rename acknowledgement failed. */
export class MemoryWriteCommitUnknown extends Error {
	constructor(filePath, cause) {
		super(`文件提交结果未知：${filePath}；请先核对目标文件与账本，不要盲目重试。${cause ? ` 原因：${redactSecrets(String(cause.message ?? cause)).text}` : ''}`, cause ? { cause } : undefined);
		this.name = 'MemoryWriteCommitUnknown';
		this.code = 'MEMORY_WRITE_COMMIT_UNKNOWN';
		this.fileWritten = null;
		this.ledgerStatus = 'unknown';
		this.path = path.resolve(filePath);
	}
}

/** A file replacement succeeded but its required ledger record did not. */
export class MemoryLedgerAppendError extends Error {
	constructor(filePath, key, cause) {
		super(`文件已写入，但写入账本未能确认追加：${filePath}。请先核对文件和账本，不要盲目重试。`, cause ? { cause } : undefined);
		this.name = 'MemoryLedgerAppendError';
		this.code = 'MEMORY_LEDGER_APPEND_FAILED';
		this.fileWritten = true;
		// appendFile can fail after a partial or complete append; do not claim
		// the record is certainly absent merely because the call failed.
		this.ledgerRecorded = null;
		this.ledgerStatus = 'unknown';
		this.path = path.resolve(filePath);
		this.key = key;
	}
}

/** Record tracked targets only; do not silently hide a post-commit failure. */
async function recordTrackedWrite(absPath, text, memoryRoot, tool = undefined) {
	const { recordWrite, isTracked, ledgerKey, contentHash } = await import('./write-ledger.js');
	const configuredRoot = memoryRoot === undefined ? resolveRoot({}) : path.resolve(memoryRoot);
	const logicalKey = ledgerKey(configuredRoot, path.resolve(absPath));
	let root;
	let target;
	try {
		[root, target] = await Promise.all([realpath(configuredRoot), realpath(absPath)]);
	} catch (err) {
		// A missing default root must not turn an unrelated write into an error.
		// For a target under a tracked logical path, missing resolution means the
		// record cannot be confirmed after the file replacement.
		if (isTracked(logicalKey)) throw new MemoryLedgerAppendError(absPath, logicalKey, err);
		return;
	}
	const key = ledgerKey(root, target);
	if (!isTracked(key)) return;
	// tool 可由调用方指定（归档通道要求账本可追溯 tool='daily-archive'）；
	// 缺省保持原 'memory-manager' 身份，既有账本语义一分不变。
	try {
		const recorded = await recordWrite(root, { key, hash: contentHash(text), tool: typeof tool === 'string' && tool.trim() ? tool : 'memory-manager', bytes: byteLenLocal(text) });
		if (!recorded) throw new MemoryLedgerAppendError(absPath, key);
	} catch (err) {
		if (err instanceof MemoryLedgerAppendError) throw err;
		throw new MemoryLedgerAppendError(absPath, key, err);
	}
}

const byteLenLocal = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');

export async function statExists(p) {
	try {
		await stat(p);
		return true;
	} catch (error) {
		if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
		throw error;
	}
}

/** Validate a feature/theme slug used as a markdown filename. */
export function safeSlug(raw) {
	// Tolerate the filename spelling callers reach for by habit ("x.md"); without
	// this, related: ["x.md"] renders as `x.md.md（未建档）` instead of a link.
	const s = String(raw ?? '').trim().replace(/\.md$/i, '');
	if (!s) throw new Error('slug must be a non-empty string');
	if (s.length > 60) throw new Error(`slug too long (max 60 chars): ${s}`);
	if (/[\\/:*?"<>|]/.test(s) || s.includes('..') || s.startsWith('.')) {
		throw new Error(`invalid slug (no path separators or dots at start): ${s}`);
	}
	if (/^memory$/i.test(s)) throw new Error('slug "MEMORY" is reserved for MEMORY.md');
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('slug must not look like a daily-log date (YYYY-MM-DD)');
	return s;
}

/** Iteration blocks (`## [date…] title`) with their bodies, for R14 length checks. */
export function splitIterationBlocks(text) {
	const out = [];
	let cur = null;
	for (const line of String(text ?? '').split('\n')) {
		if (/^##\s/.test(line)) {
			if (cur) out.push(cur);
			cur = null;
			const m = /^##\s*\[(\d{4}-\d{2}-\d{2}[^\]]*)\]\s*(.*)$/.exec(line);
			if (m) cur = { title: m[2].trim() || m[1], body: '' };
			continue;
		}
		if (cur) cur.body += `${line}\n`;
	}
	if (cur) out.push(cur);
	return out.map((b) => ({ title: b.title, body: b.body.trim() }));
}

/**
 * Resolve the harness home (same precedence as @deepseek-ai/dsh-home-paths:
 * $DSH_HOME, then ~/.dsh) without importing the package — the plugin keeps a
 * zero bare-import surface.
 */
export function dshHome() {
	const env = process.env.DSH_HOME;
	if (typeof env === 'string' && env.trim()) return path.resolve(env.trim());
	return path.join(homedir(), '.dsh');
}

export function joinDshHome(...segments) {
	return path.join(dshHome(), ...segments);
}

export function resolveRoot(opts) {
	if (opts.memoryRoot) return path.resolve(opts.memoryRoot);
	// Global memory root: the harness home's memory/ directory, shared across
	// every workspace, profile, and session (~/.dsh/memory by default).
	return joinDshHome('memory');
}

export function appendBlock(text, block) {
	return text.replace(/\n*$/, '\n') + block;
}

/**
 * Next same-day iteration index. Counts every `[YYYY-MM-DD]` / `[YYYY-MM-DD补N]`
 * tag in the file — not just the `## [..]` headings — because memory_fold removes
 * headings and lists the folded tags inside 「早期演化」: counting headings alone
 * would reuse an existing tag after a fold (补4 colliding with a folded 补4, which
 * also trips the R3 ordering check).
 */
export function countHeadingDate(text, date) {
	let max = -1;
	const re = new RegExp(`\\[${date}(补(\\d*))?\\]`, 'g');
	for (const m of String(text ?? '').matchAll(re)) {
		const n = m[2] === undefined ? 0 : m[2] === '' ? 1 : Number(m[2]);
		if (Number.isFinite(n) && n > max) max = n;
	}
	return max + 1;
}
