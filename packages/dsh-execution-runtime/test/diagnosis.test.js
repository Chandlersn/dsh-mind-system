import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailureRoute, validateDiagnosis, createDiagnosisEscalation,
  nextStepAfterDiagnosis } from '../src/diagnosis.js';

test('a self-explanatory error is repaired directly instead of diagnosed', () => {
  const route = classifyFailureRoute({ trigger: 'execution_error', selfExplanatory: true, signatureFailures: 5 });
  assert.equal(route.route, 'repair_directly');
  assert.equal(route.reason, 'self_explanatory_error');
});

test('a first occurrence is repaired directly; only repetition earns a diagnosis', () => {
  assert.equal(classifyFailureRoute({ trigger: 'verification_failed', signatureFailures: 1, repairAttempts: 1 }).route,
    'repair_directly');
  const repeated = classifyFailureRoute({ trigger: 'verification_failed', signatureFailures: 2, repairAttempts: 2 });
  assert.equal(repeated.route, 'diagnose');
  assert.equal(repeated.reason, 'repeated_without_progress');
  assert.throws(() => classifyFailureRoute({ trigger: 'x', signatureFailures: -1 }), { code: 'invalid_diagnosis_route' });
  assert.throws(() => classifyFailureRoute({ trigger: '' }), { code: 'invalid_contract' });
});

test('unknown is a first-class diagnosis and cannot smuggle a confidence or a cause', () => {
  const unknown = validateDiagnosis({ structure: 'unknown', summary: 'Not enough evidence to tell.' });
  assert.equal(unknown.resolved, false);
  assert.equal(unknown.confidence, null);
  for (const invalid of [
    { structure: 'unknown', confidence: 0.8 },
    { structure: 'invented' },
    { structure: 'cyclic', extra: true },
    { structure: 'cyclic', confidence: 1.5 },
    { structure: 'cyclic', evidenceRefs: [1] },
    { structure: 'cyclic', summary: 'x'.repeat(2001) },
    [],
  ]) assert.throws(() => validateDiagnosis(invalid), { code: 'invalid_diagnosis' });
});

test('a resolved diagnosis carries structure and evidence but never authorizes repair', () => {
  const resolved = validateDiagnosis({ structure: 'cyclic', confidence: 0.7, evidenceRefs: ['trace:1'],
    summary: 'Retry amplifies the original cause.' });
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.confidence, 0.7);
  assert.equal(Object.isFrozen(resolved), true);
  const next = nextStepAfterDiagnosis({ status: 'resolved', diagnostic: resolved });
  assert.equal(next.status, 'waiting_analysis');
  assert.equal(next.reason, 'diagnosed_cyclic');
  assert.equal(next.repairAuthorized, false, 'A structure is guidance, not permission.');
});

test('an unknown or unavailable diagnosis stops for a human instead of guessing', () => {
  const unknown = validateDiagnosis({ structure: 'unknown' });
  const fromUnknown = nextStepAfterDiagnosis({ status: 'unknown', diagnostic: unknown });
  assert.equal(fromUnknown.status, 'waiting_human');
  assert.equal(fromUnknown.reason, 'diagnosis_unknown');
  assert.equal(nextStepAfterDiagnosis({ status: 'unavailable', reason: 'http_500' }).reason, 'diagnosis_unavailable');
  assert.equal(nextStepAfterDiagnosis({ status: 'budget_exhausted' }).reason, 'diagnosis_budget_exhausted');
  assert.throws(() => nextStepAfterDiagnosis(null), { code: 'invalid_diagnosis_outcome' });
});

test('diagnosis is called at most once per task and never twice for the same signature', async () => {
  let calls = 0;
  const escalation = createDiagnosisEscalation({ diagnose: async () => { calls++; return { structure: 'unidirectional' }; } });
  const first = await escalation.request({ taskId: 't1', trigger: 'verification_failed', signature: 'sig-1' });
  assert.equal(first.status, 'resolved');
  assert.equal(calls, 1);
  const second = await escalation.request({ taskId: 't1', trigger: 'verification_failed', signature: 'sig-1' });
  assert.equal(second.status, 'budget_exhausted');
  assert.equal(calls, 1, 'A repeated question must not be re-asked.');
  // A different task has its own budget.
  await escalation.request({ taskId: 't2', trigger: 'verification_failed', signature: 'sig-1' });
  assert.equal(calls, 2);
});

test('a transport failure or malformed answer is unavailable, not a loosened cause', async () => {
  const throwing = createDiagnosisEscalation({ diagnose: async () => { throw new Error('offline'); } });
  const failed = await throwing.request({ taskId: 't', trigger: 'no_progress', signature: 's' });
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.diagnostic, null);
  const malformed = createDiagnosisEscalation({ diagnose: async () => ({ structure: 'made-up' }) });
  const rejected = await malformed.request({ taskId: 't', trigger: 'no_progress', signature: 's' });
  assert.equal(rejected.status, 'unavailable');
  assert.equal(rejected.reason, 'invalid_diagnosis');
});

test('the escalation refuses unbounded configuration and missing identities', async () => {
  assert.throws(() => createDiagnosisEscalation({}), { code: 'invalid_diagnosis_escalation' });
  assert.throws(() => createDiagnosisEscalation({ diagnose: async () => null, maxCallsPerTask: 9 }),
    { code: 'invalid_diagnosis_escalation' });
  const escalation = createDiagnosisEscalation({ diagnose: async () => ({ structure: 'unknown' }) });
  await assert.rejects(escalation.request({ trigger: 'x', signature: 's' }), { code: 'invalid_contract' });
  await assert.rejects(escalation.request({ taskId: 't', trigger: 'x' }), { code: 'invalid_contract' });
});
