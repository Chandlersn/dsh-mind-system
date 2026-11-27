/**
 * Safe rotation primitive for the dispatch-sample JSONL ledger.
 *
 * The live ledger is append-only and immutable; the only production readers
 * (readTrend / readTrendSync in ./sampling.js) discard rows older than their
 * `days` window before bucketing. Dropping rows that are already outside the
 * default 30-day window is therefore invisible to every production reader.
 *
 * NOTHING IS DESTROYED: after the new canonical file has been written and
 * verified, the staged original is renamed to a `.dropped` quarantine file
 * under the same staging directory. Every original byte stays recoverable.
 *
 * No production caller is wired to this module. It is a primitive, not a
 * trigger; enabling periodic cleanup is a separate, explicit decision.
 *
 * @module src/rotation
 */

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { sampleFilePath } from './sampling.js';

/** Default look-back window; matches the default of readTrend / readTrendSync. */
const DEFAULT_DAYS = 30;
/** Upper bound on bytes read from any one ledger/staged file. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Upper bound on rows read from any one ledger/staged file. */
const MAX_LINES = 200000;
/** Upper bound on a single JSONL line, in UTF-8 bytes. */
const MAX_LINE_BYTES = 256 * 1024;
/** How long to watch the staged file for a pre-rename handle still writing. */
const SETTLE_MS = 140;
/** Poll interval while watching the staged file settle. */
const SETTLE_POLL_MS = 20;
/** Milliseconds in one day. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Structured outcome for expected conditions; never thrown by this module. */
function outcome(status, detail = {}) {
	return {
		status,
		ok: status === 'rotated' || status === 'already_current',
		...detail,
	};
}

/**
 * Validate one option value without coercion tricks.
 *
 * @param {unknown} value Candidate value.
 * @returns {boolean} True when the value is a usable option.
 */
function isOption(value) {
	return value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Parse an ISO-ish timestamp exactly the way readTrend / readTrendSync do:
 * `Date.parse(e.t)`, finite, and within the window. A row whose `t` is absent,
 * non-string, or unparseable is treated as DROP (it is invisible to readers
 * for the same reason an old row is), but a row that is not valid JSON at all
 * is a hard `read_failed` — bad rows are never silently skipped.
 *
 * @param {string} line One trimmed JSONL line.
 * @returns {{ok: true, t: number} | {ok: false, reason: string}} Parsed row.
 */
function parseLine(line) {
	let row;
	try {
		row = JSON.parse(line);
	} catch {
		return { ok: false, reason: 'invalid_json' };
	}
	if (row === null || typeof row !== 'object' || Array.isArray(row)) {
		return { ok: false, reason: 'row_not_object' };
	}
	if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
		return { ok: false, reason: 'line_too_large' };
	}
	const t = Date.parse(row.t);
	return { ok: true, t };
}

/**
 * Split raw UTF-8 text into lines, trim each line like the production readers,
 * and parse every line. Blank lines are ignored (same as `if (!s) continue`
 * in sampling.js). Any bad row rejects the whole read.
 *
 * @param {string} text Raw file body.
 * @returns {{ok: true, rows: Array<{line: string, t: number}>} | {ok: false, reason: string}} Rows.
 */
function parseAll(text) {
	const rows = [];
	for (const raw of String(text ?? '').split('\n')) {
		const line = raw.trim();
		if (!line) continue;
		if (rows.length >= MAX_LINES) return { ok: false, reason: 'too_many_lines' };
		const parsed = parseLine(line);
		if (!parsed.ok) return parsed;
		rows.push({ line, t: parsed.t });
	}
	return { ok: true, rows };
}

/**
 * Bounded read of a regular file that refuses links, directories and swaps.
 * The post-read lstat catches a path replaced by a link during the read; a
 * size/mtime change is reported as `settling` so the caller can re-read.
 *
 * @param {string} file Absolute file path.
 * @returns {Promise<{status: string, text?: string, bytes?: number, code?: string, reason?: string}>}
 */
async function readBounded(file) {
	let info;
	try {
		info = await lstat(file);
	} catch (error) {
		if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 'not_found' };
		return { status: 'read_failed', code: error?.code ?? 'unknown' };
	}
	if (info.isSymbolicLink()) return { status: 'read_failed', reason: 'symlink' };
	if (!info.isFile()) return { status: 'read_failed', reason: 'not_regular_file' };
	if (info.size > MAX_FILE_BYTES) return { status: 'read_failed', reason: 'too_large', bytes: info.size };
	let text;
	try {
		text = await readFile(file, 'utf8');
	} catch (error) {
		if (error?.code === 'ENOENT') return { status: 'not_found' };
		return { status: 'read_failed', code: error?.code ?? 'unknown' };
	}
	try {
		const again = await lstat(file);
		if (again.isSymbolicLink() || !again.isFile()) return { status: 'read_failed', reason: 'changed_during_read' };
		if (again.size !== info.size || again.mtimeMs !== info.mtimeMs) {
			return { status: 'settling', text, bytes: again.size };
		}
	} catch (error) {
		if (error?.code === 'ENOENT') return { status: 'not_found' };
		return { status: 'read_failed', code: error?.code ?? 'unknown' };
	}
	return { status: 'ok', text, bytes: info.size };
}

/**
 * Wait for a moved file to stop changing, then return a stable snapshot.
 *
 * A writer that opened the source before the rename keeps its handle on the
 * same inode; its bytes land at the staging path. Two identical consecutive
 * reads are treated as stable. The residual window is real: an append that
 * arrives after this observation but before the staged file is archived could
 * still be missed, because Node cannot prove an inode has no other open
 * handles. The window is bounded by SETTLE_MS and the staged bytes are kept
 * as a `.dropped` archive, so nothing is destroyed.
 *
 * @param {string} file Staged file path.
 * @returns {Promise<{status: string, text?: string, bytes?: number, code?: string, reason?: string}>}
 */
async function settleStaged(file) {
	const deadline = Date.now() + SETTLE_MS;
	let previous = null;
	for (;;) {
		const read = await readBounded(file);
		if (read.status !== 'ok' && read.status !== 'settling') return read;
		if (previous !== null && previous === read.bytes) return { status: 'ok', text: read.text, bytes: read.bytes };
		if (Date.now() >= deadline) return { status: 'settling', text: read.text, bytes: read.bytes };
		previous = read.bytes;
		await delay(SETTLE_POLL_MS);
	}
}

/**
 * Partition rows into KEEP (>= cutoff) and DROP (< cutoff), preserving each
 * row's exact trimmed JSON text. Rows with an unparseable `t` are DROP: the
 * production readers also discard them before bucketing.
 *
 * @param {Array<{line: string, t: number}>} rows Parsed rows.
 * @param {number} cutoff Cutoff timestamp.
 * @returns {{keep: Array<{line: string, t: number}>, drop: Array<{line: string, t: number}>}}
 */
function partition(rows, cutoff) {
	const keep = [];
	const drop = [];
	for (const row of rows) {
		if (Number.isFinite(row.t) && row.t >= cutoff) keep.push(row);
		else drop.push(row);
	}
	return { keep, drop };
}

/**
 * Serialize rows back to JSONL. The writer uses `appendFile(path, line,
 * 'utf8')` with no BOM, so the rewritten file keeps that exact policy: one
 * trimmed JSON object per line, a trailing newline, no BOM.
 *
 * @param {Array<{line: string, t: number}>} rows Rows to serialize.
 * @returns {string} File body.
 */
function serialize(rows) {
	return rows.length === 0 ? '' : `${rows.map((row) => row.line).join('\n')}\n`;
}

/**
 * Write bytes to a temporary file in the staging dir, then rename into place.
 * The temp name is unique, so an existing canonical path is never clobbered
 * by this helper; callers decide how to handle a concurrent post-rename file.
 *
 * @param {string} stageDir Staging directory.
 * @param {string} canonical Canonical ledger path.
 * @param {string} base Basename of the ledger.
 * @param {string} body File body (no BOM).
 * @returns {Promise<{status: string, code?: string}>} Write result.
 */
async function writeAtomic(stageDir, canonical, base, body) {
	const temp = join(stageDir, `${base}.${randomUUID()}.new`);
	try {
		await writeFile(temp, body, { encoding: 'utf8', flag: 'wx' });
	} catch (error) {
		return { status: 'write_failed', code: error?.code ?? 'unknown' };
	}
	try {
		await rename(temp, canonical);
	} catch (error) {
		return { status: 'write_failed', code: error?.code ?? 'unknown' };
	}
	return { status: 'ok' };
}

/**
 * Rotate the dispatch-sample ledger: keep rows inside the window, quarantine
 * the rest, and leave every original byte recoverable.
 *
 * Protocol:
 *  1. Resolve the canonical path through sampling.js `sampleFilePath` and
 *     validate all inputs as pure data.
 *  2. Lstat + bounded read the source; any bad row rejects the whole run with
 *     `read_failed` and the source untouched.
 *  3. Partition. Nothing old enough -> `already_current`, zero writes.
 *  4. Rename the source into a same-filesystem `.stage/samples/` dir. EXDEV
 *     means no rename happened and the source stays intact.
 *  5. Settle-read the staged bytes; re-read/re-partition once if they changed.
 *  6. Write KEEP rows back atomically. If a post-rename appender created a
 *     fresh canonical file, merge its rows into KEEP, sort by `t`, verify,
 *     and only then archive staging.
 *  7. Read back the canonical file and assert it is byte-identical to the
 *     expected rows, all valid JSON, with no DROP row. Only then rename the
 *     staged file to `.dropped`. On any uncertainty, keep staging and return
 *     `manual_reconcile_required`.
 *
 * @param {object} options Rotation options.
 * @param {string} options.dshHome Data root used by sampling.js.
 * @param {number} [options.days=30] Look-back window in days.
 * @param {number} [options.now=Date.now()] Reference time as epoch milliseconds.
 * @returns {Promise<object>} Structured status; never throws for expected I/O.
 */
export async function rotateDispatchSamples({ dshHome, days = DEFAULT_DAYS, now = Date.now() } = {}) {
	if (!isOption({ dshHome, days, now })
		|| typeof dshHome !== 'string' || !dshHome.trim()
		|| !Number.isFinite(days) || days <= 0
		|| !Number.isFinite(now) || now < 0) {
		return outcome('invalid_input', { reason: 'invalid_options' });
	}

	const source = sampleFilePath(dshHome);
	const base = 'mind-dispatch-samples.jsonl';
	const stageDir = join(dirname(source), '.stage', 'samples');
	const cutoff = now - days * DAY_MS;
	const result = { dshHome, source, stageDir, cutoff };

	// Step 1: refuse links, directories and traversal before reading anything.
	let sourceInfo;
	try {
		sourceInfo = await lstat(source);
	} catch (error) {
		if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
			return outcome('read_failed', { ...result, reason: 'source_not_found' });
		}
		return outcome('read_failed', { ...result, code: error?.code ?? 'unknown', reason: 'source_stat_failed' });
	}
	if (sourceInfo.isSymbolicLink()) return outcome('read_failed', { ...result, reason: 'source_is_symlink' });
	if (!sourceInfo.isFile()) return outcome('read_failed', { ...result, reason: 'source_not_regular_file' });
	if (sourceInfo.size > MAX_FILE_BYTES) {
		return outcome('read_failed', { ...result, reason: 'source_too_large', bytes: sourceInfo.size });
	}

	const first = await readBounded(source);
	if (first.status !== 'ok') {
		return outcome(first.status === 'settling' ? 'read_failed' : first.status, {
			...result,
			...(first.code ? { code: first.code } : {}),
			reason: first.reason ?? 'source_read_failed',
		});
	}
	const parsed = parseAll(first.text);
	if (!parsed.ok) return outcome('read_failed', { ...result, reason: parsed.reason });
	let { keep, drop } = partition(parsed.rows, cutoff);
	if (drop.length === 0) {
		return outcome('already_current', {
			...result,
			rows: keep.length,
			bytes: first.bytes,
		});
	}

	// Step 2: atomic move to a staging path on the SAME filesystem as the
	// ledger. EXDEV means no rename occurred; the source is untouched.
	try {
		await mkdir(stageDir, { recursive: true });
	} catch (error) {
		return outcome('write_failed', { ...result, code: error?.code ?? 'unknown', reason: 'staging_dir_create_failed' });
	}
	const staged = join(stageDir, `${base}.${randomUUID()}.moved`);
	try {
		await rename(source, staged);
	} catch (error) {
		if (error?.code === 'EXDEV') {
			return outcome('rename_failed', { ...result, code: 'EXDEV', reason: 'cross_device_rename' });
		}
		// A failed rename may still have moved the entry (lost acknowledgement).
		// Only a still-present source proves it did not; otherwise stop rather
		// than guess which path holds the bytes.
		let stillThere = false;
		try { stillThere = (await lstat(source)).isFile(); } catch { stillThere = false; }
		if (stillThere) {
			return outcome('rename_failed', { ...result, code: error?.code ?? 'unknown', reason: 'rename_failed' });
		}
		return outcome('manual_reconcile_required', {
			...result,
			staged,
			code: error?.code ?? 'unknown',
			reason: 'rename_outcome_unknown',
		});
	}

	const settled = await settleStaged(staged);
	if (settled.status === 'settling') {
		// Re-read and re-partition once. If still unstable, keep staging.
		const retry = await settleStaged(staged);
		if (retry.status !== 'ok') {
			return outcome('manual_reconcile_required', {
				...result, staged, reason: 'staged_never_settled',
			});
		}
		// The later snapshot wins: use its bytes for the partition below.
		settled.text = retry.text;
		settled.bytes = retry.bytes;
	} else if (settled.status !== 'ok') {
		return outcome('manual_reconcile_required', {
			...result,
			staged,
			...(settled.code ? { code: settled.code } : {}),
			reason: settled.reason ?? 'staged_read_failed',
		});
	}
	const stagedParsed = parseAll(settled.text);
	if (!stagedParsed.ok) {
		return outcome('manual_reconcile_required', { ...result, staged, reason: `staged_${stagedParsed.reason}` });
	}
	({ keep, drop } = partition(stagedParsed.rows, cutoff));

	// Step 3: detect a post-rename appender. It opens the old path after the
	// rename and therefore created a fresh canonical file with its own bytes.
	// Those bytes are new data; they must be merged into the rewritten file.
	let extraRows = [];
	try {
		const concurrentInfo = await lstat(source);
		if (concurrentInfo.isSymbolicLink() || !concurrentInfo.isFile()) {
			return outcome('manual_reconcile_required', { ...result, staged, reason: 'concurrent_source_not_regular' });
		}
		const concurrentRaw = await readFile(source, 'utf8');
		const concurrentParsed = parseAll(concurrentRaw);
		if (!concurrentParsed.ok) {
			return outcome('manual_reconcile_required', {
				...result, staged, reason: `concurrent_${concurrentParsed.reason}`,
			});
		}
		extraRows = concurrentParsed.rows;
	} catch (error) {
		if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
			return outcome('manual_reconcile_required', {
				...result,
				staged,
				code: error?.code ?? 'unknown',
				reason: 'concurrent_read_failed',
			});
		}
	}

	// A post-rename appender may open the fresh canonical file at any point,
	// including between our read above and the atomic replace below. Its handle
	// then points at an inode we replace, so the write would be orphaned. Those
	// bytes are only safe if we fold them in and re-verify. Repeat a bounded
	// number of times; if the file will not settle, keep staging and stop.
	const MAX_MERGE_ROUNDS = 4;
	let expectedBody = '';
	let mergedCount = 0;
	for (let round = 0; round < MAX_MERGE_ROUNDS; round += 1) {
		// Stable sort by `t` keeps same-timestamp rows in their original order
		// (staged rows first, then post-rename rows).
		const merged = [...keep, ...extraRows].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
		expectedBody = serialize(merged);
		const wrote = await writeAtomic(stageDir, source, base, expectedBody);
		if (wrote.status !== 'ok') {
			return outcome(wrote.status, {
				...result, staged, code: wrote.code, reason: 'canonical_write_failed',
			});
		}

		// Step 4: read back and verify before touching staging. A late append
		// becomes `extraRows` for the next round instead of being lost.
		const verify = await readBounded(source);
		if (verify.status !== 'ok') {
			return outcome('manual_reconcile_required', {
				...result, staged, reason: 'canonical_verify_read_failed',
			});
		}
		if (verify.text === expectedBody) {
			const verifyParsed = parseAll(verify.text);
			if (!verifyParsed.ok) {
				return outcome('manual_reconcile_required', { ...result, staged, reason: 'canonical_verify_bad_row' });
			}
			for (const row of drop) {
				if (verifyParsed.rows.some((candidate) => candidate.line === row.line)) {
					return outcome('manual_reconcile_required', { ...result, staged, reason: 'dropped_row_reappeared' });
				}
			}
			mergedCount = extraRows.length;
			break;
		}
		const late = parseAll(verify.text);
		if (!late.ok || round === MAX_MERGE_ROUNDS - 1) {
			return outcome('manual_reconcile_required', {
				...result, staged, reason: 'canonical_never_settled',
			});
		}
		// Keep only rows we have not already folded in; a late append may have
		// written the same bytes twice through different handles.
		const seen = new Set(merged.map((row) => row.line));
		extraRows = late.rows.filter((row) => !seen.has(row.line));
		if (extraRows.length === 0) {
			return outcome('manual_reconcile_required', {
				...result, staged, reason: 'canonical_verify_unexplained_mismatch',
			});
		}
	}

	// Step 5: archive staging instead of deleting it. Every original byte --
	// including rows outside the window and any pre-rename appended payload --
	// stays recoverable at the `.dropped` path.
	const dropped = join(stageDir, `${base}.${randomUUID()}.dropped`);
	try {
		await rename(staged, dropped);
	} catch (error) {
		return outcome('manual_reconcile_required', {
			...result,
			staged,
			code: error?.code ?? 'unknown',
			reason: 'staged_archive_failed',
		});
	}
	return outcome('rotated', {
		...result,
		staged,
		dropped,
		kept: keep.length,
		droppedRows: drop.length,
		merged: mergedCount,
		bytes: Buffer.byteLength(expectedBody, 'utf8'),
	});
}
