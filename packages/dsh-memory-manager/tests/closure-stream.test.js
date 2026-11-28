import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClosureStream } from '../src/closure-stream.js';
import { createLiveFlow } from '../src/live-flow.js';

const flowWith = edges => ({ snapshot: () => ({ edges }) });
const fullFlow = flowWith({ e10: { phase: 'finished' }, e2: { phase: 'active' }, e3: { phase: 'finished' } });
const humanReview = { actor: 'boss', sourceType: 'external' };
const makeEvent = (taskId, kind, overrides = {}) => {
  const kinds = ['recall', 'action', 'result', 'review'];
  const index = kinds.indexOf(kind);
  return {
    taskId,
    eventId: `${taskId}:${kind}`,
    kind,
    ...(index > 0 ? { linkedTo: `${taskId}:${kinds[index - 1]}` } : {}),
    source: { type: kind === 'action' || kind === 'result' ? 'self' : 'external', actor: kind === 'review' ? 'boss' : kind === 'recall' ? 'prestep' : 'agent' },
    ...(kind === 'result' ? { evidence: { kind: 'persisted_artifact', ref: 'artifact-1', status: 'observed' } } : {}),
    ...(kind === 'review' ? { evidence: { kind: 'question_answer', ref: 'question-call-1', status: 'answered' } } : {}),
    ...overrides,
  };
};
const recordChain = (stream, taskId = 'task-1') => {
  for (const kind of ['recall', 'action', 'result', 'review']) assert.equal(stream.record(makeEvent(taskId, kind)).accepted, true);
};

test('legacy flow remains diagnostic even with caller task and external review', () => {
  const stream = createClosureStream({ flow: fullFlow, now: () => 1 });
  assert.deepEqual(stream.observe(), { recall: true, action: true, result: true, observedAt: 1, source: 'live_flow' });
  const report = stream.report({ taskId: 'task-1', review: humanReview });
  assert.equal(report.chain, 'unknown');
  assert.equal(report.independentReview, false);
  assert.equal(report.correlation, 'unbound');
  assert.equal(report.reviewSupplied, false);
  assert.ok(Object.values(report.hops).every(hop => hop.status === 'unknown' && hop.identity === null));
});

test('automatic searches never become tool observations, including late finishes and overlapping calls', () => {
  const flow = createLiveFlow({ now: () => 1 });
  const stream = createClosureStream({ flow });
  const observations = () => {
    const { action, result, recall } = stream.observe();
    return [action, result, recall];
  };
  const settle = flow.automaticSagStarted();
  assert.deepEqual(observations(), [false, false, false]);
  const manual = { token: Symbol(), name: 'memory_sag', arguments: {} };
  flow.start(manual);
  assert.deepEqual(observations(), [true, false, false]);
  settle('timeout');
  assert.deepEqual(observations(), [true, false, false]);
  flow.finish(manual, { isError: false });
  settle('success');
  assert.equal(flow.snapshot().edges.e15.source, undefined);
  assert.deepEqual(observations(), [false, true, false]);
  flow.automaticSagStarted()('success');
  assert.deepEqual(observations(), [false, false, false]);
  flow.recallJoined(true);
  assert.deepEqual(observations(), [false, false, true]);
  assert.equal(stream.report().chain, 'unknown');
});

test('unavailable or throwing legacy flow cannot provide evidence', () => {
  for (const flow of [null, { snapshot() { throw new Error('unavailable'); } }]) {
    const stream = createClosureStream({ flow });
    assert.equal(stream.observe().source, 'unavailable');
    assert.equal(stream.report().chain, 'unknown');
    assert.equal(stream.report({ taskId: 'bad id' }).correlation, 'required');
  }
});

test('serial task events retain completed actions and explicit review lineage', () => {
  const stream = createClosureStream();
  for (const kind of ['recall', 'action', 'result']) assert.equal(stream.record(makeEvent('task-1', kind)).accepted, true);
  const before = stream.report({ taskId: 'task-1', review: humanReview });
  assert.equal(before.hops.action.status, 'present');
  assert.equal(before.hops.result.status, 'present');
  assert.equal(before.hops.review.status, 'missing');
  assert.equal(before.independentReview, false);
  assert.equal(stream.record(makeEvent('task-1', 'review')).accepted, true);
  const report = stream.report({ taskId: 'task-1' });
  assert.equal(report.chain, 'correlated');
  assert.equal(report.declaredIndependentReview, true);
  assert.equal(report.independentReview, false);
  assert.equal(report.incomplete, false);
  assert.equal(report.provenance, 'caller_declared_unverified');
  assert.equal(report.humanIdentity, 'unknown');
  assert.equal(report.principleValidity, 'unknown');
  assert.equal(report.goalProof, 'not_evaluated');
  assert.equal(report.principleAttribution, 'not_evaluated');
  assert.equal(report.governanceEligible, false);
  assert.deepEqual(report.eventRefs, { recall: 'task-1:recall', action: 'task-1:action', result: 'task-1:result', review: 'task-1:review' });
});

test('tool completion cannot substitute for persisted evidence', () => {
  for (const evidence of [undefined, { kind: 'tool_finished', ref: 'call-1', status: 'observed' }]) {
    const stream = createClosureStream({ flow: fullFlow });
    stream.record(makeEvent('task-1', 'recall'));
    stream.record(makeEvent('task-1', 'action'));
    assert.equal(stream.record(makeEvent('task-1', 'result', { evidence })).accepted, false);
    assert.equal(stream.report({ taskId: 'task-1' }).chain, 'unknown');
    assert.equal(stream.report({ taskId: 'task-1' }).independentReview, false);
  }
});

test('interleaved tasks never share predecessor events or query-time labels', () => {
  const stream = createClosureStream();
  stream.record(makeEvent('A', 'recall'));
  stream.record(makeEvent('B', 'recall'));
  stream.record(makeEvent('A', 'action'));
  assert.equal(stream.record(makeEvent('B', 'result', { linkedTo: 'A:action' })).accepted, false);
  assert.equal(stream.report({ taskId: 'B' }).chain, 'unknown');
  assert.equal(stream.report({ taskId: 'C' }).hops.action.identity, null);
  stream.record(makeEvent('A', 'result'));
  stream.record(makeEvent('A', 'review'));
  assert.equal(stream.report({ taskId: 'A' }).chain, 'correlated');
});

test('review must reference its known result and question-answer evidence', () => {
  for (const overrides of [{ linkedTo: 'task-1:action' }, { linkedTo: 'foreign:result' }, { evidence: { kind: 'question_answer', ref: 'call-1', status: 'skipped' } }]) {
    const stream = createClosureStream();
    for (const kind of ['recall', 'action', 'result']) stream.record(makeEvent('task-1', kind));
    assert.equal(stream.record(makeEvent('task-1', 'review', overrides)).accepted, false);
    assert.equal(stream.report({ taskId: 'task-1' }).independentReview, false);
  }
});

test('self review cannot become independent even when declared external', () => {
  const stream = createClosureStream();
  for (const kind of ['recall', 'action', 'result']) stream.record(makeEvent('task-1', kind));
  stream.record(makeEvent('task-1', 'review', { source: { type: 'external', actor: 'agent' } }));
  const report = stream.report({ taskId: 'task-1' });
  assert.equal(report.chain, 'correlated');
  assert.equal(report.independentReview, false);
  assert.equal(report.selfReviewCannotClose, true);
});

test('duplicate replay is idempotent but conflicting replay poisons previous positive evidence', () => {
  const stream = createClosureStream();
  recordChain(stream);
  assert.equal(stream.record(makeEvent('task-1', 'review')).duplicate, true);
  assert.equal(stream.record(makeEvent('task-1', 'review', { source: { type: 'self', actor: 'agent' } })).reason, 'event_conflict');
  assert.equal(stream.report({ taskId: 'task-1' }).chain, 'unknown');
  assert.equal(stream.report({ taskId: 'task-1' }).independentReview, false);
  assert.equal(stream.snapshot().tasks[0].conflicted, true);
});

test('cross-task event identity collision poisons both tasks', () => {
  const stream = createClosureStream();
  recordChain(stream, 'A');
  assert.equal(stream.record(makeEvent('B', 'recall', { eventId: 'A:recall' })).reason, 'event_identity_conflict');
  assert.equal(stream.report({ taskId: 'A' }).chain, 'unknown');
  assert.equal(stream.report({ taskId: 'B' }).chain, 'unknown');
});

test('event capacity marks a sticky incomplete prefix, even after a formerly complete chain', () => {
  const stream = createClosureStream({ maxEventsPerTask: 4 });
  recordChain(stream);
  assert.equal(stream.record(makeEvent('task-1', 'recall', { eventId: 'extra' })).reason, 'event_limit');
  const report = stream.report({ taskId: 'task-1' });
  assert.equal(report.truncated, true);
  assert.equal(report.incomplete, true);
  assert.equal(report.chain, 'unknown');
  assert.equal(report.independentReview, false);
  assert.equal(stream.snapshot().tasks[0].events.length, 4);
});

test('task eviction never washes away a conflict or restores complete reports', () => {
  const stream = createClosureStream({ maxTasks: 1 });
  recordChain(stream, 'A');
  stream.record(makeEvent('A', 'review', { source: { type: 'self', actor: 'agent' } }));
  recordChain(stream, 'B');
  assert.equal(stream.snapshot().tasks.length, 1);
  assert.equal(stream.report({ taskId: 'A' }).chain, 'unknown');
  assert.equal(stream.report({ taskId: 'B' }).truncated, true);
  assert.equal(stream.report({ taskId: 'B' }).chain, 'unknown');
  assert.equal(stream.report({ taskId: 'B' }).independentReview, false);
});

test('records, snapshots and reports cannot mutate the retained evidence', () => {
  const stream = createClosureStream();
  const recall = makeEvent('task-1', 'recall');
  stream.record(recall);
  recall.source.actor = 'mutated';
  for (const kind of ['action', 'result', 'review']) stream.record(makeEvent('task-1', kind));
  stream.snapshot().tasks[0].events[0].source.actor = 'mutated';
  stream.report({ taskId: 'task-1' }).hops.recall.actor = 'mutated';
  assert.equal(stream.report({ taskId: 'task-1' }).hops.recall.actor, 'prestep');
});

test('unrelated newer action cannot be spliced into an earlier reviewed lineage', () => {
  const stream = createClosureStream();
  recordChain(stream);
  stream.record(makeEvent('task-1', 'recall', { eventId: 'other-recall' }));
  stream.record(makeEvent('task-1', 'action', { eventId: 'other-action', linkedTo: 'other-recall' }));
  assert.equal(stream.report({ taskId: 'task-1' }).eventRefs.action, 'task-1:action');
});

test('malformed input fails closed and retention options are bounded', () => {
  const stream = createClosureStream();
  assert.equal(stream.record(null).accepted, false);
  assert.equal(stream.record({ taskId: 'bad id' }).accepted, false);
  for (const value of [0, -1, 1.5, Infinity, 1025]) {
    assert.throws(() => createClosureStream({ maxTasks: value }), RangeError);
    assert.throws(() => createClosureStream({ maxEventsPerTask: value }), RangeError);
  }
  assert.throws(() => createClosureStream({ now: 1 }), TypeError);
});
