import { readLedger, reconcile, isTracked } from './write-ledger.js';

/**
 * Do not make an unrecorded or inconsistent daily file appear reconciled by
 * rewriting it and recording a new hash. This proves only current consistency,
 * not who authored any earlier content. Call inside the cooperative capture lock.
 */
export async function verifyCaptureBaseline(root, key, existingText) {
	if (typeof key !== 'string' || key.includes('/') || !isTracked(key)) throw new TypeError('invalid daily capture key');
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
