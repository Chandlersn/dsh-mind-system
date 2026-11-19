/**
 * Outcome and checkpoint commit together (2026-11-19).
 *
 * The scheduler used to commit the settled attempt and business state first, then write the checkpoint in
 * a second transaction. A crash or a failing checkpoint insert in that gap left a verified, advanced run
 * with no rollback target — the two records disagreed about the same step. These tests force the failure
 * instead of trusting the happy path, and check that the continuation state after a rollback is exactly
 * what was committed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createHost, installed } from './helpers/host.js';
import { RuntimeStore } from '../src/store.js';
import { HostExecutor } from '../src/executor.js';
import { RuntimeScheduler } from '../src/scheduler.js';
import { jsonNormalizeRecipe } from '../recipes/json-normalize.js';

async function pipeline(t) {
  const host = await createHost(t);
  const store = new RuntimeStore(join(host.root, 'atomic.sqlite'));
  const agent = await host.agent('atomic-caller');
  const executor = new HostExecutor({ context: host.ctx, tools: host.tools, agent });
  const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(installed['dsh-tools'].entry).href);
  writeFileSync(join(host.storage, 'source.json'), JSON.stringify([{ id: 'a', name: ' Alpha ' }]));
  host.tools.register({ name: 'runtime_write_json', description: 'Create the owned fixture artifact.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, createOnly: { type: 'boolean', enum: [true] } },
      required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{"created":true}' }] },
    async execute({ path, content }) { writeFileSync(path, content, { flag: 'wx' }); return { created: true }; } });
  const scheduler = new RuntimeScheduler({ store, executor, recipes: [jsonNormalizeRecipe], tools: host.tools,
    validateArguments({ tool, arguments: args }) { assertObjectJsonSchema(tool.parameters); return validateJsonSchemaValue(tool.parameters, args); } });
  const authority = { scopeRef: 'atomic-scope', workspaceRoot: host.storage, allowedTools: ['runtime_write_json'], agent };
  const task = { taskId: randomUUID(), recipeId: 'json-normalize', recipeVersion: '1', goal: 'Create sorted records.',
    scopeRef: authority.scopeRef, workspaceRoot: host.storage, inputs: { inputFile: 'source.json', outputFile: 'output.json' },
    deadlineAt: Date.now() + 60_000 };
  const close = async () => { await executor.dispose(); store.close(); };
  return { host, store, scheduler, task, authority, close };
}

test('a checkpoint insert failure leaves no settled attempt, state change or event', async (t) => {
  const env = await pipeline(t);
  try {
    // Fail only the checkpoint row: if the outcome had already committed, the run would still read as
    // settled with advanced state and a missing rollback point. The whole transaction must roll back.
    env.store.withDatabase((db) => db.exec(`CREATE TRIGGER fail_checkpoint BEFORE INSERT ON checkpoints
      BEGIN SELECT RAISE(ABORT, 'checkpoint insert blocked'); END`));
    // A created run never throws out of `run`: the failure is converted into a frozen attempt so the
    // caller sees a state, not an exception. What must NOT exist is any trace of the settled outcome.
    await env.scheduler.run(env.task, { authority: env.authority });

    const run = env.store.getRun(env.task.taskId);
    assert.equal(env.store.listCheckpoints(env.task.taskId).length, 0);
    const events = env.store.readEvents(env.task.taskId);
    const kinds = events.map((event) => event.kind);
    assert.ok(!kinds.includes('checkpoint_recorded'), 'no checkpoint event may survive the rollback');
    const outcomeEvents = events.filter((event) => event.kind === 'outcome_recorded');
    assert.equal(outcomeEvents.length, 1, 'only the post-rollback reconciliation event may exist');
    assert.equal(outcomeEvents[0].payload.outcome.status, 'outcome_unknown',
      'a settled success must not survive a failed checkpoint insert');
    // The failure happened after dispatch, so the attempt is frozen for reconciliation rather than
    // quietly settled — the runtime must not claim a result it could not persist.
    const attempts = env.store.listUnresolved(env.task.taskId);
    assert.equal(attempts.length, 1, 'the started attempt must remain unresolved');
    assert.equal(run.status, 'reconciling');
    // The reason carries the real storage failure code rather than a fabricated semantic one.
    assert.match(run.reason, /ERR_SQLITE_ERROR|checkpoint/);
  } finally { await env.close(); }
});

test('the committed outcome and checkpoint describe the same step and survive reopen', async (t) => {
  const env = await pipeline(t);
  const file = join(env.host.root, 'atomic.sqlite');
  try {
    const run = await env.scheduler.run(env.task, { authority: env.authority });
    assert.equal(run.status, 'completed');
    const [checkpoint] = env.store.listCheckpoints(env.task.taskId);
    assert.ok(checkpoint, 'a verified step must leave a rollback point');
    // Same step as the settled attempt: one transaction advances the run once, so the checkpoint cannot
    // point at a step the attempt did not actually reach.
    assert.deepEqual(checkpoint.state, run.state);
    assert.equal(checkpoint.stepIndex, 1);
    assert.equal(env.store.getLatestAttempt(env.task.taskId).status, 'settled');
    const kinds = env.store.readEvents(env.task.taskId).map((event) => event.kind);
    assert.ok(kinds.indexOf('outcome_recorded') < kinds.indexOf('checkpoint_recorded'), 'outcome precedes checkpoint');
  } finally { await env.close(); }

  const reopened = new RuntimeStore(file);
  try {
    const checkpoints = reopened.listCheckpoints(env.task.taskId);
    assert.equal(checkpoints.length, 1, 'the rollback point is durable, not an in-memory artefact');
    assert.deepEqual(checkpoints[0].state, reopened.getRun(env.task.taskId).state);
  } finally { reopened.close(); }
});

test('an unverified step still writes no checkpoint after consolidation', async (t) => {
  const env = await pipeline(t);
  try {
    env.host.tools.get('runtime_write_json').execute = async ({ path }) => {
      writeFileSync(path, '[]', { flag: 'wx' });
      return { created: true };
    };
    const run = await env.scheduler.run(env.task, { authority: env.authority });
    assert.equal(run.status, 'waiting_analysis');
    assert.equal(env.store.listCheckpoints(env.task.taskId).length, 0);
  } finally { await env.close(); }
});