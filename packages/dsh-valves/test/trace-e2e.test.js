/**
 * V-1 end-to-end: a real execution path must leave a trace with all four
 * contract fields on disk.
 *
 * The unit suite (trace.test.js) proves the normalizers. This proves the WIRING:
 * that calling the plugin's own entry point actually writes a trace into the same
 * ledger the decisions live in. A normalizer nobody calls is not acceptance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../index.js';
import { verifyTraceFields, traceRows, TRACE_FIELDS } from '../src/trace.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'dsh-trace-e2e-'));
const settle = () => new Promise((r) => setTimeout(r, 80));

async function readLedger(dir) {
	const p = join(dir, 'mind-valves.jsonl');
	if (!existsSync(p)) return [];
	return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('semanticCheck writes a trace carrying all four contract fields', async () => {
	const dir = tempDir();
	try {
		const rt = createRuntime({ storageDir: dir });
		// A check with NO rules consulted genuinely has nothing to say about
		// rule_versions — verifyTraceFields rejects such a trace, which is correct.
		// So establish a real rule first: then the trace must name its version.
		await rt.confirm({
			id: 'no-shared-lib-delete', negative_type: 'forbidden_skill',
			statement: '禁止删除共享库', keywords: ['不要删共享库'],
		});
		// Real call through the runtime's own surface. No embedder supplied, so the
		// semantic layer degrades — which must be recorded as SKIPPED, not passed.
		await rt.semanticCheck({ text: '不要删共享库 相关的改动', candidate_id: 'cand-1' });
		await settle();

		const rows = await readLedger(dir);
		const traces = traceRows(rows);
		assert.equal(traces.length, 1, 'exactly one trace row was written');

		const t = traces[0];
		for (const field of TRACE_FIELDS) {
			assert.ok(field in t, `the trace carries ${field}`);
		}
		const verdict = verifyTraceFields(t);
		assert.equal(verdict.ok, true, `trace is complete (missing: ${verdict.missing.join(',')})`);
		assert.ok(t.rule_versions['no-shared-lib-delete'], 'the consulted rule is named with a version');

		// The degraded semantic layer must be SKIPPED — claiming a pass would say
		// the semantic layer inspected something it never saw.
		assert.ok(verdict.skipped_gates.includes('semantic'), 'degraded semantic layer is recorded as skipped');
		// And the lexical layer did run.
		assert.ok(t.gate_decisions.some((g) => g.gate === 'lexical' && g.result === 'passed'), 'the lexical gate ran');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a check with no rules consulted is honestly incomplete, not silently fine', async () => {
	const dir = tempDir();
	try {
		const rt = createRuntime({ storageDir: dir });
		await rt.semanticCheck({ text: '无关文本', candidate_id: 'cand-empty' });
		await settle();
		const traces = traceRows(await readLedger(dir));
		assert.equal(traces.length, 1);
		// No rules → no versions and no budget size. The trace must SAY that by
		// failing the contract, rather than presenting empty objects as evidence.
		const verdict = verifyTraceFields(traces[0]);
		assert.equal(verdict.ok, false, 'an unobservable trace must not pass verification');
		assert.ok(verdict.missing.includes('rule_versions'));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the trace rides the same ledger as decisions (no second store)', async () => {
	const dir = tempDir();
	try {
		const rt = createRuntime({ storageDir: dir });
		// A downward evaluation always writes a decision row; the trace must land in
		// the SAME file so a reader cannot see one without the other.
		rt.downward('L1', 'L2', { constraints: ['先读再改'] });
		await rt.semanticCheck({ text: '不要删共享库', candidate_id: 'cand-2' });
		await settle();
		const rows = await readLedger(dir);
		assert.ok(rows.some((r) => r.kind === 'trace'), 'trace row present');
		assert.ok(rows.some((r) => r.kind !== 'trace'), 'decision rows present in the same file');
		// One ledger path, by construction.
		assert.equal(existsSync(join(dir, 'mind-valves.jsonl')), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('an older ledger without traces still reads (history is not rewritten)', async () => {
	const dir = tempDir();
	try {
		// Simulate a pre-V-1 root: decisions only, no trace rows.
		const { appendDecision } = await import('../src/store.js');
		await appendDecision(dir, { gate: 'downward', direction: 'down', outcome: 'admitted' });
		await settle();
		const rows = await readLedger(dir);
		assert.equal(traceRows(rows).length, 0, 'old rows are not retroactively given traces');
		assert.equal(rows.length, 1, 'the old row is still there, unchanged');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
