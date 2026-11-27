/** Verify adoption isolation at the governance runtime boundary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../index.js';
import { adoptionCandidates, adoptionConsumedRow } from '../src/adoption-consumer.js';
import { appendDecision, readDecisions } from '../src/store.js';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'adoption-consume-'));
  return { dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}
const principle = (id) => ({ principle_id: id, statement: `principle ${id}` });

test('historical consumed markers do not hide nominations', () => {
  const rows = [
    { gate: 'adoption_nomination', candidate_id: 'adoption:f/a.md@t1', adoption: { provenance: 'caller/user-action', kind: 'correction', note: 'c1' } },
    { gate: 'adoption_nomination', candidate_id: 'adoption:f/a.md@t2', adoption: { provenance: 'caller/user-action', kind: 'positive', note: 'p1' } },
    { gate: 'adoption_nomination', candidate_id: 'adoption:f/b.md@t3', adoption: { provenance: 'caller/user-action', kind: 'correction', note: 'c2' } },
  ];
  const first = adoptionCandidates(rows);
  assert.deepEqual(first.keys, ['adoption:f/a.md@t1', 'adoption:f/a.md@t2', 'adoption:f/b.md@t3']);
  const second = adoptionCandidates([...rows, adoptionConsumedRow(['adoption:f/a.md@t1'])]);
  assert.deepEqual(second.keys, first.keys);
  assert.equal(second.items[0].status, 'historical_consumed_unverified');
  assert.equal(second.items.every((i) => i.source === 'caller/user-action'), true);
  assert.equal(second.read_completeness, 'unknown');
});

test('duplicate, conflicting and missing identities remain visible and unknown', () => {
  const same = { gate: 'adoption_nomination', candidate_id: 'same', adoption: { kind: 'positive' } };
  const conflict = { gate: 'adoption_nomination', candidate_id: 'same', adoption: { kind: 'correction' } };
  const missing = { gate: 'adoption_nomination', adoption: { kind: 'correction' } };
  const rows = [same, structuredClone(same), conflict, missing, { ...missing, candidate_id: '  ' }];
  const result = adoptionCandidates(rows);
  assert.equal(result.items.length, 5);
  assert.ok(result.items.every((item) => item.identity === 'unknown'));
  assert.equal(result.items.filter((item) => item.trace_ref === null).length, 2);
  assert.deepEqual(adoptionCandidates(rows), result);
});

test('correlation collisions remain visible across the provided entries, including beyond the page', () => {
  const id = '12345678-1234-4123-8123-123456789abc';
  const other = '12345678-1234-4123-8123-123456789abd';
  const row = (key, correlationId, kind = 'positive') => ({ gate: 'adoption_nomination', candidate_id: key, correlationId, adoption: { kind } });
  for (const secondKind of ['positive', 'correction']) {
    const result = adoptionCandidates([row('a', id), row('z', id, secondKind), row('b', other),
      { gate: 'adoption_nomination', candidate_id: 'c', adoption: { kind: 'positive' } }], { limit: 3 });
    assert.equal(result.truncated, true);
    assert.equal(result.ambiguous_correlation_ids, 1);
    assert.equal(result.ambiguous_correlation_rows, 2);
    assert.equal(result.correlation_count_scope, 'provided_entries');
    assert.equal(result.unambiguous_count_scope, 'current_page_observed');
    assert.equal(result.unambiguous_page_keys, 2);
    assert.equal(result.items[0].correlationId, id);
    assert.equal(result.items[0].correlation_status, 'ambiguous');
    assert.equal(result.items[0].correlation_observed_count, 2);
    assert.equal(result.items[0].identity, 'unknown');
    assert.equal(result.items[1].correlation_status, 'unverified');
    assert.equal(result.items[2].correlation_status, 'missing');
    assert.equal(result.read_completeness, 'unknown');
  }
});

test('invalid correlation identifiers fail closed and are not echoed', () => {
  const result = adoptionCandidates([null, ...[null, '', '12345678-1234-1123-8123-123456789abc', 123].map((id, i) => ({
    gate: 'adoption_nomination', candidate_id: `bad${i}`, correlationId: id, adoption: { kind: 'positive' },
  }))]);
  assert.equal(result.items.length, 4);
  assert.equal(result.unambiguous_page_keys, 0);
  assert.equal(result.ambiguous_correlation_rows, 0);
  assert.ok(result.items.every((item) => item.kind === 'unknown' && item.identity === 'unknown'
    && item.correlation_status === 'invalid' && !Object.hasOwn(item, 'correlationId')));
  const unavailable = adoptionCandidates(null);
  assert.equal(unavailable.unambiguous_page_keys, null);
  assert.equal(unavailable.ambiguous_correlation_ids, null);
  assert.equal(unavailable.read_completeness, 'unknown');
});

test('limit is bounded and truncation is explicit', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ gate: 'adoption_nomination',
    candidate_id: `adoption:f/x.md@t${i}`, adoption: { provenance: 'caller/user-action', kind: 'positive' } }));
  const r = adoptionCandidates(rows, { limit: 3 });
  assert.equal(r.keys.length, 3);
  assert.equal(r.truncated, true);
});

test('runtime quarantines positive, correction and verification signals for all principles', async () => {
  const s = sandbox();
  try {
    const rt = createRuntime({ storageDir: s.dir });
    await rt.recordAdoptionSignal({ objectKey: 'functions/a.md', kind: 'positive' });
    await rt.recordAdoptionSignal({ objectKey: 'functions/b.md', kind: 'correction' });
    await appendDecision(s.dir, { gate: 'adoption_nomination', candidate_id: 'adoption:verification@1', origin: 'verification', adoption: { kind: 'correction', provenance: 'caller/user-action' } });
    const principles = [
      { ...principle('related'), anti_examples: [{ source: 'a', trace_ref: 'manual:1' }, { source: 'b', trace_ref: 'manual:2' }] },
      principle('unrelated'),
    ];
    const inputCopy = structuredClone(principles);
    const first = await rt.govern({ principles, consume_adoption: true });
    assert.deepEqual(principles, inputCopy);
    assert.deepEqual(first.principle_reports.map((p) => p.anti_example_count), [2, 0]);
    assert.deepEqual(first.redefinition_proposals, []);
    assert.equal(first.human_gate_required, false);
    assert.equal(first.adoption_pending, 3);
    assert.equal(first.adoption_consumed, undefined);
    const second = await rt.govern({ principles, consume_adoption: true, adoption_limit: 2 });
    assert.equal(second.adoption_pending, 2);
    assert.equal(second.adoption_truncated, true);
    assert.equal(second.adoption_count_scope, 'current_page');
    assert.equal(second.adoption_read_completeness, 'unknown');
    assert.equal(second.adoption_candidates.length, 2);
    assert.deepEqual(second.principle_reports.map((p) => p.anti_example_count), [2, 0]);
    const rows = await readDecisions(s.dir);
    assert.equal(rows.filter((row) => row.gate === 'adoption_nomination').length, 3);
    assert.equal(rows.some((row) => row.gate === 'adoption_consumed'), false);
  } finally { s.close(); }
});

test('replay exposes historical, ambiguous and missing identities without injection', async () => {
  const s = sandbox();
  try {
    const row = { gate: 'adoption_nomination', candidate_id: 'legacy', adoption: { kind: 'correction' } };
    for (const entry of [row, { ...row, adoption: { kind: 'positive' } }, { gate: 'adoption_nomination' }, adoptionConsumedRow(['legacy'])]) {
      assert.equal(await appendDecision(s.dir, entry), true);
    }
    const rt = createRuntime({ storageDir: s.dir });
    const input = { principles: [principle('P1')], consume_adoption: true };
    const first = await rt.govern(input);
    const second = await rt.govern(input);
    assert.equal(first.adoption_pending, 3);
    assert.deepEqual(first.adoption_candidates, second.adoption_candidates);
    assert.ok(first.adoption_candidates.every((item) => item.identity === 'unknown'));
    assert.equal(first.adoption_candidates.filter((item) => item.status === 'historical_consumed_unverified').length, 2);
    assert.equal(first.principle_reports[0].anti_example_count, 0);
    assert.deepEqual(first.redefinition_proposals, []);
    assert.equal((await readDecisions(s.dir)).filter((entry) => entry.gate === 'adoption_consumed').length, 1);
  } finally { s.close(); }
});

test('govern reports observed correlation ambiguity with distinct scopes on complete and partial reads', async () => {
  const s = sandbox();
  try {
    const correlationId = '6f923b31-2198-4f26-89b7-7f122755cafa';
    for (const [candidate_id, kind] of [['a', 'positive'], ['b', 'correction']]) {
      await appendDecision(s.dir, { gate: 'adoption_nomination', candidate_id, correlationId, adoption: { kind } });
    }
    await appendDecision(s.dir, { gate: 'adoption_nomination', candidate_id: 'c', adoption: { kind: 'positive' } });
    const rt = createRuntime({ storageDir: s.dir });
    const input = { principles: [principle('P')], consume_adoption: true, adoption_limit: 1 };
    for (const partial of [false, true]) {
      if (partial) appendFileSync(join(s.dir, 'mind-valves.jsonl'), '{broken json\n');
      const result = await rt.govern(input);
      assert.equal(result.adoption_pending, 1);
      assert.equal(result.adoption_count_scope, 'current_page');
      assert.equal(result.adoption_ambiguous_correlation_rows, 2);
      assert.equal(result.adoption_ambiguous_correlation_ids, 1);
      assert.equal(result.adoption_correlation_count_scope, 'provided_entries');
      assert.equal(result.adoption_unambiguous_page_keys, 0);
      assert.equal(result.adoption_unambiguous_count_scope, 'current_page_observed');
      assert.equal(result.adoption_read_completeness, 'unknown');
      assert.equal(result.adoption_candidates[0].correlation_status, 'ambiguous');
      assert.match(result.adoption_note, /not proof of uniqueness, governance eligibility or authenticated adoption/);
      if (!partial) assert.equal(result.principle_reports[0].anti_example_count, 0);
      else assert.equal(result.error, 'ledger_incomplete');
    }
  } finally { s.close(); }
});

test('corrupt ledger rows leave completeness unknown', async () => {
  const s = sandbox();
  try {
    await appendDecision(s.dir, { gate: 'adoption_nomination', candidate_id: 'visible' });
    appendFileSync(join(s.dir, 'mind-valves.jsonl'), '{broken json\n');
    const result = await createRuntime({ storageDir: s.dir }).govern({ principles: [], consume_adoption: true });
    assert.equal(result.adoption_pending, 1);
    assert.equal(result.adoption_read_completeness, 'unknown');
    assert.equal(result.adoption_truncated, false);
  } finally { s.close(); }
});

test('manual counterexamples retain their original proposal behavior', async () => {
  const s = sandbox();
  try {
    const rt = createRuntime({ storageDir: s.dir });
    await rt.recordAdoptionSignal({ objectKey: 'functions/x.md', kind: 'positive' });
    const anti_examples = [{ source: 'a', trace_ref: 'manual:1' }, { source: 'b', trace_ref: 'manual:2' }, { source: 'a', trace_ref: 'manual:3' }];
    const result = await rt.govern({ principles: [{ ...principle('P1'), anti_examples }], consume_adoption: true });
    assert.equal(result.principle_reports[0].anti_example_count, 3);
    assert.deepEqual(result.redefinition_proposals[0].evidence, anti_examples.map((a) => a.trace_ref));
    assert.equal(result.human_gate_required, true);
  } finally { s.close(); }
});

test('empty principles and disabled option never consume pending signals', async () => {
  const s = sandbox();
  try {
    const rt = createRuntime({ storageDir: s.dir });
    await rt.recordAdoptionSignal({ objectKey: 'functions/x.md', kind: 'correction' });
    const empty = await rt.govern({ principles: [], consume_adoption: true });
    assert.deepEqual(empty.principle_reports, []);
    assert.deepEqual(empty.redefinition_proposals, []);
    assert.equal(empty.adoption_pending, 1);
    for (const consume_adoption of [false, undefined]) {
      const result = await rt.govern({ principles: [principle('P1')], consume_adoption });
      assert.equal(result.adoption_pending, undefined);
      assert.equal(result.principle_reports[0].anti_example_count, 0);
      assert.deepEqual(result.redefinition_proposals, []);
    }
    const rows = await readDecisions(s.dir);
    assert.equal(rows.filter((row) => row.gate === 'adoption_nomination').length, 1);
    assert.equal(rows.some((row) => row.gate === 'adoption_consumed'), false);
  } finally { s.close(); }
});
