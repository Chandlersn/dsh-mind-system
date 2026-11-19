import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeRef, readKnowledge, writeKnowledge, createGovernanceOutbox } from '../src/knowledge.js';

const ref = (overrides = {}) => ({ domain: 'formal', id: 'doc-1', version: '3', ...overrides });

const adapter = (overrides = {}) => ({
  async read({ domain, id, version }) { return { identity: { domain, id, version }, content: `${domain}/${id}@${version}`, verified: domain === 'formal' }; },
  async write() { return { stored: true, indexed: true }; },
  ...overrides,
});

test('a knowledge reference carries its domain, so identity is never inferred from a path', () => {
  assert.equal(knowledgeRef(ref()).ref, 'formal:doc-1@3');
  assert.equal(knowledgeRef(ref({ domain: 'scratch' })).ref, 'scratch:doc-1@3');
  for (const domain of ['unknown', '', null]) {
    assert.throws(() => knowledgeRef(ref({ domain })), { code: 'invalid_knowledge_ref' });
  }
  assert.throws(() => knowledgeRef({ domain: 'formal', id: '', version: '1' }), { code: 'invalid_contract' });
});

test('reading keeps the domain identity: scratch content is not relabelled as formal', async () => {
  const formal = await readKnowledge({ adapter: adapter(), reference: ref() });
  assert.equal(formal.trust, 'formal');
  assert.equal(formal.verified, true);
  const scratch = await readKnowledge({ adapter: adapter(), reference: ref({ domain: 'scratch', id: 'note-1' }) });
  assert.equal(scratch.trust, 'scratch');
  assert.equal(scratch.verified, false, 'Unverified notes must not claim verification.');
  const workspace = await readKnowledge({ adapter: adapter(), reference: ref({ domain: 'workspace' }) });
  assert.equal(workspace.verified, false);
});

test('reading requires the adapter to identify the returned domain, id and version', async () => {
  for (const identity of [undefined, { domain: 'scratch', id: 'doc-1', version: '3' },
    { domain: 'formal', id: 'doc-1', version: '2' }, { domain: 'formal', id: 'other', version: '3' }]) {
    await assert.rejects(readKnowledge({ adapter: adapter({ async read() { return { identity, content: 'wrong' }; } }),
      reference: ref() }), { code: 'knowledge_identity_mismatch' });
  }
});

test('a write reports storage and indexing as separate facts', async () => {
  const both = await writeKnowledge({ adapter: adapter(), reference: ref(), content: 'x' });
  assert.equal(both.state, 'stored_and_indexed');
  assert.equal(both.stored, true);
  assert.equal(both.indexed, true);
  const storedOnly = await writeKnowledge({ adapter: adapter({ async write() { return { stored: true, indexed: false, indexError: 'engine offline' }; } }),
    reference: ref(), content: 'x' });
  // The write happened; claiming it failed would be wrong, and claiming it is searchable is also wrong.
  assert.equal(storedOnly.state, 'stored_not_indexed');
  assert.equal(storedOnly.stored, true);
  assert.equal(storedOnly.indexed, false);
  assert.equal(storedOnly.indexError, 'engine offline');
  const failed = await writeKnowledge({ adapter: adapter({ async write() { return { stored: false, indexed: false }; } }),
    reference: ref(), content: 'x' });
  assert.equal(failed.state, 'write_failed');
  assert.equal(failed.stored, false);
});

test('a verification sample cannot be written with the daily origin', async () => {
  await assert.rejects(writeKnowledge({ adapter: adapter(), reference: ref({ domain: 'scratch' }), content: 'x', origin: 'daily' }),
    { code: 'daily_origin_requires_formal' });
  const allowed = await writeKnowledge({ adapter: adapter(), reference: ref(), content: 'x', origin: 'daily' });
  assert.equal(allowed.state, 'stored_and_indexed');
});

test('an adapter that cannot write or read is rejected rather than silently skipped', async () => {
  await assert.rejects(readKnowledge({ adapter: {}, reference: ref() }), { code: 'invalid_knowledge_adapter' });
  await assert.rejects(writeKnowledge({ adapter: null, reference: ref(), content: 'x' }), { code: 'invalid_knowledge_adapter' });
  await assert.rejects(readKnowledge({ adapter: { async read() { return null; } }, reference: ref() }),
    { code: 'invalid_knowledge_result' });
});

test('the governance outbox is idempotent on replay', () => {
  const outbox = createGovernanceOutbox({ now: () => 1000 });
  const first = outbox.enqueue({ eventId: 'evt-1', kind: 'pattern_ref', payload: { patternId: 'pattern:abc' } });
  assert.equal(first.duplicate, false);
  const replay = outbox.enqueue({ eventId: 'evt-1', kind: 'pattern_ref', payload: { patternId: 'pattern:abc' } });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.id, first.id);
  assert.equal(outbox.pending().length, 1, 'A replay must not add a second entry.');
  // A different kind for the same event is a different intent.
  outbox.enqueue({ eventId: 'evt-1', kind: 'telemetry', payload: {} });
  assert.equal(outbox.pending().length, 2);
});

test('a failed delivery stays pending and a delivered one is recorded only once', () => {
  const outbox = createGovernanceOutbox({ now: () => 1000 });
  const entry = outbox.enqueue({ eventId: 'evt-2', kind: 'pattern_ref', payload: {} });
  const failed = outbox.markFailed(entry.id, { error: 'sink unavailable' });
  assert.equal(failed.status, 'pending');
  assert.equal(failed.attempts, 1);
  assert.equal(failed.lastError, 'sink unavailable');
  assert.equal(outbox.pending().length, 1, 'An attempted delivery must not look delivered.');
  const delivered = outbox.markDelivered(entry.id);
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.attempts, 2);
  assert.equal(outbox.pending().length, 0);
  assert.equal(outbox.delivered().length, 1);
});

test('the outbox refuses entries without an event identity', () => {
  const outbox = createGovernanceOutbox();
  assert.throws(() => outbox.enqueue({ kind: 'x' }), { code: 'invalid_contract' });
  assert.throws(() => outbox.enqueue({ eventId: 'e' }), { code: 'invalid_contract' });
  assert.throws(() => outbox.markDelivered('missing'), { code: 'unknown_outbox_entry' });
});
