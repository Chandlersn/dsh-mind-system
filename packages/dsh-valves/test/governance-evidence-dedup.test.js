import test from 'node:test';
import assert from 'node:assert/strict';
import { governanceRound } from '../src/governance.js';

function assess(anti_examples) {
  return governanceRound({ entries: [], principles: [{ principle_id: 'p', anti_examples }] });
}

test('repeating one trace cannot manufacture independent counterexamples', () => {
  const result = assess(Array.from({ length: 5 }, () => ({ trace_ref: 'trace:one', source: 'taskA' })));
  assert.equal(result.principle_reports[0].anti_example_count, 1);
  assert.equal(result.principle_reports[0].anti_example_duplicates, 4);
  assert.equal(result.redefinition_proposals.length, 0);
});

test('conflicting source claims for one trace are excluded rather than increasing diversity', () => {
  for (const values of [['A', 'B', 'C'], ['C', 'B', 'A']]) {
    const result = assess(values.map((source) => ({ trace_ref: 'trace:one', source })));
    assert.equal(result.principle_reports[0].anti_example_count, 0);
    assert.equal(result.principle_reports[0].anti_example_conflicts, 1);
    assert.equal(result.principle_reports[0].source_diversity, 0);
    assert.equal(result.redefinition_proposals.length, 0);
  }
});

test('whitespace aliases deduplicate and blank traces are not evidence', () => {
  const result = assess([{ trace_ref: ' trace:one ', source: 'A' }, { trace_ref: 'trace:one', source: ' A ' }, { trace_ref: '  ', source: 'B' }]);
  assert.equal(result.principle_reports[0].anti_example_count, 1);
  assert.equal(result.redefinition_proposals.length, 0);
});

test('missing and blank source declarations do not manufacture source diversity', () => {
  const result = assess([{ trace_ref: 'trace:1', source: 'A' }, { trace_ref: 'trace:2' }, { trace_ref: 'trace:3', source: '  ' }]);
  assert.equal(result.principle_reports[0].source_diversity, 1);
  assert.ok(!result.principle_reports[0].triggered.includes('diverse_anti_examples'));
  const missing = assess([{ trace_ref: 'trace:1' }]);
  assert.equal(missing.principle_reports[0].source_diversity, 0);
});

test('distinct caller-declared references still produce a trace-linked human-gated proposal', () => {
  const result = assess([{ trace_ref: 'trace:1', source: 'A' }, { trace_ref: 'trace:2', source: 'B' }, { trace_ref: 'trace:3', source: 'A' }]);
  assert.equal(result.principle_reports[0].anti_example_count, 3);
  assert.equal(result.principle_reports[0].anti_example_duplicates, 0);
  assert.equal(result.principle_reports[0].anti_example_conflicts, 0);
  assert.deepEqual(result.redefinition_proposals[0].evidence, ['trace:1', 'trace:2', 'trace:3']);
  assert.equal(result.human_gate_required, true);
});
