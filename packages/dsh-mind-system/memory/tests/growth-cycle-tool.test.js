import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { memoryCycleTool, growthReport } from '../src/growth-cycle-tool.js';
import { initGrowth, applyGrowth } from '../src/growth-cycle-projection.js';

async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'growth-cycle-tool-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const root = path.join(cwd, 'memory');
  await mkdir(path.join(root, 'functions'), { recursive: true });
  const principle = path.join(root, 'functions', 'principle.md');
  await writeFile(principle, 'Use a failing negative control.');
  const artifact = path.join(cwd, 'result.txt');
  const header = { id: 'session-a', cwd };
  const session = { header };
  let state = initGrowth(header, 0), seq = 0, counter = 0;
  const events = [];
  const append = (type, data, sources) => {
    const event = { type, seq: seq++, time: '2026-11-27T00:00:00Z', data, ...(sources ? { sourceEventSeqs: sources } : {}) };
    events.push(event); state = applyGrowth(state, event); return event.seq;
  };
  const start = (name, args, id = `call-${++counter}`) => {
    const callSeq = append('tool/call', { turn: 1, step: counter, callId: id, name, arguments: JSON.stringify(args) });
    return { id, callSeq };
  };
  const finish = (call, text, isError = false) => append('tool/result', { turn: 1, step: counter, message: { id: `message-${call.id}`, role: 'tool', toolCallId: call.id, source: { kind: 'tool', callId: call.id }, content: [{ type: 'text', text }], isError } }, [call.callSeq]);
  const tool = memoryCycleTool({ stateOf: async () => state, memoryRoot: () => root });
  const invoke = async args => {
    const call = start('memory_cycle', args);
    try {
      const result = await tool.execute(args, { callId: call.id, agent: { session } });
      finish(call, JSON.stringify(result)); return result;
    } catch (error) { finish(call, String(error.message), true); throw error; }
  };
  const seed = async () => {
    const begin = await invoke({ action: 'begin' });
    const recall = start('memory_read', { kind: 'function', name: 'principle' });
    finish(recall, await readFile(principle, 'utf8'));
    const action = start('write', { file_path: artifact, content: 'verified artifact' });
    await writeFile(artifact, 'verified artifact'); finish(action, 'Created file');
    return { cycleId: begin.cycleId, recallCallId: recall.id, actionCallId: action.id, path: artifact };
  };
  return { cwd, root, artifact, principle, header, events, start, finish, invoke, seed, tool, session, state: () => state };
}

test('real file checkpoint, bound answer and replay survive a completed action', async t => {
  const f = await fixture(t);
  const selected = await f.seed();
  const checkpoint = await f.invoke({ action: 'checkpoint', ...selected });
  assert.equal(checkpoint.artifact.bytes, 17);
  const question = f.start('ask_user_question', { questions: [{ id: checkpoint.questionId, question: 'Review?', options: [{ label: 'accepted' }] }] });
  f.finish(question, JSON.stringify({ answers: [{ id: checkpoint.questionId, selected: ['accepted'] }] }));
  const report = JSON.parse((await f.invoke({ action: 'report' })).report);
  assert.equal(report.questionAnswerObserved, true);
  assert.equal(report.artifactCurrent, 'matches');
  assert.equal(report.reviewAppliesToCurrentBytes, true);
  assert.equal(report.goalProof, 'not_evaluated');
  assert.equal(report.reviewQuestion, null);
  assert.match(report.next, /actual response/);
  const replayed = f.events.reduce(applyGrowth, initGrowth(f.header, 0));
  assert.deepEqual(replayed, f.state());
  await writeFile(f.artifact, 'changed after review');
  const changed = JSON.parse((await f.invoke({ action: 'report' })).report);
  assert.equal(changed.artifactCurrent, 'changed');
  assert.equal(changed.reviewAppliesToCurrentBytes, false);
});

test('a skipped question and an unrelated question cannot supply review', async t => {
  const f = await fixture(t);
  const selected = await f.seed();
  const checkpoint = await f.invoke({ action: 'checkpoint', ...selected });
  const unrelated = f.start('ask_user_question', { questions: [{ id: 'unrelated', question: 'Other?' }] });
  f.finish(unrelated, JSON.stringify({ answers: [{ id: 'unrelated', selected: ['yes'] }] }));
  const question = f.start('ask_user_question', { questions: [{ id: checkpoint.questionId, question: 'Review?' }] });
  f.finish(question, JSON.stringify({ answers: [{ id: checkpoint.questionId, selected: [] }] }));
  const report = JSON.parse((await f.invoke({ action: 'report' })).report);
  assert.equal(report.questionAnswerObserved, false);
  assert.equal(report.reviewQuestion, null);
  assert.match(report.next, /skip is not approval/);
});

test('an issued question waits for its existing reply without prompting again', async t => {
  const f = await fixture(t);
  const selected = await f.seed();
  const checkpoint = await f.invoke({ action: 'checkpoint', ...selected });
  f.start('ask_user_question', { questions: [{ id: checkpoint.questionId, question: 'Review?' }] });
  const report = JSON.parse((await f.invoke({ action: 'report' })).report);
  assert.equal(report.reviewQuestion, null);
  assert.equal(report.questionAnswerObserved, false);
  assert.match(report.next, /Await the existing question/);
});

test('checkpoint rejects other-cycle calls, changed recall and unrelated artifact', async t => {
  const f = await fixture(t);
  const selected = await f.seed();
  const other = path.join(f.cwd, 'unrelated.txt');
  await writeFile(other, 'unrelated');
  await assert.rejects(f.invoke({ action: 'checkpoint', ...selected, path: other }), /not_action_target/);
  await writeFile(f.principle, 'changed');
  await assert.rejects(f.invoke({ action: 'checkpoint', ...selected }), /recall_bytes_not_matched/);
  const next = await f.invoke({ action: 'begin' });
  await assert.rejects(f.invoke({ action: 'checkpoint', ...selected, cycleId: next.cycleId }), /recall_not_observed/);
});

test('layered reuse never promotes a read or an answered review into adoption or outcome', async () => {
  const priorHash = 'a'.repeat(64);
  const state = {
    incomplete: false, reasons: [], activeCycleId: 'current',
    cycles: [
      { cycleId: 'prior', checkpoint: { artifact: { path: 'x', sha256: priorHash, bytes: 1 } }, review: { reviewObserved: true, selected: ['成立，继续复用'], customPresent: false, status: 'answered' } },
      { cycleId: 'current', checkpoint: null, review: null },
    ],
    calls: [
      { callId: 'read-again', cycleId: 'current', name: 'memory_read', finished: true, error: false, args: { kind: 'function', name: 'x' }, result: { success: true, textSha256: priorHash } },
    ],
  };
  const report = await growthReport(state, { cycleId: 'current', cwd: process.cwd(), memoryRoot: process.cwd() });
  assert.equal(report.reuseObservations.length, 1);
  const reuse = report.reuseObservations[0];
  assert.deepEqual(reuse.readAgain, { observed: true, basis: 'checkpoint_artifact_sha256_equals_recalled_bytes' });
  assert.equal(reuse.cited.observed, false, 'no artifact in the current cycle means no byte-copy evidence');
  assert.equal(reuse.adopted.observed, false, 'an answered review that selected an adopt label is still not adoption');
  assert.match(reuse.adopted.basis, /uninterpreted_and_human_unverified/);
  assert.equal(reuse.outcome.observed, false, 'no independent goal evidence exists');
  assert.equal(report.goalProof, 'not_evaluated');
  assert.equal(report.principleAttribution, 'not_evaluated');

  // Positive control: an exact byte copy into the current artifact is observable.
  const copied = structuredClone(state);
  copied.cycles[1].checkpoint = { artifact: { path: 'y', sha256: priorHash, bytes: 1 } };
  const withCopy = await growthReport(copied, { cycleId: 'current', cwd: process.cwd(), memoryRoot: process.cwd() });
  const cited = withCopy.reuseObservations[0].cited;
  assert.equal(cited.observed, true);
  assert.match(cited.basis, /current_checkpoint_artifact_bytes_equal_recalled_bytes/);
  assert.equal(withCopy.reuseObservations[0].adopted.observed, false, 'a byte copy is still not adoption');
});

test('no caller-supplied session or verdict can create evidence', async t => {
  const f = await fixture(t);
  await assert.rejects(f.tool.execute({ action: 'begin' }, {}), /host_session_required/);
  await assert.rejects(f.invoke({ action: 'begin', cycleId: 'invented' }), /only_action|Unknown|Unexpected|unrecognized/i);
});
