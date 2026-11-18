import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createHost, installed } from './helpers/host.js';
import { RuntimeStore } from '../src/store.js';
import { HostExecutor } from '../src/executor.js';
import { RuntimeScheduler } from '../src/scheduler.js';
import { csvNormalizeRecipe, RECIPE_ID, VERIFIER_ID } from '../recipes/csv-normalize.js';

/**
 * A second recipe through the same engine.
 *
 * Why this suite exists: the engine's generality cannot be demonstrated by the JSON template alone —
 * `json-normalize` could have been special-cased without anyone noticing. These tests run a
 * line-oriented format with its own parser, its own verifier identity and its own preconditions through
 * the unchanged scheduler, so generality is observed rather than asserted.
 */

async function pipeline(t, { source = 'id,name\nb, Beta \na, Alpha \n' } = {}) {
  const host = await createHost(t);
  const store = new RuntimeStore(join(host.root, 'csv.sqlite'));
  const agent = await host.agent('csv-caller');
  const executor = new HostExecutor({ context: host.ctx, tools: host.tools, agent });
  const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(installed['dsh-tools'].entry).href);
  writeFileSync(join(host.storage, 'source.csv'), source);
  host.tools.register({ name: 'runtime_write_text', description: 'Create the owned text artifact.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, createOnly: { type: 'boolean', enum: [true] } },
      required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{"created":true}' }] },
    async execute({ path, content }) { writeFileSync(path, content, { flag: 'wx' }); return { created: true }; } });
  const scheduler = new RuntimeScheduler({ store, executor, recipes: [csvNormalizeRecipe], tools: host.tools,
    validateArguments({ tool, arguments: args }) { assertObjectJsonSchema(tool.parameters); return validateJsonSchemaValue(tool.parameters, args); } });
  const authority = { scopeRef: 'csv-scope', workspaceRoot: host.storage, allowedTools: ['runtime_write_text'], agent };
  const task = { taskId: randomUUID(), recipeId: RECIPE_ID, recipeVersion: '1', goal: 'Normalize the CSV.',
    scopeRef: authority.scopeRef, workspaceRoot: host.storage, inputs: { inputFile: 'source.csv', outputFile: 'output.csv' },
    deadlineAt: Date.now() + 60_000 };
  const close = async () => { await executor.dispose(); store.close(); };
  return { host, store, scheduler, task, authority, close };
}

test('a second recipe runs through the unchanged engine to verified completion', async (t) => {
  const env = await pipeline(t);
  try {
    const run = await env.scheduler.run(env.task, { authority: env.authority });
    assert.equal(run.status, 'completed');
    assert.equal(run.state.inputs.inputSha256.length, 64);
    const written = readFileSync(join(env.host.storage, 'output.csv'), 'utf8');
    assert.equal(written, 'id,name\na,Alpha\nb,Beta\n', 'Sorted by id with trimmed names.');
    // The verifier identity is this recipe's own; it must not be borrowed from the JSON template.
    const final = env.store.readEvents(env.task.taskId).findLast((event) => event.kind === 'outcome_recorded');
    assert.equal(final.payload.verification.verifierId, VERIFIER_ID);
    assert.notEqual(final.payload.verification.verifierId, 'json-source-output');
  } finally { await env.close(); }
});

test('quoting is parsed rather than taken literally, and output stays minimal', async (t) => {
  const env = await pipeline(t, { source: 'id,name\n"a,1"," Alpha "\n"b""2", Beta \n' });
  try {
    const run = await env.scheduler.run(env.task, { authority: env.authority });
    assert.equal(run.status, 'completed');
    const written = readFileSync(join(env.host.storage, 'output.csv'), 'utf8');
    // Ids containing a comma or a quote must be re-quoted; plain ids must not be.
    assert.equal(written, 'id,name\n"a,1",Alpha\n"b""2",Beta\n');
  } finally { await env.close(); }
});

test('an output that parses but does not match is rejected by verification, not by the write', async (t) => {
  const env = await pipeline(t);
  try {
    // Write a valid CSV that is wrong in content: verification must catch it even though the file parses.
    env.host.tools.get('runtime_write_text').execute = async ({ path }) => {
      writeFileSync(path, 'id,name\na,Wrong\nb,Beta\n', { flag: 'wx' });
      return { created: true };
    };
    const run = await env.scheduler.run(env.task, { authority: env.authority });
    assert.equal(run.status, 'waiting_analysis');
    assert.equal(run.reason, 'output_mismatch');
  } finally { await env.close(); }
});

test('a malformed source is refused at preparation instead of producing a bad artifact', async (t) => {
  const env = await pipeline(t, { source: 'id,name\na,Alpha\na,Duplicate\n' });
  try {
    // The scheduler owns the run by now, so a preparation failure surfaces as a stop state rather than a
    // thrown error (the same contract the JSON recipe relies on). What matters is that nothing was written.
    const run = await env.scheduler.run(env.task, { authority: env.authority });
    // A preparation failure lands in the analysis queue, not a hard failure: the engine treats it as a
    // condition worth diagnosing. The invariant that matters is that no artifact was produced.
    assert.equal(run.status, 'waiting_analysis');
    assert.equal(run.reason, 'invalid_recipe_input');
    assert.throws(() => readFileSync(join(env.host.storage, 'output.csv')), { code: 'ENOENT' },
      'A refused source must not produce an artifact.');
  } finally { await env.close(); }
});

test('a malformed source is rejected before the run owns it when preparation is called directly', async (t) => {
  const env = await pipeline(t, { source: 'id,name\na,Alpha\na,Duplicate\n' });
  try {
    const { prepareCsvTask } = await import('../recipes/csv-normalize.js');
    assert.throws(() => prepareCsvTask({ taskId: randomUUID(), workspaceRoot: env.host.storage,
      inputFile: 'source.csv', outputFile: 'output.csv', scopeRef: 'csv-scope',
      deadlineAt: Date.now() + 60_000 }), { code: 'invalid_recipe_input' });
  } finally { await env.close(); }
});

test('the two recipes are independent: registering one does not enable the other', async (t) => {
  const env = await pipeline(t);
  try {
    // A task claiming the JSON recipe must be refused here: this scheduler only registered the CSV one.
    const foreign = { ...env.task, recipeId: 'json-normalize' };
    await assert.rejects(env.scheduler.run(foreign, { authority: env.authority }),
      { code: 'recipe_not_registered' });
  } finally { await env.close(); }
});
