import path from 'node:path';
import { defineTool } from './host.js';
import { inspectGrowthArtifact, growthQuestionId } from './growth-artifact.js';

const SLUG = /^[^\\/\x00-\x1f]+$/;
const ZONES = { function: 'functions', insight: 'insights', dao: 'dao', capability: 'capabilities' };
const ACTIONS = new Set(['write', 'edit', 'memory_write']);

function memoryTarget(args, root) {
  if (args?.kind === 'index') return path.join(root, 'MEMORY.md');
  if (!ZONES[args?.kind] || typeof args.name !== 'string' || !SLUG.test(args.name) || ['.', '..'].includes(args.name)) {
    throw new Error('growth_recall_requires_named_memory');
  }
  return path.join(root, ZONES[args.kind], `${args.name}.md`);
}
function actionTarget(call, root) {
  if (['write', 'edit'].includes(call.name)) return call.args.file_path;
  const name = call.args.feature;
  if (typeof name !== 'string' || !SLUG.test(name) || ['.', '..'].includes(name)) throw new Error('growth_action_target_invalid');
  return path.join(root, 'functions', `${name}.md`);
}
const bounds = { humanIdentity: 'unknown', goalProof: 'not_evaluated', principleAttribution: 'not_evaluated', governanceEligible: false };

export async function growthReport(state, { cycleId, cwd, memoryRoot }) {
  const cycle = state.cycles.find(item => item.cycleId === (cycleId ?? state.activeCycleId));
  if (!cycle) return { status: 'missing', ...bounds, incomplete: state.incomplete, cycles: state.cycles.map(item => item.cycleId) };
  const calls = state.calls.filter(call => call.cycleId === cycle.cycleId);
  const checkpoint = cycle.checkpoint;
  const questionIssued = Boolean(checkpoint && state.calls.some(call => call.questionBinding?.checkpointCallId === checkpoint.checkpointCallId));
  let artifactCurrent = 'not_observed';
  if (checkpoint) {
    try {
      const current = await inspectGrowthArtifact(checkpoint.artifact.path, { cwd, memoryRoot });
      artifactCurrent = current.sha256 === checkpoint.artifact.sha256 ? 'matches' : 'changed';
    } catch { artifactCurrent = 'unavailable'; }
  }
  return {
    status: 'available', cycleId: cycle.cycleId, incomplete: state.incomplete,
    reasons: state.reasons, evidenceScope: 'committed_session_events', ...bounds,
    recalls: calls.filter(call => call.name === 'memory_read' && call.finished && !call.error).map(call => ({ callId: call.callId, args: call.args })),
    actions: calls.filter(call => ACTIONS.has(call.name) && call.finished && !call.error).map(call => ({ callId: call.callId, name: call.name, args: call.args })),
    checkpoint, artifactCurrent, review: cycle.review,
    // Layered reuse: only "read again" and an exact byte-copy into the current
    // artifact are observable from committed events. A bound review (even one
    // whose selected label says "adopt") is neither interpreted nor human-
    // authenticated, so it can never establish adoption or an outcome.
    reuseObservations: calls.filter(call => call.name === 'memory_read' && call.finished && !call.error).flatMap(call =>
      state.cycles.filter(prior => prior.cycleId !== cycle.cycleId && prior.review?.reviewObserved && prior.checkpoint?.artifact.sha256 === call.result?.textSha256)
        .map(prior => {
          const copiedIntoArtifact = Boolean(cycle.checkpoint && cycle.checkpoint.artifact.sha256 === call.result?.textSha256);
          return {
            priorCycleId: prior.cycleId, recallCallId: call.callId, artifact: prior.checkpoint.artifact, priorReview: prior.review,
            readAgain: { observed: true, basis: 'checkpoint_artifact_sha256_equals_recalled_bytes' },
            cited: copiedIntoArtifact
              ? { observed: true, basis: 'current_checkpoint_artifact_bytes_equal_recalled_bytes' }
              : { observed: false, basis: 'no_artifact_reference_signal_in_committed_events' },
            adopted: { observed: false, basis: 'prior_review_uninterpreted_and_human_unverified' },
            outcome: { observed: false, basis: 'no_independent_goal_evidence' },
          };
        })),
    reviewQuestion: checkpoint && !questionIssued && !state.incomplete ? { id: checkpoint.questionId, question: '这次改进是否成立？复核对象是本次 checkpoint 记录的产物版本。', options: [{ label: '成立，继续复用' }, { label: '需要纠正' }] } : null,
    questionAnswerObserved: !state.incomplete && Boolean(cycle.review?.reviewObserved),
    reviewAppliesToCurrentBytes: !state.incomplete && artifactCurrent === 'matches' && Boolean(cycle.review?.reviewObserved) && cycle.review?.checkpointCallId === checkpoint?.checkpointCallId,
    next: state.incomplete ? 'Resolve the incomplete evidence before requesting review.'
      : cycle.review ? 'A reply was recorded. Interpret the actual response; an answer or skip is not approval. Do not repeat the same question.'
      : questionIssued ? 'Await the existing question reply; do not repeat the same question.'
      : checkpoint ? 'Use ask_user_question with this exact checkpoint questionId; after the answer, read report again. A skipped answer is not confirmation.'
      : 'Read relevant memory, perform the actual change, then checkpoint the selected recall and action callIds.',
  };
}

/** Evidence is committed through ordinary tool results and replayed by the Host. */
export function memoryCycleTool({ stateOf, memoryRoot }) {
  return defineTool({
    name: 'memory_cycle',
    description: 'Track a real improvement through committed session events. begin starts an explicit cycle; report lists its real memory reads and changes; checkpoint independently hashes a named recalled memory and the exact file targeted by a successful change. Use the returned questionId with ask_user_question for review, then report again. No caller-supplied verdict, human authentication or automatic governance. Begin before doing the task; do not fabricate a demonstration as natural work.',
    parameters: {
      action: { type: 'string', required: true, enum: ['begin', 'checkpoint', 'report'] },
      cycleId: { type: 'string', description: 'Cycle id returned by begin/report, from this session only.' },
      recallCallId: { type: 'string', description: 'Successful named memory_read call in this cycle.' },
      actionCallId: { type: 'string', description: 'Successful write, edit or memory_write call in this cycle. Use an absolute file_path for write/edit.' },
      path: { type: 'string', description: 'Existing artifact targeted by that action, inside the session workspace or memory root.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', required: true }, begin: { type: 'boolean' }, cycleId: { type: 'string' },
        recallCallId: { type: 'string' }, actionCallId: { type: 'string' }, questionId: { type: 'string' },
        artifact: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, sha256: { type: 'string', required: true }, bytes: { type: 'integer', required: true } } },
        recallArtifact: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, sha256: { type: 'string', required: true }, bytes: { type: 'integer', required: true } } },
        report: { type: 'string' },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const session = exec?.agent?.session;
      if (!session || typeof exec.callId !== 'string') throw new Error('growth_host_session_required');
      const state = await stateOf(session);
      if (!state) throw new Error('growth_projection_unavailable');
      if (state.incomplete && args.action !== 'report') throw new Error(`growth_projection_incomplete:${state.reasons.join(',')}`);
      const root = memoryRoot();
      const cwd = session.header.cwd;
      if (args.action === 'begin') {
        if (Object.keys(args).some(key => key !== 'action')) throw new Error('growth_begin_accepts_only_action');
        return { kind: 'growth_begin', begin: true, cycleId: exec.callId };
      }
      if (args.action === 'report') {
        if (Object.keys(args).some(key => !['action', 'cycleId'].includes(key))) throw new Error('growth_report_arguments');
        return { kind: 'growth_report', report: JSON.stringify(await growthReport(state, { cycleId: args.cycleId, cwd, memoryRoot: root })) };
      }
      if (args.action !== 'checkpoint') throw new Error('growth_action_invalid');
      const cycle = state.cycles.find(item => item.cycleId === args.cycleId);
      if (!cycle || cycle.cycleId !== state.activeCycleId) throw new Error('growth_active_cycle_required');
      const recall = state.calls.find(call => call.callId === args.recallCallId && call.cycleId === cycle.cycleId);
      const action = state.calls.find(call => call.callId === args.actionCallId && call.cycleId === cycle.cycleId);
      if (!recall?.finished || recall.error || !recall.result?.success || !recall.result?.recallCandidate || recall.name !== 'memory_read') throw new Error('growth_recall_not_observed');
      if (!action?.finished || action.error || !action.result?.success || !ACTIONS.has(action.name) || action.seq <= recall.resultSeq) throw new Error('growth_action_not_observed');
      const options = { cwd, memoryRoot: root };
      const recallArtifact = await inspectGrowthArtifact(memoryTarget(recall.args, root), options);
      if (recallArtifact.sha256 !== recall.result?.textSha256) throw new Error('growth_recall_bytes_not_matched');
      const artifact = await inspectGrowthArtifact(args.path, options);
      const target = await inspectGrowthArtifact(actionTarget(action, root), options);
      if (artifact.path !== target.path || artifact.sha256 !== target.sha256) throw new Error('growth_artifact_not_action_target');
      return {
        kind: 'growth_checkpoint', cycleId: cycle.cycleId, recallCallId: recall.callId, actionCallId: action.callId,
        artifact, recallArtifact, questionId: growthQuestionId(cycle.cycleId, exec.callId, artifact),
      };
    },
  });
}
