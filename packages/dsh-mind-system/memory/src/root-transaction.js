/**
 * Cooperative, in-process transactions for a memory root.
 *
 * Every participant must enter this queue before reading and remain inside it
 * through all related writes. This does not coordinate other processes or
 * writers that bypass the queue; it does not make multiple files crash-atomic.
 * Re-entering the same root from a transaction callback will deadlock.
 */
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

// Symbol.for survives separate ESM module instances and in-process plugin reloads.
const QUEUES = Symbol.for('dsh-memory-manager.memory-root-transactions.v1');
const queues = globalThis[QUEUES] ??= new Map();
if (!(queues instanceof Map)) throw new Error('memory root transaction registry is invalid');

/** Resolve existing ancestors physically, retaining any not-yet-created suffix. */
async function rootIdentity(root) {
	if (typeof root !== 'string' || !root.trim()) throw new TypeError('memory root must be a non-empty path');
	let candidate = path.resolve(root);
	const suffix = [];
	for (;;) {
		try {
			const physical = await realpath(candidate);
			if (!(await stat(physical)).isDirectory()) throw Object.assign(new Error(`memory root ancestor is not a directory: ${candidate}`), { code: 'ENOTDIR' });
			let identity = path.join(physical, ...suffix);
			if (process.platform === 'win32') identity = identity.toLowerCase();
			return identity;
		} catch (error) {
			if (error?.code !== 'ENOENT') throw error;
			// A dangling link is not an absent directory: guessing its identity
			// could put the same root in two independent queues.
			try {
				await lstat(candidate);
				throw error;
			} catch (statError) {
				if (statError?.code !== 'ENOENT' || statError === error) throw statError;
			}
			const parent = path.dirname(candidate);
			if (parent === candidate) throw error;
			suffix.unshift(path.basename(candidate));
			candidate = parent;
		}
	}
}

/**
 * Serialize fn with other cooperating callbacks for the same physical root.
 * The return value or error is exactly that of fn; a rejection releases the
 * queue so subsequent callbacks can proceed. Different roots remain parallel.
 *
 * @template T
 * @param {string} root Memory root, which may not exist yet.
 * @param {() => T | Promise<T>} fn Complete read/modify/write transaction.
 * @returns {Promise<T>}
 */
export async function withMemoryRootTransaction(root, fn) {
	if (typeof fn !== 'function') throw new TypeError('transaction callback must be a function');
	const key = await rootIdentity(root);
	const previous = queues.get(key) ?? Promise.resolve();
	const run = previous.then(fn, fn);
	queues.set(key, run);
	const cleanup = () => { if (queues.get(key) === run) queues.delete(key); };
	run.then(cleanup, cleanup);
	return run;
}
