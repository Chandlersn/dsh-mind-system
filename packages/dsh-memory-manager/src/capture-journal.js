/*
 * Experimental append-only capture witness. Not wired into production.
 *
 * Every participant MUST hold the same physical-root withCaptureMutex SQLite
 * lock across inspection, begin, the whole daily/ledger operation and commit.
 * This module cannot verify that lock: in particular it cannot stop old or
 * same-account non-cooperating writers. There is exactly one fixed journal per
 * root. Calls on that root are additionally non-reentrant within this process.
 *
 * Provisioning is intentionally out of scope: ENOENT blocks. An empty journal
 * cannot prove that one never existed and was deleted, and there is no trusted
 * genesis marker. Neither an fsync acknowledgement nor this parse establishes
 * durability over power loss, authorship, authenticity, or absence of rollback.
 * Never automatically unlink, reset, repair, truncate, compact, or replace it.
 */
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';

export const CAPTURE_JOURNAL_NAME = '.daily-capture-intents.jsonl';
const LEGACY_NAME = '.daily-capture.pending';
const MAX_BYTES = 16 * 1024 * 1024;
const guardKey = Symbol.for('dsh-memory-manager.capture-journal.in-flight');
const inFlight = globalThis[guardKey] ??= new Set();

function problem(code, message, extra = {}) {
	return Object.assign(new Error(message), { code, ...extra });
}
function same(a, b) { return a.dev === b.dev && a.ino === b.ino && a.ino !== 0n && b.ino !== 0n; }
function invalid(message) { return problem('CAPTURE_JOURNAL_INVALID', message); }
function validId(id) { return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id); }
function validDay(day) {
	if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}(?![\s\S])/.test(day)) return false;
	const date = new Date(`${day}T00:00:00.000Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

// Reject root/ancestor symlinks and junctions rather than silently accepting an
// alias for a different lock domain. Directory nlink is not a hardlink count on
// all supported filesystems, so only the journal's nlink is restricted.
async function checkedRoot(root) {
	if (typeof root !== 'string' || !root.trim()) throw new TypeError('root must be an existing directory');
	const absolute = path.resolve(root);
	const parsed = path.parse(absolute);
	let current = parsed.root;
	for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		let info;
		try { info = await lstat(current, { bigint: true }); }
		catch { throw problem('CAPTURE_JOURNAL_ROOT_UNKNOWN', 'journal root or an ancestor cannot be verified'); }
		if (!info.isDirectory() || info.isSymbolicLink() || info.ino === 0n)
			throw problem('CAPTURE_JOURNAL_UNSAFE_PATH', 'journal root or an ancestor is not a verifiable ordinary directory');
	}
	let info;
	try { info = await lstat(absolute, { bigint: true }); }
	catch { throw problem('CAPTURE_JOURNAL_ROOT_UNKNOWN', 'journal root cannot be verified'); }
	if (!info.isDirectory() || info.isSymbolicLink() || info.ino === 0n)
		throw problem('CAPTURE_JOURNAL_UNSAFE_PATH', 'journal root is not a verifiable ordinary directory');
	let physical;
	try { physical = await realpath(absolute); } catch { throw problem('CAPTURE_JOURNAL_ROOT_UNKNOWN', 'journal root real path cannot be verified'); }
	return { root: absolute, physical, info };
}
async function legacyAbsent(root) {
	try { await lstat(path.join(root, LEGACY_NAME)); }
	catch (error) {
		if (error?.code === 'ENOENT') return;
		throw problem('CAPTURE_JOURNAL_LEGACY_UNKNOWN', 'legacy capture intent cannot be verified');
	}
	throw problem('CAPTURE_JOURNAL_LEGACY_PENDING', 'legacy capture intent exists; inspect it without deleting or retrying');
}
async function checkedPath(file) {
	let info;
	try { info = await lstat(file, { bigint: true }); }
	catch (error) {
		if (error?.code === 'ENOENT') throw problem('CAPTURE_JOURNAL_MISSING', 'journal is missing; first initialization and deletion are indistinguishable');
		throw problem('CAPTURE_JOURNAL_PATH_UNKNOWN', 'journal path cannot be verified');
	}
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.ino === 0n)
		throw problem('CAPTURE_JOURNAL_UNSAFE_PATH', 'journal is not an independent regular file');
	return info;
}

function parse(bytes) {
	if (bytes.length > MAX_BYTES) throw invalid('journal exceeds the inspection size limit; no automatic compaction is performed');
	if (bytes.length === 0) return { count: 0, pending: null, ids: new Set() };
	const text = new TextDecoder('utf-8', { fatal: true });
	let raw;
	try { raw = text.decode(bytes); } catch { throw invalid('journal contains invalid UTF-8'); }
	if (!raw.endsWith('\n')) throw invalid('journal has a truncated final record');
	const ids = new Set();
	let pending = null, count = 0;
	for (const line of raw.slice(0, -1).split('\n')) {
		let event;
		try { event = JSON.parse(line); } catch { throw invalid('journal contains a malformed record'); }
		if (!event || typeof event !== 'object' || Array.isArray(event) ||
			Object.keys(event).join(',') !== 'version,op,id,day' || JSON.stringify(event) !== line ||
			event.version !== 1 || !['begin', 'commit'].includes(event.op) || !validId(event.id) || !validDay(event.day))
			throw invalid('journal contains an unsupported, ambiguous or malformed record');
		if (event.op === 'begin') {
			if (pending || ids.has(event.id)) throw invalid('journal contains a duplicate or overlapping begin');
			ids.add(event.id);
			pending = { id: event.id, day: event.day };
		} else {
			if (!pending || pending.id !== event.id || pending.day !== event.day)
				throw invalid('journal contains an unpaired commit');
			pending = null;
		}
		count++;
	}
	return { count, pending, ids };
}

async function withJournal(root, mode, callback) {
	const checked = await checkedRoot(root);
	const key = process.platform === 'win32' ? checked.physical.toLowerCase() : checked.physical;
	if (inFlight.has(key)) throw problem('CAPTURE_JOURNAL_CONCURRENT', 'another journal operation in this process is in flight');
	inFlight.add(key);
	let handle, result, primary, closeError, attempted = false, closed = false;
	try {
		await legacyAbsent(checked.root);
		const file = path.join(checked.root, CAPTURE_JOURNAL_NAME);
		const before = await checkedPath(file);
		const flags = (mode === 'read' ? constants.O_RDONLY : constants.O_RDWR | constants.O_APPEND) | (constants.O_NOFOLLOW ?? 0);
		try { handle = await open(file, flags); }
		catch { throw problem('CAPTURE_JOURNAL_OPEN_UNKNOWN', 'journal could not be opened and verified'); }
		const opened = await handle.stat({ bigint: true });
		const after = await checkedPath(file);
		const rootAfter = await checkedRoot(checked.root);
		if (!same(before, opened) || !same(before, after) || !same(checked.info, rootAfter.info) || opened.nlink !== 1n)
			throw problem('CAPTURE_JOURNAL_UNSAFE_PATH', 'journal or root identity changed during open');
		if (opened.size > BigInt(MAX_BYTES)) throw invalid('journal exceeds the inspection size limit; no automatic compaction is performed');
		const parsed = parse(await handle.readFile());
		const beforeAppendPath = await checkedPath(file);
		const beforeAppendRoot = await checkedRoot(checked.root);
		if (!same(before, beforeAppendPath) || !same(checked.info, beforeAppendRoot.info))
			throw problem('CAPTURE_JOURNAL_UNSAFE_PATH', 'journal or root identity changed during inspection');
		// Recheck the legacy witness before any append. External actors can still
		// race this observation; the lock only coordinates cooperating writers.
		await legacyAbsent(checked.root);
		result = await callback(parsed, async (event) => {
			const record = `${JSON.stringify(event)}\n`;
			if (opened.size + BigInt(Buffer.byteLength(record)) > BigInt(MAX_BYTES)) throw invalid('journal would exceed the inspection size limit');
			attempted = true;
			try { await handle.writeFile(record, 'utf8'); }
			catch { throw problem('CAPTURE_JOURNAL_APPEND_UNKNOWN', 'journal write acknowledgement is unknown; inspect without retrying', { stage: 'write', recordStatus: 'unknown' }); }
			try { await handle.sync(); }
			catch { throw problem('CAPTURE_JOURNAL_APPEND_UNKNOWN', 'journal sync acknowledgement is unknown; inspect without retrying', { stage: 'sync', recordStatus: 'unknown' }); }
			try {
				const current = await checkedPath(file);
				const currentRoot = await checkedRoot(checked.root);
				if (!same(before, current) || !same(checked.info, currentRoot.info)) throw new Error('identity changed');
				await legacyAbsent(checked.root);
			} catch {
				throw problem('CAPTURE_JOURNAL_APPEND_UNKNOWN', 'journal was written but path or legacy state cannot be confirmed; inspect without retrying', { stage: 'post-sync', recordStatus: 'unknown' });
			}
		});
	} catch (error) { primary = error; }
	if (handle) {
		try { await handle.close(); closed = true; }
		catch { closeError = true; }
	}
	inFlight.delete(key);
	if (closeError && attempted) throw problem('CAPTURE_JOURNAL_APPEND_UNKNOWN', 'journal close acknowledgement is unknown; inspect without retrying', { stage: primary?.stage ?? 'close', recordStatus: 'unknown', closeStatus: 'unknown' });
	if (primary) throw primary;
	if (closeError || (handle && !closed)) throw problem('CAPTURE_JOURNAL_CLOSE_UNKNOWN', 'journal inspection close acknowledgement is unknown');
	return result;
}

/** Read-only check. Requires the same external mutex as the write operations. */
export async function inspectCaptureJournal(root) {
	return withJournal(root, 'read', async (parsed) => {
		if (parsed.pending) throw problem('CAPTURE_JOURNAL_PENDING', 'unfinished begin blocks capture; inspect without repair', { id: parsed.pending.id, day: parsed.pending.day });
		return { status: 'clear', records: parsed.count, history: 'unverified' };
	});
}

/** Append begin only after a complete, valid journal is observed. */
export async function beginCaptureJournal(root, id, day) {
	if (!validId(id) || !validDay(day)) throw new TypeError('id must be a UUIDv4 and day must be YYYY-MM-DD');
	return withJournal(root, 'append', async (parsed, append) => {
		if (parsed.pending) throw problem('CAPTURE_JOURNAL_PENDING', 'unfinished begin blocks capture; inspect without repair', { id: parsed.pending.id, day: parsed.pending.day });
		if (parsed.ids.has(id)) throw problem('CAPTURE_JOURNAL_DUPLICATE', 'capture id already occurs in the journal');
		await append({ version: 1, op: 'begin', id, day });
		return { status: 'begin-recorded', id, day, durability: 'not-proven' };
	});
}

/** Commit only the one outstanding matching begin. No automatic retries. */
export async function commitCaptureJournal(root, id, day) {
	if (!validId(id) || !validDay(day)) throw new TypeError('id must be a UUIDv4 and day must be YYYY-MM-DD');
	return withJournal(root, 'append', async (parsed, append) => {
		if (!parsed.pending || parsed.pending.id !== id || parsed.pending.day !== day)
			throw problem('CAPTURE_JOURNAL_UNPAIRED', 'no matching unfinished begin; do not append a commit');
		await append({ version: 1, op: 'commit', id, day });
		return { status: 'commit-recorded', id, day, durability: 'not-proven' };
	});
}
