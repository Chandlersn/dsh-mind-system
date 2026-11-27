/**
 * Adoption-signal bookkeeping (caller/user-action -> governance-visible trace).
 *
 * A user's explicit positive/correction is left in the ledger as a human-review
 * raw material. It must NOT nominate, admit, confirm or change any rule, must
 * carry the noPromotion safety shape, and must stay out of daily calibration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRuntime } from '../index.js';
import { adoptionCandidates } from '../src/adoption-consumer.js';
import { appendDecision, readDecisions, summarizeDecisions } from '../src/store.js';

test('correlated signals append independently without implying idempotency or attribution', async () => {
  const s = sandbox();
  try {
    const rt = createRuntime({ storageDir: s.dir });
    const eventId = randomUUID();
    const base = { schemaVersion: 1, eventId, objectKey: 'functions/example.md', kind: 'positive', note: 'ok' };
    assert.equal(await rt.recordCorrelatedAdoptionSignal(base), 'appended');
    assert.equal(await rt.recordCorrelatedAdoptionSignal(base), 'appended');
    assert.equal(await rt.recordCorrelatedAdoptionSignal({ ...base, kind: 'correction', objectKey: 'insights/example.md' }), 'appended');
    const rows = await readDecisions(s.dir);
    assert.equal(rows.length, 3);
    assert.ok(rows.every(row => row.correlationId === eventId && row.adoption.governanceEligible === false));
    assert.equal(new Set(rows.map(row => row.candidate_id)).size, 3);
    assert.deepEqual(rows.map(row => row.adoption.kind), ['positive', 'positive', 'correction']);
    assert.ok(rows.every(row => row.adoption.provenance === 'caller/user-action' && row.adoption.principleAttribution === 'not_evaluated'));
  } finally { s.close(); }
});

test('correlated signals reject malformed inputs and redact credentials', async () => {
  const s = sandbox();
  try {
    const rt = createRuntime({ storageDir: s.dir });
    const base = { schemaVersion: 1, eventId: randomUUID(), objectKey: 'functions/example.md', kind: 'positive' };
    for (const bad of [null, {}, { ...base, schemaVersion: 2 }, { ...base, eventId: randomUUID().toUpperCase() },
      { ...base, eventId: 'not-a-uuid' }, { ...base, objectKey: 'functions/../example.md' },
      { ...base, objectKey: 'functions/example' }, { ...base, objectKey: 'functions/' + 'x'.repeat(61) + '.md' },
      { ...base, kind: 'recall' }, { ...base, note: 'x'.repeat(2049) }, { ...base, extra: true },
      { ...base, objectKey: 'functions/sk-' + 'a'.repeat(30) + '.md' }]) {
      assert.equal(await rt.recordCorrelatedAdoptionSignal(bad), 'invalid');
    }
    assert.deepEqual(await readDecisions(s.dir), []);
    const secret = 'sk-' + 'a'.repeat(30);
    assert.equal(await rt.recordCorrelatedAdoptionSignal({ ...base, note: `key ${secret}` }), 'appended');
    const [row] = await readDecisions(s.dir);
    assert.equal(row.adoption.note, 'key [REDACTED:openai-key]');
    assert.equal(JSON.stringify(row).includes(secret), false);
  } finally { s.close(); }
});

test('correlated append false or throw is unconfirmed even after a committed row', async () => {
  const s = sandbox();
  try {
    const base = { schemaVersion: 1, eventId: randomUUID(), objectKey: 'functions/example.md', kind: 'correction' };
    for (const mode of ['false', 'throw']) {
      let calls = 0;
      const rt = createRuntime({ storageDir: s.dir, appendAdoptionDecision: async (dir, row) => {
        calls++;
        assert.equal(await appendDecision(dir, row), true);
        if (mode === 'throw') throw new Error('ack lost');
        return false;
      } });
      assert.equal(await rt.recordCorrelatedAdoptionSignal(base), 'unconfirmed');
      assert.equal(calls, 1);
    }
    assert.equal((await readDecisions(s.dir)).length, 2);
  } finally { s.close(); }
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'adoption-signal-'));
  return { dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('recordAdoptionSignal writes a human-review trace with noPromotion safety', async () => {
  const s = sandbox();
  try {
    const rt = createRuntime({ storageDir: s.dir });
    const ok = await rt.recordAdoptionSignal({ objectKey: 'functions/心智编排层.md', kind: 'correction', note: '用户纠正：不要按单日蒸馏' });
    assert.equal(ok, true);
    const rows = await readDecisions(s.dir);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.gate, 'adoption_nomination');
    assert.equal(row.origin, 'adoption');
    assert.equal(row.direction, 'up');
    assert.equal(row.action, 'noted');
    assert.ok(row.candidate_id.startsWith('adoption:functions/心智编排层.md@'), 'event-level key must include time');
    assert.equal(row.adoption.objectKey, 'functions/心智编排层.md');
    assert.equal(row.adoption.kind, 'correction');
    assert.equal(row.adoption.provenance, 'caller/user-action');
    assert.equal(row.adoption.goalProof, 'not_evaluated');
    assert.equal(row.adoption.principleAttribution, 'not_evaluated');
    assert.equal(row.adoption.governanceEligible, false);
  } finally { s.close(); }
});

test('same-millisecond events remain distinct and legacy keys remain readable', async (t) => {
  const s = sandbox();
  try {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T00:00:00.000Z') });
    const rt = createRuntime({ storageDir: s.dir });
    const oldKey = 'adoption:functions/x.md@2026-01-01T00:00:00.000Z';
    assert.equal(await appendDecision(s.dir, { gate: 'adoption_nomination', candidate_id: oldKey, origin: 'adoption' }), true);
    const results = await Promise.all(Array.from({ length: 20 }, () => rt.recordAdoptionSignal({ objectKey: 'functions/x.md', kind: 'positive' })));
    assert.ok(results.every(Boolean));
    const rows = await readDecisions(s.dir);
    assert.equal(rows.length, 21);
    assert.equal(new Set(rows.map((row) => row.candidate_id)).size, 21);
    assert.ok(rows.slice(1).every((row) => /^adoption:functions\/x\.md@2026-01-01T00:00:00\.000Z#[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.candidate_id)));
    assert.ok(adoptionCandidates(rows).keys.includes(oldKey));
    const result = await rt.govern({ principles: [{ principle_id: 'p' }], consume_adoption: true });
    assert.equal(result.adoption_pending, 21);
    assert.equal(result.principle_reports[0].anti_example_count, 0);
    assert.deepEqual(result.redefinition_proposals, []);
    assert.equal((await readDecisions(s.dir)).some((row) => row.gate === 'adoption_consumed'), false);
  } finally { t.mock.timers.reset(); s.close(); }
});

test('separate processes create distinct event ids at the same timestamp', async () => {
  const s = sandbox();
  try {
    const moduleUrl = new URL('../index.js', import.meta.url).href;
    const script = `
      import { createRuntime } from ${JSON.stringify(moduleUrl)};
      const NativeDate = Date;
      globalThis.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : ['2026-01-01T00:00:00.000Z'])); }
        static now() { return new NativeDate('2026-01-01T00:00:00.000Z').getTime(); }
      };
      const runtime = createRuntime({ storageDir: process.argv[1] });
      if (!await runtime.recordAdoptionSignal({ objectKey: 'functions/x.md', kind: 'correction' })) process.exitCode = 1;
    `;
    const exits = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, s.dir], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    })));
    assert.ok(exits.every(({ code, signal }) => code === 0 && signal === null));
    const rows = await readDecisions(s.dir);
    assert.equal(rows.length, 4);
    assert.ok(rows.every((row) => row.t === '2026-01-01T00:00:00.000Z'));
    assert.equal(new Set(rows.map((row) => row.candidate_id)).size, 4);
  } finally { s.close(); }
});

test('adoption rows are excluded from daily calibration and never become verdicts', async () => {
  const s = sandbox();
  try {
    const rt = createRuntime({ storageDir: s.dir });
    await rt.recordAdoptionSignal({ objectKey: 'functions/demo.md', kind: 'positive', note: 'ok' });
    await rt.recordAdoptionSignal({ objectKey: 'insights/demo.md', kind: 'correction', note: 'nope' });
    const sum = await summarizeDecisions(s.dir);
    const daily = sum?.dailyCount ?? sum?.origins?.daily ?? 0;
    assert.equal(daily, 0, 'adoption must not inflate the daily calibration pool');
    const rows = await readDecisions(s.dir);
    assert.ok(rows.every((r) => r.outcome === 'admitted' && r.action === 'noted'));
    // No rule was created/confirmed: only the two adoption traces exist.
    assert.equal(rows.length, 2);
  } finally { s.close(); }
});

test('shortens unbounded note and tolerates missing fields without inventing identity', async () => {
  const s = sandbox();
  try {
    const rt = createRuntime({ storageDir: s.dir });
    await rt.recordAdoptionSignal({ objectKey: 'functions/x.md', kind: 'positive', note: 'z'.repeat(5000) });
    await rt.recordAdoptionSignal({});
    const rows = await readDecisions(s.dir);
    assert.equal(rows[0].adoption.note.length, 2048);
    assert.equal(rows[1].adoption.objectKey, null);
    assert.equal(rows[1].adoption.kind, null);
    assert.equal(rows[1].candidate_id, undefined);
    assert.equal(rows[1].origin, 'adoption');
  } finally { s.close(); }
});
