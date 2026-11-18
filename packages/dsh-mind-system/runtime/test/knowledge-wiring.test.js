import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knowledgeRef, readKnowledge, writeKnowledge, createGovernanceOutbox }
  from '../src/knowledge.js';
import { createKnowledgeTool } from '../src/dynamic-tools.js';
import { resolveSagKey, createSagAdapter } from '../src/knowledge-sag.js';

/**
 * The knowledge channel, wired through a tool and driven by an adapter.
 *
 * Two claims matter more than the happy path, and both are the reason this file exists:
 *
 * 1. An unavailable channel must refuse with a reason, not answer with an empty list. "I could not reach the
 *    knowledge base" and "the knowledge base has nothing" are different facts, and a caller that cannot tell
 *    them apart will conclude the second.
 * 2. `stored` and `indexed` are separate. Content that was written but never made searchable must not be
 *    reported as a success, because that is a silent write that a later reader will never find.
 */

const adapterReturning = (value) => ({ async read() { return value; }, async write() { return value; } });

test('a knowledge reference carries its domain, so trust is never inferred from the path', () => {
  const formal = knowledgeRef({ domain: 'formal', id: 'note', version: '1' });
  const scratch = knowledgeRef({ domain: 'scratch', id: 'note', version: '1' });
  assert.equal(formal.ref, 'formal:note@1');
  assert.equal(scratch.ref, 'scratch:note@1');
  // The domain decides trust, not the id: identical content in different domains stays distinguishable.
  assert.notEqual(formal.ref, scratch.ref);
  assert.throws(() => knowledgeRef({ domain: 'invented', id: 'x', version: '1' }),
    { code: 'invalid_knowledge_ref' });
  assert.throws(() => knowledgeRef({ domain: 'formal', id: '', version: '1' }), { code: 'invalid_contract' });
});

test('reading keeps the domain identity even when the same engine serves both', async () => {
  const adapter = adapterReturning({ content: [{ path: '/x', text: 'body' }], verified: true });
  const formal = await readKnowledge({ adapter, reference: { domain: 'formal', id: 'n', version: '1' } });
  assert.equal(formal.trust, 'formal');
  assert.equal(formal.verified, true);
  // The same adapter serving scratch content must not be upgraded to verified.
  const scratch = await readKnowledge({ adapter, reference: { domain: 'scratch', id: 'n', version: '1' } });
  assert.equal(scratch.trust, 'scratch');
  assert.equal(scratch.verified, false);
});

test('a write reports stored and indexed as separate facts', async () => {
  // Stored, not indexed: the content exists but nobody can find it.
  const partial = await writeKnowledge({ adapter: adapterReturning({ stored: true, indexed: false,
    indexError: 'embedding_failed' }), reference: { domain: 'workspace', id: 'n', version: '1' }, content: {} });
  assert.equal(partial.state, 'stored_not_indexed');
  assert.equal(partial.indexError, 'embedding_failed');
  // Nothing stored at all.
  const failed = await writeKnowledge({ adapter: adapterReturning({ stored: false }),
    reference: { domain: 'workspace', id: 'n', version: '1' }, content: {} });
  assert.equal(failed.state, 'write_failed');
  // Fully successful.
  const ok = await writeKnowledge({ adapter: adapterReturning({ stored: true, indexed: true }),
    reference: { domain: 'formal', id: 'n', version: '1' }, content: {} });
  assert.equal(ok.state, 'stored_and_indexed');
});

test('a daily-origin write is refused outside the formal domain', async () => {
  // Verification samples must not pollute daily calibration: the guard is on the write, not on the reader.
  await assert.rejects(writeKnowledge({ adapter: adapterReturning({ stored: true, indexed: true }),
    reference: { domain: 'scratch', id: 'n', version: '1' }, content: {}, origin: 'daily' }),
  { code: 'daily_origin_requires_formal' });
});

test('the tool refuses with a reason instead of returning an empty result', async () => {
  // No adapter configured: the caller must learn *why*, and must not receive an empty list that reads like
  // "there is nothing in the knowledge base".
  const unconfigured = createKnowledgeTool({ adapter: null, endpoint: 'http://127.0.0.1:24681' });
  const refused = await unconfigured.execute({ action: 'read', domain: 'formal', id: 'x', version: '1' }, {});
  assert.equal(refused.available, false);
  assert.match(refused.reason, /not configured/);
  assert.equal(Object.hasOwn(refused, 'content'), false, 'A refusal must not carry an empty result set.');
});

test('an adapter failure is reported with its code, not swallowed', async () => {
  const broken = {
    async read() { const error = new Error('unreachable'); error.code = 'network'; throw error; },
    async write() { throw new Error('no'); },
  };
  const tool = createKnowledgeTool({ adapter: broken });
  const result = await tool.execute({ action: 'read', domain: 'workspace', id: 'x', version: '1' }, {});
  assert.equal(result.error, 'network');
  assert.equal(Object.hasOwn(result, 'content'), false);
});

test('the tool reports the write state through to the caller', async () => {
  const tool = createKnowledgeTool({ adapter: adapterReturning({ stored: true, indexed: false,
    indexError: 'not_searchable' }) });
  const result = await tool.execute({ action: 'write', domain: 'workspace', id: 'n', version: '1',
    content: { path: '/tmp/x' } }, {});
  assert.equal(result.state, 'stored_not_indexed');
  assert.equal(result.indexed, false);
  assert.equal(result.indexError, 'not_searchable');
});

test('the SAG key resolves from configuration before the environment file', () => {
  const root = mkdtempSync(join(tmpdir(), 'sag-key-'));
  try {
    const appData = join(root, 'appdata');
    const dir = join(appData, 'com.sag.desktop');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'api-key'), 'sag_from_file\n');
    // With no environment key, the app-data file is used.
    const fromFile = resolveSagKey({ appData });
    assert.equal(fromFile.source, 'appdata');
    assert.equal(fromFile.key, 'sag_from_file');
    // A missing file and no environment key is reported as absent, not as an empty string key.
    const none = resolveSagKey({ appData: join(root, 'nowhere') });
    assert.equal(none.key, null);
    assert.equal(none.source, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a SAG adapter without a key refuses to read rather than reporting an empty base', async () => {
  const adapter = createSagAdapter({ apiKey: null, sagCmd: 'sag' });
  await assert.rejects(adapter.read({ id: 'x' }), { code: 'no_key' });
});

test('a SAG write without a path refuses instead of claiming index progress', async () => {
  const adapter = createSagAdapter({ apiKey: 'sag_test', sagCmd: 'sag' });
  await assert.rejects(adapter.write({ id: 'x', version: '1', content: {} }),
    { code: 'invalid_knowledge_write' });
});

test('the governance outbox is idempotent and keeps failures retryable', () => {
  const outbox = createGovernanceOutbox({ now: () => 1000 });
  const first = outbox.enqueue({ eventId: 'e1', kind: 'rule', payload: { a: 1 } });
  assert.equal(first.duplicate, false);
  // A replay returns the original entry rather than creating a second governance reference.
  const again = outbox.enqueue({ eventId: 'e1', kind: 'rule', payload: { a: 1 } });
  assert.equal(again.duplicate, true);
  assert.equal(again.id, first.id);
  // A delivery attempt that failed must stay pending: "attempted" is not "delivered".
  outbox.markFailed(first.id, { error: 'sink_down' });
  assert.equal(outbox.pending().length, 1);
  assert.equal(outbox.delivered().length, 0);
  outbox.markDelivered(first.id);
  assert.equal(outbox.pending().length, 0);
  assert.equal(outbox.delivered().length, 1);
});
