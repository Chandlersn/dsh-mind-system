import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { initGrowth, applyGrowth, growthStateSchema } from '../src/growth-cycle-projection.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const TARGET = 'C:\\work\\result.md';
const QUESTION = `growth:${sha(JSON.stringify(['begin', 'checkpoint', TARGET, sha('artifact'), 8]))}`;
const MEMORY = 'C:\\memory\\functions\\example.md';
const MEMORY_TEXT = '# Remember this\n';

function fixture(inherited = 0) {
  let state = initGrowth({ id: 'session-one', cwd: 'C:\\work' }, inherited);
  let seq = 0;
  const events = [];
  const push = (type, data, attributes = {}) => {
    const event = { type, seq: seq++, time: 100, data };
    if (type === 'tool/result') event.sourceEventSeqs = [events.find(item => item.type === 'tool/call' && item.data.callId === data.message?.toolCallId)?.seq];
    Object.assign(event, attributes);
    events.push(event);
    state = applyGrowth(state, event);
    return event;
  };
  const call = (id, name, args, turn = 1, step = 1) => push('tool/call', { turn, step, callId: id, name, arguments: JSON.stringify(args) });
  const result = (id, value, error = false, raw = false, turn = 1, step = 1) => push('tool/result', {
    turn, step, message: { id: `message-${id}`, source: { kind: 'tool', callId: id }, toolCallId: id, isError: error, content: [{ type: 'text', text: raw ? value : JSON.stringify(value) }] },
  });
  const begin = (id = 'begin') => { call(id, 'memory_cycle', { action: 'begin' }); result(id, { kind: 'growth_begin', begin: true }); };
  const recall = (id = 'recall', args = { kind: 'function', name: 'example' }, content = MEMORY_TEXT) => {
    call(id, 'memory_read', args); result(id, content, false, true);
  };
  const action = (id = 'action', file = TARGET) => { call(id, 'write', { file_path: file, content: 'private artifact body' }); result(id, 'Written', false, true); };
  const checkpoint = (id = 'checkpoint', overrides = {}, argsOverrides = {}) => {
    call(id, 'memory_cycle', { action: 'checkpoint', cycleId: 'begin', recallCallId: 'recall', actionCallId: 'action', path: TARGET, ...argsOverrides });
    const artifact = overrides.artifact ?? { path: TARGET, sha256: sha('artifact'), bytes: 8 };
    result(id, {
      kind: 'growth_checkpoint', cycleId: 'begin', recallCallId: 'recall', actionCallId: 'action',
      artifact: { path: TARGET, sha256: sha('artifact'), bytes: 8 },
      recallArtifact: { path: MEMORY, sha256: sha(MEMORY_TEXT), bytes: Buffer.byteLength(MEMORY_TEXT) },
      questionId: `growth:${sha(JSON.stringify(['begin', id, artifact.path, artifact.sha256, artifact.bytes]))}`, ...overrides,
    });
  };
  const ready = () => { begin(); recall(); action(); checkpoint(); };
  const ask = (id = 'ask', questionId = QUESTION) => call(id, 'ask_user_question', {
    questions: [{ id: questionId, question: 'Private full question text', options: [{ label: 'Yes' }, { label: 'No' }] }],
  });
  const answer = (id = 'ask', selected = ['Yes'], custom) => result(id, { answers: [{ id: QUESTION, selected, ...(custom === undefined ? {} : { custom }) }] });
  const late = (id = 'ask', selected = ['Yes']) => push('user/message', {
    id: 'late-message', source: { kind: 'user-question-reply', callId: id, outcome: 'answered' },
    content: [{ type: 'text', text: JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId: id, answers: [{ id: QUESTION, selected }] }) }],
  });
  return { get state() { return state; }, push, call, result, begin, recall, action, checkpoint, ready, ask, answer, late, events };
}

test('records one native cycle and opaque review without retaining content', () => {
  const f = fixture(); f.ready(); f.ask(); f.answer('ask', [], 'Secret free text');
  assert.equal(f.state.incomplete, false);
  const cycle = f.state.cycles[0];
  assert.equal(cycle.checkpoint.recallArtifact.sha256, sha(MEMORY_TEXT));
  assert.equal(cycle.review.reviewObserved, true);
  assert.equal(cycle.review.customPresent, true);
  assert.equal(cycle.review.interpretation, 'not_interpreted');
  assert.equal(cycle.review.governanceEligible, false);
  const serialized = JSON.stringify(f.state);
  for (const secret of [MEMORY_TEXT, 'Secret free text', 'Private full question text', 'private artifact body']) assert.equal(serialized.includes(secret), false);
});

test('skipped answer is observed as skipped without recognition', () => {
  const f = fixture(); f.ready(); f.ask(); f.answer('ask', []);
  assert.equal(f.state.cycles[0].review.status, 'skipped');
  assert.equal(f.state.cycles[0].review.reviewObserved, false);
});

test('begin invocation cuts the old cycle before settlement and failures do not reopen it', () => {
  const f = fixture(); f.begin(); f.call('next', 'memory_cycle', { action: 'begin' });
  assert.equal(f.state.activeCycleId, null);
  f.action('gap'); f.result('next', 'Error', true, true); f.action('after');
  assert.equal(f.state.activeCycleId, null);
  assert.equal(f.state.calls.some(call => ['gap', 'after'].includes(call.callId)), false);
});

test('superseded pending begin cannot override the newest begin', () => {
  const f = fixture(); f.call('older', 'memory_cycle', { action: 'begin' }); f.begin('newer');
  f.result('older', { kind: 'growth_begin', begin: true });
  assert.equal(f.state.activeCycleId, 'newer');
  assert.equal(f.state.cycles.length, 1);
});

test('parallel results retain the cycle captured at their call start', () => {
  const f = fixture(); f.begin(); f.call('slow', 'write', { file_path: TARGET }); f.begin('next'); f.result('slow', 'OK', false, true);
  assert.equal(f.state.calls.find(call => call.callId === 'slow').cycleId, 'begin');
});

test('unrelated history and PTC before the first begin do not consume bounds', () => {
  const f = fixture();
  for (let i = 0; i < 400; i++) f.action(`old-${i}`);
  f.push('tool/ptc-dispatch', { name: 'write' });
  f.begin();
  assert.equal(f.state.incomplete, false);
  assert.equal(f.state.calls.length, 1);
  assert.equal(f.state.eventRefs.length, 2);
});

test('fork inherited events do not create cycles or evidence', () => {
  const f = fixture(2); f.begin('inherited');
  assert.equal(f.state.cycles.length, 0);
  f.begin('own');
  assert.equal(f.state.cycles[0].cycleId, 'own');
});

test('requires matching actual recall content and bound memory path', () => {
  for (const recallArtifact of [
    { path: MEMORY, sha256: sha('different'), bytes: Buffer.byteLength(MEMORY_TEXT) },
    { path: 'C:\\memory\\functions\\other.md', sha256: sha(MEMORY_TEXT), bytes: Buffer.byteLength(MEMORY_TEXT) },
    { path: MEMORY, sha256: sha(MEMORY_TEXT), bytes: 0 },
  ]) {
    const f = fixture(); f.begin(); f.recall(); f.action(); f.checkpoint('checkpoint', { recallArtifact });
    assert.equal(f.state.cycles[0].checkpoint, null);
    assert.equal(f.state.incomplete, true);
  }
});

test('rejects empty recalls, unsupported read kinds, and failed actions', () => {
  for (const mode of ['empty', 'kind', 'failed']) {
    const f = fixture(); f.begin();
    f.recall('recall', mode === 'kind' ? { kind: 'live_flow' } : { kind: 'function', name: 'example' }, mode === 'empty' ? '' : MEMORY_TEXT);
    if (mode === 'failed') { f.call('action', 'write', { file_path: TARGET }); f.result('action', 'Error', true, true); } else f.action();
    f.checkpoint(); assert.equal(f.state.cycles[0].checkpoint, null);
  }
});

test('checkpoint rejects changed call arguments, foreign cycles, and unrelated artifacts', () => {
  for (const [overrides, args] of [
    [{}, { recallCallId: 'other' }], [{ cycleId: 'other-cycle' }, {}],
    [{ artifact: { path: 'C:\\work\\other.md', sha256: sha('artifact'), bytes: 8 } }, {}],
  ]) {
    const f = fixture(); f.begin(); f.recall(); f.action(); f.checkpoint('checkpoint', overrides, args);
    assert.equal(f.state.cycles[0].checkpoint, null);
  }
});

test('a correctly shaped question hash must bind the exact checkpoint and artifact', () => {
  const f = fixture(); f.begin(); f.recall(); f.action(); f.checkpoint('checkpoint', { questionId: `growth:${'f'.repeat(64)}` });
  assert.equal(f.state.cycles[0].checkpoint, null);
  assert.ok(f.state.reasons.includes('question_identity_mismatch'));
});

test('relative Windows paths resolve only against the session cwd', () => {
  const f = fixture(); f.begin(); f.recall(); f.action('action', 'result.md'); f.checkpoint('checkpoint', {}, { path: '.\\result.md' });
  assert.equal(f.state.incomplete, false);
  assert.equal(f.state.cycles[0].checkpoint.artifact.path, TARGET);
});

test('memory_write derives target from feature without parsing human text', () => {
  const f = fixture(); f.begin(); f.recall(); f.call('action', 'memory_write', { feature: 'changed' }); f.result('action', 'Human output', false, true);
  const target = 'C:\\memory\\functions\\changed.md';
  f.checkpoint('checkpoint', { artifact: { path: target, sha256: sha('artifact'), bytes: 8 } }, { path: target });
  assert.equal(f.state.incomplete, false);
  assert.equal(f.state.cycles[0].checkpoint.artifact.path, target);
});

test('only a bound question accepts an answer and wrong options are rejected', () => {
  const f = fixture(); f.ready(); f.ask('unbound', 'unrelated'); f.answer('unbound');
  assert.equal(f.state.cycles[0].review, null);
  f.ask(); f.answer('ask', ['Injected label']);
  assert.equal(f.state.incomplete, true);
  assert.equal(f.state.cycles[0].review, null);
});

test('late answers stay with their original cycle and pending is not review', () => {
  const f = fixture(); f.ready(); f.ask(); f.result('ask', { pending: true, callId: 'ask' });
  assert.equal(f.state.cycles[0].review, null);
  f.begin('next'); f.late();
  assert.equal(f.state.cycles[0].review.reviewObserved, true);
  assert.equal(f.state.cycles[1].review, null);
});

test('late reply with mismatched source envelope cannot settle review', () => {
  const f = fixture(); f.ready(); f.ask();
  f.push('user/message', { source: { kind: 'user-question-reply', callId: 'ask', outcome: 'answered' }, content: [{ type: 'text', text: JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId: 'other', answers: [{ id: QUESTION, selected: ['Yes'] }] }) }] });
  assert.equal(f.state.cycles[0].review, null);
  assert.equal(f.state.incomplete, true);
});

test('old checkpoint answers cannot certify a replacement checkpoint', () => {
  const f = fixture(); f.ready(); f.ask(); f.result('ask', { pending: true, callId: 'ask' });
  f.checkpoint('checkpoint2'); f.late();
  assert.equal(f.state.cycles[0].review, null);
  assert.equal(f.state.cycles[0].checkpoint.checkpointCallId, 'checkpoint2');
});

test('replay is deterministic and same-event idempotent without mutation', () => {
  const f = fixture(); f.ready(); f.ask(); f.answer();
  const original = JSON.stringify(f.state);
  let replay = initGrowth({ id: 'session-one', cwd: 'C:\\work' });
  for (const event of f.events) replay = applyGrowth(replay, event);
  assert.deepEqual(replay, f.state);
  assert.equal(applyGrowth(f.state, f.events.at(-1)), f.state);
  const changed = structuredClone(f.events.at(-1)); changed.data.message.isError = true;
  const conflict = applyGrowth(f.state, changed);
  assert.equal(conflict.incomplete, true);
  assert.equal(conflict.cycles[0].review.reviewObserved, false);
  assert.equal(JSON.stringify(f.state), original);
});

test('conflicting late answer degrades instead of replacing an observed answer', () => {
  const f = fixture(); f.ready(); f.ask(); f.answer(); f.late('ask', ['No']);
  assert.equal(f.state.incomplete, true);
  assert.equal(f.state.cycles[0].review.reviewObserved, false);
});

test('unsupported PTC during a cycle is visible as incomplete', () => {
  const f = fixture(); f.begin(); f.push('tool/ptc-dispatch-start', { name: 'write', subCallId: 'ptc-1' });
  assert.equal(f.state.incomplete, true);
  assert.ok(f.state.reasons.includes('ptc_unsupported'));
});

test('call and cycle bounds remain sticky and bounded', () => {
  const calls = fixture(); calls.begin();
  for (let i = 0; i < 260; i++) calls.action(`call-${i}`);
  assert.equal(calls.state.calls.length, 256);
  assert.ok(calls.state.reasons.includes('calls_overflow'));
  const cycles = fixture(); for (let i = 0; i < 33; i++) cycles.begin(`cycle-${i}`);
  assert.equal(cycles.state.cycles.length, 32);
  assert.ok(cycles.state.reasons.includes('cycles_overflow'));
});

test('result source, call event reference, and turn identity must agree', () => {
  for (const mutate of [
    event => { event.data.message.source.callId = 'another-call'; },
    event => { event.data.message.source.kind = 'plugin'; },
    event => { event.sourceEventSeqs = [999]; },
    event => { delete event.sourceEventSeqs; },
    event => { event.data.turn = 99; },
  ]) {
    const f = fixture(); f.begin(); f.call('read', 'memory_read', { kind: 'index' });
    const result = { type: 'tool/result', seq: 3, time: 100, sourceEventSeqs: [2], data: {
      turn: 1, step: 1, message: { toolCallId: 'read', source: { kind: 'tool', callId: 'read' }, content: [{ type: 'text', text: MEMORY_TEXT }] },
    } };
    mutate(result);
    const state = applyGrowth(f.state, result);
    assert.equal(state.incomplete, true);
    assert.equal(state.calls.find(call => call.callId === 'read').finished, false);
  }
});

test('action starting before recall finished cannot enter checkpoint', () => {
  const f = fixture(); f.begin(); f.call('recall', 'memory_read', { kind: 'function', name: 'example' });
  f.action(); f.result('recall', MEMORY_TEXT, false, true); f.checkpoint();
  assert.equal(f.state.incomplete, true);
  assert.equal(f.state.cycles[0].checkpoint, null);
});

function replacement(f, callId, content = '[pruned]', target) {
  const call = f.state.calls.find(item => item.callId === callId);
  const source = target ?? call.presentationResultSeq;
  const original = f.events.find(event => event.seq === call.resultSeq);
  const data = structuredClone(original.data);
  data.message.content = [{ type: 'text', text: content }];
  return { data, attributes: { surfaceOp: { op: 'replace', startSeq: source, endSeq: source }, sourceEventSeqs: [source] } };
}

function prune(f, callId, content, target) {
  const { data, attributes } = replacement(f, callId, content, target);
  return f.push('tool/result', data, attributes);
}

test('native presentation replacements preserve canonical recall action checkpoint and review', () => {
  const f = fixture(); f.ready(); f.ask(); f.answer();
  const original = structuredClone(f.state);
  for (const id of ['begin', 'recall', 'action', 'checkpoint', 'ask']) {
    prune(f, id);
    const before = original.calls.find(call => call.callId === id);
    const after = f.state.calls.find(call => call.callId === id);
    assert.deepEqual(after.result, before.result);
    assert.equal(after.resultHash, before.resultHash);
    assert.equal(after.resultSeq, before.resultSeq);
    assert.ok(after.presentationResultSeq > before.resultSeq);
  }
  assert.equal(f.state.incomplete, false);
  assert.deepEqual(f.state.cycles, original.cycles);
  const replay = f.events.reduce(applyGrowth, initGrowth({ id: 'session-one', cwd: 'C:\\work' }));
  assert.deepEqual(replay, f.state);
});

test('chained pruning follows the last presentation and never promotes replacement content', () => {
  const f = fixture(); f.ready(); f.ask(); f.answer('ask', []);
  const original = structuredClone(f.state.calls.find(call => call.callId === 'ask'));
  prune(f, 'ask');
  const second = prune(f, 'ask', JSON.stringify({ answers: [{ id: QUESTION, selected: ['Yes'] }] }));
  assert.equal(f.state.incomplete, false);
  assert.equal(f.state.calls.find(call => call.callId === 'ask').presentationResultSeq, second.seq);
  assert.equal(f.state.calls.find(call => call.callId === 'ask').resultHash, original.resultHash);
  assert.equal(f.state.cycles[0].review.status, 'skipped');
  assert.equal(f.state.cycles[0].review.reviewObserved, false);
  prune(f, 'ask', '[pruned again]', original.resultSeq);
  assert.equal(f.state.incomplete, false);
});

test('pruned recall still checks against original bytes at a later checkpoint', () => {
  const f = fixture(); f.begin(); f.recall(); prune(f, 'recall'); f.action(); prune(f, 'action'); f.checkpoint();
  assert.equal(f.state.incomplete, false);
  assert.equal(f.state.cycles[0].checkpoint.recallArtifact.sha256, sha(MEMORY_TEXT));
});

test('forged presentation ranges source identity and outcome drift are rejected', () => {
  for (const mutate of [
    item => { item.attributes.surfaceOp.startSeq = 999; item.attributes.surfaceOp.endSeq = 999; item.attributes.sourceEventSeqs = [999]; },
    item => { item.attributes.surfaceOp.endSeq++; },
    item => { item.attributes.sourceEventSeqs = [999]; },
    item => { item.attributes.sourceEventSeqs.push(999); },
    item => { item.data.message.source.callId = 'foreign'; },
    item => { item.data.message.toolCallId = 'foreign'; },
    item => { item.data.message.source.callId = 'foreign'; item.data.message.toolCallId = 'foreign'; },
    item => { delete item.data.message; },
    item => { item.data.message.source.kind = 'plugin'; },
    item => { item.data.turn++; },
    item => { item.data.step++; },
    item => { item.data.message.id = 'foreign-message'; },
    item => { item.data.message.isError = true; },
  ]) {
    const f = fixture(); f.ready(); f.ask(); f.answer();
    const canonical = structuredClone(f.state.calls.find(call => call.callId === 'ask'));
    const item = replacement(f, 'ask'); mutate(item);
    f.push('tool/result', item.data, item.attributes);
    assert.equal(f.state.incomplete, true);
    assert.ok(f.state.reasons.includes('invalid_result_replacement'));
    assert.equal(f.state.cycles[0].review.reviewObserved, false);
    assert.deepEqual(f.state.calls.find(call => call.callId === 'ask'), canonical);
  }
});

test('replacement cannot create a canonical result for an unfinished call', () => {
  const f = fixture(); f.begin(); f.call('read', 'memory_read', { kind: 'index' });
  f.push('tool/result', { turn: 1, step: 1, message: { toolCallId: 'read', source: { kind: 'tool', callId: 'read' }, content: [{ type: 'text', text: 'pretend success' }] } },
    { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] });
  assert.equal(f.state.incomplete, true);
  assert.equal(f.state.calls.find(call => call.callId === 'read').finished, false);
});

test('superseded intermediate presentation references are rejected', () => {
  const f = fixture(); f.begin(); f.recall();
  const first = prune(f, 'recall'); prune(f, 'recall'); prune(f, 'recall', '[stale]', first.seq);
  assert.equal(f.state.incomplete, true);
  assert.ok(f.state.reasons.includes('invalid_result_replacement'));
});

test('host Zod schema accepts roundtrip and rejects corrupt states', t => {
  if (!process.env.DSH_INSTALL_DIR) return t.skip('Host installation is required for the host Zod contract');
  const req = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'));
  const z = createRequire(req.resolve('@deepseek-ai/dsh-session-projection/package.json'))('zod').z;
  const schema = growthStateSchema(z);
  const f = fixture(); f.ready(); f.ask(); f.answer();
  prune(f, 'recall'); prune(f, 'recall'); prune(f, 'ask');
  assert.equal(f.state.version, 2);
  assert.deepEqual(schema.parse(JSON.parse(JSON.stringify(f.state))), f.state);
  for (const mutate of [
    state => { state.version = 1; },
    state => { state.extra = true; },
    state => { state.cycles[0].review.governanceEligible = true; },
    state => { state.cycles[0].checkpoint.artifact.sha256 = 'bad'; },
    state => { state.calls.push(state.calls[0]); },
    state => { state.incomplete = true; },
  ]) {
    const broken = structuredClone(f.state); mutate(broken);
    assert.equal(schema.safeParse(broken).success, false);
  }
});
