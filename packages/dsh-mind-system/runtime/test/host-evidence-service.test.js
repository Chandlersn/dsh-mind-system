import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHost, deferred, waitFor } from './helpers/host.js';
import * as hostEntry from '../src/host-plugin.js';
import { jsonNormalizeRepairPolicy } from '../recipes/json-repair.js';

function persistentBytes(root) {
  return Object.fromEntries(readdirSync(root).map((name) => [name, name.endsWith('-shm')
    ? 'sqlite-reader-coordination' : createHash('sha256').update(readFileSync(join(root, name))).digest('hex')]));
}

function query(stateDir, sql) {
  const db = new DatabaseSync(join(stateDir, 'runtime.sqlite'), { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

test('installed host evidence service binds identity and database, refuses paths, and expires on unload', async (t) => {
  const host = await createHost(t);
  const stateDir = mkdtempSync(join(host.root, 'evidence-'));
  const fiber = host.ctx.plugin(hostEntry.plugin, { enabled: true, stateDir, workspaceRoot: host.storage });
  await fiber.await();
  const service = host.ctx.get('executionRuntimeEvidence');
  try {
    assert.ok(Object.isFrozen(service));
    assert.deepEqual(Object.keys(service).sort(), ['producerId', 'readRepairEvidence']);
    assert.equal(service.producerId, query(stateDir, "SELECT value FROM runtime_metadata WHERE key='producer_id'")[0].value);
    const before = persistentBytes(stateDir);
    const request = { producerId: service.producerId, eventId: 'missing' };
    assert.equal(service.readRepairEvidence(request).reason, 'event_missing');
    assert.equal(service.readRepairEvidence({ ...request, producerId: 'foreign' }).reason, 'producer_id_mismatch');
    for (const bad of [null, [], {}, { ...request, runtimeFilePath: join(host.root, 'foreign.sqlite') },
      { ...request, path: join(host.root, 'foreign.sqlite') }, { ...request, [Symbol('path')]: 'foreign' }]) {
      assert.equal(service.readRepairEvidence(bad).reason, 'invalid_request');
    }
    assert.equal(service.readRepairEvidence({ ...request, eventId: '' }).reason, 'invalid_request');
    // Exercise the installed host compiler as a receiver-owned read-only tool would.
    host.tools.register({ name: 'fixture_read_repair_evidence', description: 'Read a host-owned repair fixture.',
      parameters: { type: 'object', properties: { producerId: { type: 'string' }, eventId: { type: 'string' } },
        required: ['producerId', 'eventId'], additionalProperties: false },
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute(args) { return host.ctx.get('executionRuntimeEvidence').readRepairEvidence(args); } });
    const missing = await host.execute('fixture_read_repair_evidence', { arguments: request });
    assert.equal(missing.isError, false);
    assert.equal(missing.value.status, 'missing');
    const wrong = await host.execute('fixture_read_repair_evidence', { arguments: { ...request, producerId: 'foreign' } });
    assert.equal(wrong.isError, false);
    assert.equal(wrong.value.status, 'mismatch');
    const path = await host.execute('fixture_read_repair_evidence', { arguments: { ...request, runtimeFilePath: 'foreign' } });
    assert.equal(path.isError, false, JSON.stringify(path));
    assert.equal(path.value.reason, 'invalid_request', JSON.stringify(path));
    assert.deepEqual(persistentBytes(stateDir), before, 'Review must not create stores, migrate, or change persistent bytes.');
  } finally { await fiber.dispose(); }
  assert.equal(host.ctx.get('executionRuntimeEvidence'), undefined);
  assert.equal(service.readRepairEvidence({ producerId: service.producerId, eventId: 'missing' }).reason, 'runtime_unavailable');
});

test('disabled and failed installed mounts do not publish an evidence capability', async (t) => {
  const host = await createHost(t);
  let fiber = host.ctx.plugin(hostEntry.plugin, { enabled: false });
  await fiber.await();
  assert.equal(host.ctx.get('executionRuntimeEvidence'), undefined);
  await fiber.dispose();
  host.register('runtime_write_text');
  fiber = host.ctx.plugin(hostEntry.plugin, { enabled: true, stateDir: mkdtempSync(join(host.root, 'failed-')) });
  await fiber.await();
  try {
    assert.equal(hostEntry.healthProbe.probe().facts.state, 'failed');
    assert.equal(host.ctx.get('executionRuntimeEvidence'), undefined);
  } finally { await fiber.dispose(); }
});

test('receiver resolves an actual native repair through the service before and after delivery acknowledgement', async (t) => {
  const host = await createHost(t);
  const stateDir = mkdtempSync(join(host.root, 'actual-repair-'));
  const output = join(host.storage, 'output.json');
  writeFileSync(join(host.storage, 'source.json'), '[{"id":"a","name":" Alpha "}]');
  // Corrupt only the original creation so the native verifier must fail before repair.
  host.ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.name === 'runtime_write_json' && !result.isError) writeFileSync(output, '[]');
    return next();
  });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const packet = JSON.parse(JSON.parse(init.body).messages[1].content);
    const ref = packet.verification.evidenceRefs.find((item) => item.startsWith(`file:${output}#sha256:`));
    const repair = { kind: 'retry_with', requiresHumanReview: false,
      diagnosis: { location: 'output', cause: 'wrong_guess', evidenceRefs: [ref] },
      candidate: { ...packet.candidate, candidateId: 'replace', toolName: 'runtime_replace_json',
        preconditionIds: jsonNormalizeRepairPolicy.requiredPreconditionIds,
        arguments: { path: output, content: packet.candidate.arguments.content, expectedSha256: ref.slice(-64) } } };
    return Response.json({ choices: [{ message: { content: JSON.stringify(repair) } }] });
  });
  const valveUrl = [new URL('../../dsh-valves/index.js', import.meta.url), new URL('../../valves/index.js', import.meta.url)].find(existsSync);
  const valveModule = await import(valveUrl.href);
  const valveDir = mkdtempSync(join(host.root, 'valve-inbox-'));
  const valveFiber = host.ctx.plugin(valveModule, { storageDir: valveDir, patrol: { enabled: false } });
  await valveFiber.await();
  const receiver = host.ctx.get('valves');
  const accept = receiver.receiveRepairEvent.bind(receiver);
  const delivered = deferred();
  t.mock.method(receiver, 'receiveRepairEvent', (message) => {
    const acknowledgement = accept(message);
    const service = host.ctx.get('executionRuntimeEvidence');
    const evidence = service.readRepairEvidence({ producerId: message.producerId, eventId: message.eventId });
    delivered.resolve({ message, evidence, service });
    return acknowledgement;
  });
  const task = { taskId: 'native-evidence', recipeId: 'json-normalize', recipeVersion: '1', goal: 'Normalize records.',
    workspaceRoot: host.storage, scopeRef: 'evidence-scope', inputs: { inputFile: 'source.json', outputFile: 'output.json' },
    deadlineAt: Date.now() + 60_000, autoRepair: true, origin: 'verification', principleRefs: ['fixture:repair'],
    allowedTools: ['runtime_write_json', 'runtime_replace_json'] };
  const config = { enabled: true, stateDir, workspaceRoot: host.storage, tasks: [task], repair: { replaceTool: true },
    outbox: { intervalMs: 10 }, analysis: { endpoint: 'https://fixture.invalid/', model: 'fixture', apiKey: 'fixture' } };
  let fiber = host.ctx.plugin(hostEntry.plugin, config);
  await fiber.await();
  try {
    const agent = await host.agent('evidence-caller');
    const result = await host.execute('runtime_run', { agent, arguments: { taskRef: task.taskId } });
    assert.equal(result.isError, false, JSON.stringify(result.content));
    assert.equal(result.value.status, 'completed', JSON.stringify(result.value));
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), [{ id: 'a', name: 'Alpha' }]);
    const { message, evidence, service } = await waitFor(delivered.promise, 'repair evidence delivery');
    assert.equal(evidence.status, 'match', JSON.stringify(evidence));
    assert.equal(service.producerId, message.producerId);
    assert.deepEqual(evidence.payload, message.payload);
    assert.equal(evidence.payload.evidence.status, 'verified_success');
    assert.equal(evidence.governanceEligible, false);
    assert.equal(evidence.goalProof, 'not_evaluated');
    assert.equal(evidence.principleAttribution, 'not_evaluated');
    assert.equal(service.readRepairEvidence({ producerId: message.producerId, eventId: 'not-this-event' }).status, 'missing');
    // Disposal drains the delivery acknowledgement before closing the host-owned writer.
    await fiber.dispose();
    assert.equal(service.readRepairEvidence(message).reason, 'runtime_unavailable');
    fiber = host.ctx.plugin(hostEntry.plugin, config);
    await fiber.await();
    const remounted = host.ctx.get('executionRuntimeEvidence');
    assert.equal(remounted.producerId, message.producerId);
    const before = persistentBytes(stateDir);
    assert.deepEqual(remounted.readRepairEvidence({ producerId: message.producerId, eventId: message.eventId }), evidence);
    assert.deepEqual(persistentBytes(stateDir), before);
    const inboxBefore = persistentBytes(valveDir);
    const reviewed = await host.execute('valve_repair_identity', { agent, arguments: { producerId: message.producerId, eventId: message.eventId } });
    assert.equal(reviewed.isError, false, JSON.stringify(reviewed));
    assert.equal(reviewed.value.status, 'match', JSON.stringify(reviewed.value));
    assert.deepEqual(reviewed.value.payload, message.payload);
    assert.equal(reviewed.value.governanceEligible, false);
    assert.equal(reviewed.value.goalProof, 'not_evaluated');
    assert.deepEqual(persistentBytes(stateDir), before);
    assert.deepEqual(persistentBytes(valveDir), inboxBefore);
    assert.equal(existsSync(join(valveDir, 'mind-valves.jsonl')), false);
  } finally {
    await fiber.dispose();
    await valveFiber.dispose();
    assert.equal(host.ctx.get('valves'), undefined);
  }
});
