import assert from 'node:assert/strict';
import test from 'node:test';
import { Analyzer, validateRepairAction } from '../src/analyzer.js';

const candidate = () => ({ candidateId: 'retry', toolName: 'fixture.read', arguments: { path: 'input' },
  progressKey: 'read', preconditionIds: ['ready'], postconditionIds: ['read'], effect: 'read',
  source: { recipeId: 'fixture', version: '1' }, inputVersion: 'v1', idempotencyKey: 'retry-1', recoveryContractId: 'inspect' });
const pack = () => ({ schemaVersion: 1, taskId: 'task', attemptId: 'unexecuted:plan-gap', trigger: 'plan_gap',
  goal: 'Inspect input', scopeSummary: 'Read input only', candidate: null, decision: null,
  executionSummary: null, verification: null, recentTrace: ['No candidate found'], evidenceRefs: ['e:1'],
  truncation: { omittedBytes: 0, fields: [] } });
const repair = (kind = 'abort') => ({ diagnosis: { location: 'recipe', cause: 'wrong_guess', evidenceRefs: ['e:1'] },
  requiresHumanReview: false, kind, ...(kind === 'retry_with' ? { candidate: candidate() }
    : kind === 'gather_evidence' ? { probeIds: ['inspect-input'] }
      : kind === 'rollback_to' ? { checkpointId: 'cp:1', compensationPlanId: null } : { reason: 'Evidence insufficient' }) });
const validate = (value) => validateRepairAction(value, { allowedEvidenceRefs: ['e:1'] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

for (const kind of ['retry_with', 'gather_evidence', 'rollback_to', 'abort']) {
  test(`valid ${kind} proposal uses nonempty English instructions and quoted input`, async () => {
    let calls = 0;
    const analyzer = new Analyzer({ invoke: ({ instructions, input, signal }) => {
      calls++;
      assert.match(instructions, /untrusted data/);
      assert.ok(instructions.length > 0);
      assert.deepEqual(input, pack());
      assert.equal(signal.aborted, false);
      input.goal = 'Transport mutation';
      return JSON.stringify(repair(kind));
    } });
    const original = pack();
    assert.deepEqual(await analyzer.analyze(original), { status: 'proposed', repair: repair(kind) });
    assert.equal(calls, 1);
    assert.equal(original.goal, 'Inspect input');
    assert.equal(analyzer.pendingCount, 0);
    await analyzer.dispose();
  });
}

test('array discriminators cannot coerce into a repair branch and skip its validation', async () => {
  for (const kind of ['retry_with', 'gather_evidence', 'rollback_to', 'abort']) {
    const invalid = { ...repair(kind), kind: [kind] };
    if (kind === 'retry_with') invalid.candidate = {};
    if (kind === 'abort') invalid.reason = null;
    assert.throws(() => validate(invalid), { code: 'analysis_protocol_error' });
    const analyzer = new Analyzer({ invoke: async () => JSON.stringify(invalid) });
    assert.equal((await analyzer.analyze(pack())).status, 'analysis_parse_failed');
    await analyzer.dispose();
  }
});

test('repair rejects forged references, extra fields, mixed branches and invalid candidates', () => {
  const forged = repair(); forged.diagnosis.evidenceRefs.push('invented');
  const unknown = repair(); unknown.diagnosis.cause = 'unknown';
  const badCandidate = repair('retry_with'); delete badCandidate.candidate.postconditionIds;
  const goalCandidate = repair('retry_with'); goalCandidate.candidate.goal = 'New goal';
  const emptyProbe = repair('gather_evidence'); emptyProbe.probeIds = [];
  const duplicateProbe = repair('gather_evidence'); duplicateProbe.probeIds = ['p', 'p'];
  const manyProbes = repair('gather_evidence'); manyProbes.probeIds = Array.from({ length: 17 }, (_, i) => `p${i}`);
  for (const invalid of [forged, unknown, badCandidate, goalCandidate, emptyProbe, duplicateProbe, manyProbes,
    { ...repair(), goal: 'New goal' }, { ...repair(), scope: 'all' }, { ...repair(), authorization: true },
    { ...repair(), checkpointId: 'cp' }, { ...repair('rollback_to'), compensationPlanId: undefined }]) assert.throws(() => validate(invalid));
  unknown.requiresHumanReview = true;
  assert.deepEqual(validate(unknown), unknown);
  assert.throws(() => validateRepairAction(repair()));
  const rollback = repair('rollback_to'); rollback.compensationPlanId = 'compensate:1';
  assert.deepEqual(validate(rollback), rollback);
});

test('lossless JSON rejects prototype keys, getters, symbols, sparse arrays and non-finite values', () => {
  const getter = repair(); Object.defineProperty(getter, 'reason', { enumerable: true, get() { throw new Error('must not execute'); } });
  const symbol = repair(); symbol[Symbol('hidden')] = true;
  const sparse = repair('gather_evidence'); sparse.probeIds = new Array(1);
  const fakeDense = new Array(1); fakeDense['4294967295'] = 'lost';
  const nested = (value) => { const result = repair('retry_with'); result.candidate.arguments.value = value; return result; };
  for (const value of [getter, symbol, sparse, nested(fakeDense), nested(NaN), nested(Infinity), nested(-0), nested(2 ** 53), nested(undefined), nested(1n), nested(new Date()),
    nested(JSON.parse('{"__proto__":{}}')), nested({ constructor: 'forged' }), nested(Object.assign([1], { extra: true }))]) assert.throws(() => validate(value));
});

test('malformed JSON, duplicate escaped keys, parsed objects and UTF-8 byte overflow fail closed', async () => {
  const valid = JSON.stringify(repair());
  const duplicate = valid.replace('"kind":"abort"', '"kind":"retry_with","k\\u0069nd":"abort"');
  const nestedDuplicate = valid.replace('"location":"recipe"', '"location":"first","location":"recipe"');
  for (const raw of ['{', `${valid} trailing`, duplicate, nestedDuplicate, repair(), '{"__proto__":{}}',
    valid.replace('"reason":"Evidence insufficient"', '"reason":"Evidence insufficient","goal":"change"'),
    valid.replace('"Evidence insufficient"', `"${'界'.repeat(6000)}"`)]) {
    const analyzer = new Analyzer({ invoke: () => raw });
    assert.equal((await analyzer.analyze(pack())).status, 'analysis_parse_failed');
  }
  const analyzer = new Analyzer({ maxResponseBytes: Buffer.byteLength(valid) - 1, invoke: () => valid });
  assert.equal((await analyzer.analyze(pack())).status, 'analysis_parse_failed');
});

test('package validation rejects malformed or oversized data before invoking transport', async () => {
  let calls = 0;
  const analyzer = new Analyzer({ invoke: () => { calls++; return JSON.stringify(repair()); } });
  const oversized = pack(); oversized.executionSummary = '界'.repeat(6000);
  const badRefs = pack(); badRefs.evidenceRefs = ['e:1', 'e:1'];
  const badTrace = pack(); badTrace.recentTrace = ['a', 'b', 'c', 'd'];
  const badCandidate = pack(); badCandidate.candidate = {};
  for (const value of [{}, { ...pack(), schemaVersion: 2 }, { ...pack(), scope: 'forged' }, oversized, badRefs, badTrace, badCandidate,
    { ...pack(), truncation: { omittedBytes: -1, fields: [] } }]) {
    assert.equal((await analyzer.analyze(value)).error.code, 'invalid_analysis_package');
  }
  assert.equal(calls, 0);
});

test('pre-aborted analysis invokes transport zero times', async () => {
  let calls = 0;
  const analyzer = new Analyzer({ invoke: () => { calls++; } });
  const controller = new AbortController(); controller.abort();
  assert.equal((await analyzer.analyze(pack(), { signal: controller.signal })).status, 'analysis_cancelled');
  assert.equal(calls, 0);
});

test('timeout quarantines late proposals and exposes pending work until explicit drain', async () => {
  const late = deferred();
  let providerSignal;
  const analyzer = new Analyzer({ timeoutMs: 5, invoke: ({ signal }) => { providerSignal = signal; return late.promise; } });
  const result = await analyzer.analyze(pack());
  assert.equal(result.status, 'analysis_timeout');
  assert.equal(providerSignal.aborted, true);
  assert.equal(analyzer.pendingCount, 1);
  await analyzer.dispose();
  assert.equal(analyzer.pendingCount, 1);
  late.resolve(JSON.stringify(repair()));
  await analyzer.drain();
  assert.equal(analyzer.pendingCount, 0);
  assert.equal(result.status, 'analysis_timeout');
  assert.equal((await analyzer.analyze(pack())).status, 'analysis_cancelled');
});

test('cancellation quarantines late rejected work and disposal cancels active analyses', async () => {
  for (const dispose of [false, true]) {
    const late = deferred(); const entered = deferred();
    const analyzer = new Analyzer({ invoke: () => { entered.resolve(); return late.promise; } });
    const controller = new AbortController();
    const pending = analyzer.analyze(pack(), { signal: controller.signal });
    await entered.promise;
    if (dispose) await analyzer.dispose(); else controller.abort();
    assert.equal((await pending).status, 'analysis_cancelled');
    assert.equal(analyzer.pendingCount, 1);
    late.reject(new Error('Sensitive transport failure'));
    await analyzer.drain();
    assert.equal(analyzer.pendingCount, 0);
  }
});

test('synchronous and asynchronous provider failures return sanitized plain JSON', async () => {
  for (const invoke of [() => { throw new Error('secret'); }, async () => { throw new Error('secret'); }]) {
    const result = await new Analyzer({ invoke }).analyze(pack());
    assert.deepEqual(result, { status: 'analysis_failed', error: { code: 'analysis_transport_error', message: 'Analysis transport failed.' } });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  }
});

test('transport mutation cannot invent evidence authority', async () => {
  const analyzer = new Analyzer({ invoke: ({ input }) => {
    input.evidenceRefs.push('forged');
    const proposal = repair(); proposal.diagnosis.evidenceRefs = ['forged'];
    return JSON.stringify(proposal);
  } });
  assert.equal((await analyzer.analyze(pack())).status, 'analysis_parse_failed');
});

test('late successful proposal after cancellation stays quarantined', async () => {
  const late = deferred(); const entered = deferred();
  const analyzer = new Analyzer({ invoke: () => { entered.resolve(); return late.promise; } });
  const controller = new AbortController();
  const pending = analyzer.analyze(pack(), { signal: controller.signal });
  await entered.promise; controller.abort();
  const result = await pending;
  assert.equal(result.status, 'analysis_cancelled');
  late.resolve(JSON.stringify(repair()));
  await analyzer.drain();
  assert.deepEqual(result, { status: 'analysis_cancelled', error: { code: 'analysis_cancelled', message: 'Analysis cancelled.' } });
});

test('raw numeric precision loss and malformed Unicode fail closed', async () => {
  const proposal = repair('retry_with'); proposal.candidate.arguments.value = 0.1;
  const raw = JSON.stringify(proposal);
  for (const response of [raw.replace('"value":0.1', '"value":0.10000000000000001'),
    raw.replace('"value":0.1', '"value":1e-999'), raw.replace('"value":0.1', '"value":1e999'),
    raw.replace('"value":0.1', '"value":9007199254740993'), raw.replace('"value":0.1', '"value":"\\ud800"')]) {
    assert.equal((await new Analyzer({ invoke: () => response }).analyze(pack())).status, 'analysis_parse_failed');
  }
  assert.equal((await new Analyzer({ invoke: () => raw.replace('"value":0.1', '"value":1e-1') }).analyze(pack())).status, 'proposed');
});

test('constructor rejects unbounded configuration', () => {
  for (const config of [{}, { invoke: null }, { invoke() {}, timeoutMs: 0 }, { invoke() {}, timeoutMs: Infinity },
    { invoke() {}, maxResponseBytes: 16_385 }]) assert.throws(() => new Analyzer(config));
});
