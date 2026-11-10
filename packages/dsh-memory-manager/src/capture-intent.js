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
 * An unresolved witness is not automatically repaired or interpreted as proof of outcome.
 * The legacy finish helper removes a path after success and is unsafe against
 * non-cooperating path replacement; its red regression must block deployment.
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
	try {
		await handle.writeFile(`${JSON.stringify({ version: 1, id, day })}\n`, 'utf8');
		await handle.sync();
		closeAttempted = true;
		await handle.close();
	} catch (error) {
		if (!closeAttempted) try { await handle.close(); } catch { /* close outcome is unknown */ }
		throw Object.assign(new Error('每日采集意图记录结果不明；需核查，不能自动重试或删除', { cause: error }), { code: 'CAPTURE_INTENT_UNKNOWN' });
	}
	return { file, id };
}

/**
 * Only after writeText and its ledger append both return success, remove the
 * witness. Do not retry an uncertain unlink: the path may have changed hands.
 */
export async function finishCaptureIntent(intent) {
	try { await unlink(intent.file); }
	catch (error) {
		throw Object.assign(new Error('每日记录和账本已确认，意图清理结果不明；需核查，不要盲目重试'), { code: 'CAPTURE_FINALIZE_UNKNOWN', fileWritten: true, ledgerStatus: 'recorded', cause: error });
	}
}
