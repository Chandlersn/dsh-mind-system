import test from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from './helpers/host.js';
import * as hostEntry from '../src/host-plugin.js';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RuntimeStore } from '../src/store.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { RuntimeScheduler } from '../src/scheduler.js';
import { jsonNormalizeRecipe } from '../recipes/json-normalize.js';

const task = (root, taskId) => ({ taskId, recipeId: 'csv-normalize', recipeVersion: '1', goal: 'Check a fixture.',
  scopeRef: 'test', workspaceRoot: root, inputs: {}, deadlineAt: Date.now() + 60000 });
const contract = { schemaVersion: 1, predicate: { id: 'file_sha256', version: 1 },
  output: { path: 'reports/result.json', sha256: 'a'.repeat(64) } };

test('host registers supported contracts and rejects invalid ones', async (t) => {
  const host = await createHost(t);
  const fiber = await host.ctx.plugin(hostEntry.plugin, { enabled: true, stateDir: host.root, workspaceRoot: host.storage,
    tasks: [task(host.storage, 'legacy'), { ...task(host.storage, 'configured'), acceptanceContract: contract },
      { ...task(host.storage, 'invalid'), acceptanceContract: { ...contract, output: { ...contract.output, path: '../escape' } } }] });
  await fiber.await();
  try {
    const status = host.ctx.get('executionRuntimeStatus').snapshot();
    assert.equal(status.state, 'ready');
    assert.deepEqual(status.registeredTasks.taskIds, ['configured', 'legacy']);
    const probe = hostEntry.healthProbe.probe();
    assert.equal(probe.status, 'degraded');
    assert.equal(probe.facts.rejectedAcceptanceTasks, 1);
    assert.ok(probe.findings.some((item) => item.code === 'execution-runtime.acceptance-unavailable'));
    assert.equal(status.runs.length, 0);
    const unavailable = await host.execute('runtime_run', { arguments: { taskRef: 'invalid' } });
    assert.equal(unavailable.isError, true);
    assert.equal(host.ctx.get('executionRuntimeStatus').snapshot().runs.length, 0);
  } finally { await fiber.dispose(); }
});

test('native execution binds before dispatch and reports an independent mismatch', async (t) => {
  const host = await createHost(t);
  writeFileSync(join(host.storage, 'source.json'), '[{"id":"a","name":" Alpha "}]');
  const configured = { ...contract, output: { path: 'output.json', sha256: 'a'.repeat(64) } };
  const native = { ...task(host.storage, 'bound'), recipeId: 'json-normalize',
    inputs: { inputFile: 'source.json', outputFile: 'output.json' },
    allowedTools: ['runtime_write_json'], acceptanceContract: structuredClone(configured) };
  const fiber = host.ctx.plugin(hostEntry.plugin, { enabled: true, stateDir: host.root,
    workspaceRoot: host.storage, tasks: [native] });
  await fiber.await();
  let bindingAtDispatch;
  host.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'runtime_write_json') {
      const db = new DatabaseSync(join(host.root, 'runtime.sqlite'), { readOnly: true });
      try { bindingAtDispatch = db.prepare('SELECT native_ref, contract_json, authority_json FROM acceptance_bindings WHERE task_id = ?').get('bound'); }
      finally { db.close(); }
    }
    return next();
  });
  try {
    native.acceptanceContract.output.sha256 = 'b'.repeat(64);
    const agent = await host.agent('acceptance-caller');
    const result = await host.execute('runtime_run', { agent, arguments: { taskRef: 'bound' } });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.deepEqual(result.value.acceptance, { status: 'fail', reason: 'sha256_mismatch', goalProof: 'not_evaluated',
      principleAttribution: 'not_evaluated', governanceEligible: false });
    assert.equal(result.value.status, 'completed');
    assert.equal(bindingAtDispatch.native_ref, 'bound');
    assert.deepEqual(JSON.parse(bindingAtDispatch.contract_json), configured);
    assert.deepEqual(JSON.parse(bindingAtDispatch.authority_json), { schemaVersion: 1, scopeRef: 'test',
      workspaceRoot: realpathSync(host.storage), allowedTools: ['runtime_write_json'] });
  } finally { await fiber.dispose(); }
  const drifted = host.ctx.plugin(hostEntry.plugin, { enabled: true, stateDir: host.root,
    workspaceRoot: host.storage, tasks: [native] });
  await drifted.await();
  try {
    const agent = await host.agent('drift-caller');
    const replay = await host.execute('runtime_run', { agent, arguments: { taskRef: 'bound' } });
    assert.equal(replay.isError, true);
  } finally { await drifted.dispose(); }
  const store = new RuntimeStore(join(host.root, 'runtime.sqlite'));
  try {
    assert.deepEqual(store.getAcceptanceBinding('bound'), { nativeRef: 'bound', contract: configured,
      authority: { schemaVersion: 1, scopeRef: 'test', workspaceRoot: realpathSync(host.storage), allowedTools: ['runtime_write_json'] } });
    assert.throws(() => store.resumeRun('bound', { requireEnvironment: false }), { code: 'acceptance_recovery_unavailable' });
    assert.throws(() => store.startRepair('bound', 'fake', { signature: 'fake' }), { code: 'acceptance_recovery_unavailable' });
    assert.throws(() => store.reconcileAttempt('bound', 'fake', { resolution: 'absent', evidenceRef: 'fake' }), { code: 'acceptance_recovery_unavailable' });
  } finally { store.close(); }
});

test('host reviews post-run bytes and leaves unbound responses unchanged', async (t) => {
  const host = await createHost(t);
  writeFileSync(join(host.storage, 'source.json'), '[{"id":"a","name":" Alpha "}]');
  const bytes = `${JSON.stringify([{ id: 'a', name: 'Alpha' }], null, 2)}\n`;
  const hash = createHash('sha256').update(bytes).digest('hex');
  const native = (id, output, acceptanceContract) => ({ ...task(host.storage, id), recipeId: 'json-normalize',
    inputs: { inputFile: 'source.json', outputFile: output }, allowedTools: ['runtime_write_json'],
    ...(acceptanceContract ? { acceptanceContract } : {}) });
  const bound = (path) => ({ ...contract, output: { path, sha256: hash } });
  const fiber = host.ctx.plugin(hostEntry.plugin, { enabled: true, stateDir: host.root, workspaceRoot: host.storage,
    tasks: [native('match', 'match.json', bound('match.json')), native('missing', 'missing.json', bound('absent.json')),
      native('plain', 'plain.json')] });
  await fiber.await();
  try {
    const agent = await host.agent('review-caller');
    for (const [ref, status, reason] of [['match', 'pass', 'sha256_match'], ['missing', 'unknown', 'evidence_unavailable']]) {
      const result = await host.execute('runtime_run', { agent, arguments: { taskRef: ref } });
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(result.value.status, 'completed');
      assert.deepEqual(result.value.acceptance, { status, reason, goalProof: 'not_evaluated',
        principleAttribution: 'not_evaluated', governanceEligible: false });
    }
    const plain = await host.execute('runtime_run', { agent, arguments: { taskRef: 'plain' } });
    assert.equal(plain.isError, false, JSON.stringify(plain));
    assert.equal(plain.value.status, 'completed');
    assert.equal(Object.hasOwn(plain.value, 'acceptance'), false);
  } finally { await fiber.dispose(); }
});

test('a changed or missing persisted binding cannot authorize review', async (t) => {
  const host = await createHost(t);
  writeFileSync(join(host.storage, 'source.json'), '[{"id":"a","name":" Alpha "}]');
  const expected = createHash('sha256').update(`${JSON.stringify([{ id: 'a', name: 'Alpha' }], null, 2)}\n`).digest('hex');
  const bound = (id) => ({ ...task(host.storage, id), recipeId: 'json-normalize',
    inputs: { inputFile: 'source.json', outputFile: `${id}.json` }, allowedTools: ['runtime_write_json'],
    acceptanceContract: { ...contract, output: { path: `${id}.json`, sha256: expected } } });
  const fiber = host.ctx.plugin(hostEntry.plugin, { enabled: true, stateDir: host.root, workspaceRoot: host.storage,
    tasks: [bound('changed'), bound('removed'), bound('authority')] });
  await fiber.await();
  host.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'runtime_write_json') {
      const db = new DatabaseSync(join(host.root, 'runtime.sqlite'));
      try {
        if (exec.arguments.path.endsWith('changed.json')) {
          const other = { ...contract, output: { path: 'changed.json', sha256: 'a'.repeat(64) } };
          db.prepare('UPDATE acceptance_bindings SET contract_json = ? WHERE task_id = ?').run(JSON.stringify(other), 'changed');
        } else if (exec.arguments.path.endsWith('authority.json')) {
          const authority = { schemaVersion: 1, scopeRef: 'test', workspaceRoot: realpathSync(host.storage), allowedTools: ['runtime_write_json', 'extra'] };
          db.prepare('UPDATE acceptance_bindings SET authority_json = ? WHERE task_id = ?').run(JSON.stringify(authority), 'authority');
        } else if (exec.arguments.path.endsWith('removed.json')) {
          db.prepare('DELETE FROM acceptance_bindings WHERE task_id = ?').run('removed');
        }
      } finally { db.close(); }
    }
    return next();
  });
  try {
    const agent = await host.agent('tamper-caller');
    for (const [ref, reason] of [['changed', 'binding_mismatch'], ['removed', 'binding_unavailable'], ['authority', 'binding_mismatch']]) {
      const result = await host.execute('runtime_run', { agent, arguments: { taskRef: ref } });
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(result.value.status, 'failed');
      assert.equal(existsSync(join(host.storage, `${ref}.json`)), false);
      assert.deepEqual(result.value.acceptance, { status: 'unknown', reason, goalProof: 'not_evaluated',
        principleAttribution: 'not_evaluated', governanceEligible: false });
    }
  } finally { await fiber.dispose(); }
});

test('native task and authority drift fail before run creation', async (t) => {
  const host = await createHost(t);
  const store = new RuntimeStore(join(host.root, 'scheduler.sqlite'));
  const agent = {};
  let dispatches = 0;
  const executor = { agent, async execute() { dispatches++; } };
  const nativeTask = { ...task(host.storage, 'native'), recipeId: 'json-normalize' };
  const authority = { scopeRef: 'test', workspaceRoot: realpathSync(host.storage), allowedTools: ['runtime_write_json'], agent };
  const nativeAuthority = { schemaVersion: 1, scopeRef: authority.scopeRef, workspaceRoot: authority.workspaceRoot, allowedTools: [...authority.allowedTools] };
  const make = (binding = { nativeRef: 'native', contract }) => new RuntimeScheduler({ store,
    recipes: [jsonNormalizeRecipe], executor, tools: {}, validateArguments: () => true,
    nativeBinding: binding, nativeTask, nativeAuthority });
  for (const [candidateTask, candidateAuthority] of [
    [{ ...nativeTask, goal: 'changed' }, authority],
    [nativeTask, { ...authority, allowedTools: ['runtime_write_json', 'other'] }],
    [nativeTask, { ...authority, scopeRef: 'other' }],
    [nativeTask, { ...authority, workspaceRoot: host.root }],
  ]) {
    await assert.rejects(make().run(candidateTask, { authority: candidateAuthority }));
    assert.throws(() => store.getRun('native'), { code: 'run_not_found' });
  }
  await assert.rejects(make({ nativeRef: 'native', contract: { ...contract, schemaVersion: 2 } }).run(nativeTask, { authority }));
  assert.throws(() => store.getRun('native'), { code: 'run_not_found' });
  assert.equal(dispatches, 0);
  store.withDatabase((db) => assert.equal(db.prepare('SELECT count(*) AS n FROM attempts').get().n, 0));
  store.close();
});

test('invalid native authority cannot create a task or dispatch a tool', async (t) => {
  const host = await createHost(t);
  writeFileSync(join(host.storage, 'source.json'), '[{"id":"a","name":"A"}]');
  const native = { ...task(host.storage, 'invalid-authority'), recipeId: 'json-normalize',
    inputs: { inputFile: 'source.json', outputFile: 'invalid.json' },
    allowedTools: ['runtime_write_json', 'runtime_write_json'], acceptanceContract: contract };
  const fiber = host.ctx.plugin(hostEntry.plugin, { enabled: true, stateDir: host.root, workspaceRoot: host.storage, tasks: [native] });
  await fiber.await();
  try {
    const agent = await host.agent('invalid-authority-caller');
    const result = await host.execute('runtime_run', { agent, arguments: { taskRef: native.taskId } });
    assert.equal(result.isError, true);
    assert.equal(existsSync(join(host.storage, 'invalid.json')), false);
    const db = new DatabaseSync(join(host.root, 'runtime.sqlite'), { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM attempts').get().n, 0);
    } finally { db.close(); }
  } finally { await fiber.dispose(); }
});

test('dynamic caller declarations cannot create an acceptance binding', async (t) => {
  const host = await createHost(t);
  writeFileSync(join(host.storage, 'input.txt'), 'a\n');
  const fiber = host.ctx.plugin(hostEntry.plugin, { enabled: true, stateDir: host.root, workspaceRoot: host.storage });
  await fiber.await();
  try {
    const agent = await host.agent('dynamic-attacker');
    const result = await host.execute('runtime_execute', { agent, arguments: {
      taskId: 'attacker', goal: 'Write a file', inputs: { inputFile: 'input.txt', outputFile: 'dynamic.txt', acceptanceBinding: { nativeRef: 'trusted', contract } },
      recipe: { recipeId: 'attacker-recipe', tool: 'runtime_write_text', effect: 'reversible_write',
        verifier: { primitive: 'line_set', parameters: { expectedLines: ['a'] } },
        arguments: { path: '{{workspaceRoot}}/dynamic.txt', content: 'a\n', createOnly: true } },
    } });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.value.status, 'completed', JSON.stringify(result.value));
    assert.equal(Object.hasOwn(result.value, 'acceptance'), false);
  } finally { await fiber.dispose(); }
  const store = new RuntimeStore(join(host.root, 'runtime.sqlite'));
  try { assert.equal(store.getAcceptanceBinding('attacker'), null); } finally { store.close(); }
});
