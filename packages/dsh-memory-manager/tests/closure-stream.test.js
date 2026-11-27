import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClosureStream } from '../src/closure-stream.js';

const flowWith = edges => ({ snapshot: () => ({ edges, dropped: 0 }) });
const allEdges = {
  e10: { phase: 'finished' },
  e2: { phase: 'finished' },
  e3: { phase: 'finished' },
};
const humanReview = { actor: 'boss', sourceType: 'external' };

test('observes three hops from the passive live-flow snapshot', () => {
  const stream = createClosureStream({ flow: flowWith(allEdges), now: () => 1 });
  const o = stream.observe();
  assert.equal(o.recall, true);
  assert.equal(o.action, false);
  assert.equal(o.result, true);
  assert.equal(o.source, 'live_flow');
  assert.equal(o.observedAt, 1);
});

test('unavailable flow is reported, never treated as absent evidence', () => {
  const stream = createClosureStream({ flow: null, now: () => 1 });
  const o = stream.observe();
  assert.equal(o.source, 'unavailable');
  assert.equal(o.recall, false);
});

test('no taskId keeps all hops unknown and never correlates', () => {
  const stream = createClosureStream({ flow: flowWith(allEdges) });
  const r = stream.report({ review: humanReview });
  assert.equal(r.correlation, 'required');
  assert.equal(r.chain, 'unknown');
  assert.equal(r.independentReview, false);
});

test('no human review stays incomplete and never self-closes', () => {
  const stream = createClosureStream({ flow: flowWith(allEdges) });
  const r = stream.report({ taskId: 'task-1' });
  assert.equal(r.reviewSupplied, false);
  assert.equal(r.independentReview, false);
  assert.equal(r.closureClaim, 'not_asserted');
});

test('agent-supplied review cannot become an independent review', () => {
  const stream = createClosureStream({ flow: flowWith(allEdges) });
  const r = stream.report({ taskId: 'task-1', review: { actor: 'agent', sourceType: 'external' } });
  assert.equal(r.independentReview, false);
  assert.equal(r.selfReviewCannotClose, true);
});

test('human review with full chain yields correlated, independent, still not asserted', () => {
  const stream = createClosureStream({ flow: flowWith({
    e10: { phase: 'finished' },
    e2: { phase: 'active' },
    e3: { phase: 'finished' },
  }) });
  const r = stream.report({ taskId: 'task-1', review: humanReview });
  assert.equal(r.chain, 'correlated');
  assert.equal(r.independentReview, true);
  assert.equal(r.closureClaim, 'not_asserted');
  assert.equal(r.humanAdoption, 'not_evaluated');
});

test('malformed taskId degrades to unknown', () => {
  const stream = createClosureStream({ flow: flowWith(allEdges) });
  const r = stream.report({ taskId: 'bad id', review: humanReview });
  assert.equal(r.correlation, 'required');
  assert.equal(r.chain, 'unknown');
  assert.equal(r.independentReview, false);
});
