import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore } from '../src/store.js';

function fixture(t, budget = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-analysis-')));
  const filename = join(root, 'runtime.sqlite');
  const resources = [];
  let now = 1000;
  t.after(() => {
    for (const close of resources.toReversed()) close();
    assert.equal(dirname(root), realpathSync(tmpdir()));
    assert.ok(basename(root).startsWith('runtime-analysis-'));
    rmSync(root, { recursive: true, force: true });
  });
  const f = { filename, setNow(value) { now = value; }, open() {
    const store = new RuntimeStore(filename, { now: () => now });
    resources.push(() => store.close());
    return store;
  }, db() {
    const db = new DatabaseSync(filename);
    resources.push(() => db.close());
    return db;
  } };
  const store = f.open();
  const task = { taskId: 'task', recipeId: 'fixture', recipeVersion: '1', goal: 'Verify storage.',
    scopeRef: 'fixture', workspaceRoot: root, inputs: {}, deadlineAt: 5000,
    budget: { maxAnalysisCalls: 2, maxIoOperations: 5, ...budget } };
  store.createRun(task);
  return { ...f, store, task, options() { return { expectedVersion: store.getRun('task').version }; },
    wait() { return store.stopRun('task', 'waiting_analysis', 'test_exception', this.options()); },
    reserve() { this.wait(); return store.reserveAnalysis('task', this.options()); } };
}

const candidate = { candidateId: 'one', toolName: 'fixture', arguments: {}, preconditionIds: ['ready'],
  postconditionIds: ['done'], progressKey: 'cursor', effect: 'read', source: { recipeId: 'fixture', version: '1' } };
const verification = { status: 'pass', progress: 'advanced', goalSatisfied: false,
  verifierId: 'file', verifierVersion: '1', evidenceRefs: ['file:verified'] };
const proposed = (refs = [], human = false) => ({ status: 'proposed', repair: { kind: 'abort', reason: 'No applicable repair.',
  diagnosis: { location: 'fixture', cause: 'wrong_guess', evidenceRefs: refs }, requiresHumanReview: human } });
const failure = (status = 'analysis_failed') => ({ status, error: { code: status, message: 'Analysis could not finish.' } });

function unchanged(f, action, code) {
  const before = f.store.getRun('task');
  const events = f.store.readEvents('task');
  assert.throws(action, code ? { code } : undefined);
  assert.deepEqual(f.store.getRun('task'), before);
  assert.deepEqual(f.store.readEvents('task'), events);
}

test('evidence stores lossless immutable JSON and only bounded metadata enters events', (t) => {
  const f = fixture(t);
  const value = { text: 'private evidence 😀', nested: [null, true, 3] };
  const raw = JSON.stringify(value);
  const stored = f.store.putEvidence('task', 'execution', value, f.options());
  assert.equal(stored.bytes, Buffer.byteLength(raw));
  assert.match(stored.ref, /^runtime-evidence:[0-9a-f-]{36}#sha256:[0-9a-f]{64}$/);
  assert.ok(stored.ref.endsWith(createHash('sha256').update(raw).digest('hex')));
  assert.equal(stored.run.status, 'running');
  assert.deepEqual(stored.run.state, {});
  assert.deepEqual(f.store.readEvents('task').at(-1).payload, { ref: stored.ref, label: 'execution', bytes: stored.bytes });
  const db = f.db();
  assert.throws(() => db.exec("UPDATE evidence SET raw_json = '{}'"), /immutable/);
  assert.throws(() => db.exec('DELETE FROM evidence'), /immutable/);
  const { analysisId } = f.reserve();
  f.store.bindAnalysisEvidence('task', analysisId, [stored.ref], f.options());
  value.text = 'mutated caller data';
  const read = f.store.readAnalysisEvidence('task', analysisId, stored.ref, f.options());
  assert.equal(read.text, raw);
  assert.equal(read.bytes, stored.bytes);
  assert.equal(read.omittedBytes, 0);
  assert.equal(f.store.getAnalysis('task', analysisId).readsUsed, 1);
  assert.equal(f.store.getRun('task').budgetUsage.ioOperations, 1);
  assert.ok(!JSON.stringify(f.store.readEvents('task')).includes('private evidence'));
});

test('evidence validates JSON, labels, exact 4 MiB limit, task existence and CAS', (t) => {
  const f = fixture(t);
  const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get() { throw new Error('getter executed'); } });
  const symbol = { [Symbol('hidden')]: 1 };
  const fakeDenseArray = new Array(1);
  fakeDenseArray['4294967295'] = 1;
  for (const value of [undefined, NaN, -0, Infinity, 9007199254740992, new Date(), { missing: undefined },
    [, 1], fakeDenseArray, accessor, symbol, '\ud800']) {
    unchanged(f, () => f.store.putEvidence('task', 'bad', value, f.options()), 'invalid_json');
  }
  for (const label of ['', ' ', 'x'.repeat(1025)]) {
    unchanged(f, () => f.store.putEvidence('task', label, {}, f.options()), 'invalid_contract');
  }
  unchanged(f, () => f.store.putEvidence('task', 'large', 'x'.repeat(4 * 1024 * 1024 - 1), f.options()), 'evidence_too_large');
  const atLimit = f.store.putEvidence('task', 'limit', 'x'.repeat(4 * 1024 * 1024 - 2), f.options());
  assert.equal(atLimit.bytes, 4 * 1024 * 1024);
  unchanged(f, () => f.store.putEvidence('task', 'stale', {}, { expectedVersion: 0 }), 'stale_run');
  assert.throws(() => f.store.putEvidence('absent', 'missing', {}, { expectedVersion: 0 }), { code: 'run_not_found' });
});

test('competing connections reserve exactly one analysis and evidence writes honor CAS', (t) => {
  const f = fixture(t);
  const peer = f.open();
  f.wait();
  const version = f.options().expectedVersion;
  const reserved = f.store.reserveAnalysis('task', { expectedVersion: version, analysisId: 'first' });
  assert.equal(reserved.analysisId, 'first');
  assert.equal(reserved.run.status, 'analyzing');
  assert.equal(reserved.run.budgetUsage.analysisCalls, 1);
  assert.throws(() => peer.reserveAnalysis('task', { expectedVersion: version, analysisId: 'second' }), { code: 'stale_run' });
  assert.equal(peer.getAnalysis('task', 'second'), null);
  const evidence = f.store.putEvidence('task', 'one', {}, f.options());
  assert.throws(() => peer.putEvidence('task', 'two', {}, { expectedVersion: evidence.run.version - 1 }), { code: 'stale_run' });
  assert.equal(f.db().prepare('SELECT count(*) AS n FROM evidence').get().n, 1);
});

test('analysis reservation refuses unknown or unresolved business work even with remaining budget', (t) => {
  const f = fixture(t);
  const attempt = f.store.reserveAttempt('task', candidate, f.options());
  f.store.markStarted('task', attempt.attemptId, f.options());
  f.store.recordOutcome('task', attempt.attemptId, { status: 'outcome_unknown' },
    { ...verification, status: 'unknown', progress: 'unknown', goalSatisfied: null }, f.options());
  unchanged(f, () => f.store.reserveAnalysis('task', f.options()), 'invalid_analysis_state');
  // Simulate a corrupt owner transition; unresolved attempts must independently block reservation.
  f.db().exec("UPDATE runs SET status = 'waiting_analysis' WHERE task_id = 'task'");
  unchanged(f, () => f.store.reserveAnalysis('task', f.options()), 'attempt_unresolved');
  assert.equal(f.store.getRun('task').budgetUsage.analysisCalls, 0);
});

test('analysis reservation checks deadline and persisted analysis budget without reset', (t) => {
  const f = fixture(t, { maxAnalysisCalls: 1 });
  const { analysisId } = f.reserve();
  f.store.recordAnalysis('task', analysisId, failure(), f.options());
  const db = f.db();
  db.exec("UPDATE runs SET status = 'waiting_analysis' WHERE task_id = 'task'");
  const peer = f.open();
  assert.throws(() => peer.reserveAnalysis('task', f.options()), { code: 'budget_exceeded' });
  assert.equal(peer.getRun('task').budgetUsage.analysisCalls, 1);
  f.setNow(5000);
  unchanged(f, () => f.store.reserveAnalysis('task', f.options()), 'budget_exceeded');
});

test('deadline denies reservation before charging any analysis call', (t) => {
  const f = fixture(t);
  f.wait();
  f.setNow(5000);
  unchanged(f, () => f.store.reserveAnalysis('task', f.options()), 'budget_exceeded');
  assert.equal(f.store.getRun('task').budgetUsage.analysisCalls, 0);
});

test('evidence allowlists enforce unique bounded refs, task boundaries and no file reads', (t) => {
  const f = fixture(t);
  f.store.createRun({ ...f.task, taskId: 'foreign' });
  const own = f.store.putEvidence('task', 'own', { secret: 1 }, f.options());
  const foreign = f.store.putEvidence('foreign', 'foreign', { secret: 2 }, { expectedVersion: 0 });
  const { analysisId } = f.reserve();
  for (const refs of [[own.ref, own.ref], Array.from({ length: 33 }, (_, i) => `ref:${i}`), ['x'.repeat(1025)], [null]]) {
    unchanged(f, () => f.store.bindAnalysisEvidence('task', analysisId, refs, f.options()));
  }
  f.store.bindAnalysisEvidence('task', analysisId, [foreign.ref, 'file:external-verifier'], f.options());
  for (const ref of [own.ref, foreign.ref, 'file:external-verifier']) {
    unchanged(f, () => f.store.readAnalysisEvidence('task', analysisId, ref, f.options()), 'evidence_not_allowed');
  }
  assert.equal(f.store.getAnalysis('foreign', analysisId), null);
  assert.equal(f.store.getAnalysis('task', analysisId).readsUsed, 0);
});

test('UTF-8 reads preserve prefixes and reread stable evidence across reopen', (t) => {
  const f = fixture(t);
  const raw = JSON.stringify('😀é中'.repeat(100));
  const { ref } = f.store.putEvidence('task', 'unicode', '😀é中'.repeat(100), f.options());
  const { analysisId } = f.reserve();
  f.store.bindAnalysisEvidence('task', analysisId, [ref], f.options());
  const first = f.store.readAnalysisEvidence('task', analysisId, ref, { ...f.options(), maxBytes: 4 });
  assert.equal(first.text, '"');
  assert.equal(first.bytes, 1);
  assert.equal(first.omittedBytes, Buffer.byteLength(raw) - 1);
  const peer = f.open();
  const second = peer.readAnalysisEvidence('task', analysisId, ref, { ...f.options(), maxBytes: 12 });
  assert.ok(raw.startsWith(second.text));
  assert.ok(!second.text.includes('\ufffd'));
  assert.equal(Buffer.byteLength(second.text), second.bytes);
  unchanged(f, () => f.store.readAnalysisEvidence('task', analysisId, ref, f.options()), 'analysis_read_limit');
  assert.equal(peer.getAnalysis('task', analysisId).readsUsed, 2);
});

test('reads enforce cumulative 32 KiB and two-read caps, with no budget mutation on denial', (t) => {
  const f = fixture(t);
  const { ref } = f.store.putEvidence('task', 'large', 'x'.repeat(50_000), f.options());
  const { analysisId } = f.reserve();
  f.store.bindAnalysisEvidence('task', analysisId, [ref], f.options());
  for (const maxBytes of [0, -1, 32769, 1.2]) {
    unchanged(f, () => f.store.readAnalysisEvidence('task', analysisId, ref, { ...f.options(), maxBytes }), 'invalid_evidence_limit');
  }
  const first = f.store.readAnalysisEvidence('task', analysisId, ref, { ...f.options(), maxBytes: 20_000 });
  const second = f.store.readAnalysisEvidence('task', analysisId, ref, { ...f.options(), maxBytes: 20_000 });
  assert.equal(first.bytes, 20_000);
  assert.equal(second.bytes, 12_768);
  assert.equal(f.store.getAnalysis('task', analysisId).bytesRead, 32_768);
  unchanged(f, () => f.store.readAnalysisEvidence('task', analysisId, ref, f.options()), 'analysis_read_limit');
  assert.equal(f.store.getRun('task').budgetUsage.ioOperations, 2);
  assert.equal(f.store.getRun('task').budgetUsage.decisionRequests, 0);
});

test('evidence reads check task I/O budget and deadline before delivery', (t) => {
  const f = fixture(t, { maxIoOperations: 1 });
  f.store.reserveBudget('task', 'ioOperations', 1, f.options());
  const { ref } = f.store.putEvidence('task', 'small', 'secret', f.options());
  const { analysisId } = f.reserve();
  f.store.bindAnalysisEvidence('task', analysisId, [ref], f.options());
  unchanged(f, () => f.store.readAnalysisEvidence('task', analysisId, ref, f.options()), 'budget_exceeded');
  assert.equal(f.store.getAnalysis('task', analysisId).readsUsed, 0);
  f.setNow(5000);
  unchanged(f, () => f.store.readAnalysisEvidence('task', analysisId, ref, f.options()), 'budget_exceeded');
});

test('expired evidence access does not charge a read despite remaining I/O budget', (t) => {
  const f = fixture(t);
  const { ref } = f.store.putEvidence('task', 'small', 'secret', f.options());
  const { analysisId } = f.reserve();
  f.store.bindAnalysisEvidence('task', analysisId, [ref], f.options());
  f.setNow(5000);
  unchanged(f, () => f.store.readAnalysisEvidence('task', analysisId, ref, f.options()), 'budget_exceeded');
  assert.equal(f.store.getRun('task').budgetUsage.ioOperations, 0);
  assert.equal(f.store.getAnalysis('task', analysisId).readsUsed, 0);
});

test('pending analysis mutations require matching identity and current version', (t) => {
  const f = fixture(t);
  const { ref } = f.store.putEvidence('task', 'small', 'secret', f.options());
  const { analysisId } = f.reserve();
  const stale = f.options();
  f.store.bindAnalysisEvidence('task', analysisId, [ref], f.options());
  for (const operation of [
    () => f.store.bindAnalysisEvidence('task', analysisId, [], stale),
    () => f.store.readAnalysisEvidence('task', analysisId, ref, stale),
    () => f.store.recordAnalysis('task', analysisId, failure(), stale),
  ]) unchanged(f, operation, 'stale_run');
  for (const operation of [
    () => f.store.bindAnalysisEvidence('task', 'wrong', [], f.options()),
    () => f.store.readAnalysisEvidence('task', 'wrong', ref, f.options()),
    () => f.store.recordAnalysis('task', 'wrong', failure(), f.options()),
  ]) unchanged(f, operation, 'invalid_analysis_state');
  assert.equal(f.store.getAnalysis('task', analysisId).readsUsed, 0);
});

test('evidence insertion and metadata event roll back together', (t) => {
  const f = fixture(t);
  const db = f.db();
  db.exec("CREATE TRIGGER reject_evidence BEFORE INSERT ON events WHEN NEW.kind = 'evidence_stored' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  unchanged(f, () => f.store.putEvidence('task', 'rollback', { secret: true }, f.options()));
  assert.equal(db.prepare('SELECT count(*) AS n FROM evidence').get().n, 0);
});

test('evidence integrity rejects tampering even when an external connection removes triggers', (t) => {
  const f = fixture(t);
  const { ref } = f.store.putEvidence('task', 'hash', 'original', f.options());
  const { analysisId } = f.reserve();
  f.store.bindAnalysisEvidence('task', analysisId, [ref], f.options());
  const db = f.db();
  db.exec('DROP TRIGGER evidence_no_update');
  db.prepare('UPDATE evidence SET raw_json = ? WHERE ref = ?').run('"tampered"', ref);
  unchanged(f, () => f.store.readAnalysisEvidence('task', analysisId, ref, f.options()), 'evidence_integrity_error');
  assert.equal(f.store.getAnalysis('task', analysisId).readsUsed, 0);
});

test('proposals persist unresolved, require explicit review when requested, and reject late results', (t) => {
  const f = fixture(t);
  const { analysisId } = f.reserve();
  const run = f.store.recordAnalysis('task', analysisId, proposed(), f.options());
  assert.equal(run.status, 'waiting_analysis');
  assert.equal(run.reason, 'repair_proposed');
  assert.equal(f.store.getAnalysis('task', analysisId).status, 'proposed');
  unchanged(f, () => f.store.reserveAnalysis('task', f.options()), 'analysis_unresolved');
  unchanged(f, () => f.store.recordAnalysis('task', analysisId, failure('analysis_timeout'), f.options()), 'invalid_analysis_state');
  assert.equal(f.store.getAnalysis('task', analysisId).result.status, 'proposed');
  assert.equal(f.store.getRun('task').budgetUsage.analysisCalls, 1);
  assert.equal(f.store.getRun('task').usage.attempts, 0);
});

for (const status of ['analysis_parse_failed', 'analysis_timeout', 'analysis_cancelled', 'analysis_failed', 'analysis_package_failed', 'proposed']) {
  test(`analysis result ${status} commits the expected stop state`, (t) => {
    const f = fixture(t);
    const { analysisId } = f.reserve();
    const result = status === 'proposed' ? proposed([], true) : failure(status);
    const run = f.store.recordAnalysis('task', analysisId, result, f.options());
    assert.equal(run.status, status === 'analysis_cancelled' ? 'cancelled' : 'waiting_human');
    assert.equal(f.store.readEvents('task').at(-1).kind, 'analysis_recorded');
    unchanged(f, () => f.store.recordAnalysis('task', analysisId, proposed(), f.options()), 'invalid_analysis_state');
  });
}

test('analysis results reject arbitrary model output, over-limit data and unbound diagnosis refs', (t) => {
  const f = fixture(t);
  const { analysisId } = f.reserve();
  for (const result of [ { ...failure(), raw: 'model output' }, { status: 'not_known' },
    { ...proposed(), rawOutput: 'x'.repeat(32768) }, { status: 'proposed', repair: { ...proposed().repair, reason: 'x'.repeat(32768) } },
    { status: 'analysis_failed', error: { code: 'bad', message: 'failed', raw: 'secret' } }, proposed(['foreign:ref']) ]) {
    unchanged(f, () => f.store.recordAnalysis('task', analysisId, result, f.options()));
  }
  assert.equal(f.store.getAnalysis('task', analysisId).status, 'pending');
});

test('analysis writes roll back rows and budgets when the event insert fails', (t) => {
  const f = fixture(t);
  f.wait();
  const db = f.db();
  db.exec("CREATE TRIGGER reject_analysis BEFORE INSERT ON events WHEN NEW.kind = 'analysis_reserved' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  unchanged(f, () => f.store.reserveAnalysis('task', { ...f.options(), analysisId: 'rollback' }));
  assert.equal(f.store.getAnalysis('task', 'rollback'), null);
  db.exec('DROP TRIGGER reject_analysis');
  const { analysisId } = f.store.reserveAnalysis('task', f.options());
  const { ref } = f.store.putEvidence('task', 'small', {}, f.options());
  f.store.bindAnalysisEvidence('task', analysisId, [ref], f.options());
  db.exec("CREATE TRIGGER reject_read BEFORE INSERT ON events WHEN NEW.kind = 'analysis_evidence_read' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  unchanged(f, () => f.store.readAnalysisEvidence('task', analysisId, ref, f.options()));
  assert.equal(f.store.getAnalysis('task', analysisId).readsUsed, 0);
  db.exec("CREATE TRIGGER reject_record BEFORE INSERT ON events WHEN NEW.kind = 'analysis_recorded' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  unchanged(f, () => f.store.recordAnalysis('task', analysisId, proposed(), f.options()));
  assert.equal(f.store.getAnalysis('task', analysisId).status, 'pending');
});

test('latest attempt uses insertion order and recent trace returns only bounded metadata', (t) => {
  const f = fixture(t);
  assert.equal(f.store.getLatestAttempt('task'), null);
  const first = f.store.reserveAttempt('task', candidate, f.options());
  f.store.markStarted('task', first.attemptId, f.options());
  f.store.recordOutcome('task', first.attemptId, { status: 'succeeded' }, verification, f.options());
  f.setNow(900);
  const second = f.store.reserveAttempt('task', candidate, f.options());
  assert.equal(f.store.getLatestAttempt('task').attemptId, second.attemptId);
  assert.equal(f.store.getLatestAttempt('task').outcome, null);
  assert.equal(f.store.readRecentTrace('task').length, 3);
  const recent = f.store.readRecentTrace('task', { limit: 10 });
  assert.equal(recent.at(-1).attemptId, second.attemptId);
  assert.ok(recent.every((row) => Object.keys(row).sort().join(',') === 'attemptId,createdAt,eventId,kind,sequence'));
  assert.deepEqual(recent.map((event) => event.sequence), recent.map((event) => event.sequence).toSorted((a, b) => a - b));
  for (const limit of [0, 11, 2.5]) assert.throws(() => f.store.readRecentTrace('task', { limit }), { code: 'invalid_trace_limit' });
});
