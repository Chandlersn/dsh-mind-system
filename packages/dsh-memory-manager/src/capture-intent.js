import path from 'node:path';
import { lstat, open, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const INTENT_NAME = '.daily-capture.pending';

/** Read-only observation only: absence cannot prove that no past intent existed. */
export async function inspectCaptureIntent(root) {
	try { if (!(await stat(root)).isDirectory()) return 'unknown'; } catch { return 'unknown'; }
	try { await lstat(path.join(root, INTENT_NAME)); return 'present'; }
	catch (error) { return error?.code === 'ENOENT' ? 'not_seen' : 'unknown'; }
}

/** Caller holds the capture mutex. Existence, including a broken link, blocks. */
export async function assertNoCaptureIntent(root) {
	try {
		await lstat(path.join(root, INTENT_NAME));
	} catch (error) {
		if (error?.code === 'ENOENT') return;
		throw Object.assign(new Error('每日采集意图状态不可读取，未开始写入', { cause: error }), { code: 'CAPTURE_INTENT_UNKNOWN' });
	}
	throw Object.assign(new Error('存在未完成的每日采集意图；需核查，不能自动重试或删除'), { code: 'CAPTURE_INTENT_PENDING' });
}

/**
 * Create a durable-in-file witness before touching a daily file. Caller must
 * already hold the cooperative capture mutex. Any failure leaves the witness
 * untouched because the create/write/close acknowledgement may be uncertain.
 *
 * The handle's (dev, ino) is recorded here and verified by finishCaptureIntent:
 * a pathname is not proof of ownership, so deletion must be gated on the
 * identity we created rather than on the name we wrote.
 */
export async function beginCaptureIntent(root, day) {
	if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}(?![\s\S])/.test(day)) throw new TypeError('invalid capture date');
	const file = path.join(root, INTENT_NAME);
	const id = randomUUID();
	let handle;
	try {
		handle = await open(file, 'wx', 0o600);
	} catch (error) {
		if (error?.code === 'EEXIST') throw Object.assign(new Error('存在未完成的每日采集意图；需核查，不能自动重试或删除'), { code: 'CAPTURE_INTENT_PENDING' });
		throw Object.assign(new Error('每日采集意图创建结果不明；需核查，不能自动重试或删除', { cause: error }), { code: 'CAPTURE_INTENT_UNKNOWN' });
	}
	let closeAttempted = false;
	let identity;
	try {
		await handle.writeFile(`${JSON.stringify({ version: 1, id, day })}\n`, 'utf8');
		await handle.sync();
		identity = await handle.stat({ bigint: true });
		closeAttempted = true;
		await handle.close();
	} catch (error) {
		if (!closeAttempted) try { await handle.close(); } catch { /* close outcome is unknown */ }
		throw Object.assign(new Error('每日采集意图记录结果不明；需核查，不能自动重试或删除', { cause: error }), { code: 'CAPTURE_INTENT_UNKNOWN' });
	}
	return { file, id, dev: identity.dev, ino: identity.ino };
}

/**
 * Remove the witness only if the path still points at the inode we created.
 *
 * Inode identity is the strongest gate available through the public Node API
 * (same discipline as src/stage.js for panel staging). It closes the
 * "delete someone else's file" outcome. It does NOT close a check-then-act
 * window between this lstat and the unlink: a non-cooperating process can
 * still swap the path in between, and no portable primitive prevents that.
 * Unknown ownership is reported, never deleted — an unresolved witness blocks
 * the next capture, which is the safe, loud, human-recoverable failure.
 */
export async function finishCaptureIntent(intent) {
	let st;
	try {
		// bigint lstat: Windows inodes exceed Number.MAX_SAFE_INTEGER, and a
		// lossy Number read makes a genuine match compare unequal.
		st = await lstat(intent.file, { bigint: true });
	} catch (error) {
		throw Object.assign(new Error('意图路径无法核验，未删除；需核查'), { code: 'CAPTURE_FINALIZE_UNKNOWN', fileWritten: true, ledgerStatus: 'recorded', cause: error });
	}
	const ours = intent.ino !== undefined && intent.ino !== 0n &&
		!st.isSymbolicLink() && st.ino === intent.ino && st.dev === intent.dev;
	if (!ours) {
		throw Object.assign(new Error('意图路径已被替换（非本次创建的 inode），未删除；需核查'), {
			code: 'CAPTURE_INTENT_REPLACED', fileWritten: true, ledgerStatus: 'recorded',
		});
	}
	try { await unlink(intent.file); }
	catch (error) {
		throw Object.assign(new Error('每日记录和账本已确认，意图清理结果不明；需核查，不要盲目重试'), { code: 'CAPTURE_FINALIZE_UNKNOWN', fileWritten: true, ledgerStatus: 'recorded', cause: error });
	}
}
