import { readLedger, reconcile, isTracked } from './write-ledger.js';

/**
 * 采集基线接受的键口径：根层日线程 `YYYY-MM-DD.md`，以及按月归档
 * `daily/YYYY-MM.md`（月/周折叠方案 2026-11 与 isTracked 的 daily/ 前缀口径
 * 对齐）。其他带斜杠路径一律拒绝——采集不越出这两个数据文件形态。
 */
export function isCaptureKey(key) {
	if (typeof key !== 'string') return false;
	if (/^\d{4}-\d{2}-\d{2}\.md(?![\s\S])/u.test(key)) return true;
	const m = /^daily\/(\d{4}-(?:0[1-9]|1[0-2]))\.md$/u.exec(key);
	return Boolean(m) && isTracked(key);
}

/**
 * Do not make an unrecorded or inconsistent daily file appear reconciled by
 * rewriting it and recording a new hash. This proves only current consistency,
 * not who authored any earlier content. Call inside the cooperative capture lock.
 */
export async function verifyCaptureBaseline(root, key, existingText) {
	if (!isCaptureKey(key)) throw new TypeError('invalid daily capture key');
	const ledger = await readLedger(root);
	if (!(ledger instanceof Map)) throw Object.assign(new Error('采集前账本不可读，未修改每日记录'), { code: 'CAPTURE_BASELINE_UNVERIFIED', reason: 'ledger_unreadable' });
	if (existingText === undefined) {
		// Absence now cannot establish absence of prior history; reject a recorded
		// live or incomplete entry rather than silently creating a replacement.
		const prior = ledger.get(key);
		if (prior && prior.op !== 'delete') throw Object.assign(new Error('每日记录缺失但账本存在未完成或现存记录'), { code: 'CAPTURE_BASELINE_UNVERIFIED', reason: 'recorded_file_absent' });
		return { currentFile: 'absent', provenance: 'unknown' };
	}
	if (typeof existingText !== 'string') throw new TypeError('existing daily text must be a string');
	const result = reconcile({ key, text: existingText, ledger });
	if (result.verdict !== 'ok') throw Object.assign(new Error('每日记录现有内容无法与账本对账，未修改'), { code: 'CAPTURE_BASELINE_UNVERIFIED', reason: result.reason });
	return { currentFile: 'consistent', provenance: 'unknown' };
}
