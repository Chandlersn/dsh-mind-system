/**
 * Tool receipts must be lossless JSON (2026-11-14).
 *
 * Why this suite exists: after P0-2 landed, a REAL `valve_metrics` call failed
 * with "value is not lossless JSON" because the new calibration block carried
 * `note: undefined` on the non-empty path. Isolated tests were green -- they
 * asserted field VALUES, not that the receipt survives a JSON round trip. The
 * host compiles output schemas and serializes receipts, so an undefined value
 * is not a cosmetic issue, it is a failed tool call.
 *
 * These assertions serialize the real receipt the way the host does, so the
 * next undefined field fails here instead of in production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../index.js';

function sandbox() {
	return mkdtempSync(join(tmpdir(), 'dsh-valves-json-'));
}

/** Walk a value and report every path whose value is undefined. */
function findUndefined(value, path = '$', out = []) {
	if (value === undefined) { out.push(path); return out; }
	if (value === null || typeof value !== 'object') return out;
	if (Array.isArray(value)) {
		value.forEach((v, i) => findUndefined(v, `${path}[${i}]`, out));
		return out;
	}
	for (const [k, v] of Object.entries(value)) findUndefined(v, `${path}.${k}`, out);
	return out;
}

const lossless = (receipt) => {
	const undefinedPaths = findUndefined(receipt);
	assert.deepEqual(undefinedPaths, [], `receipt carries undefined at: ${undefinedPaths.join(', ')}`);
	const roundTrip = JSON.parse(JSON.stringify(receipt));
	assert.deepEqual(roundTrip, receipt, 'JSON round trip must preserve the receipt');
	return roundTrip;
};

const settle = () => new Promise((r) => setTimeout(r, 50));

test('metrics receipt is lossless JSON when there are NO daily samples (the real root shape)', async () => {
	const dir = sandbox();
	try {
		const rt = createRuntime({ storageDir: dir });
		// Reproduce the real ledger shape: nomination rows only, no daily rows.
		for (let i = 0; i < 3; i++) rt.downward('L1', 'L2', { constraints: ['c'], origin: 'nomination' });
		await settle();
		const m = await rt.metrics();
		const rt2 = lossless(m);
		assert.equal(rt2.calibration.evaluated, 0);
		assert.ok(typeof rt2.calibration.note === 'string', 'empty-calibration note must be a real string');
		assert.equal(rt2.calibration_writable, false);
		assert.match(String(rt2.thresholds_status), /no_daily_samples|sample_below_floor/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('metrics receipt is lossless JSON when daily samples DO exist', async () => {
	const dir = sandbox();
	try {
		const rt = createRuntime({ storageDir: dir });
		for (let i = 0; i < 2; i++) rt.downward('L1', 'L2', { constraints: ['c'] });
		await settle();
		const rt2 = lossless(await rt.metrics());
		assert.equal(rt2.calibration.evaluated, 2);
		assert.equal(rt2.calibration.note, null, 'non-empty calibration reports null, not undefined');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('metrics receipt stays lossless before any patrol has ever run', async () => {
	const dir = sandbox();
	try {
		const rt = createRuntime({ storageDir: dir });
		const rt2 = lossless(await rt.metrics());
		// "never" is the honest value; it must be a serializable string.
		assert.equal(rt2.last_patrol.weekly, 'never');
		assert.equal(rt2.last_patrol.quarterly, 'never');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
