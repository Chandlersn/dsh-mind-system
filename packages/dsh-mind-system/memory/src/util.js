/**
 * Small shared helpers: dates, atomic file writes, slugs, iteration-block
 * parsing and memory-root resolution. No Host dependency.
 */
import { readFile, writeFile, rename, unlink, mkdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { Buffer } from 'node:buffer';
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
	} catch {
		return undefined;
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
export function withPathLock(p, fn) {
	const key = path.resolve(p);
	const prev = pathTails.get(key) ?? Promise.resolve();
	// The next writer queues behind THIS one whether or not this one rejects.
	const run = prev.then(fn, fn);
	// Keep the tail alive for a follower, then drop the entry once settled.
	pathTails.set(key, run);
	run.then(
		() => {
			if (pathTails.get(key) === run) pathTails.delete(key);
		},
		() => {
			if (pathTails.get(key) === run) pathTails.delete(key);
		},
	);
	return run;
}

/**
 * Write text atomically: a crash or a reader can never observe a partial file.
 * `rename` replaces the destination in one step (Node uses MOVEFILE_REPLACE_
 * EXISTING on Windows); a short retry covers transient locks from readers or
 * antivirus scanning the destination.
 *
 * MEMORY DEFENCE: every markdown write funnels through here, so tier-1
 * credentials are redacted at the choke point. (The .usage.jsonl ledger is the
 * ONE writer that appends directly — it redacts its note inside usage.js;
 * appendUsage is not a markdown write and keeps O(1) append semantics.)
 * The returned `{ hits }` lets callers surface what changed in the tool receipt;
 * callers that ignore the return value keep working.
 */
export async function writeText(p, content) {
	const { text, hits } = redactSecrets(content);
	await mkdir(path.dirname(p), { recursive: true });
	// tmp name carries pid + ms + a RANDOM suffix: same-process writes to the
	// same target in the same millisecond would otherwise share a tmp file and
	// one rename steals the other's bytes.
	const tmp = `${p}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	try {
		await writeFile(tmp, text, 'utf8');
		for (let attempt = 0; ; attempt++) {
			try {
				await rename(tmp, p);
				return { hits };
			} catch (err) {
				if (attempt >= 3) throw err;
				await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
			}
		}
	} catch (err) {
		try {
			await unlink(tmp);
		} catch {
			/* tmp already gone */
		}
		throw err;
	}
}

export async function statExists(p) {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
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
