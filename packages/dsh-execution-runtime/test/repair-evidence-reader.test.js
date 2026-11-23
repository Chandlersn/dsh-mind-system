import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, readdirSync, writeFileSync, truncateSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { RuntimeStore } from '../src/store.js';
import { readRepairEvidence, REPAIR_EVIDENCE_LIMITS } from '../src/repair-evidence-reader.js';

const candidate = { candidateId: 'retry', toolName: 'fixture', arguments: {},
  preconditionIds: ['ready'], postconditionIds: ['done'], progressKey: 'cursor', effect: 'read',
  source: { recipeId: 'fixture', version: 'recipe-v2' } };
const proof = { status: 'pass', progress: 'advanced', goalSatisfied: false,
  verifierId: 'target-check', verifierVersion: 'verifier-v3', evidenceRefs: ['proof:one'] };
function fixture(t, { declarations = {}, status = 'settled' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'repair-reader-')));
  const runtimeFilePath = join(root, 'runtime.sqlite');
  const store = new RuntimeStore(runtimeFilePath, { now: () => 1000 });
  t.after(() => {
    store.close();
    assert.equal(dirname(root), realpathSync(tmpdir()));
    assert.ok(basename(root).startsWith('repair-reader-'));
    rmSync(root, { recursive: true, force: true });
  });
  const options = () => ({ expectedVersion: store.getRun('task').version });
  store.createRun({ taskId: 'task', recipeId: 'fixture', recipeVersion: 'recipe-v2', goal: 'Read evidence',
    scopeRef: 'fixture', workspaceRoot: root, inputs: {}, deadlineAt: 5000, ...declarations });
  const producerId = store.getProducerId();
  let checkpointId;
  if (status === 'restored') ({ checkpointId } = store.recordCheckpoint('task',
    { stepIndex: 0, state: {}, environment: {}, evidenceRef: 'checkpoint:proof' }, options()));
  store.stopRun('task', 'waiting_analysis', 'exception', options());
  const { analysisId } = store.reserveAnalysis('task', options());
  const repair = { kind: status === 'restored' ? 'rollback_to' : status === 'settled' || status === 'unknown' ? 'retry_with' : 'gather_evidence',
    diagnosis: { location: 'fixture', cause: 'wrong_guess', evidenceRefs: [] }, requiresHumanReview: false,
    ...(status === 'restored' ? { checkpointId, compensationPlanId: null }
      : status === 'settled' || status === 'unknown' ? { candidate } : { probeIds: ['inspect'] }) };
  store.recordAnalysis('task', analysisId, { status: 'proposed', repair }, options());
  const { repairId } = store.startRepair('task', analysisId, { ...options(), signature: 'fixture' });
  let attemptId;
  if (status === 'settled' || status === 'unknown') {
    ({ attemptId } = store.reserveAttempt('task', candidate, options()));
    store.markStarted('task', attemptId, options());
    store.recordOutcome('task', attemptId, { status: status === 'unknown' ? 'outcome_unknown' : 'succeeded' },
      status === 'unknown' ? { ...proof, status: 'unknown', progress: 'unknown', goalSatisfied: null } : proof, options());
  }
  if (status === 'restored') store.restoreCheckpoint('task', checkpointId, options());
  store.finishRepair('task', repairId, { ...options(), status, ...(attemptId ? { attemptId } : {}) });
  const pending = store.listPendingOutbox()[0];
  const request = { runtimeFilePath, producerId, eventId: pending.eventId };
  return { root, store, request, pending, repairId, attemptId, analysisId };
}
function snapshot(root) {
  return Object.fromEntries(readdirSync(root).map((name) => [name, name.endsWith('-shm') ? 'sqlite-reader-coordination' : createHash('sha256').update(readFileSync(join(root, name))).digest('hex')]));
}
function readUnchanged(f, request = f.request) {
  const before = snapshot(f.root);
  const result = readRepairEvidence(request);
  assert.deepEqual(snapshot(f.root), before, 'Reader must leave persistent database/WAL bytes and directory entries unchanged.');
  assert.equal(result.governanceEligible, false);
  assert.equal(result.goalProof, 'not_evaluated');
  assert.equal(result.principleAttribution, 'not_evaluated');
  return result;
}

test('embedded NUL suffixes and blob storage cannot masquerade as valid text', (t) => {
  for (const [sql, status] of [
    ["UPDATE runtime_metadata SET value = value || char(0) || 'suffix' WHERE key='producer_id'", 'mismatch'],
    ["UPDATE runs SET task_json = task_json || char(0) || 'suffix'", 'error'],
    ['UPDATE runs SET task_json = CAST(task_json AS BLOB)', 'unsupported'],
  ]) {
    const f = fixture(t);
    const db = new DatabaseSync(f.request.runtimeFilePath);
    try { db.exec(sql); } finally { db.close(); }
    assert.equal(readUnchanged(f).status, status);
  }
});

test('actual immutable event matches delivery before and after acknowledgement; advanced is not goal proof', (t) => {
  const f = fixture(t);
  for (const acknowledged of [false, true]) {
    if (acknowledged) f.store.acknowledgeOutbox(f.request.eventId, { expectedAttempts: 0 });
    const result = readUnchanged(f);
    assert.equal(result.status, 'match');
    assert.deepEqual(result.payload, f.pending.payload);
    assert.equal(result.payload.evidence.goalSatisfied, false);
  }
});

test('explicit declarations preserve strings, empty refs, and absence', (t) => {
  for (const declarations of [{}, { origin: 'daily', principleRefs: [] },
    { origin: 'verification', principleRefs: [' rule:one '] }, { origin: 'drill' }]) {
    const f = fixture(t, { declarations });
    const result = readUnchanged(f);
    assert.equal(result.status, 'match');
    assert.deepEqual(result.payload, f.pending.payload);
  }
});

test('restored, observed, blocked and unknown do not become verified goal success', (t) => {
  for (const status of ['restored', 'observed', 'blocked', 'unknown']) {
    const f = fixture(t, { status });
    const result = readUnchanged(f);
    assert.equal(result.status, 'match');
    assert.equal(result.payload.evidence.status, status);
  }
});

test('incorrect producer, event and missing producer metadata are explicit', (t) => {
  const f = fixture(t);
  assert.equal(readUnchanged(f, { ...f.request, producerId: 'wrong' }).status, 'mismatch');
  assert.equal(readUnchanged(f, { ...f.request, eventId: 'missing' }).status, 'missing');
  f.store.withDatabase((db) => db.exec("DELETE FROM runtime_metadata WHERE key = 'producer_id'"));
  assert.equal(readUnchanged(f).reason, 'producer_missing');
});

test('persisted task, analysis, attempt, candidate and verification mismatches refuse', (t) => {
  for (const mutation of [
    (db, f) => db.prepare('UPDATE runs SET task_json = ?').run(JSON.stringify({ ...f.store.getRun('task').task, taskId: 'wrong' })),
    (db) => db.exec("UPDATE analyses SET consumed_at = NULL"),
    (db) => db.exec("UPDATE repairs SET attempt_floor = 999999"),
    (db) => db.exec("UPDATE attempts SET status = 'unknown'"),
    (db) => db.prepare('UPDATE attempts SET candidate_json = ?').run(JSON.stringify({ ...candidate, toolName: 'other' })),
    (db) => db.prepare('UPDATE attempts SET verification_json = ?').run(JSON.stringify({ ...proof, verifierVersion: 'wrong' })),
    (db) => db.prepare('UPDATE attempts SET verification_json = ?').run(JSON.stringify({ ...proof, evidenceRefs: ['other'] })),
    (db) => db.prepare('UPDATE attempts SET outcome_json = ?').run(JSON.stringify({ status: 'failed' })),
  ]) {
    const f = fixture(t);
    f.store.withDatabase((db) => mutation(db, f));
    assert.equal(readUnchanged(f).status, 'mismatch');
  }
});

test('foreign linkage and missing attempt are detected without relying on foreign keys', (t) => {
  for (const sql of ["UPDATE analyses SET task_id = 'foreign'", "UPDATE attempts SET task_id = 'foreign'",
    "UPDATE repairs SET task_id = 'foreign'", 'DELETE FROM attempts']) {
    const f = fixture(t);
    f.store.withDatabase((db) => { db.exec('PRAGMA foreign_keys = OFF'); db.exec(sql); });
    assert.ok(['missing', 'mismatch'].includes(readUnchanged(f).status));
  }
});

test('tampered immutable payload and legacy schema are rejected', (t) => {
  for (const mode of ['legacy', 'version', 'verification', 'task', 'attempt', 'json']) {
    const f = fixture(t);
    const payload = structuredClone(f.pending.payload);
    delete payload.taskId;
    delete payload.attemptId;
    if (mode === 'legacy') delete payload.evidence;
    if (mode === 'version') payload.evidence.schemaVersion = 2;
    if (mode === 'verification') payload.evidence.verifier.id = 'wrong';
    if (mode === 'task') payload.evidence.taskId = 'wrong';
    if (mode === 'attempt') payload.evidence.attemptId = 'wrong';
    f.store.withDatabase((db) => {
      db.exec('DROP TRIGGER events_no_update');
      db.prepare('UPDATE events SET payload_json = ? WHERE event_id = ?').run(mode === 'json' ? '{' : JSON.stringify(payload), f.request.eventId);
    });
    assert.equal(readUnchanged(f).status, ['legacy', 'version'].includes(mode) ? 'unsupported' : mode === 'json' ? 'error' : 'mismatch');
  }
});

test('duplicate event identity is rejected even in a database missing uniqueness enforcement', (t) => {
  const f = fixture(t);
  f.store.withDatabase((db) => db.exec(`PRAGMA foreign_keys = OFF;
    ALTER TABLE events RENAME TO original_events;
    CREATE TABLE events AS SELECT * FROM original_events;
    INSERT INTO events SELECT * FROM original_events WHERE kind = 'repair_finished';`));
  assert.equal(readUnchanged(f).reason, 'event_not_unique');
});

test('SQL field byte budgets reject before parsing oversized JSON', (t) => {
  for (const field of ['payload_json', 'verification_json', 'task_json']) {
    const f = fixture(t);
    f.store.withDatabase((db) => {
      db.exec('DROP TRIGGER events_no_update');
      const table = field === 'payload_json' ? 'events' : field === 'verification_json' ? 'attempts' : 'runs';
      db.prepare(`UPDATE ${table} SET ${field} = ?`).run('x'.repeat(REPAIR_EVIDENCE_LIMITS.fieldBytes + 1));
    });
    assert.equal(readUnchanged(f).status, 'unsupported');
  }
});

test('cumulative byte budget and request identity limits are explicit', (t) => {
  const f = fixture(t);
  assert.equal(readUnchanged(f, { ...f.request, eventId: 'x'.repeat(REPAIR_EVIDENCE_LIMITS.identityBytes + 1) }).reason, 'invalid_request');
  const padding = 'x'.repeat(220 * 1024);
  f.store.withDatabase((db) => {
    for (const [table, column] of [['runs', 'task_json'], ['repairs', 'candidate_json'],
      ['attempts', 'candidate_json'], ['attempts', 'outcome_json'], ['attempts', 'verification_json']]) {
      const value = JSON.parse(db.prepare(`SELECT ${column} AS value FROM ${table}`).get().value);
      db.prepare(`UPDATE ${table} SET ${column} = ?`).run(JSON.stringify({ ...value, padding }));
    }
  });
  assert.equal(readUnchanged(f).reason, 'total_byte_limit');
});

test('missing, corrupt, unsupported and oversized databases remain untouched', (t) => {
  const f = fixture(t);
  const absent = join(f.root, 'missing.sqlite');
  assert.equal(readUnchanged(f, { ...f.request, runtimeFilePath: absent }).reason, 'database_missing');
  const corrupt = join(f.root, 'corrupt.sqlite');
  writeFileSync(corrupt, 'not a database');
  assert.equal(readUnchanged(f, { ...f.request, runtimeFilePath: corrupt }).status, 'error');
  const legacy = join(f.root, 'legacy.sqlite');
  const db = new DatabaseSync(legacy);
  db.exec('CREATE TABLE unrelated (id TEXT)');
  db.close();
  assert.equal(readUnchanged(f, { ...f.request, runtimeFilePath: legacy }).status, 'unsupported');
  const huge = join(f.root, 'huge.sqlite');
  writeFileSync(huge, '');
  truncateSync(huge, REPAIR_EVIDENCE_LIMITS.databaseBytes + 1);
  assert.equal(readUnchanged(f, { ...f.request, runtimeFilePath: huge }).reason, 'database_byte_limit');
});
