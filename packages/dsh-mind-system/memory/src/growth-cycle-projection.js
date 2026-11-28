import { createHash } from 'node:crypto';
import { growthQuestionId } from './growth-identity.js';
import path from 'node:path';

// The fold observes recorded facts. It never authenticates a person or proves a goal.
const MAX_CYCLES = 32;
const MAX_CALLS = 256;
const MAX_EVENTS = 1024;
const MAX_TEXT = 1024 * 1024;
const ACTIONS = new Set(['write', 'edit', 'memory_write']);
const RELEVANT = new Set(['tool/call', 'tool/result', 'user/message', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function parse(value) {
  if (typeof value !== 'string' || value.length > MAX_TEXT) return null;
  try { const result = JSON.parse(value); return record(result) ? result : null; } catch { return null; }
}

function body(content) {
  if (!Array.isArray(content)) return null;
  const blocks = content.filter(block => block?.type === 'text');
  if (blocks.length !== 1) return null;
  return parse(blocks[0].text);
}

function degrade(state, reason) {
  state.incomplete = true;
  if (!state.reasons.includes(reason) && state.reasons.length < 16) state.reasons.push(reason);
  for (const cycle of state.cycles) {
    if (cycle.review) cycle.review = { ...cycle.review, reviewObserved: false, status: 'unknown' };
  }
  return state;
}

function pathKey(value) {
  const path = text(value, 4096);
  if (!path) return null;
  // Do not resolve paths against process.cwd() in a replayable fold.
  return path.replaceAll('\\', '/').replace(/\/$/, '').replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`);
}

function samePath(a, b, cwd = null) {
  const resolved = value => {
    if (!text(value, 4096) || !cwd) return value;
    const api = /^[a-z]:[\\/]|^\\\\/i.test(cwd) ? path.win32 : path.posix;
    return api.resolve(cwd, value);
  };
  const left = pathKey(resolved(a)), right = pathKey(resolved(b));
  if (!left || !right) return false;
  if (/^[a-z]:\//i.test(left) && /^[a-z]:\//i.test(right)) return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function safeArgs(name, raw) {
  const args = parse(raw);
  if (!args) return null;
  if (name === 'memory_cycle') return {
    action: text(args.action, 32), cycleId: text(args.cycleId),
    recallCallId: text(args.recallCallId), actionCallId: text(args.actionCallId), path: text(args.path, 4096),
  };
  if (name === 'memory_read') return { kind: text(args.kind, 64), name: text(args.name), objectKey: text(args.objectKey) };
  if (name === 'memory_write') return { feature: text(args.feature) };
  if (name === 'write' || name === 'edit') return { file_path: text(args.file_path, 4096) };
  if (name === 'ask_user_question') {
    if (!Array.isArray(args.questions) || args.questions.length > 32) return null;
    return { questions: args.questions.map(question => ({
      id: text(question?.id),
      options: Array.isArray(question?.options) && question.options.length <= 64
        ? question.options.map(option => text(option?.label, 512)) : [],
      multi_select: question?.multi_select === true,
    })) };
  }
  return {};
}

function successful(value, isError) {
  return !isError && !(record(value) && (value.ok === false || value.success === false || value.status === 'error' || value.error));
}

function safeResult(call, value, isError, content) {
  const rendered = Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') : '';
  const result = {
    textSha256: hash(rendered), textNonempty: rendered.trim().length > 0, textBytes: Buffer.byteLength(rendered, 'utf8'),
    success: successful(value, isError), path: record(value) ? text(value.path, 4096) : null,
    selfCheckOk: record(value?.selfCheck) && typeof value.selfCheck.ok === 'boolean' ? value.selfCheck.ok : null,
  };
  if (call.name === 'memory_read') {
    result.recallCandidate = call.args?.kind === 'index' || (['function', 'insight', 'dao', 'capability'].includes(call.args?.kind)
      && /^[^\\/\x00-\x1f]+$/.test(call.args?.name ?? '') && !['.', '..'].includes(call.args?.name));
  }
  if (result.selfCheckOk === false) result.success = false;
  return result;
}

export function initGrowth(header, inheritedEventCount = 0) {
  const inherited = Number.isSafeInteger(inheritedEventCount) && inheritedEventCount >= 0 ? inheritedEventCount : 0;
  return {
    version: 2, sessionId: text(header?.id), cwd: text(header?.cwd, 4096), inheritedEventCount: inherited, lastSeq: -1,
    activeCycleId: null, pendingBeginId: null, incomplete: false, reasons: [], cycles: [], calls: [], eventRefs: [],
  };
}

function bindQuestion(state, call) {
  const cycle = state.cycles.find(item => item.cycleId === call.cycleId);
  const checkpoint = cycle?.checkpoint;
  if (!checkpoint || !call.args?.questions) return;
  const ids = call.args.questions.map(question => question.id);
  const matches = call.args.questions.filter(question => question.id === checkpoint.questionId);
  if (!matches.length) return;
  if (matches.length !== 1 || ids.some(id => !id) || new Set(ids).size !== ids.length) {
    degrade(state, 'ambiguous_question');
    return;
  }
  // A checkpoint owns one question call; a repeated call is not a second review.
  if (state.calls.some(item => item.questionBinding?.checkpointCallId === checkpoint.checkpointCallId)) {
    degrade(state, 'duplicate_question_binding');
    return;
  }
  call.questionBinding = { cycleId: cycle.cycleId, checkpointCallId: checkpoint.checkpointCallId, questionId: checkpoint.questionId };
}

function acceptCheckpoint(state, call, value) {
  if (!record(value) || value.kind !== 'growth_checkpoint') return degrade(state, 'invalid_checkpoint');
  const cycle = state.cycles.find(item => item.cycleId === call.cycleId);
  const args = call.args;
  const recall = state.calls.find(item => item.callId === value.recallCallId);
  const action = state.calls.find(item => item.callId === value.actionCallId);
  const artifact = value.artifact;
  const recallArtifact = value.recallArtifact;
  const valid = cycle && args && args.cycleId === cycle.cycleId && value.cycleId === cycle.cycleId
    && args.recallCallId === value.recallCallId && args.actionCallId === value.actionCallId
    && recall?.cycleId === cycle.cycleId && recall.name === 'memory_read' && recall.finished
    && recall.result?.success && recall.result.recallCandidate && recall.result.textNonempty
    && record(recallArtifact) && text(recallArtifact.path, 4096)
    && recallArtifact.sha256 === recall.result.textSha256 && recallArtifact.bytes === recall.result.textBytes
    && action?.cycleId === cycle.cycleId && ACTIONS.has(action.name) && action.finished && action.result?.success
    && recall.resultSeq < action.seq && action.resultSeq < call.seq
    && record(artifact) && text(artifact.path, 4096) && /^[a-f0-9]{64}$/.test(artifact.sha256)
    && Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0
    && samePath(args.path, artifact.path, state.cwd) && /^growth:[a-f0-9]{64}$/.test(value.questionId);
  if (!valid) return degrade(state, 'invalid_checkpoint');
  let expectedQuestionId;
  try { expectedQuestionId = growthQuestionId(cycle.cycleId, call.callId, artifact); }
  catch { return degrade(state, 'question_identity_mismatch'); }
  if (value.questionId !== expectedQuestionId) return degrade(state, 'question_identity_mismatch');
  const recallKind = recall.args.kind;
  const recallSuffix = recallKind === 'index' ? '/MEMORY.md' : `/${{ function: 'functions', insight: 'insights', dao: 'dao', capability: 'capabilities' }[recallKind]}/${recall.args.name}.md`;
  if (!pathKey(recallArtifact.path)?.endsWith(recallSuffix)) return degrade(state, 'recall_target_mismatch');
  // Root and realpath admission belongs to the checkpoint tool, never this fold.
  if (action.name === 'memory_write') {
    const feature = action.args?.feature;
    if (!text(feature) || feature.includes('/') || feature.includes('\\') || ['.', '..'].includes(feature)
      || !pathKey(artifact.path)?.endsWith(`/functions/${feature}.md`)) return degrade(state, 'artifact_target_mismatch');
  } else if (!samePath(action.args?.file_path, artifact.path, state.cwd)) return degrade(state, 'artifact_target_mismatch');
  if (state.cycles.some(item => item.checkpoint?.questionId === value.questionId)) return degrade(state, 'duplicate_question_id');
  cycle.checkpoint = {
    checkpointCallId: call.callId, checkpointSeq: call.resultSeq,
    cycleId: cycle.cycleId, recallCallId: recall.callId, actionCallId: action.callId,
    artifact: { path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes },
    recallArtifact: { path: recallArtifact.path, sha256: recallArtifact.sha256, bytes: recallArtifact.bytes }, questionId: value.questionId,
  };
  cycle.review = null;
}

function acceptAnswer(state, call, value, event) {
  const binding = call.questionBinding;
  if (!binding) return;
  const cycle = state.cycles.find(item => item.cycleId === binding.cycleId);
  // A late answer to an older checkpoint never settles the replacement checkpoint.
  if (!cycle || cycle.checkpoint?.checkpointCallId !== binding.checkpointCallId) return;
  const answers = value?.answers;
  const questions = call.args.questions;
  if (!Array.isArray(answers) || answers.length !== questions.length) return degrade(state, 'malformed_answer');
  const ids = answers.map(answer => answer?.id);
  if (new Set(ids).size !== ids.length || questions.some(question => !ids.includes(question.id))) return degrade(state, 'malformed_answer');
  const item = answers.find(answer => answer.id === binding.questionId);
  const question = questions.find(entry => entry.id === binding.questionId);
  if (!record(item) || !Array.isArray(item.selected) || item.selected.length > 64
    || item.selected.some(label => !text(label, 512) || !question.options.includes(label))
    || new Set(item.selected).size !== item.selected.length
    || (!question.multi_select && item.selected.length > 1)
    || (item.custom !== undefined && typeof item.custom !== 'string')) return degrade(state, 'malformed_answer');
  const customPresent = typeof item.custom === 'string' && item.custom.trim().length > 0;
  const skipped = item.selected.length === 0 && !customPresent;
  const answerHash = hash(JSON.stringify({ selected: item.selected, custom: item.custom ?? '' }));
  if (cycle.review) {
    if (cycle.review.answerHash !== answerHash || cycle.review.questionCallId !== call.callId) degrade(state, 'conflicting_answer');
    return;
  }
  cycle.review = {
    questionCallId: call.callId, questionId: binding.questionId, checkpointCallId: binding.checkpointCallId,
    eventSeq: event.seq, messageId: text(event.data?.id) ?? text(event.data?.message?.id),
    selected: [...item.selected], customPresent, answerHash, skipped,
    reviewObserved: !skipped && !state.incomplete, status: state.incomplete ? 'unknown' : skipped ? 'skipped' : 'answered',
    interpretation: 'not_interpreted', humanIdentity: 'unknown', goalProof: 'unknown', governanceEligible: false,
  };
}

function startCall(state, event) {
  const data = event.data;
  const callId = text(data.callId), name = text(data.name, 128);
  if (!callId || !name) return degrade(state, 'malformed_call');
  if (state.calls.some(call => call.callId === callId)) return degrade(state, 'duplicate_call_id');
  const args = safeArgs(name, data.arguments);
  const begin = name === 'memory_cycle' && args?.action === 'begin';
  if (begin) {
    state.activeCycleId = null;
    state.pendingBeginId = callId;
  }
  if (state.calls.length >= MAX_CALLS) return degrade(state, 'calls_overflow');
  const call = {
    callId, name, seq: event.seq, turn: Number.isSafeInteger(data.turn) ? data.turn : null,
    step: Number.isSafeInteger(data.step) ? data.step : null,
    cycleId: begin ? null : state.activeCycleId, args, finished: false, error: false,
    result: null, resultSeq: null, resultHash: null, resultIdentityHash: null, presentationResultSeq: null, questionBinding: null,
  };
  if (name === 'ask_user_question') bindQuestion(state, call);
  state.calls.push(call);
}

function resultCall(state, event) {
  const message = event.data?.message;
  return state.calls.find(item => item.callId === message?.toolCallId || item.callId === message?.source?.callId)
    ?? (event.surfaceOp?.op === 'replace' ? state.calls.find(item => item.finished
      && [item.resultSeq, item.presentationResultSeq].includes(event.surfaceOp.startSeq)) : undefined);
}

function finishCall(state, event) {
  const message = event.data.message;
  const call = resultCall(state, event);
  if (!call) return;
  if (!record(message)) return degrade(state, 'invalid_result_replacement');
  const { content: _presentationContent, ...messageIdentity } = message;
  const identityHash = hash(JSON.stringify({ ...event.data, message: messageIdentity }));
  if (event.surfaceOp?.op === 'replace') {
    const replacement = event.surfaceOp;
    const target = replacement.startSeq;
    if (!call.finished || !Number.isSafeInteger(target) || replacement.endSeq !== target
      || (target !== call.resultSeq && target !== call.presentationResultSeq)
      || !Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length !== 1 || event.sourceEventSeqs[0] !== target
      || event.data.turn !== call.turn || event.data.step !== call.step
      || message.toolCallId !== call.callId || message.source?.kind !== 'tool' || message.source?.callId !== call.callId
      || identityHash !== call.resultIdentityHash) return degrade(state, 'invalid_result_replacement');
    // Native surface pruning changes presentation only. Never reparse its content.
    call.presentationResultSeq = event.seq;
    return;
  }
  const fingerprint = hash(JSON.stringify({ content: message.content, isError: message.isError, source: message.source, sourceEventSeqs: event.sourceEventSeqs, turn: event.data.turn, step: event.data.step, error: event.data.error }));
  if (call.finished) {
    if (call.resultHash !== fingerprint) degrade(state, 'conflicting_result');
    return;
  }
  if (message.toolCallId !== call.callId || event.data.turn !== call.turn || event.data.step !== call.step || message.source?.kind !== 'tool'
    || message.source?.callId !== call.callId || !Array.isArray(event.sourceEventSeqs)
    || event.sourceEventSeqs.length !== 1 || event.sourceEventSeqs[0] !== call.seq) return degrade(state, 'result_identity_mismatch');
  const value = body(message.content);
  call.finished = true;
  call.error = message.isError === true || event.data.error !== undefined;
  call.result = safeResult(call, value, call.error, message.content);
  call.resultSeq = event.seq;
  call.resultHash = fingerprint;
  call.resultIdentityHash = identityHash;
  call.presentationResultSeq = event.seq;
  if (call.name === 'memory_cycle' && call.args?.action === 'begin') {
    if (state.pendingBeginId !== call.callId) return;
    state.pendingBeginId = null;
    if (!call.result.success || value?.kind !== 'growth_begin' || value.begin !== true
      || (value.cycleId !== undefined && value.cycleId !== call.callId)) return;
    if (state.cycles.length >= MAX_CYCLES) return degrade(state, 'cycles_overflow');
    state.cycles.push({ cycleId: call.callId, beginCallId: call.callId, beginSeq: call.seq, checkpoint: null, review: null });
    state.activeCycleId = call.callId;
  } else if (call.name === 'memory_cycle' && call.args?.action === 'checkpoint' && call.result.success) {
    acceptCheckpoint(state, call, value);
  } else if (call.name === 'ask_user_question' && call.result.success) {
    if (value?.pending === true) return;
    acceptAnswer(state, call, value, event);
  }
}

// The host supplies its installed Zod instance; this module adds no dependency.
export function growthStateSchema(z) {
  const id = z.string().min(1).max(512);
  const nullableId = id.nullable();
  const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const sha = z.string().regex(/^[a-f0-9]{64}$/);
  const filePath = z.string().min(1).max(4096);
  const artifact = z.object({ path: filePath, sha256: sha, bytes: seq }).strict();
  const binding = z.object({ cycleId: id, checkpointCallId: id, questionId: id }).strict();
  const checkpoint = z.object({
    checkpointCallId: id, checkpointSeq: seq, cycleId: id, recallCallId: id, actionCallId: id,
    artifact, recallArtifact: artifact, questionId: z.string().regex(/^growth:[a-f0-9]{64}$/),
  }).strict();
  const review = z.object({
    questionCallId: id, questionId: id, checkpointCallId: id, eventSeq: seq, messageId: nullableId,
    selected: z.array(id).max(64), customPresent: z.boolean(), answerHash: sha, skipped: z.boolean(),
    reviewObserved: z.boolean(), status: z.enum(['unknown', 'skipped', 'answered']),
    interpretation: z.literal('not_interpreted'), humanIdentity: z.literal('unknown'), goalProof: z.literal('unknown'), governanceEligible: z.literal(false),
  }).strict();
  const args = z.union([
    z.object({ action: z.string().max(32).nullable(), cycleId: nullableId, recallCallId: nullableId, actionCallId: nullableId, path: filePath.nullable() }).strict(),
    z.object({ kind: z.string().max(64).nullable(), name: nullableId, objectKey: nullableId }).strict(),
    z.object({ feature: nullableId }).strict(),
    z.object({ file_path: filePath.nullable() }).strict(),
    z.object({ questions: z.array(z.object({ id: nullableId, options: z.array(nullableId).max(64), multi_select: z.boolean() }).strict()).max(32) }).strict(),
    z.object({}).strict(),
  ]).nullable();
  const result = z.object({
    textSha256: sha, textNonempty: z.boolean(), textBytes: seq,
    success: z.boolean(), path: filePath.nullable(), selfCheckOk: z.boolean().nullable(), recallCandidate: z.boolean().optional(),
  }).strict();
  return z.object({
    version: z.literal(2), sessionId: nullableId, cwd: filePath.nullable(), inheritedEventCount: seq,
    lastSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER), activeCycleId: nullableId, pendingBeginId: nullableId,
    incomplete: z.boolean(), reasons: z.array(z.string().min(1).max(64)).max(16),
    cycles: z.array(z.object({ cycleId: id, beginCallId: id, beginSeq: seq, checkpoint: checkpoint.nullable(), review: review.nullable() }).strict()).max(MAX_CYCLES),
    calls: z.array(z.object({
      callId: id, name: z.string().min(1).max(128), seq, turn: seq.nullable(), step: seq.nullable(), cycleId: nullableId,
      args, finished: z.boolean(), error: z.boolean(), result: result.nullable(), resultSeq: seq.nullable(), resultHash: sha.nullable(), resultIdentityHash: sha.nullable(), presentationResultSeq: seq.nullable(), questionBinding: binding.nullable(),
    }).strict()).max(MAX_CALLS),
    eventRefs: z.array(z.object({ seq, hash: sha }).strict()).max(MAX_EVENTS),
  }).strict().superRefine((state, ctx) => {
    const fail = message => ctx.addIssue({ code: 'custom', message });
    if (new Set(state.calls.map(call => call.callId)).size !== state.calls.length) fail('Duplicate call identities');
    if (new Set(state.cycles.map(cycle => cycle.cycleId)).size !== state.cycles.length) fail('Duplicate cycle identities');
    if (state.activeCycleId !== null && !state.cycles.some(cycle => cycle.cycleId === state.activeCycleId)) fail('Unknown active cycle');
    if (state.pendingBeginId !== null && state.activeCycleId !== null) fail('Pending begin cannot retain an active cycle');
    for (const cycle of state.cycles) {
      if (cycle.checkpoint && cycle.checkpoint.cycleId !== cycle.cycleId) fail('Checkpoint cycle mismatch');
      if (cycle.review?.reviewObserved && (state.incomplete || cycle.review.skipped || cycle.review.status !== 'answered'
        || cycle.review.checkpointCallId !== cycle.checkpoint?.checkpointCallId)) fail('Invalid observed review');
    }
  });
}

export function applyGrowth(state, event) {
  if (!record(event) || !Number.isSafeInteger(event.seq) || event.seq < 0) return degrade(clone(state), 'malformed_event');
  if (event.seq < state.inheritedEventCount) return state;
  if (!RELEVANT.has(event.type)) return state;
  if (event.type === 'user/message' && event.data?.source?.kind !== 'user-question-reply') return state;
  if (event.type === 'tool/call' && !state.activeCycleId
    && !(event.data?.name === 'memory_cycle' && parse(event.data?.arguments)?.action === 'begin')
    && !state.calls.some(call => call.callId === event.data?.callId)) return state;
  if (event.type === 'tool/result' && !resultCall(state, event)) return state;
  if (event.type === 'user/message' && !state.calls.some(call => call.callId === event.data?.source?.callId && call.questionBinding)) return state;
  if (event.type.startsWith('tool/ptc-') && !state.activeCycleId) return state;
  const next = clone(state);
  const serialized = JSON.stringify(event);
  if (serialized.length > MAX_TEXT) return degrade(next, 'event_oversized');
  const fingerprint = hash(serialized);
  const prior = next.eventRefs.find(item => item.seq === event.seq);
  if (prior) return prior.hash === fingerprint ? state : degrade(next, 'conflicting_event');
  if (event.seq <= next.lastSeq) return degrade(next, 'out_of_order_event');
  if (next.eventRefs.length >= MAX_EVENTS) return degrade(next, 'events_overflow');
  next.lastSeq = event.seq;
  next.eventRefs.push({ seq: event.seq, hash: fingerprint });
  if (!record(event.data)) return degrade(next, 'malformed_event');
  if (event.type.startsWith('tool/ptc-')) return degrade(next, 'ptc_unsupported');
  if (event.type === 'tool/call') startCall(next, event);
  if (event.type === 'tool/result') finishCall(next, event);
  if (event.type === 'user/message') {
    const source = event.data.source;
    const call = next.calls.find(item => item.callId === source.callId);
    const value = body(event.data.content);
    if (call?.questionBinding) {
      if (source.outcome !== 'answered' || value?.kind !== 'answer_to_pending_question'
        || value?.tool !== 'ask_user_question' || value?.callId !== source.callId) degrade(next, 'malformed_late_answer');
      else acceptAnswer(next, call, value, event);
    }
  }
  return next;
}
