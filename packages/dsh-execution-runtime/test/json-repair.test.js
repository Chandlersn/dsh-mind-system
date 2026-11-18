import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { prepareJsonTask, buildJsonCandidate, verifyJsonOutput } from '../recipes/json-normalize.js';
import { jsonNormalizeRepairPolicy as policy } from '../recipes/json-repair.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-json-repair-')));
  t.after(() => {
    assert.equal(dirname(resolve(root)), realpathSync(tmpdir()));
    assert.ok(basename(root).startsWith('runtime-json-repair-'));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, 'source.json'), JSON.stringify([
    { id: 'b', name: ' Beta ' }, { id: 'a', name: ' Alpha ' },
  ]));
  const task = prepareJsonTask({ taskId: 'repair-fixture', workspaceRoot: root, inputFile: 'source.json',
    outputFile: 'output.json', scopeRef: 'owned-fixture', deadlineAt: Date.now() + 60_000 });
  const state = { inputs: clone(task.inputs) };
  const original = buildJsonCandidate(task);
  writeFileSync(join(root, 'output.json'), '[]\n', { flag: 'wx' });
  const previousAttempt = { attemptId: 'original-create', status: 'settled', candidate: original,
    outcome: { status: 'succeeded' }, verification: verifyJsonOutput(task) };
  const calls = [];
  const io = Object.fromEntries(Object.entries({ lstatSync, readFileSync, realpathSync })
    .map(([name, fn]) => [name, (...args) => { calls.push({ name, path: args[0] }); return fn(...args); }]));
  const context = policy.prepare({ task, state, previousAttempt });
  const candidate = { ...clone(original), candidateId: 'repair-output', toolName: 'runtime_replace_json',
    arguments: { path: join(root, 'output.json'), content: original.arguments.content, expectedSha256: context.observedSha256 },
    preconditionIds: [...policy.requiredPreconditionIds], postconditionIds: [...policy.postconditionIds] };
  const args = { task, state, candidate, io, repairContext: context };
  const verdicts = (overrides = {}) => policy.requiredPreconditionIds.map((id) => policy.preconditions[id]({ ...args, ...overrides }));
  return { root, task, state, previousAttempt, candidate, context, io, calls, args, verdicts };
}

function denied(env, overrides = {}) {
  assert.ok(env.verdicts(overrides).every((result) => result.verdict === 'deny'));
}

test('native policy exposes fixed authority and immutable JSON ownership context', (t) => {
  const env = fixture(t);
  assert.deepEqual(policy.allowedTools, ['runtime_replace_json']);
  assert.deepEqual(policy.toolEffects, { 'runtime_replace_json': 'reversible_write' });
  assert.deepEqual(policy.requiredPreconditionIds, ['source-hash-unchanged', 'owned-output-unchanged', 'workspace-scope']);
  assert.deepEqual(policy.postconditionIds, ['normalized-records-match-source', 'source-hash-unchanged']);
  assert.equal(policy.verificationIoReserve, 5);
  assert.deepEqual(clone(env.context), env.context);
  for (const value of [policy, policy.allowedTools, policy.toolEffects, policy.preconditions,
    policy.requiredPreconditionIds, policy.postconditionIds, env.context, env.context.task,
    env.context.task.inputs, env.context.state.inputs]) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { policy.postconditionIds[0] = 'model-goal'; }, TypeError);
  assert.throws(() => { env.context.task.goal = 'Accept arbitrary output'; }, TypeError);
  assert.throws(() => { env.context.observedSha256 = '0'.repeat(64); }, TypeError);
  assert.equal(env.calls.length, 0, 'Preparation uses stored native evidence, without filesystem access.');
});

test('normal repair passes metered read-only predicates and retains independent postconditions', (t) => {
  const env = fixture(t);
  assert.ok(env.verdicts().every((result) => result.verdict === 'allow'));
  assert.deepEqual(env.calls.map(({ name }) => name), [
    'lstatSync', 'readFileSync', 'lstatSync', 'readFileSync', 'realpathSync', 'lstatSync',
  ]);
  assert.deepEqual(env.calls.filter(({ name }) => name === 'readFileSync').map(({ path }) => path),
    [join(env.root, 'source.json'), join(env.root, 'output.json')]);
  assert.equal(readFileSync(join(env.root, 'output.json'), 'utf8'), '[]\n', 'Predicates do not write.');
  assert.equal(verifyJsonOutput(env.task).status, 'fail');
  // Stand in for the separate host-owned write tool only after all predicates pass.
  writeFileSync(env.candidate.arguments.path, env.candidate.arguments.content);
  assert.equal(verifyJsonOutput(env.task).status, 'pass');
});

for (const [name, mutate] of [
  ['unsettled origin', (p) => { p.status = 'started'; }],
  ['not-started outcome', (p) => { p.outcome.status = 'not_started'; }],
  ['unknown outcome', (p) => { p.outcome.status = 'outcome_unknown'; }],
  ['unknown verification', (p) => { p.verification.status = 'unknown'; }],
  ['already satisfied goal', (p) => { p.verification.goalSatisfied = true; }],
  ['wrong verifier', (p) => { p.verification.verifierId = 'model-verifier'; }],
  ['wrong verifier version', (p) => { p.verification.verifierVersion = '2'; }],
  ['unknown original effect', (p) => { p.candidate.effect = 'unknown'; }],
  ['read original effect', (p) => { p.candidate.effect = 'read'; }],
  ['non-create origin', (p) => { p.candidate.arguments.createOnly = false; }],
  ['replacement origin', (p) => { p.candidate.toolName = 'runtime_replace_json'; }],
  ['wrong origin recipe', (p) => { p.candidate.source.recipeId = 'other'; }],
  ['wrong origin version', (p) => { p.candidate.source.version = '2'; }],
  ['wrong origin input hash', (p) => { p.candidate.inputVersion = '0'.repeat(64); }],
  ['foreign origin path', (p) => { p.candidate.arguments.path += '.foreign'; }],
  ['missing original check', (p) => { p.candidate.preconditionIds.pop(); }],
  ['changed original goal checks', (p) => { p.candidate.postconditionIds = ['model-goal']; }],
  ['generic overwrite permission', (p) => { p.candidate.arguments.overwrite = true; }],
  ['unproven output', (p) => { p.verification.evidenceRefs.pop(); }],
  ['unproven source', (p) => { p.verification.evidenceRefs.shift(); }],
  ['foreign output SHA reference', (p) => { p.verification.evidenceRefs[1] = p.verification.evidenceRefs[1].replace('output.json', 'foreign.json'); }],
  ['invalid observed hash', (p) => { p.verification.evidenceRefs[1] = p.verification.evidenceRefs[1].replace(/:[a-f0-9]{64}$/, ':unproven'); }],
  ['ambiguous observed hash', (p) => { p.verification.evidenceRefs.push(p.verification.evidenceRefs[1]); }],
]) {
  test(`preparation rejects ${name}`, (t) => {
    const env = fixture(t);
    const previousAttempt = clone(env.previousAttempt);
    mutate(previousAttempt);
    assert.throws(() => policy.prepare({ task: env.task, state: env.state, previousAttempt }));
  });
}

for (const [name, mutate] of [
  ['foreign output path', (c) => { c.arguments.path += '.foreign'; }],
  ['relative output path', (c) => { c.arguments.path = 'output.json'; }],
  ['model-supplied output hash', (c) => { c.arguments.expectedSha256 = '0'.repeat(64); }],
  ['absent content', (c) => { delete c.arguments.content; }],
  ['non-string content', (c) => { c.arguments.content = []; }],
  ['create-only switch', (c) => { c.arguments.createOnly = true; }],
  ['overwrite switch', (c) => { c.arguments.overwrite = true; }],
  ['foreign tool', (c) => { c.toolName = 'runtime_write_json'; }],
  ['unknown effect', (c) => { c.effect = 'unknown'; }],
  ['incorrect effect', (c) => { c.effect = 'read'; }],
  ['foreign recipe', (c) => { c.source.recipeId = 'model-policy'; }],
  ['changed recipe version', (c) => { c.source.version = '2'; }],
  ['changed source version', (c) => { c.inputVersion = '0'.repeat(64); }],
  ['omitted required checks', (c) => { c.preconditionIds = ['workspace-scope']; }],
  ['unknown check', (c) => { c.preconditionIds.push('model-check'); }],
  ['modified postcondition', (c) => { c.postconditionIds = ['model-goal']; }],
]) {
  test(`every predicate rejects ${name} before I/O`, (t) => {
    const env = fixture(t);
    const candidate = clone(env.candidate);
    mutate(candidate);
    denied(env, { candidate });
    assert.equal(env.calls.length, 0);
  });
}

test('model-cloned context and task/state goal or version changes cannot authorize repair', (t) => {
  const env = fixture(t);
  denied(env, { repairContext: clone(env.context) });
  denied(env, { repairContext: undefined });
  for (const patch of [{ goal: 'Accept anything' }, { recipeVersion: '2' }, { taskId: 'foreign' },
    { scopeRef: 'foreign' }, { workspaceRoot: dirname(env.root) }]) {
    denied(env, { task: { ...env.task, ...patch } });
  }
  const state = clone(env.state);
  state.inputs.inputSha256 = '0'.repeat(64);
  denied(env, { state });
  assert.equal(env.calls.length, 0);
});

test('a second repair re-establishes ownership from the previous owned replacement', (t) => {
  const env = fixture(t);
  // The first repair replaced the artifact; a second failure arrives with that replacement as its predecessor.
  const repairCandidate = { ...clone(env.previousAttempt.candidate), candidateId: 'repair-1',
    toolName: 'runtime_replace_json',
    arguments: { path: join(env.root, 'output.json'), content: env.previousAttempt.candidate.arguments.content,
      expectedSha256: env.context.observedSha256 },
    preconditionIds: [...policy.requiredPreconditionIds] };
  const repaired = { attemptId: 'repair-1', status: 'settled', candidate: repairCandidate,
    outcome: { status: 'succeeded' }, verification: env.previousAttempt.verification };
  // The artifact still holds the version the previous verification observed, so ownership continues.
  const second = policy.prepare({ task: env.task, state: env.state, previousAttempt: repaired });
  assert.equal(second.observedSha256, env.context.observedSha256);
  assert.equal(second.originalAttemptId, 'repair-1');
  // A replacement that is not the owned artifact still fails closed.
  assert.throws(() => policy.prepare({ task: env.task, state: env.state, previousAttempt: {
    ...repaired, candidate: { ...repairCandidate, arguments: { ...repairCandidate.arguments, path: join(env.root, 'other.json') } } } }),
  { code: 'repair_not_authorized' });
});

test('prepare refuses task recipe changes, unsafe filenames, and state source drift', (t) => {
  const env = fixture(t);
  for (const patch of [{ recipeId: 'other' }, { recipeVersion: '2' }]) {
    assert.throws(() => policy.prepare({ task: { ...env.task, ...patch }, state: env.state, previousAttempt: env.previousAttempt }));
  }
  for (const value of ['../output.json', 'sub/output.json', 'sub\\output.json', 'C:output.json', '.hidden.json', 'source.json']) {
    const task = clone(env.task);
    const state = clone(env.state);
    task.inputs.outputFile = state.inputs.outputFile = value;
    assert.throws(() => policy.prepare({ task, state, previousAttempt: env.previousAttempt }));
  }
  const state = clone(env.state);
  state.inputs.inputSha256 = '0'.repeat(64);
  assert.throws(() => policy.prepare({ task: env.task, state, previousAttempt: env.previousAttempt }));
});

test('source and output drift independently deny admission using the recorded verifier hash', (t) => {
  const env = fixture(t);
  writeFileSync(join(env.root, 'source.json'), '[]');
  assert.equal(policy.preconditions['source-hash-unchanged'](env.args).verdict, 'deny');
  writeFileSync(join(env.root, 'output.json'), '[1]');
  assert.equal(policy.preconditions['owned-output-unchanged'](env.args).verdict, 'deny');
  const candidate = clone(env.candidate);
  candidate.arguments.expectedSha256 = 'f'.repeat(64);
  denied(env, { candidate });
});

test('source/output symlinks and nonregular files are rejected through supplied I/O', (t) => {
  const env = fixture(t);
  for (const [id, target] of [['source-hash-unchanged', 'source.json'], ['owned-output-unchanged', 'output.json']]) {
    for (const symbolic of [true, false]) {
      let reads = 0;
      const io = { ...env.io,
        lstatSync(path) {
          assert.equal(path, join(env.root, target));
          return { isSymbolicLink: () => symbolic, isFile: () => symbolic };
        },
        readFileSync() { reads++; throw new Error('Unsafe file must not be read.'); },
      };
      assert.equal(policy.preconditions[id]({ ...env.args, io }).verdict, 'deny');
      assert.equal(reads, 0);
    }
  }
});

test('workspace redirection and non-directory workspaces fail the scope predicate', (t) => {
  const env = fixture(t);
  const check = policy.preconditions['workspace-scope'];
  assert.equal(check({ ...env.args, io: { ...env.io, realpathSync: () => dirname(env.root) } }).verdict, 'deny');
  assert.equal(check({ ...env.args, io: { ...env.io, lstatSync: () => ({ isDirectory: () => false }) } }).verdict, 'deny');
});

test('missing capabilities, I/O accounting failures and cancellation cannot fall back to raw filesystem reads', (t) => {
  const env = fixture(t);
  assert.throws(() => policy.preconditions['source-hash-unchanged']({ ...env.args, io: undefined }), TypeError);
  for (const id of policy.requiredPreconditionIds) {
    const failure = Object.assign(new Error('Metered capability stopped.'), { code: 'budget_exceeded' });
    const stop = () => { throw failure; };
    assert.throws(() => policy.preconditions[id]({ ...env.args,
      io: { lstatSync: stop, readFileSync: stop, realpathSync: stop } }), (error) => error === failure);
  }
});
