import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  DecisionClient, buildSystemoneRequest, parseSystemoneResponse,
  selectDecision, selectUniqueRuleFallback,
} from '../src/decision-client.js';

const candidates = [
  { candidateId: 'inspect', toolName: 'read', arguments: { path: 'input.json' }, effect: 'read', source: { recipeId: 'fixture', version: '1' } },
  { candidateId: 'validate', toolName: 'validate', arguments: {}, effect: 'read', source: { recipeId: 'fixture', version: '1' } },
];
const valid = { answers: { inspect: { type: 'noul', noul: 0.9 }, validate: { type: 'noul', noul: 0.2 } } };
const policy = { version: 'fixture-policy-v1', minScore: 0.7, minMargin: 0.1 };
const rule = { version: 'fixture-rule-v1', candidateId: 'inspect', recipeId: 'fixture', recipeVersion: '1' };

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}/systemone`;
}
function client(endpoint, extra = {}) {
  return new DecisionClient({ provider: 'fixture', endpoint, model: 'fixture-model', auth: { type: 'bearer', token: 'fixture-only' }, timeoutMs: 1000, ...extra });
}
async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const hasCode = (code) => (error) => error.code === code;

test('batch success sends the SAG systemone shape and preserves independent scores', async (t) => {
  let observed;
  const endpoint = await fixture(t, async (request, response) => {
    observed = { method: request.method, url: request.url, auth: request.headers.authorization, data: await body(request) };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(valid));
  });
  const result = await client(endpoint).decide({ state: { goal: 'Validate the input' }, candidates, policy });
  assert.equal(observed.method, 'POST');
  assert.equal(observed.url, '/systemone');
  assert.equal(observed.auth, 'Bearer fixture-only');
  assert.equal(observed.data.model, 'fixture-model');
  assert.deepEqual(JSON.parse(observed.data.state), { goal: 'Validate the input' });
  assert.deepEqual(Object.keys(observed.data.questions), ['inspect', 'validate']);
  assert.equal(observed.data.questions.inspect.type, 'noul');
  assert.equal(typeof observed.data.questions.inspect.instructions.question, 'string');
  assert.deepEqual(observed.data.questions.inspect.instructions.candidate, candidates[0]);
  assert.equal(typeof observed.data.questions.inspect.criteria.true, 'string');
  assert.deepEqual(result.scores, { inspect: 0.9, validate: 0.2 });
  assert.equal(result.selectedCandidateId, 'inspect');
  assert.equal(result.confidence, null);
  assert.equal(result.confidenceSource, 'unavailable');
  assert.equal(result.distribution, undefined);
  assert.equal(result.policyVersion, policy.version);
  assert.equal(result.highestScore, 0.9);
  assert.ok(Math.abs(result.scoreMargin - 0.7) < 1e-10);
  assert.equal(result.protocolVersion, 'systemone-noul-v1');
  assert.equal(result.provider, 'fixture');
  assert.equal(result.model, 'fixture-model');
  assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
});

test('malformed UTF-8 cannot be silently repaired into a matching candidate identity', async (t) => {
  const unusual = [{ candidateId: '\uFFFD' }];
  const raw = Buffer.concat([Buffer.from('{"answers":{"'), Buffer.from([0xff]), Buffer.from('\":{"type":"noul","noul":0.9}}}')]);
  const endpoint = await fixture(t, (_request, response) => response.end(raw));
  await assert.rejects(client(endpoint).query({ state: 'Fixture', candidates: unusual }), hasCode('decision_protocol_error'));
});

const invalidResponses = [
  ['invalid JSON', '{'],
  ['null root', 'null'],
  ['array root', '[]'],
  ['missing answers', '{}'],
  ['array answers', '{"answers":[]}'],
  ['missing candidate', '{"answers":{"inspect":{"type":"noul","noul":0.9}}}'],
  ['unknown candidate', '{"answers":{"inspect":{"type":"noul","noul":0.9},"unknown":{"type":"noul","noul":0.1}}}'],
  ['wrong type', JSON.stringify({ answers: { ...valid.answers, inspect: { type: 'predicate', noul: 0.9 } } })],
  ['string score', JSON.stringify({ answers: { ...valid.answers, inspect: { type: 'noul', noul: '0.9' } } })],
  ['null score', JSON.stringify({ answers: { ...valid.answers, inspect: { type: 'noul', noul: null } } })],
  ['boolean score', JSON.stringify({ answers: { ...valid.answers, inspect: { type: 'noul', noul: true } } })],
  ['missing score', JSON.stringify({ answers: { ...valid.answers, inspect: { type: 'noul' } } })],
  ['negative score', JSON.stringify({ answers: { ...valid.answers, inspect: { type: 'noul', noul: -0.1 } } })],
  ['score above one', JSON.stringify({ answers: { ...valid.answers, inspect: { type: 'noul', noul: 1.1 } } })],
  ['infinite score', '{"answers":{"inspect":{"type":"noul","noul":1e400},"validate":{"type":"noul","noul":0}}}'],
  ['duplicate candidate', '{"answers":{"inspect":{"type":"noul","noul":0.1},"inspect":{"type":"noul","noul":0.9},"validate":{"type":"noul","noul":0.2}}}'],
  ['escaped duplicate candidate', '{"answers":{"inspect":{"type":"noul","noul":0.1},"inspe\\u0063t":{"type":"noul","noul":0.9},"validate":{"type":"noul","noul":0.2}}}'],
  ['duplicate score field', '{"answers":{"inspect":{"type":"noul","noul":0.1,"noul":0.9},"validate":{"type":"noul","noul":0.2}}}'],
  ['duplicate answers', `{"answers":{},"answers":${JSON.stringify(valid.answers)}}`],
];
for (const [name, raw] of invalidResponses) {
  test(`HTTP protocol rejects ${name}`, async (t) => {
    const endpoint = await fixture(t, (_request, response) => response.end(raw));
    await assert.rejects(client(endpoint).query({ state: 'Fixture', candidates }), hasCode('decision_protocol_error'));
  });
}

test('parser accepts boundaries, unusual keys and escaped strings without normalizing scores', () => {
  const unusual = [{ candidateId: '__proto__' }, { candidateId: 'quote"\\key' }];
  const raw = JSON.stringify({ answers: Object.fromEntries(unusual.map((c, i) => [c.candidateId, { type: 'noul', noul: i }])) });
  const scores = parseSystemoneResponse(raw, unusual);
  assert.equal(scores.__proto__, 0);
  assert.equal(scores['quote"\\key'], 1);
  assert.equal(Object.getPrototypeOf(scores), Object.prototype);
});

test('invalid and duplicate input IDs are rejected before network', () => {
  for (const input of [[], [{ candidateId: '' }], [candidates[0], candidates[0]]]) {
    assert.throws(() => buildSystemoneRequest({ model: 'fixture', state: {}, candidates: input }), hasCode('decision_protocol_error'));
  }
});

test('selection abstains on thresholds and ties and requires explicit policy', () => {
  const scoring = { scores: { a: 0.9, b: 0.9 } };
  assert.equal(selectDecision(scoring, { ...policy, minMargin: 0 }).abstainReason, 'insufficient_margin');
  assert.equal(selectDecision({ scores: { a: 0.4 } }, policy).abstainReason, 'score_below_threshold');
  assert.equal(selectDecision({ scores: { a: 0.8, b: 0.75 } }, policy).selectedCandidateId, null);
  assert.equal(selectDecision({ scores: { a: 0.8 } }, policy).scoreMargin, null);
  for (const invalid of [undefined, {}, { ...policy, version: '' }, { ...policy, minScore: NaN }, { ...policy, minMargin: -1 }]) {
    assert.throws(() => selectDecision(scoring, invalid), hasCode('decision_config_error'));
  }
});

test('unique fallback requires admission, read effect and exact rule binding', () => {
  const input = { candidates: [candidates[0]], rule, admitted: true };
  const result = selectUniqueRuleFallback(input);
  assert.equal(result.selectedCandidateId, 'inspect');
  assert.equal(result.decisionSource, 'rules');
  assert.deepEqual(result.scores, {});
  assert.equal(result.confidence, null);
  for (const unsafe of [
    { ...input, candidates }, { ...input, admitted: false }, { ...input, rule: undefined },
    { ...input, rule: { ...rule, recipeVersion: '2' } },
    { ...input, rule: { ...rule, candidateId: 'validate' } },
    { ...input, candidates: [{ ...candidates[0], effect: 'reversible_write' }] },
    { ...input, candidates: [{ ...candidates[0], source: undefined }] },
  ]) {
    assert.equal(selectUniqueRuleFallback(unsafe).selectedCandidateId, null);
    assert.equal(selectUniqueRuleFallback(unsafe).abstainReason, 'no_safe_unique_rule');
  }
});

test('transport failure never chooses an arbitrary fallback', async (t) => {
  const endpoint = await fixture(t, (request) => request.socket.destroy());
  await assert.rejects(client(endpoint).decide({ state: {}, candidates, policy }), hasCode('decision_transport_error'));
  assert.equal(selectUniqueRuleFallback({ candidates }).selectedCandidateId, null);
});

test('timeout bounds headers and response body', async (t) => {
  for (const phase of ['headers', 'body']) {
    const endpoint = await fixture(t, (_request, response) => {
      if (phase === 'body') { response.writeHead(200); response.write('{"answers":'); }
    });
    await assert.rejects(client(endpoint, { timeoutMs: 40 }).query({ state: {}, candidates }), hasCode('decision_timeout'));
  }
});

test('parent cancellation reaches the pending fetch and closes the connection', async (t) => {
  let started;
  let closed;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const closedPromise = new Promise((resolve) => { closed = resolve; });
  const endpoint = await fixture(t, (_request, response) => {
    response.on('close', closed);
    response.writeHead(200);
    response.write('{');
    started();
  });
  const controller = new AbortController();
  const pending = client(endpoint).query({ state: {}, candidates, signal: controller.signal });
  const rejected = assert.rejects(pending, hasCode('decision_cancelled'));
  await startedPromise;
  controller.abort(new Error('Private caller reason'));
  await rejected;
  await closedPromise;
});

test('pre-cancelled requests and invalid policies cause no network requests', async (t) => {
  let calls = 0;
  const endpoint = await fixture(t, (_request, response) => { calls++; response.end(JSON.stringify(valid)); });
  const signal = AbortSignal.abort();
  await assert.rejects(client(endpoint).query({ state: {}, candidates, signal }), hasCode('decision_cancelled'));
  await assert.rejects(client(endpoint).decide({ state: {}, candidates, policy: {} }), hasCode('decision_config_error'));
  assert.equal(calls, 0);
});

test('HTTP errors and redirect rejection never expose provider bodies or credentials', async (t) => {
  for (const status of [401, 429, 500, 302]) {
    let calls = 0;
    const endpoint = await fixture(t, (_request, response) => {
      calls++;
      response.writeHead(status, { location: '/leak' });
      response.end('fixture-only provider secret');
    });
    await assert.rejects(client(endpoint).query({ state: {}, candidates }), (error) => {
      assert.equal(error.code, status === 302 ? 'decision_transport_error' : 'decision_http_error');
      assert.ok(!error.message.includes('fixture-only'));
      assert.ok(!error.message.includes(endpoint));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('response limit prevents accepting oversized bodies', async (t) => {
  const endpoint = await fixture(t, (_request, response) => response.end(JSON.stringify(valid)));
  await assert.rejects(client(endpoint, { maxResponseBytes: 10 }).query({ state: {}, candidates }), hasCode('decision_protocol_error'));
});

test('configuration is explicit, bounded and does not infer provider or endpoint', () => {
  const base = { provider: 'fixture', endpoint: 'http://localhost/systemone', model: 'fixture', auth: { type: 'none' }, timeoutMs: 1000 };
  assert.doesNotThrow(() => new DecisionClient(base));
  for (const patch of [
    { provider: '' }, { model: '' }, { endpoint: 'invalid' }, { endpoint: 'file:///secret' },
    { endpoint: 'https://user:secret@example.test/systemone' }, { endpoint: 'https://example.test/?key=secret' },
    { auth: undefined }, { auth: { type: 'bearer', token: '' } },
    { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 120001 }, { maxResponseBytes: 0 },
  ]) {
    assert.throws(() => new DecisionClient({ ...base, ...patch }), hasCode('decision_config_error'));
  }
});
