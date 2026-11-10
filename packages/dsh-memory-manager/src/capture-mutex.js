/**
 * Cooperative capture serialization across processes using SQLite's OS locks.
 * All participants must use this same physical-root sentinel. It does not stop
 * old/non-cooperating writers or make the daily file and ledger crash-atomic.
 * It is not reentrant: nested acquisition for one root waits until timeout.
 * Never remove the sentinel as a recovery procedure. It contains no user data.
 * On unreliable network filesystems SQLite locking must be verified separately.
 */
import path from 'node:path';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

export const CAPTURE_SENTINEL = '.capture-mutex.sqlite';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function failure(code, message, cause) {
	return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function sameFile(a, b) {
	return a.dev === b.dev && a.ino === b.ino && a.ino !== 0n && b.ino !== 0n;
}

async function checkedFile(file) {
	const info = await lstat(file, { bigint: true });
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.ino === 0n)
		throw failure('CAPTURE_MUTEX_UNSAFE_PATH', `capture sentinel is not an independent regular file: ${file}`);
	return info;
}

async function prepare(root) {
	if (typeof root !== 'string' || !root.trim()) throw new TypeError('root must be a non-empty existing directory');
	const physical = await realpath(path.resolve(root));
	const dir = await stat(physical, { bigint: true });
	if (!dir.isDirectory() || dir.ino === 0n) throw failure('CAPTURE_MUTEX_UNSAFE_PATH', 'memory root identity is not a verifiable directory');
	const file = path.join(physical, CAPTURE_SENTINEL);
	try {
		const handle = await open(file, 'wx', 0o600);
		try { await handle.close(); } catch (error) { throw failure('CAPTURE_MUTEX_SENTINEL_CLOSE_UNKNOWN', 'sentinel creation close failed; do not remove or retry blindly', error); }
	} catch (error) {
		if (error?.code !== 'EEXIST') throw error;
	}
	const info = await checkedFile(file);
	// SQLite may open these companion paths itself; never intentionally follow
	// an existing symlink or another hard link in the root.
	for (const suffix of ['-journal', '-wal', '-shm']) {
		try { await checkedFile(file + suffix); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
	}
	return { physical, dir, file, info };
}

/**
 * Lock for the duration of an asynchronous callback. timeoutMs bounds retries
 * after a busy result; SQLite and filesystem synchronous calls may still block
 * on a malfunctioning filesystem. A timeout of 0 attempts the lock once.
 *
 * @template T
 * @param {string} root Existing memory root (aliases resolve to its real path).
 * @param {() => T | Promise<T>} callback Complete read/modify/write operation.
 * @param {{timeoutMs?: number, retryMs?: number}} options
 * @returns {Promise<T>}
 */
export async function withCaptureMutex(root, callback, { timeoutMs = 2000, retryMs = 20 } = {}) {
	if (typeof callback !== 'function') throw new TypeError('callback must be a function');
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000 || !Number.isFinite(retryMs) || retryMs <= 0 || retryMs > 1000)
		throw new RangeError('timeoutMs must be 0..60000 and retryMs must be >0..1000');
	let DatabaseSync;
	try { ({ DatabaseSync } = await import('node:sqlite')); }
	catch (error) { throw failure('CAPTURE_MUTEX_UNAVAILABLE', 'node:sqlite is unavailable; capture was not run', error); }
	if (typeof DatabaseSync !== 'function') throw failure('CAPTURE_MUTEX_UNAVAILABLE', 'DatabaseSync is unavailable; capture was not run');
	const prepared = await prepare(root);
	let db;
	let value;
	let primary;
	let hasPrimary = false;
	try {
		try {
			db = new DatabaseSync(prepared.file);
			db.exec('PRAGMA busy_timeout=0');
		} catch (error) {
			throw failure('CAPTURE_MUTEX_OPEN_FAILED', 'SQLite sentinel could not be opened safely; capture was not run', error);
		}
		// Opening SQLite is not a security boundary. Verify both names again;
		// same-account path replacement races remain outside this mechanism.
		const after = await checkedFile(prepared.file);
		const dirAfter = await stat(prepared.physical, { bigint: true });
		if (!sameFile(prepared.info, after) || !sameFile(prepared.dir, dirAfter))
			throw failure('CAPTURE_MUTEX_UNSAFE_PATH', 'root or sentinel changed while opening SQLite');
		const deadline = performance.now() + timeoutMs;
		for (;;) {
			try { db.exec('BEGIN IMMEDIATE'); break; }
			catch (error) {
				// SQLITE_BUSY is 5, including extended busy codes in the low byte.
				if (!Number.isInteger(error?.errcode) || (error.errcode & 0xff) !== 5) throw failure('CAPTURE_MUTEX_ACQUIRE_FAILED', 'SQLite could not confirm lock acquisition; capture was not run', error);
				const remaining = deadline - performance.now();
				if (remaining <= 0) throw failure('CAPTURE_MUTEX_BUSY', 'capture lock remained busy until the deadline; capture was not run', error);
				await pause(Math.min(retryMs, remaining));
				if (performance.now() >= deadline) throw failure('CAPTURE_MUTEX_BUSY', 'capture lock remained busy until the deadline; capture was not run', error);
			}
		}
		// A successful BEGIN is the only positive evidence of lock acquisition.
		const lockedFile = await checkedFile(prepared.file);
		const lockedDir = await stat(prepared.physical, { bigint: true });
		if (!sameFile(prepared.info, lockedFile) || !sameFile(prepared.dir, lockedDir))
			throw failure('CAPTURE_MUTEX_UNSAFE_PATH', 'root or sentinel changed during acquisition; capture was not run');
		value = await callback();
	} catch (error) { primary = error; hasPrimary = true; }
	let closeError;
	if (db) {
		try { db.close(); }
		catch (error) { closeError = failure('CAPTURE_MUTEX_CLOSE_UNKNOWN', 'SQLite close failed; lock release is unknown', error); }
	}
	if (hasPrimary && closeError) {
		const combined = new AggregateError([primary, closeError], 'capture failed and SQLite lock release is unknown', { cause: primary });
		combined.code = 'CAPTURE_MUTEX_CLOSE_UNKNOWN';
		combined.callbackOrAcquireError = primary;
		throw combined;
	}
	if (hasPrimary) throw primary;
	if (closeError) throw closeError;
	return value;
}
