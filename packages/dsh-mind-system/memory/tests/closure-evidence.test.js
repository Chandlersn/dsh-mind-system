import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyClosure } from '../src/closure-evidence.js';

function hop(status, identity, sourceType, actor, linkedTo) {
  return { status, identity, source: { type: sourceType, actor }, linkedTo };
}

function validChain(reviewActor = 'reviewer-x') {
  return {
    recall: hop('present', 'task-1', 'external', 'prestep', undefined),
    action: hop('present', 'task-1', 'self', 'agent', 'task-1'),
    result: hop('present', 'task-1', 'self', 'agent', 'task-1'),
    review: hop('present', 'task-1', 'external', reviewActor, 'task-1'),
  };
}

test('correlated chain with a distinct external review is still not a closure claim', () => {
  const r = classifyClosure(validChain());
  assert.equal(r.chain, 'correlated');
  assert.equal(r.independentReview, true);
  assert.equal(r.selfReviewCannotClose, false);
  assert.equal(r.closureClaim, 'not_asserted');
  assert.equal(r.humanAdoption, 'not_evaluated');
  assert.equal(r.governanceEligible, false);
});

test('self-produced review cannot close the loop even when all hops are present', () => {
  const chain = validChain('agent'); // same actor as action/result
  const r = classifyClosure(chain);
  assert.equal(r.chain, 'correlated');
  assert.equal(r.independentReview, false);
  assert.equal(r.selfReviewCannotClose, true);
  assert.equal(r.closureClaim, 'not_asserted');
});

test('explicit source.type self is never independent', () => {
  const chain = validChain();
  chain.review.source.type = 'self';
  const r = classifyClosure(chain);
  assert.equal(r.independentReview, false);
  assert.equal(r.selfReviewCannotClose, true);
});

test('wrong identity link degrades to not_correlated, never correlated', () => {
  const chain = validChain();
  chain.review.linkedTo = 'task-OTHER';
  const r = classifyClosure(chain);
  assert.equal(r.chain, 'not_correlated');
  assert.equal(r.independentReview, false);
});

test('missing hop stays unknown and never closes', () => {
  const chain = validChain();
  chain.result = { status: 'missing', identity: 'task-1', source: { type: 'self', actor: 'agent' }, linkedTo: 'task-1' };
  const r = classifyClosure(chain);
  assert.equal(r.chain, 'unknown');
  assert.equal(r.independentReview, false);
});

test('absent hop is unknown, not evidence that there is no loop', () => {
  const r = classifyClosure({ recall: hop('present', 'task-1', 'external', 'prestep', undefined) });
  assert.equal(r.hops.action.status, 'unknown');
  assert.equal(r.chain, 'unknown');
});

test('malformed input degrades whole chain to unknown, never to a clean result', () => {
  const chain = validChain();
  chain.action.identity = 'bad identity'; // spaces not allowed
  const r = classifyClosure(chain);
  assert.equal(r.chain, 'unknown');
  assert.equal(r.degraded, 'malformed_input');
  assert.equal(r.independentReview, false);
});

test('external review without an actor is not independent', () => {
  const chain = validChain();
  chain.review.source.actor = undefined;
  const r = classifyClosure(chain);
  assert.equal(r.independentReview, false);
  assert.equal(r.closureClaim, 'not_asserted');
});

test('identity drift across hops is not correlated even if links are adjacent', () => {
  const chain = validChain();
  chain.action.identity = 'task-B'; chain.action.linkedTo = 'task-1';
  chain.result.identity = 'task-C'; chain.result.linkedTo = 'task-B';
  chain.review.identity = 'task-D'; chain.review.linkedTo = 'task-C';
  const r = classifyClosure(chain);
  assert.equal(r.chain, 'not_correlated');
  assert.equal(r.independentReview, false);
});

test('missing actor on any hop degrades and never yields independent review', () => {
  const chain = validChain();
  delete chain.action.source.actor;
  delete chain.result.source.actor;
  chain.review.source.actor = 'agent';
  const r = classifyClosure(chain);
  assert.equal(r.independentReview, false);
  assert.equal(r.closureClaim, 'not_asserted');
});

test('malformed actor with illegal characters degrades whole chain', () => {
  const chain = validChain();
  chain.result.source.actor = 'bad actor';
  const r = classifyClosure(chain);
  assert.equal(r.chain, 'unknown');
  assert.equal(r.degraded, 'malformed_input');
  assert.equal(r.independentReview, false);
});

test('actor equal to its own hop identity is ambiguous, never independent', () => {
  const chain = validChain();
  chain.recall.source.actor = 'task-1'; // actor == identity, namespace conflation
  const r = classifyClosure(chain);
  assert.equal(r.independentReview, false);
  assert.equal(r.selfReviewCannotClose, true);
});

test('self-produced recall with no external review never asserts closure', () => {
  const chain = validChain();
  chain.recall.source.type = 'self';
  chain.review.source.type = 'self';
  const r = classifyClosure(chain);
  assert.equal(r.chain, 'correlated');
  assert.equal(r.independentReview, false);
  assert.equal(r.closureClaim, 'not_asserted');
});
