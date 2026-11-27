import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync, linkSync, mkdirSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createTechnicalReviewStore } from '../src/technical-review-store.js';
import { readTechnicalReview } from '../src/technical-review-read.js';

const request = { producerId: 'producer-1', eventId: 'event-1' };
const safety = { goalProof: 'not_evaluated', principleAttribution: 'not_evaluated', governanceEligible: false };
const evidence = () => ({ identity: { ...safety, ...request, status: 'match', code: 'receipt_matches_persisted_identity', attestation: 'record_consistency', payload: { value: 1 } }, artifacts: { ...safety, status: 'match', reason: 'all_artifacts_match' } });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'review-read-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'store.sqlite');
}
const read = (filePath, changes = {}) => readTechnicalReview({ filePath, ...request, ...changes });
const hash = (path) => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
function create(filePath) {
  let current = evidence();
  const store = createTechnicalReviewStore({ filePath, resolveEvidence: () => current });
  const snapshot = store.review(request).snapshot;
  return { store, snapshot, invalidate() { current = null; } };
}

test('reads persisted snapshots without re-evaluating evidence or changing database and WAL', (t) => {
  const path = fixture(t);
  const { store, snapshot, invalidate } = create(path);
  invalidate();
  const before = [hash(path), hash(`${path}-wal`)];
  assert.deepEqual(read(path), { status: 'available', reason: 'snapshot_available', ...safety, snapshot });
  assert.deepEqual([hash(path), hash(`${path}-wal`)], before);
  assert.equal(read(path, { eventId: 'different' }).status, 'missing');
  store.close();
  assert.deepEqual(read(path).snapshot, snapshot);
});

test('every accepted artifact status and reason survives a real write and separate read', (t) => {
  const path = fixture(t);
  const reasons = ['artifacts_not_verified', 'invalid_workspace_root', 'invalid_evidence_refs',
    'empty_evidence_refs', 'reference_count_limit', 'link_not_allowed', 'ancestor_not_directory',
    'workspace_not_directory', 'file_missing', 'access_denied', 'filesystem_error', 'output_byte_limit'];
  const combinations = [['match', 'all_artifacts_match'],
    ...['mismatch', 'unknown', 'error'].flatMap((status) => reasons.map((reason) => [status, reason]))];
  let current;
  const store = createTechnicalReviewStore({ filePath: path, resolveEvidence: () => current });
  for (const [index, [status, reason]] of combinations.entries()) {
    const identity = { ...request, eventId: `event-${index}` };
    current = evidence();
    Object.assign(current.identity, identity);
    Object.assign(current.artifacts, { status, reason });
    const written = store.review(identity);
    assert.equal(written.status, 'created');
    assert.deepEqual(read(path, identity), { status: 'available', reason: 'snapshot_available', ...safety, snapshot: written.snapshot });
    assert.deepEqual([written.snapshot.goalProof, written.snapshot.principleAttribution, written.snapshot.governanceEligible], ['not_evaluated', 'not_evaluated', false]);
  }
  store.close();
});

test('missing, invalid inputs and malformed database return sanitized results', (t) => {
  const path = fixture(t);
  assert.equal(read(path).status, 'missing');
  assert.equal(existsSync(path), false);
  for (const options of [{ filePath: path, ...request, extra: true }, { filePath: ':memory:', ...request }, { filePath: path, ...request, eventId: 'bad/id' }, null]) {
    const output = readTechnicalReview(options);
    assert.equal(output.status, 'error');
    assert.ok(!JSON.stringify(output).includes(path));
    assert.deepEqual([output.goalProof, output.principleAttribution, output.governanceEligible], ['not_evaluated', 'not_evaluated', false]);
  }
  writeFileSync(path, 'secret malformed database');
  const before = hash(path);
  assert.equal(read(path).status, 'error');
  assert.equal(hash(path), before);
});

test('rejects corrupt, forged, oversized and wrong-key snapshots', (t) => {
  const path = fixture(t);
  const { store, snapshot } = create(path);
  store.close();
  const db = new DatabaseSync(path);
  const update = db.prepare('UPDATE technical_review_snapshots SET data=?');
  const variants = [
    { ...snapshot, governanceEligible: true }, { ...snapshot, goalProof: 'verified' },
    { ...snapshot, producerId: 'different' }, { ...snapshot, algorithmVersion: 'other' },
    { ...snapshot, artifactStatus: 'mismatch', artifactReason: 'all_artifacts_match' },
    { ...snapshot, artifactStatus: 'match', artifactReason: 'file_missing' },
    { ...snapshot, artifactStatus: 'other' }, { ...snapshot, artifactReason: 'other' },
    { ...snapshot, identityReason: 'other' }, { ...snapshot, identityStatus: 'unknown' },
    { ...snapshot, principleAttribution: 'verified' }, { ...snapshot, payloadSha256: 'z'.repeat(64) },
    { ...snapshot, createdAt: '2026-02-30T00:00:00.000Z' }, { ...snapshot, extra: 1 },
  ];
  for (const item of variants) {
    update.run(JSON.stringify(item));
    assert.equal(read(path).status, 'error');
  }
  update.run(JSON.stringify(snapshot).replace('{', '{"governanceEligible":true,'));
  assert.equal(read(path).status, 'error');
  db.exec('PRAGMA ignore_check_constraints=ON');
  update.run('x'.repeat(2049));
  assert.equal(read(path).status, 'error');
  db.exec("UPDATE technical_review_snapshots SET data=CAST(X'80' AS TEXT)");
  assert.equal(read(path).status, 'error');
  db.exec("UPDATE technical_review_snapshots SET data=CAST(X'7b7d00' AS TEXT)");
  assert.equal(read(path).status, 'error');
  update.run(JSON.stringify(snapshot));
  db.prepare('UPDATE technical_review_snapshots SET event_id=?').run('different');
  assert.equal(read(path).status, 'missing');
  assert.equal(read(path, { eventId: 'different' }).status, 'error');
  db.close();
});

test('rejects oversized database, sidecars, directories and available links', (t) => {
  const path = fixture(t);
  const { store } = create(path); store.close();
  const alias = `${path}.hard`;
  linkSync(path, alias);
  assert.equal(read(path).status, 'unknown');
  rmSync(alias);
  try {
    symlinkSync(path, alias, 'file');
    assert.equal(read(alias).status, 'unknown');
    rmSync(alias);
  } catch (error) { if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error; }
  const directory = `${path}.dir`;
  mkdirSync(directory);
  assert.equal(read(directory).status, 'unknown');
  const junction = `${path}.junction`;
  try {
    symlinkSync(directory, junction, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(read(join(junction, 'file')).status, 'unknown');
  } catch (error) { if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error; }
  writeFileSync(`${path}-wal`, '');
  truncateSync(`${path}-wal`, 64 * 1024 * 1024);
  assert.equal(read(path).status, 'unknown', 'main database and WAL share one byte limit');
  truncateSync(`${path}-wal`, 64 * 1024 * 1024 + 1);
  assert.equal(read(path).status, 'unknown');
  rmSync(`${path}-wal`);
  truncateSync(path, 64 * 1024 * 1024 + 1);
  assert.equal(read(path).status, 'unknown');
});
