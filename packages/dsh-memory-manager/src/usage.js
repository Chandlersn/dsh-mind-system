/**
 * Usage signals — the data that lets the memory sort itself.
 *
 * The index/insight layer is written by the model; which rows are actually USED
 * is a different signal. Every recall injection, explicit file read, correction
 * and positive confirmation appends one line to <root>/.usage.jsonl (a dot-file
 * so no zone listing, search or lint sees it), and memory_check / memory_usage
 * turn those lines into layer suggestions.
 */
import { appendFile, link, lstat, mkdir, open, opendir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import * as path from 'node:path';
// Enumeration goes through the default fs/promises object on purpose: callers and
// tests that fault-inject on fs.promises.readdir must be observed here too.
import fsp from 'node:fs/promises';
import { redactSecrets } from './secrets.js';

export function usagePath(root) {
	return path.join(root, '.usage.jsonl');
}

async function confirmMissingDirectory(dir, original) {
	let current = path.resolve(dir);
	for (;;) {
		try {
			await lstat(current);
			if (current === path.resolve(dir)) throw original;
			await realpath(current);
			if (!(await stat(current)).isDirectory()) throw original;
			return;
		} catch (error) {
			if (error === original) throw error;
			if (error?.code !== 'ENOENT') throw error;
			// An existing dangling link is not a missing directory.
			try { await lstat(current); } catch (missing) {
				if (missing?.code !== 'ENOENT') throw missing;
				const parent = path.dirname(current);
				if (parent === current) throw original;
				current = parent;
				continue;
			}
			throw original;
		}
	}
}

const gunzipAsync = promisify(gunzip);
export const USAGE_GZIP_MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
export const USAGE_GZIP_MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;

function usageReadError(code, message, cause) {
	const error = new Error(message, cause ? { cause } : undefined);
	error.code = code;
	return error;
}

/** Read an explicitly selected file; this function never selects a replacement source. */
export async function readUsageFile(descriptor, { maxUncompressedBytes = USAGE_GZIP_MAX_UNCOMPRESSED_BYTES } = {}) {
	if (!descriptor || typeof descriptor.file !== 'string' || !descriptor.file ||
		(descriptor.encoding !== undefined && descriptor.encoding !== 'utf8' && descriptor.encoding !== 'gzip')) {
		throw new TypeError('Invalid usage file descriptor');
	}
	if (!Number.isSafeInteger(maxUncompressedBytes) || maxUncompressedBytes < 1 || maxUncompressedBytes > USAGE_GZIP_MAX_UNCOMPRESSED_BYTES) {
		throw new RangeError('Invalid uncompressed usage byte limit');
	}
	const compressed = descriptor.encoding === 'gzip';
	const handle = await open(descriptor.file, 'r');
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw usageReadError('USAGE_SOURCE_CHANGED', 'Usage source is not a regular file');
		const inputLimit = compressed ? USAGE_GZIP_MAX_COMPRESSED_BYTES : maxUncompressedBytes;
		if (before.size > inputLimit) {
			throw usageReadError(compressed ? 'USAGE_COMPRESSED_LIMIT' : 'USAGE_DECOMPRESSED_LIMIT',
				'Usage source exceeds the input limit');
		}
		const buffer = Buffer.alloc(before.size + 1);
		let count = 0;
		while (count < buffer.length) {
			const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
			if (!bytesRead) break;
			count += bytesRead;
		}
		const after = await handle.stat();
		if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
			throw usageReadError('USAGE_SOURCE_CHANGED', 'Usage source changed during read');
		}
		let data = buffer.subarray(0, count);
		if (compressed) {
			try {
				data = await gunzipAsync(data, { maxOutputLength: maxUncompressedBytes });
			} catch (error) {
				if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
					throw usageReadError('USAGE_DECOMPRESSED_LIMIT', 'Decompressed usage exceeds the output limit', error);
				}
				throw usageReadError('USAGE_GZIP_INVALID', 'Usage gzip is invalid or truncated', error);
			}
		}
		try {
			return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
		} catch (error) {
			throw usageReadError('USAGE_UTF8_INVALID', 'Usage source is not valid UTF-8', error);
		}
	} finally {
		await handle.close();
	}
}

/**
 * Monthly shard directory (2026-11-16). The ledger is an append-only EVENT log:
 * every recall injection writes a line, so a real root reached 4.3k lines / 420KB
 * in a month of use and there was no rotation of any kind. Two consequences:
 * every `readUsage` parsed the whole file (cost grows forever), and the file
 * itself would eventually become the largest thing in the memory root.
 *
 * Sharding by month bounds the cost of a 30-day window to ~2 files. It is NOT
 * deduplication: recall rows must stay as events, because "how often was this
 * put in front of the model" is what weights recall. We only change WHERE the
 * rows live, never how many there are.
 */
export function usageShardDir(root) {
	return path.join(root, '.usage');
}

/** `.usage/YYYY-MM.jsonl` for the entry's own timestamp (UTC month). */
export function usageShardPath(root, date = new Date()) {
	const d = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
	const yyyy = d.getUTCFullYear();
	const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
	return path.join(usageShardDir(root), `${yyyy}-${mm}.jsonl`);
}

/**
 * One canonical identity per skill in the ledger (5.27.0): the index row links
 * to the host bundle with an absolute file:/// URL, the tools and the activate
 * gate speak the relative `skills/<name>/SKILL.md` form — without folding, the
 * SAME skill would accumulate signals under two hrefs and each reader would
 * see half the evidence. Everything else passes through untouched.
 */
export function canonicalHref(href) {
	const m = /(?:^|[\\/])skills[\\/]+([^\\/]+)[\\/]+SKILL\.md$/i.exec(String(href ?? ''));
	return m ? `skills/${m[1]}/SKILL.md` : String(href ?? '');
}

/**
 * Last usage-write failure, for observability only.
 *
 * WHY THIS EXISTS (2026-11-19): the catch below used to be entirely empty, on the
 * stated principle that "usage logging must never break a step or a tool call".
 * The principle is right — a signal ledger must not be able to fail a real write —
 * but the implementation made the failure INVISIBLE in both directions:
 *
 *   · no error surfaced to the caller (by design), and
 *   · no record anywhere that the ledger had stopped accepting rows.
 *
 * Measured consequence: `.usage/2026-11.jsonl` went from 158 rows on 11-17 and
 * 176 on 11-18 to 1 row on 11-19, while the panel kept showing a frozen total.
 * Nothing anywhere said the ledger was down; the numbers simply stopped moving
 * and read as "no activity today" — which is the exact failure mode
 * `insights/失败被伪装成成功` warns about.
 *
 * The fix keeps the no-throw contract but adds a bounded, in-memory record that
 * a health probe and the panel can read. In-memory on purpose: writing a failure
 * record into the same filesystem that just refused a write is not reliable.
 *
 * @type {{ at: string, code: string, message: string, count: number } | null}
 */
let lastUsageWriteFailure = null;
let usageWriteFailureCount = 0;

/** Read the most recent usage-write failure (null when the last write was fine). */
export function usageWriteHealth() {
	return { failure: lastUsageWriteFailure, failures: usageWriteFailureCount };
}

/** Test hook: forget any recorded failure. */
export function resetUsageWriteHealth() {
	lastUsageWriteFailure = null;
	usageWriteFailureCount = 0;
}

export async function appendUsage(root, entry) {
	try {
		await mkdir(root, { recursive: true });
		// REDACT HERE TOO (5.27.0): util.js calls writeText "the single choke
		// point" for credentials, but this path appends directly — a note like
		// "the token leaked here" used to land in .usage.jsonl as plaintext, and
		// R21 never scans the dot-file. Same tier-1 rule as every other writer.
		const folded = { ...entry, href: canonicalHref(entry.href) };
		if (typeof folded.note === 'string') folded.note = redactSecrets(folded.note).text;
		const now = new Date();
		const line = `${JSON.stringify({ t: now.toISOString(), ...folded })}\n`;
		// Write into the month shard. The legacy single file is NOT appended to any
		// more, but it stays readable forever (see readUsage) — rotation without a
		// migration step, so an existing root loses nothing.
		await mkdir(usageShardDir(root), { recursive: true });
		await appendFile(usageShardPath(root, now), line, 'utf8');
		return { ok: true };
	} catch (error) {
		// Still never throws — but no longer silent. See usageWriteHealth above.
		usageWriteFailureCount += 1;
		lastUsageWriteFailure = {
			at: new Date().toISOString(),
			code: String(error?.code ?? error?.name ?? 'unknown'),
			// Bounded: an EACCES message can carry a long path, and this is read by
			// a probe on every panel refresh.
			message: String(error?.message ?? error).slice(0, 300),
			count: usageWriteFailureCount,
		};
		return { ok: false, code: lastUsageWriteFailure.code };
	}
}

/**
 * Archive directory for compacted shards. Old months are downsampled here: the
 * raw `recall` rows in a closed month are folded into per-(href, day) counts,
 * while read/correction/positive rows are kept verbatim (they are rare, and each
 * one carries a judgement).
 */
export function usageArchiveDir(root) {
	return path.join(usageShardDir(root), 'archive');
}

export function usageArchivePath(root, month) {
	return path.join(usageArchiveDir(root), `${month}.jsonl`);
}

// ---------------------------------------------------------------------------
// Rename-first compaction of closed monthly shards (opt-in primitive).
//
// This block is deliberately self-contained: it only touches compactUsage and
// the small private helpers immediately below it. Nothing here enables cleanup
// in production — callers must pass { enabled: true } explicitly.
// ---------------------------------------------------------------------------

/** Bounds shared with scanUsage's SCAN_LIMITS (single source of truth by value). */
const COMPACT_LIMITS = Object.freeze({ maxBytes: 8 * 1024 * 1024, maxLines: 100000, maxLineBytes: 65536, maxExpanded: 100000 });
/** How long to watch a staged shard for a pre-rename handle still writing. */
const COMPACT_SETTLE_MS = 120;
/** Poll interval while watching a staged shard settle. */
const COMPACT_SETTLE_POLL_MS = 20;
/** Staging directory for moved-not-yet-archived shards, under `.usage/`. */
const COMPACT_STAGE_REL = path.join('.usage', '.stage');
const DAY_MS = 24 * 60 * 60 * 1000;

/** Structured, never-thrown outcome for one candidate month. */
function compactOutcome(status, detail = {}) {
	return { status, ok: false, ...detail };
}

/** True when `month` is a real YYYY-MM calendar month. */
function isValidMonth(month) {
	if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) return false;
	const parsed = new Date(`${month}-01T00:00:00.000Z`);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 7) === month;
}

/**
 * Bounded read of a regular file that refuses links, directories and swaps.
 * Mirrors the shape of scanUsage's reader: the post-read lstat catches a path
 * replaced by a link during the read; a size/mtime change is reported as
 * `settling` so the caller can re-read. Bad UTF-8 is rejected with fatal decode
 * (a U+FFFD replacement character is never allowed to leak into an archive).
 */
async function compactReadBounded(file) {
	let info;
	try {
		info = await lstat(file);
	} catch (error) {
		if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 'not_found' };
		return { status: 'read_failed', code: error?.code ?? 'unknown', reason: 'source_stat_failed' };
	}
	if (info.isSymbolicLink()) return { status: 'invalid_source', reason: 'symlink' };
	if (!info.isFile()) return { status: 'invalid_source', reason: 'not_regular_file' };
	if (info.size > COMPACT_LIMITS.maxBytes) return { status: 'read_failed', reason: 'too_large', bytes: info.size };
	let text;
	try {
		text = await readFile(file, 'utf8');
	} catch (error) {
		if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 'not_found' };
		return { status: 'read_failed', code: error?.code ?? 'unknown', reason: 'read_failed' };
	}
	if (text.includes('\ufffd')) return { status: 'invalid_source', reason: 'bad_utf8' };
	try {
		const again = await lstat(file);
		if (again.isSymbolicLink() || !again.isFile()) return { status: 'invalid_source', reason: 'changed_during_read' };
		if (again.size !== info.size || again.mtimeMs !== info.mtimeMs) {
			return { status: 'settling', text, bytes: again.size };
		}
	} catch (error) {
		if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 'not_found' };
		return { status: 'read_failed', code: error?.code ?? 'unknown', reason: 'source_stat_failed' };
	}
	return { status: 'ok', text, bytes: info.size };
}

/**
 * Wait for a moved shard to stop changing, then return a stable snapshot.
 * Two identical consecutive reads are treated as stable. The residual window
 * is real: a handle opened before the rename can still append to the staged
 * inode AFTER the settle observation, because Node cannot prove an inode has
 * no other open handles. It is bounded by COMPACT_SETTLE_MS, and — crucially —
 * the staged bytes are never destroyed: they are archived as `.dropped`, and
 * a fresh live shard created by a post-rename appender is merged below.
 */
async function compactSettleStaged(file) {
	const deadline = Date.now() + COMPACT_SETTLE_MS;
	let previous = null;
	for (;;) {
		const read = await compactReadBounded(file);
		if (read.status !== 'ok' && read.status !== 'settling') return read;
		if (previous !== null && previous === read.bytes) return { status: 'ok', text: read.text, bytes: read.bytes };
		if (Date.now() >= deadline) return { status: 'settling', text: read.text, bytes: read.bytes };
		previous = read.bytes;
		await delay(COMPACT_SETTLE_POLL_MS);
	}
}

/**
 * Parse every line exactly as readUsage/scanUsage do: trim, skip blank lines,
 * JSON.parse, finite t, finite/absent n. Any bad row rejects the whole read —
 * nothing is silently dropped. Returns the exact trimmed JSON text of each row
 * (so verbatim judgment rows can be re-written byte-identically) plus its
 * parsed object and timestamp.
 */
function compactParseAll(text) {
	const rows = [];
	let bytes = 0;
	for (const raw of String(text ?? '').split('\n')) {
		const line = raw.trim();
		if (!line) continue;
		if (rows.length >= COMPACT_LIMITS.maxLines) return { ok: false, reason: 'line_limit' };
		const lineBytes = Buffer.byteLength(line, 'utf8');
		if (lineBytes > COMPACT_LIMITS.maxLineBytes) return { ok: false, reason: 'line_too_large' };
		bytes += lineBytes;
		if (bytes > COMPACT_LIMITS.maxBytes) return { ok: false, reason: 'byte_limit' };
		let entry;
		try { entry = JSON.parse(line); } catch { return { ok: false, reason: 'invalid_row' }; }
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, reason: 'invalid_row' };
		const t = Date.parse(entry.t);
		if (!Number.isFinite(t)) return { ok: false, reason: 'invalid_time' };
		if (entry.n !== undefined && (!Number.isSafeInteger(entry.n) || entry.n < 1)) return { ok: false, reason: 'invalid_count' };
		rows.push({ line, entry, t });
	}
	return { ok: true, rows };
}

/**
 * Downsample raw `recall` rows into per-(href, UTC day) counts, keep
 * read/correction/positive/lifecycle rows VERBATIM.
 *
 * Reader equivalence is PROVEN, not guessed: readUsage expands a compacted
 * recall row `n` times (usage.js readUsage:417-418), so the derived recall
 * counts are identical to the raw events. scanUsage does the same at
 * usage.js:587-589. Non-recall rows are carried byte-for-byte, which is what
 * object-trace / adoption-evidence / summarizeUsage read for verdicts.
 *
 * Rows with an unknown kind are kept verbatim as well — folding only recall
 * is safe because only recall carries the exposure-count semantics; anything
 * else must not be guessed at.
 */
function compactDownsample(rows) {
	const recalls = new Map();
	const kept = [];
	for (const row of rows) {
		if (row.entry.kind !== 'recall') {
			kept.push(row);
			continue;
		}
		const href = canonicalHref(row.entry.href);
		const day = new Date(row.t).toISOString().slice(0, 10);
		const key = `${day}\u0000${href}`;
		// A source row may already be pre-folded with `n` (readUsage/scanUsage
		// expand it), so the folded weight must include that count.
		const weight = Number.isSafeInteger(row.entry.n) && row.entry.n > 1 ? row.entry.n : 1;
		const hit = recalls.get(key);
		if (hit) {
			hit.entry.n += weight;
			// Earliest representative keeps the output deterministic.
			if (row.t < hit.t) hit.t = row.t;
		} else {
			recalls.set(key, { t: row.t, entry: { ...row.entry, href, n: weight } });
		}
	}
	for (const { t, entry } of recalls.values()) {
		// Keep the representative (earliest) timestamp verbatim, not a
		// normalized day boundary: traceObject and adoption-evidence report the
		// exact `t` of each matching row, so moving it would change their
		// results even though the derived day counts were identical. Folding
		// per (href, UTC day) with an `n` count still matches the design comment
		// at usage.js:215-219 and every count-based consumer.
		kept.push({ t, line: JSON.stringify(entry), entry });
	}
	// Deterministic order by timestamp, then by the exact line text so equal
	// timestamps keep a stable order across runs.
	kept.sort((a, b) => a.t - b.t || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
	return kept;
}

/** Serialize trimmed JSONL rows with a trailing newline, no BOM. */
function compactSerialize(rows) {
	return rows.length === 0 ? '' : `${rows.map((r) => r.line).join('\n')}\n`;
}

/**
 * Compare the derived numbers a compacted month must preserve: per-href
 * recall/read/correction/positive/lifecycle counts and the exact verdict
 * bytes. Recall rows may be downsampled, but their per-(href, day) totals
 * must be identical; every judgment row must be byte-identical.
 */
function compactSignature(rows) {
	const sig = new Map();
	const verdicts = [];
	for (const row of rows) {
		const href = canonicalHref(row.entry.href);
		const key = `${href}\u0000${row.entry.kind ?? ''}\u0000${new Date(row.t).toISOString().slice(0, 10)}`;
		const n = row.entry.kind === 'recall' ? (row.entry.n ?? 1) : 1;
		sig.set(key, (sig.get(key) ?? 0) + n);
		if (row.entry.kind === 'correction' || row.entry.kind === 'positive') {
			// Compare by content, not raw JSON text: readUsage re-stringifies
			// rows with a canonical key order. Byte-identity of the archived
			// row is preserved separately by compactParseAll keeping `line`.
			verdicts.push(JSON.stringify({ t: row.entry.t, kind: row.entry.kind,
				href: href, objectKey: row.entry.objectKey ?? '', note: row.entry.note ?? '' }));
		}
	}
	verdicts.sort();
	return JSON.stringify({ counts: [...sig.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)), verdicts });
}

/** Absolute path of a staged shard for one month. */
function compactStagePath(root, month, suffix, id) {
	return path.join(root, ...COMPACT_STAGE_REL.split(path.sep), `${month}.${id}.${suffix}`);
}

/**
 * Publish one archive EXCLUSIVELY. On Windows `fs.rename` overwrites an
 * existing destination (verified locally), so rename cannot provide EEXIST
 * semantics there. A hard link into the archive dir is atomic, same-device,
 * and fails with EEXIST when the target already exists; the temp source is
 * unlinked afterwards (the bytes stay at the archive path). Non-EEXIST
 * errors (notably EXDEV) are returned unchanged.
 */
async function compactPublishArchive(temp, archive) {
	try {
		await link(temp, archive);
	} catch (error) {
		return { status: 'write_failed', code: error?.code ?? 'unknown' };
	}
	try {
		await unlink(temp);
	} catch (error) {
		// The archive is already published; a leftover temp is a duplicate of
		// the same bytes. Keep it rather than guessing which path is canonical.
		return { status: 'ok', tempLeftover: true, code: error?.code ?? 'unknown' };
	}
	return { status: 'ok', tempLeftover: false };
}

/**
 * SAFE rename-first compaction of closed monthly shards. A primitive, NOT a
 * trigger: production callers get the disabled result unless they explicitly
 * pass { enabled: true }. Nothing is deleted — the original bytes are renamed
 * to a `.dropped` quarantine file under `.usage/.stage/` after verification.
 *
 * Protocol per candidate: validate source (no links, bounded) -> parse ALL
 * rows (any bad row skips the month) -> downsample -> rename source to a
 * same-filesystem `.moved` staging path -> settle-read -> detect a post-rename
 * fresh live shard and merge its rows -> write the archive exclusively ->
 * verify through the SAME production readers (readUsage / scanUsage /
 * usageFiles) -> only then rename staging to `.dropped`.
 *
 * @param {string} root Memory root.
 * @param {object} [options]
 * @param {boolean} [options.enabled=false] Must be exactly true to do work.
 * @param {number} [options.olderThanDays=90] Window in days.
 * @param {number} [options.now=Date.now()] Reference time, epoch ms.
 * @returns {Promise<object>} Structured stats; never throws for expected I/O.
 */
export async function compactUsage(root, { enabled = false, olderThanDays = 90, now = Date.now() } = {}) {
	const stats = { compacted: [], skipped: [], rawRows: 0, keptRows: 0 };
	if (enabled !== true) {
		return { ...stats, disabled: true,
			reason: 'unsafe-concurrent-source-and-incomplete-archive-readers',
			skipped: await compactCandidateMonths(root, now) };
	}
	if (typeof root !== 'string' || !root.trim() || !Number.isFinite(now) || now < 0
		|| !Number.isFinite(olderThanDays) || olderThanDays <= 0) {
		return { ...stats, enabled: true, disabled: false, skipped: [{ month: '', reason: 'invalid_input' }] };
	}
	// Match readUsage/scanUsage exactly: the cutoff month is the UTC month of
	// (now - days). A month qualifies only when it is STRICTLY older than that
	// month, is a closed month, and is not the current UTC month. This is what
	// keeps a 90-day window from compacting a month that still has in-window
	// rows.
	const cutoff = now - olderThanDays * DAY_MS;
	const cutoffDate = new Date(cutoff);
	const cutoffMonth = `${cutoffDate.getUTCFullYear()}-${String(cutoffDate.getUTCMonth() + 1).padStart(2, '0')}`;
	const current = new Date(now);
	const currentMonth = `${current.getUTCFullYear()}-${String(current.getUTCMonth() + 1).padStart(2, '0')}`;
	let candidates;
	try {
		candidates = await compactCandidateMonths(root, now);
	} catch (error) {
		return { enabled: true, disabled: false, compacted: [], skipped: [{ month: '', reason: 'enumeration_failed',
			code: error?.code ?? 'unknown' }], manualReconcile: [], rawRows: 0, keptRows: 0 };
	}
	const result = { enabled: true, disabled: false, compacted: [], skipped: [], manualReconcile: [], rawRows: 0, keptRows: 0 };
	for (const month of candidates) {
		if (!isValidMonth(month) || month >= cutoffMonth || month === currentMonth) {
			result.skipped.push({ month, reason: 'outside_window' });
			continue;
		}
		const one = await compactOneMonth(root, month);
		if (one.status === 'compacted') {
			result.compacted.push(one.detail);
			result.rawRows += one.detail.rawRows;
			result.keptRows += one.detail.keptRows;
		} else if (one.status === 'manual_reconcile_required') {
			result.manualReconcile.push({ month, ...one });
		} else {
			result.skipped.push({ month, reason: one.reason ?? one.status, ...(one.code ? { code: one.code } : {}) });
		}
	}
	return result;
}

/** Enumerate live shard months exactly as the disabled path did (sorted). */
async function compactCandidateMonths(root, now) {
	void now;
	try {
		return (await readdir(usageShardDir(root)))
			.filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name))
			.sort().map((name) => name.slice(0, 7));
	} catch (error) {
		// Match the original disabled path exactly: only ENOENT is an absent
		// directory. ENOTDIR (e.g. a file where `.usage/` should be) must still
		// propagate, so an unreadable ledger is never reported as "no sources".
		if (error?.code !== 'ENOENT') throw error;
		return [];
	}
}

/** Compact exactly one candidate month; never throws for expected I/O. */
async function compactOneMonth(root, month) {
	const source = path.join(usageShardDir(root), `${month}.jsonl`);
	const archive = usageArchivePath(root, month);
	const stageDir = path.join(root, ...COMPACT_STAGE_REL.split(path.sep));
	const id = randomUUID();

	// Step 1: an existing archive is an immediate hard skip — never overwrite.
	try {
		const info = await lstat(archive);
		if (info.isSymbolicLink() || !info.isFile()) return compactOutcome('skipped', { reason: 'archive_not_regular' });
		return compactOutcome('skipped', { reason: 'archive_exists' });
	} catch (error) {
		if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
			return compactOutcome('skipped', { reason: 'archive_stat_failed', code: error?.code ?? 'unknown' });
		}
	}

	// Step 2: validate and read the live source. Symlink/junction/non-file and
	// every bad row skip the month with the source byte-identical.
	const first = await compactReadBounded(source);
	if (first.status === 'not_found') return compactOutcome('skipped', { reason: 'source_not_found' });
	if (first.status === 'invalid_source') return compactOutcome('skipped', { reason: first.reason });
	if (first.status !== 'ok') return compactOutcome('skipped', { reason: first.reason ?? first.status, ...(first.code ? { code: first.code } : {}) });
	const parsed = compactParseAll(first.text);
	if (!parsed.ok) return compactOutcome('skipped', { reason: `source_${parsed.reason}` });
	// Every row must belong to the candidate month; a misplaced row means the
	// shard name and its contents disagree, which we will not guess about.
	for (const row of parsed.rows) {
		if (new Date(row.t).toISOString().slice(0, 7) !== month) {
			return compactOutcome('skipped', { reason: 'row_outside_month' });
		}
	}
	const beforeSig = compactSignature(parsed.rows);
	const rawRows = parsed.rows.length;

	// Step 3: prepare staging on the SAME filesystem as the source.
	try {
		await mkdir(stageDir, { recursive: true });
	} catch (error) {
		return compactOutcome('skipped', { reason: 'staging_dir_create_failed', code: error?.code ?? 'unknown' });
	}
	const moved = compactStagePath(root, month, 'moved', id);
	try {
		await rename(source, moved);
	} catch (error) {
		if (error?.code === 'EXDEV') return compactOutcome('skipped', { reason: 'cross_device_rename', code: 'EXDEV' });
		// A failed rename may still have moved the entry (lost acknowledgement).
		let stillThere = false;
		try { stillThere = (await lstat(source)).isFile(); } catch { stillThere = false; }
		if (stillThere) return compactOutcome('skipped', { reason: 'rename_failed', code: error?.code ?? 'unknown' });
		return compactOutcome('manual_reconcile_required', { reason: 'rename_outcome_unknown', code: error?.code ?? 'unknown', staged: moved });
	}

	// Step 4: settle-read the staged bytes; re-read once if they changed.
	let settled = await compactSettleStaged(moved);
	if (settled.status === 'settling') {
		const retry = await compactSettleStaged(moved);
		if (retry.status !== 'ok') return compactOutcome('manual_reconcile_required', { reason: 'staged_never_settled', staged: moved });
		settled = retry;
	} else if (settled.status !== 'ok') {
		return compactOutcome('manual_reconcile_required', { reason: settled.reason ?? 'staged_read_failed', staged: moved });
	}
	const stagedParsed = compactParseAll(settled.text);
	if (!stagedParsed.ok) return compactOutcome('manual_reconcile_required', { reason: `staged_${stagedParsed.reason}`, staged: moved });
	// The settled staged bytes are authoritative for what was moved. If a
	// pre-rename handle appended, its row is here; re-check the signature
	// against the source snapshot plus any new rows.
	let rows = stagedParsed.rows;
	for (const row of rows) {
		if (new Date(row.t).toISOString().slice(0, 7) !== month) {
			return compactOutcome('manual_reconcile_required', { reason: 'staged_row_outside_month', staged: moved });
		}
	}

	// Step 5: detect a post-rename appender. It opens the old path after the
	// rename and creates a FRESH live shard; those rows must also be folded in.
	let extraRows = [];
	try {
		const concurrent = await compactReadBounded(source);
		if (concurrent.status === 'not_found') {
			// No fresh shard: nothing to merge.
		} else if (concurrent.status !== 'ok') {
			return compactOutcome('manual_reconcile_required', { reason: `concurrent_${concurrent.reason ?? concurrent.status}`, staged: moved });
		} else {
			const concurrentParsed = compactParseAll(concurrent.text);
			if (!concurrentParsed.ok) {
				return compactOutcome('manual_reconcile_required', { reason: `concurrent_${concurrentParsed.reason}`, staged: moved });
			}
			for (const row of concurrentParsed.rows) {
				if (new Date(row.t).toISOString().slice(0, 7) !== month) {
					return compactOutcome('manual_reconcile_required', { reason: 'concurrent_row_outside_month', staged: moved });
				}
			}
			extraRows = concurrentParsed.rows;
		}
	} catch (error) {
		return compactOutcome('manual_reconcile_required', { reason: 'concurrent_read_failed', code: error?.code ?? 'unknown', staged: moved });
	}

	// Step 6: fold staged + post-rename rows, downsample, and write the
	// archive exclusively. The original rows are still in staging, untouched.
	const combined = compactDownsample([...rows, ...extraRows]);
	const archiveBody = compactSerialize(combined);
	try {
		await mkdir(usageArchiveDir(root), { recursive: true });
	} catch (error) {
		return compactOutcome('manual_reconcile_required', { reason: 'archive_dir_create_failed', code: error?.code ?? 'unknown', staged: moved });
	}
	const temp = path.join(usageArchiveDir(root), `${month}.${id}.tmp`);
	try {
		await writeFile(temp, archiveBody, { encoding: 'utf8', flag: 'wx' });
	} catch (error) {
		return compactOutcome('skipped', { reason: 'archive_temp_write_failed', code: error?.code ?? 'unknown', staged: moved });
	}
	const published = await compactPublishArchive(temp, archive);
	if (published.status !== 'ok') {
		try { await unlink(temp); } catch { /* best effort */ }
		if (published.code === 'EEXIST') return compactOutcome('skipped', { reason: 'archive_exists_concurrent', staged: moved });
		return compactOutcome('manual_reconcile_required', { reason: 'archive_publish_failed', code: published.code, staged: moved });
	}

	// Step 7: verify through the SAME functions production readers use.
	// readUsage expands a compacted recall `n` back into n events (usage.js:417),
	// and scanUsage does the same (usage.js:587), so both must report the same
	// derived per-(href, kind, day) counts as the pre-compaction source. A
	// tailored `now` is forced into scanUsage so the old month is inside its
	// window; readUsage uses Date.now() internally, so a window large enough to
	// cover the month's start is passed instead.
	const monthStart = Date.parse(`${month}-01T00:00:00.000Z`);
	const monthEndExclusive = Date.parse(`${month}-01T00:00:00.000Z`) + 32 * DAY_MS;
	const verifyWindowDays = Math.max(1, Math.ceil((Date.now() - monthStart) / DAY_MS) + 2);
	let verifyUsage, verifyScan, verifyFiles;
	try {
		verifyUsage = await readUsage(root, verifyWindowDays);
		verifyScan = await scanUsage(root, { days: verifyWindowDays, now: Date.now() });
		verifyFiles = await usageFiles(root);
	} catch (error) {
		return compactOutcome('manual_reconcile_required', { reason: 'verify_reader_failed', code: error?.code ?? 'unknown', staged: moved });
	}
	// usageFiles must enumerate the archive and must not see an unfurled
	// same-month live shard (that throws USAGE_AMBIGUOUS_MONTH).
	if (!verifyFiles.some((f) => f.source === 'archive' && f.month === month)) {
		return compactOutcome('manual_reconcile_required', { reason: 'verify_archive_not_enumerated', staged: moved });
	}
	// Expand readUsage's compacted rows back to individual events for this
	// month and compare the derived signature against the source snapshot.
	const expanded = [];
	for (const e of verifyUsage) {
		const ms = Date.parse(e.t);
		if (!Number.isFinite(ms) || ms < monthStart || ms >= monthEndExclusive) continue;
		// readUsage has ALREADY expanded a compacted `n` into n separate
		// entries, so each `e` here is one event. Strip `n` so compactSignature
		// does not multiply it a second time.
		const one = { ...e };
		delete one.n;
		expanded.push({ line: JSON.stringify(one), entry: one, t: ms });
	}
	// Verbatim rows: readUsage spreads the original object, so its JSON may
	// reorder keys; compare the judgment rows by their content fields instead
	// of raw bytes here. Byte-identity of the archived judgment rows was already
	// guaranteed by compactParseAll preserving `row.line` verbatim.
	const afterSig = compactSignature(expanded);
	if (afterSig !== beforeSig) {
		return compactOutcome('manual_reconcile_required', { reason: 'verify_signature_mismatch', staged: moved,
			beforeSig, afterSig });
	}
	// scanUsage must be complete with no invalid rows anywhere in the ledger.
	if (verifyScan.scanStatus === 'unknown' || verifyScan.invalidRows > 0) {
		return compactOutcome('manual_reconcile_required', { reason: 'verify_scan_incomplete', staged: moved, scanStatus: verifyScan.scanStatus });
	}

	// Step 8: verified — archive the ORIGINAL bytes. Rename, never unlink.
	const dropped = compactStagePath(root, month, 'dropped', id);
	try {
		await rename(moved, dropped);
	} catch (error) {
		return compactOutcome('manual_reconcile_required', { reason: 'staged_archive_failed', code: error?.code ?? 'unknown', staged: moved });
	}
	return compactOutcome('compacted', {
		detail: {
			month, rawRows, keptRows: combined.length, droppedArchive: dropped,
			archive, staged: moved, archivedBytes: Buffer.byteLength(archiveBody, 'utf8'),
			mergedPostRenameRows: extraRows.length,
		},
	});
}

/** Hard bound on the number of sources one enumeration may return. */
export const USAGE_FILES_MAX = 64;

/**
 * Fail-closed enumeration error. `code` is stable so whole-ledger readers can
 * map an unsafe enumeration to their own `incomplete` status with a reason that
 * does not depend on error messages.
 */
function usageFilesError(code, message, cause) {
	return usageReadError(code, message, cause);
}

/**
 * Enumerate directory entries by name without following symlinks/junctions and
 * without trusting a racing rename between lstat and the caller's open. A link
 * (or any non-directory) at the directory itself is refused, and a dangling
 * link is never treated as an absent directory.
 */
async function listLedgerDir(dir) {
	let info;
	try { info = await lstat(dir); }
	catch (error) {
		if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
		// An absent directory is an empty source list, but only once its absence
		// is confirmed through every ancestor. A dangling link is never absence.
		try { await confirmMissingDirectory(dir, error); } catch (confirmation) {
			throw usageFilesError('USAGE_DIR_STATE_UNKNOWN', 'Cannot confirm ledger directory is absent', confirmation);
		}
		// Still attempt readdir: a fault injector (or a racing creator) must be
		// observable here instead of being hidden behind the lstat result.
		try { await fsp.readdir(dir); } catch (listed) {
			if (listed?.code !== 'ENOENT' && listed?.code !== 'ENOTDIR') throw listed;
		}
		return [];
	}
	if (info.isSymbolicLink()) {
		throw usageFilesError('USAGE_LINK_NOT_ALLOWED', 'Ledger directory is a link');
	}
	if (!info.isDirectory()) {
		// Preserve the historic ENOTDIR contract: an obstruction at .usage/ or
		// .usage/archive/ is a hard error, never "no sources".
		const error = new Error('Ledger directory path is not a directory');
		error.code = 'ENOTDIR';
		throw error;
	}
	// Use the default-export object (not a named import) so fault injectors that
	// patch fs.promises.readdir are observed here too. Permission/IO errors are
	// rethrown unchanged: health rules key on the raw OS code (EACCES/EIO) to
	// report an incomplete check, so it must not be hidden behind a wrapper code.
	const entries = await fsp.readdir(dir, { withFileTypes: true });
	if (entries.length > USAGE_FILES_MAX * 4) {
		throw usageFilesError('USAGE_ENUMERATION_LIMIT', 'Ledger directory enumeration limit exceeded');
	}
	const names = [];
	for (const entry of entries) {
		if (!/^\d{4}-\d{2}\.jsonl$/.test(entry.name)) continue;
		// Dirent flags are advisory; lstat each selected name so a symlink is
		// rejected even on filesystems where dirent type is UNKNOWN.
		const target = path.join(dir, entry.name);
		const entryInfo = await lstat(target);
		if (entryInfo.isSymbolicLink() || !entryInfo.isFile()) {
			throw usageFilesError('USAGE_LINK_NOT_ALLOWED', 'Ledger source is a link or not a regular file');
		}
		names.push(entry.name);
	}
	return names.sort();
}

/**
 * Every ledger file to read, oldest first: the legacy `.usage.jsonl`, then the
 * live `.usage/YYYY-MM.jsonl` shards, then compacted `.usage/archive/YYYY-MM.jsonl`
 * months (ascending within each group). Reading ALL THREE is what makes both the
 * sharding and the compaction format changes safe — an old root has only the
 * legacy file, a newer one may have live shards, and a compacted one may have
 * archives; no window may silently see a gap.
 *
 * Each descriptor carries an additive `source` field ('legacy' | 'live' |
 * 'archive') alongside the original `file` and `month`, so existing consumers
 * that only read `{ file, name? }` keep working. `name` is retained on the
 * legacy path only where callers need it; the new `source` is authoritative.
 *
 * A month present in BOTH `.usage/` and `.usage/archive/` is ambiguous: during
 * a migration the same rows could exist in both places, and silently choosing
 * one would either double-count or drop evidence. We refuse to pick — a
 * `USAGE_AMBIGUOUS_MONTH` error is thrown so every whole-ledger reader fails
 * closed instead of returning a partial trace.
 */
export async function usageFiles(root) {
	const files = [];
	const legacy = usagePath(root);
	let info;
	try {
		info = await lstat(legacy, { bigint: true });
	} catch (error) {
		if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
		try { await confirmMissingDirectory(legacy, error); }
		catch (cause) { throw usageFilesError('MEMORY_READ_STATE_UNKNOWN', 'Cannot confirm legacy usage source is absent', cause); }
	}
	if (info) {
		if (info.isSymbolicLink() || !info.isFile()) {
			throw usageFilesError('USAGE_LINK_NOT_ALLOWED', 'Legacy usage source is a link or not a regular file');
		}
		const changed = () => usageFilesError('USAGE_SOURCE_CHANGED', 'Legacy usage source changed during enumeration');
		const sameIdentity = (a, b) => a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink()
			&& a.ino !== 0n && a.dev === b.dev && a.ino === b.ino
			&& a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
		let handle;
		try {
			// O_NOFOLLOW is unavailable on Windows; compare path and handle identity there.
			const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
			try { handle = await open(legacy, flags); }
			catch (error) {
				if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'ELOOP') throw changed();
				throw error;
			}
			const opened = await handle.stat({ bigint: true });
			let after;
			try { after = await lstat(legacy, { bigint: true }); }
			catch (error) {
				if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw changed();
				throw error;
			}
			if (!sameIdentity(info, opened) || !sameIdentity(opened, after)) throw changed();
		} finally {
			if (handle) await handle.close();
		}
		files.push({ file: legacy, name: 'legacy', source: 'legacy', month: '' });
	}

	const liveDir = usageShardDir(root);
	const archiveDir = usageArchiveDir(root);
	const [liveNames, archiveNames] = await Promise.all([
		listLedgerDir(liveDir),
		listLedgerDir(archiveDir),
	]);
	const liveMonths = new Map(liveNames.map((n) => [n.slice(0, 7), n]));
	const archiveMonths = new Map(archiveNames.map((n) => [n.slice(0, 7), n]));
	for (const month of liveMonths.keys()) {
		if (archiveMonths.has(month)) {
			throw usageFilesError('USAGE_AMBIGUOUS_MONTH',
				`Usage month ${month} exists in both .usage/ and .usage/archive/`);
		}
	}
	for (const [month, name] of liveMonths) {
		files.push({ file: path.join(liveDir, name), name: 'live', source: 'live', month });
	}
	for (const [month, name] of archiveMonths) {
		files.push({ file: path.join(archiveDir, name), name: 'archive', source: 'archive', month });
	}
	if (files.length > USAGE_FILES_MAX) {
		throw usageFilesError('USAGE_FILE_LIMIT', 'Usage ledger source count limit exceeded');
	}
	return files;
}

function usageCutoff(days, now) {
	const ms = now - days * 24 * 60 * 60 * 1000;
	const date = new Date(ms);
	return { ms, month: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}` };
}

function* usageRows(text) {
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		let entry = null;
		try { entry = JSON.parse(line); } catch { /* count the physical row even when it is corrupt */ }
		yield entry;
	}
}

function appendRecentUsage(out, entry, cutoff) {
	try {
		const ms = Date.parse(entry?.t);
		if (!Number.isFinite(ms) || ms < cutoff) return;
		const href = canonicalHref(entry.href);
		// Compaction stores repeated recall exposures in a single physical row.
		const count = Number.isSafeInteger(entry.n) && entry.n > 1 ? entry.n : 1;
		for (let i = 0; i < count; i++) out.push({ ...entry, href, ms });
	} catch {
		/* skip corrupt entries */
	}
}

/** Read entries within the window, skipping older monthly shards before opening them. */
export async function readUsage(root, days = 30) {
	const cutoff = usageCutoff(days, Date.now());
	const out = [];
	for (const { file, month } of await usageFiles(root)) {
		if (month && month < cutoff.month) continue;
		const text = await readFile(file, 'utf8');
		for (const entry of usageRows(text)) appendRecentUsage(out, entry, cutoff.ms);
	}
	return out;
}

/** Share ledger observations within a health check or overview sample. */
export function createUsageSnapshot(root) {
	const now = Date.now();
	const oldest = usageCutoff(30, now);
	let files;
	let history;
	let monthlySummary;
	const sources = () => files ??= usageFiles(root);
	const observations = new Map();
	async function readSource(descriptor) {
		const { file, month, source } = descriptor;
		if (!observations.has(file)) {
			const read = readFile(file, 'utf8').then((text) => {
				const summary = { file: path.basename(file), rows: 0, live: source === 'live' };
				const entries = [];
				const hrefs = new Set();
				let recallEvents = 0, readEvents = 0, verdictEvents = 0;
				const recent = !month || month >= oldest.month;
				for (const entry of usageRows(text)) {
					summary.rows++;
					if (entry?.kind === 'recall') recallEvents++;
					else if (entry?.kind === 'read') readEvents++;
					else if (entry?.kind === 'positive' || entry?.kind === 'correction') verdictEvents++;
					if (entry?.href) {
						try { hrefs.add(canonicalHref(entry.href)); } catch { /* skip invalid targets */ }
					}
					if (recent) appendRecentUsage(entries, entry, oldest.ms);
				}
				return { summary, entries, hrefs, recallEvents, readEvents, verdictEvents };
			});
			observations.set(file, read);
		}
		return observations.get(file);
	}
	async function gatherHistory() {
		const result = { sources: [], hrefs: new Set(), signalCount: 0, liveRows: 0, recallEvents: 0, readEvents: 0, verdictEvents: 0 };
		for (const descriptor of await sources()) {
			const { summary, hrefs, recallEvents, readEvents, verdictEvents } = await readSource(descriptor);
			result.sources.push(summary);
			result.signalCount += summary.rows;
			if (summary.live) result.liveRows += summary.rows;
			result.recallEvents += recallEvents;
			result.readEvents += readEvents;
			result.verdictEvents += verdictEvents;
			for (const href of hrefs) result.hrefs.add(href);
		}
		return result;
	}
	async function recent(cutoff) {
		const entries = [];
		for (const descriptor of await sources()) {
			if (descriptor.month && descriptor.month < cutoff.month) continue;
			for (const entry of (await readSource(descriptor)).entries) {
				if (entry.ms >= cutoff.ms) entries.push(entry);
			}
		}
		return entries;
	}
	return {
		recentWeek: () => recent(usageCutoff(7, now)),
		summarizeMonth: () => monthlySummary ??= recent(oldest).then(summarizeUsage),
		history: () => history ??= gatherHistory(),
	};
}

/**
 * Aggregate usage per target and suggest a layer (实验 / 专项 / 通用).
 *
 * SELF-REFERENCE FIX (2026-10-27): `recall` is the plugin's OWN action, not the
 * user's. Counting it as a "use" put the same fact on both sides of every
 * derived ratio — recall inflated the denominator of badRate (so a genuinely
 * corrected memory looked fine), inflated the numerator of `uses` (so the same
 * hot rows won the RRF ranking, were recalled more, and grew hotter), and
 * satisfied the skill-nomination use floor. Measured on a real root: 627 of 667
 * ledger lines were self-produced recalls; the one area with BOTH corrections
 * reported a 1% correction rate that its engagement rate says is 29%.
 *
 * So the fields are now split by WHO produced them:
 *   exposure  = recalls + reads   — how often the memory was PUT in front of the
 *                                   model (demand created by the plugin)
 *   engage    = reads + verdicts  — the model actually touched it
 *   uses      = engage            — the ONLY thing layer suggestions / heat /
 *                                   nomination may use (kept under the old name
 *                                   so every consumer reads the honest number)
 *   badRate   = corrections / (reads + corrections) — denominator EXCLUDES the
 *                                   plugin's own recall, so recall can no longer
 *                                   dilute a real correction rate
 */
const SCAN_LIMITS = Object.freeze({ maxFiles: 64, maxBytes: 8 * 1024 * 1024, maxLines: 100000, maxExpanded: 100000, maxLineBytes: 65536 });

// Path checks are cooperative best effort; they cannot make a later open atomic.
async function checkScanPath(root, canonicalRoot, target, directory) {
	const relative = path.relative(root, target);
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('outside_root');
	let current = root;
	const parts = relative.split(path.sep);
	for (let i = 0; i < parts.length; i++) {
		current = path.join(current, parts[i]);
		const info = await lstat(current);
		if (info.isSymbolicLink()) throw new Error('link_not_allowed');
		if (i < parts.length - 1 || directory) {
			if (!info.isDirectory()) throw new Error('not_directory');
		} else if (!info.isFile()) throw new Error('not_file');
	}
	const resolved = await realpath(target);
	const scoped = path.relative(canonicalRoot, resolved);
	if (!scoped || scoped === '..' || scoped.startsWith(`..${path.sep}`) || path.isAbsolute(scoped)) throw new Error('outside_root');
}

/** Scan a bounded best-effort observation without asserting a cross-file snapshot. */
export async function scanUsage(root, options = {}) {
	if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0') || !options || typeof options !== 'object') {
		throw new TypeError('Invalid usage scan input');
	}
	const limits = {};
	for (const [name, hard] of Object.entries(SCAN_LIMITS)) {
		const value = options[name] ?? hard;
		if (!Number.isSafeInteger(value) || value < 1 || value > hard) throw new RangeError(`Invalid ${name}`);
		limits[name] = value;
	}
	const days = options.days ?? 30;
	const now = options.now ?? Date.now();
	if (typeof days !== 'number' || !Number.isFinite(days) || days < 0 || typeof now !== 'number' || !Number.isFinite(now)) {
		throw new RangeError('Invalid usage scan time');
	}
	const cutoff = now - days * 86400000;
	const cutoffDate = new Date(cutoff);
	if (!Number.isFinite(cutoffDate.getTime())) throw new RangeError('Invalid usage scan cutoff');
	const cutoffMonth = `${cutoffDate.getUTCFullYear()}-${String(cutoffDate.getUTCMonth() + 1).padStart(2, '0')}`;
	const result = { entries: [], scanStatus: 'complete', invalidRows: 0, invalidRowsLowerBound: false,
		sources: [], snapshot: 'unknown', logicalCompleteness: 'unknown', reasons: [],
		scope: { cutoff: new Date(cutoff).toISOString(), monthPruning: true, selectedEncodings: ['jsonl'] } };
	let bytes = 0, lines = 0, fileCount = 0;
	const unknown = (reason) => { result.scanStatus = 'unknown'; result.invalidRowsLowerBound = true; if (!result.reasons.includes(reason)) result.reasons.push(reason); };
	const incomplete = (reason) => { if (result.scanStatus === 'complete') result.scanStatus = 'incomplete'; if (!result.reasons.includes(reason)) result.reasons.push(reason); };
	const invalid = (reason) => { result.invalidRows++; incomplete(reason); };
	const files = [];
	const months = { '.usage': new Set(), '.usage/archive': new Set() };
	root = path.resolve(root);
	let canonicalRoot;
	try {
		const rootStat = await lstat(root);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('root_unavailable');
		canonicalRoot = await realpath(root);
	} catch { unknown('root_unavailable'); return result; }
	try {
		const legacy = usagePath(root);
		try {
			const info = await lstat(legacy);
			if (!info.isFile() || info.isSymbolicLink()) unknown('legacy_unavailable');
			else files.push({ file: legacy, name: '.usage.jsonl' });
		} catch (error) {
			if (error?.code !== 'ENOENT') unknown('legacy_unavailable');
		}
		for (const [dir, prefix] of [[usageShardDir(root), '.usage'], [usageArchiveDir(root), '.usage/archive']]) {
			const names = [];
			try {
				await checkScanPath(root, canonicalRoot, dir, true);
				const listing = await opendir(dir);
				let seen = 0;
				for await (const entry of listing) {
					if (++seen > limits.maxFiles * 4) { unknown('enumeration_limit'); break; }
					const name = entry.name;
					if (/^\d{4}-\d{2}\.jsonl$/.test(name) && name.slice(0, 7) >= cutoffMonth) names.push(name);
				}
			} catch (error) {
				if (error?.code === 'ENOENT') {
					try { await confirmMissingDirectory(dir, error); } catch { unknown('directory_unavailable'); }
				} else unknown('directory_unavailable');
				continue;
			}
			for (const name of names.sort()) {
				months[prefix].add(name.slice(0, 7));
				files.push({ file: path.join(dir, name), name: `${prefix}/${name}` });
			}
		}
		for (const month of months['.usage']) {
			if (months['.usage/archive'].has(month)) incomplete('conflicting_sources');
		}
	} catch { unknown('enumeration_failed'); }
	for (const item of files) {
		if (++fileCount > limits.maxFiles) { unknown('file_limit'); break; }
		const source = { name: item.name, status: 'complete', bytes: 0, lines: 0, invalidRows: 0 };
		result.sources.push(source);
		let handle;
		try {
			await checkScanPath(root, canonicalRoot, item.file, false);
			handle = await open(item.file, 'r');
			const before = await handle.stat();
			if (!before.isFile()) throw new Error('not_file');
			if (before.size > limits.maxBytes - bytes) { source.status = 'unknown'; unknown('byte_limit'); continue; }
			const buffer = Buffer.alloc(before.size + 1);
			let count = 0;
			while (count < buffer.length) {
				const read = await handle.read(buffer, count, buffer.length - count, count);
				if (!read.bytesRead) break;
				count += read.bytesRead;
			}
			const after = await handle.stat();
			if (count !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
				source.status = 'unknown'; unknown('source_changed'); continue;
			}
			bytes += count; source.bytes = count;
			let start = 0;
			while (start < count) {
				if (lines >= limits.maxLines) { source.status = 'unknown'; unknown('line_limit'); break; }
				const end = buffer.indexOf(10, start);
				if (end < 0 || end >= count) { invalid('truncated_tail'); result.invalidRowsLowerBound = true; source.invalidRows++; source.status = 'incomplete'; break; }
				const line = buffer.subarray(start, end); start = end + 1; lines++; source.lines++;
				if (line.length > limits.maxLineBytes) { invalid('line_too_large'); source.invalidRows++; source.status = 'incomplete'; continue; }
				let text;
				try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line); }
				catch { invalid('invalid_utf8'); source.invalidRows++; source.status = 'incomplete'; continue; }
				if (source.lines === 1 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
				if (!text.trim()) continue;
				let entry;
				try { entry = JSON.parse(text); } catch { invalid('invalid_row'); source.invalidRows++; source.status = 'incomplete'; continue; }
				const time = entry && typeof entry === 'object' && !Array.isArray(entry) ? Date.parse(entry.t) : NaN;
				if (!Number.isFinite(time)) { invalid('invalid_time'); source.invalidRows++; source.status = 'incomplete'; continue; }
				if (time < cutoff) continue;
				if (entry.n !== undefined && (!Number.isSafeInteger(entry.n) || entry.n < 1)) {
					invalid('invalid_count'); source.invalidRows++; source.status = 'incomplete'; continue;
				}
				const n = entry.n ?? 1;
				if (n > limits.maxExpanded - result.entries.length) { source.status = 'unknown'; unknown('expanded_limit'); break; }
				for (let i = 0; i < n; i++) result.entries.push({ ...entry, href: canonicalHref(entry.href), ms: time });
			}
		} catch { source.status = 'unknown'; unknown('source_unavailable'); }
		finally { if (handle) { try { await handle.close(); } catch { source.status = 'unknown'; unknown('source_unavailable'); } } }
	}
	return result;
}

export function summarizeUsage(entries) {
	const map = new Map();
	// Keep the correction/positive order per href so a flip (positive -> correction
	// or the other way round) can be counted: a memory that keeps being confirmed
	// and then overturned is not the same as one that is simply used.
	const verdicts = new Map();
	for (const e of entries) {
		const href = String(e.href ?? '').trim();
		if (!href) continue;
		const cur = map.get(href) ?? { href, recalls: 0, reads: 0, corrections: 0, positives: 0, lifecycle: 0, last: 0 };
		if (e.kind === 'recall') cur.recalls++;
		else if (e.kind === 'read') cur.reads++;
		else if (e.kind === 'correction') cur.corrections++;
		else if (e.kind === 'positive') cur.positives++;
		// Lifecycle stamps (crystallize/activate/retire) belong to the LEDGER, not
		// to the skill body (the user's ruling: a skill stays the current
		// procedure; dated logs grow without bound). They count as neither uses
		// nor verdicts — pure provenance.
		else if (e.kind === 'lifecycle') cur.lifecycle++;
		if (e.kind === 'correction' || e.kind === 'positive') {
			const seq = verdicts.get(href) ?? [];
			// The NOTE is what makes a flip meaningful (see the flips computation
			// below): without it, two corrections about DIFFERENT subjects read as
			// "the same conclusion was overturned twice".
			seq.push({ kind: e.kind, ms: e.ms, note: String(e.note ?? '').trim() });
			verdicts.set(href, seq);
		}
		cur.last = Math.max(cur.last, e.ms);
		map.set(href, cur);
	}
	const items = [...map.values()];
	for (const it of items) {
		// Exposure is reported, never used as evidence of use.
		it.exposure = it.recalls + it.reads;
		// Engagement: the model opened the file or formed a verdict about it.
		// A recall the model ignored is not a use — that is the whole point.
		const uses = it.reads + it.corrections + it.positives;
		// Denominator excludes recall: corrections measure the quality of what the
		// model actually engaged with, not of everything the plugin pushed at it.
		const engaged = it.reads + it.corrections;
		const badRate = engaged ? it.corrections / engaged : it.corrections ? 1 : 0;
		// Layer suggestion mirrors the article's data-driven promotion: usage wins,
		// confirmation gates promotion, correction rate gates generality.
		if (uses >= 10 && it.positives >= 2 && badRate < 0.2) it.layer = '通用';
		else if (uses >= 3 && it.positives >= 1) it.layer = '专项';
		else it.layer = '实验';
		it.uses = uses;
		it.badRate = Number(badRate.toFixed(2));
		// FLIPS measure ONE conclusion being overturned, not one FILE collecting
		// verdicts about different subjects. The old count flipped on any
		// correction→positive→correction sequence on the same href, which is how
		// functions/memory-manager.md was reported as "结论被反复推翻（翻转 2 次）"
		// from three verdicts about three unrelated matters (duplicate-row cleanup,
		// then a capability-ledger semantics correction). A file is a container;
		// only a repeated VERDICT ON THE SAME SUBJECT is instability.
		//
		// Two verdicts belong to the same subject when their notes share content:
		// exact match, or one contains the other (short note inside a long one).
		// A verdict without a note cannot be attributed to a subject, so it can
		// only flip against an adjacent note-less verdict — that keeps the signal
		// honest (we never invent a subject link we cannot see) while the tool's
		// own description nudges the model to pass `note`.
		const seq = (verdicts.get(it.href) ?? []).sort((a, b) => a.ms - b.ms);
		const sameSubject = (a, b) => {
			if (!a.note || !b.note) return !a.note && !b.note;
			return a.note === b.note || a.note.includes(b.note) || b.note.includes(a.note);
		};
		let flips = 0;
		for (let i = 1; i < seq.length; i++) {
			if (seq[i].kind !== seq[i - 1].kind && sameSubject(seq[i], seq[i - 1])) flips++;
		}
		it.flips = flips;
	}
	items.sort((a, b) => b.uses - a.uses || b.exposure - a.exposure || b.last - a.last);
	return items;
}

/**
 * Insight trust from usage evidence (Hindsight-borrowed: beliefs carry proof
 * counts, and new evidence REFINES rather than silently replaces).
 *
 *   positives 0, corrections 0  → 待验证（沉淀了但还没被用过/验证过）
 *   corrections >= positives>0  → 动摇（被纠正追平了认可：该精炼或取代了）
 *   positives >= 3              → 稳固（反复被确认）
 *   positives >= 1              → 已验证
 */
export function insightTrust(item) {
	const p = item?.positives ?? 0;
	const c = item?.corrections ?? 0;
	if (p === 0) return { level: '待验证', positives: 0, corrections: c };
	if (c >= p) return { level: '动摇', positives: p, corrections: c };
	if (p >= 3) return { level: '稳固', positives: p, corrections: c };
	return { level: '已验证', positives: p, corrections: c };
}

/** The head line written into every insight file; the panel renders it for free. */
export function trustLineFor(trust) {
	return `> 信任：${trust.level}（认可 ${trust.positives} · 纠正 ${trust.corrections}，由 memory_insight 按 .usage.jsonl 自动刷新）`;
}

/**
 * Replace or insert the trust line right after the `> 性质：` head line.
 * BOTH branches matter: files created by the 5.16.1 template already carry the
 * line (replace), files written by an earlier generation do not (insert) — and
 * the insert needs the `m` flag, or `^` anchors at the very start of the body
 * (the `# 标题` line) and silently never matches. An insight update must never
 * return without its trust line: the recall marker and R22 both key on it.
 */
export function refreshTrustLine(text, line) {
	if (/^> 信任：.*$/m.test(text)) return text.replace(/^> 信任：.*$/m, line);
	const withInsert = text.replace(/^(> 性质：[^\n]*\n)/m, `$1${line}\n`);
	if (withInsert !== text) return withInsert;
	// No `> 性质：` head at all (a hand-written or truncated file): put the line
	// under the title instead of dropping it.
	const afterTitle = text.replace(/^(#[^\n]*\n\n?)/m, `$1${line}\n`);
	if (afterTitle !== text) return afterTitle;
	return `${line}\n${text}`;
}
