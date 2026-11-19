import test from 'node:test';
import assert from 'node:assert/strict';
import { createInjectedMessage } from '../src/host-plugin.js';

/**
 * The intervention hint is persisted as a `user/message`, so it must be a message the session log can
 * validate on the NEXT load.
 *
 * The failure this guards against is asymmetric and easy to miss: emitting an unidentified message does
 * not break the run that produced it. It breaks the reading of that session forever after — the log
 * validator refuses the whole file, and the session silently disappears from history. So the assertion is
 * not "a hint was produced" but "the hint carries the fields the loader demands".
 */

const MESSAGE_TYPES = new Set(['user/message']);

/** Mirrors the host's `assertMessageEventShape` for the one event type this runtime writes. */
function assertPersistableUserMessage(message) {
  assert.equal(typeof message, 'object', 'message must be an object');
  assert.notEqual(message, null, 'message must not be null');
  assert.equal(typeof message.id, 'string', 'message must carry a string id');
  assert.notEqual(message.id, '', 'message id must not be empty');
  assert.equal(message.role, 'user', 'role must be user');
  assert.equal(typeof message.source, 'object', 'source must be an object');
  assert.equal(typeof message.source.kind, 'string', 'source.kind must be a string');
  assert.notEqual(message.source.kind, '', 'source.kind must not be empty');
  assert.ok(Array.isArray(message.content), 'content must be an array');
}

test('the injected hint is a message the session loader can validate', () => {
  const message = createInjectedMessage('a hint about a repeated failure');
  assert.ok(MESSAGE_TYPES.has('user/message'));
  assertPersistableUserMessage(message);
});

test('the hint keeps its text and its provenance', () => {
  const text = '这个失败可能不是一次性的。';
  const message = createInjectedMessage(text);
  assert.equal(message.source.kind, 'plugin:execution-runtime');
  assert.equal(message.content.length, 1);
  assert.equal(message.content[0].type, 'text');
  assert.equal(message.content[0].text, text);
});

test('two hints never share an id', () => {
  // Duplicate ids would make two distinct events indistinguishable on replay.
  const a = createInjectedMessage('first');
  const b = createInjectedMessage('second');
  assert.notEqual(a.id, b.id);
});

test('the persisted shape survives a JSON round-trip, id included', () => {
  // The log is JSON on disk: anything lost in serialisation is lost in the session.
  const message = createInjectedMessage('round trip');
  const revived = JSON.parse(JSON.stringify(message));
  assertPersistableUserMessage(revived);
  assert.equal(revived.id, message.id);
});
