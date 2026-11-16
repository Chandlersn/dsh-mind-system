/**
 * LayerTrace contract (plan node V-1; acceptance F2/F3/N3).
 *
 * The interesting failures here are not crashes — they are traces that LOOK
 * complete but lie:
 *   · an unobserved field defaulting to 0 / {} / [] and reading like "nothing"
 *   · a skipped gate counted as a passed gate
 *   · an empty layer path rendering as a full chain
 *   · a rule version invented for a layer that never declared one
 * Every one of those is asserted below.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const {
	TRACE_FIELDS, GATE_RESULTS, normalizeLayerPath, normalizeRuleVersions,
	normalizeBudgetUsage, normalizeGateDecisions, buildTrace, appendTrace,
	verifyTraceFields, traceRows, layerChain,
} = await import('../src/trace.js');

test('the four contract fields are the documented ones', () => {
	assert.deepEqual([...TRACE_FIELDS], ['layer_path', 'rule_versions', 'budget_usage', 'gate_decisions']);
});

test('an unobserved field stays null — never zero, never empty', () => {
	// [] must not become "a path with no layers", and it must not become null-by-luck.
	assert.equal(normalizeLayerPath([]), null);
	assert.equal(normalizeLayerPath(undefined), null);
	assert.equal(normalizeLayerPath('L1'), null, 'a bare string is not a path');
	assert.equal(normalizeRuleVersions({}), null, 'no rules is unknown, not "zero rules"');
	assert.equal(normalizeBudgetUsage({}), null);
	assert.equal(normalizeGateDecisions([]), null, 'no gates is unknown, not "all passed"');

	const t = buildTrace({});
	assert.deepEqual(verifyTraceFields(t).missing, [...TRACE_FIELDS]);
	assert.equal(verifyTraceFields(t).ok, false);
});

test('a layer path keeps order and drops blanks', () => {
	assert.deepEqual(normalizeLayerPath(['L0', ' ', 'L3', 'L1']), ['L0', 'L3', 'L1']);
	// Order is the evidence: reordering would claim a different traversal.
	assert.deepEqual(normalizeLayerPath(['L3', 'L0']), ['L3', 'L0']);
	assert.equal(layerChain({ layer_path: ['L0', 'L3'] }), 'L0 → L3');
	assert.equal(layerChain({ layer_path: null }), null);
});

test('rule versions: only real declarations survive', () => {
	assert.deepEqual(normalizeRuleVersions({ L1: 'v1', L2: '', L3: '  ' }), { L1: 'v1' });
	assert.deepEqual(normalizeRuleVersions({ L1: 3 }), null, 'a non-string version is not a version');
	assert.equal(normalizeRuleVersions(null), null);
});

test('budget usage records sizes AND ceilings; non-finite becomes null', () => {
	const u = normalizeBudgetUsage({ items: 44, rows: 120, maxItems: 120, maxRows: 500, over: false });
	assert.deepEqual(u, { items: 44, rows: 120, maxItems: 120, maxRows: 500, over: false });
	// A budget object whose ONLY value is NaN carries no observation at all, so
	// the whole field is unknown — that is stronger than {items: null}.
	assert.equal(normalizeBudgetUsage({ items: NaN }), null, 'nothing observable is null, not an object full of nulls');
	// But a partially observed budget keeps the known half and nulls the rest.
	const partial = normalizeBudgetUsage({ items: 5 });
	assert.equal(partial.items, 5);
	assert.equal(partial.rows, null, 'a missing ceiling is unknown, not 0');
});

test('gate results come from a closed set, so skipped never reads as passed', () => {
	assert.deepEqual([...GATE_RESULTS], ['passed', 'failed', 'skipped', 'human_gate']);
	const gates = normalizeGateDecisions([
		{ gate: 'refs', result: 'passed' },
		{ gate: 'semantic', result: 'skipped', reason: 'no embedder' },
		{ gate: 'nonsense', result: 'maybe' },
	]);
	assert.equal(gates.length, 2, 'an unknown result is dropped, not coerced');
	assert.equal(gates[1].result, 'skipped');
	assert.equal(gates[1].reason, 'no embedder');
});

test('a skipped gate is reported apart and does not fake completeness', () => {
	const t = buildTrace({
		layerPath: ['L0', 'L1'],
		ruleVersions: { L1: 'v1' },
		budgetUsage: { items: 1, rows: 1, maxItems: 10, maxRows: 10, over: false },
		gateDecisions: [{ gate: 'semantic', result: 'skipped', reason: 'no embedder' }],
	});
	const v = verifyTraceFields(t);
	// The trace carries all four fields, so it is complete...
	assert.equal(v.ok, true);
	// ...but it must still tell the reader that one gate did not run.
	assert.deepEqual(v.skipped_gates, ['semantic']);
});

test('a complete trace is accepted only when every field was observed', () => {
	const full = buildTrace({
		layerPath: ['L0', 'L3'],
		ruleVersions: { L0: 'a', L3: 'b' },
		budgetUsage: { items: 3, rows: 9, maxItems: 120, maxRows: 500, over: false },
		gateDecisions: [{ gate: 'refs', result: 'passed' }],
	});
	assert.equal(verifyTraceFields(full).ok, true);
	assert.deepEqual(verifyTraceFields(full).missing, []);
});

test('appendTrace writes into the decision ledger with kind=trace, and traceRows splits it', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'dsh-trace-'));
	try {
		await appendTrace(dir, {
			layerPath: ['L2'], ruleVersions: { L2: 'x' },
			budgetUsage: { items: 1, rows: 2, maxItems: 5, maxRows: 5, over: false },
			gateDecisions: [{ gate: 'g', result: 'passed' }],
		});
		const text = await readFile(path.join(dir, 'mind-valves.jsonl'), 'utf8');
		const rows = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
		assert.equal(rows.length, 1);
		assert.equal(rows[0].kind, 'trace');
		assert.deepEqual(rows[0].layer_path, ['L2']);

		// A decision row shares the file but is not a trace.
		const mixed = [{ kind: 'trace', layer_path: ['L1'] }, { rule_type: 'skill' }];
		assert.equal(traceRows(mixed).length, 1);
		assert.equal(traceRows(undefined).length, 0, 'a missing ledger is not a crash');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('appendTrace never throws when the storage is unusable', async () => {
	// Recording must not break execution: a bad path returns false.
	const bad = path.join(tmpdir(), 'definitely', 'not', 'a', 'dir', '\u0000bad');
	const ok = await appendTrace(bad, { layerPath: ['L0'] }).catch(() => 'threw');
	assert.notEqual(ok, 'threw', 'appendTrace must swallow storage errors');
});
