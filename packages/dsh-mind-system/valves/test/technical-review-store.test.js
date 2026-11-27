import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createTechnicalReviewStore, TECHNICAL_REVIEW_ALGORITHM_VERSION } from '../src/technical-review-store.js';

const request = { producerId: 'producer-1', eventId: 'event-1' };
const safety = () => ({ goalProof: 'not_evaluated', principleAttribution: 'not_evaluated', governanceEligible: false });
const evidence = (payload = { b: 2, a: 1 }, status = 'match') => ({
  identity: { ...safety(), ...request, status: 'match', code: 'receipt_matches_persisted_identity', attestation: 'record_consistency', payload },
  artifacts: { ...safety(), status, reason: status === 'match' ? 'all_artifacts_match' : 'artifacts_not_verified' },
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'technical-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'private.sqlite');
}
const hasCode = (code) => (error) => error.code === code && !error.message.includes('secret');

test('canonical replay survives reopen and never stores raw payload or paths', (t) => {
  const filePath = fixture(t);
  let result = evidence({ secret: 'credential-secret', path: 'C:\\secret\\file', a: 1 });
  let store = createTechnicalReviewStore({ filePath, resolveEvidence: () => result });
  const first = store.review(request);
  assert.equal(first.status, 'created');
  assert.equal(first.snapshot.algorithmVersion, TECHNICAL_REVIEW_ALGORITHM_VERSION);
  assert.equal(first.snapshot.payloadSha256, createHash('sha256').update(JSON.stringify({ a: 1, path: 'C:\\secret\\file', secret: 'credential-secret' })).digest('hex'));
  assert.deepEqual([first.snapshot.goalProof, first.snapshot.principleAttribution, first.snapshot.governanceEligible], ['not_evaluated', 'not_evaluated', false]);
  result = evidence({ a: 1, path: 'C:\\secret\\file', secret: 'credential-secret' });
  assert.deepEqual(store.review(request), { status: 'replay', snapshot: first.snapshot });
  store.close();
  store = createTechnicalReviewStore({ filePath, resolveEvidence: () => result });
  assert.deepEqual(store.review(request).snapshot, first.snapshot);
  assert.deepEqual(store.get(request), first.snapshot);
  store.close();
  const bytes = readFileSync(filePath).toString('latin1');
  assert.ok(!bytes.includes('credential-secret'));
  assert.ok(!bytes.includes('C:\\secret'));
});

test('conflicts roll back and forged completion or extra inputs are refused', (t) => {
  const filePath = fixture(t);
  let result = evidence();
  const store = createTechnicalReviewStore({ filePath, resolveEvidence: () => result });
  const original = store.review(request).snapshot;
  result = evidence({ a: 99 });
  assert.throws(() => store.review(request), hasCode('technical_review_conflict'));
  result = evidence(undefined, 'mismatch');
  assert.throws(() => store.review(request), hasCode('technical_review_conflict'));
  result = evidence(); result.identity.goalProof = 'verified';
  assert.throws(() => store.review(request), hasCode('invalid_technical_evidence'));
  result = evidence(); result.artifacts.governanceEligible = true;
  assert.throws(() => store.review(request), hasCode('invalid_technical_evidence'));
  result = evidence(); result.artifacts.reason = 'secret_token';
  assert.throws(() => store.review(request), hasCode('invalid_technical_evidence'));
  assert.throws(() => store.review({ ...request, filePath: 'C:\\secret' }), hasCode('invalid_technical_review_request'));
  assert.throws(() => store.get({ producerId: "a' OR 1=1--", eventId: 'x' }), hasCode('invalid_technical_review_request'));
  assert.deepEqual(store.get(request), original);
  result = evidence(); result.identity.eventId = 'other';
  assert.equal(store.review({ producerId: 'producer-1', eventId: 'other' }).status, 'created');
  store.close();
});

test('storage and resolver failures are explicit and sanitized', (t) => {
  const filePath = fixture(t);
  writeFileSync(filePath, 'not a database');
  assert.throws(() => createTechnicalReviewStore({ filePath, resolveEvidence: () => evidence() }), hasCode('technical_review_database_error'));
  assert.throws(() => createTechnicalReviewStore({ filePath: ':memory:', resolveEvidence: () => evidence() }), hasCode('invalid_technical_review_config'));
  const other = `${filePath}.other`;
  const store = createTechnicalReviewStore({ filePath: other, resolveEvidence: () => { throw new Error('secret path'); } });
  assert.throws(() => store.review(request), hasCode('technical_review_resolver_error'));
  store.close();
  assert.throws(() => store.get(request), hasCode('technical_review_closed'));
});

test('invalid persisted rows are rejected instead of replayed', (t) => {
  const filePath = fixture(t);
  const store = createTechnicalReviewStore({ filePath, resolveEvidence: () => evidence() });
  store.review(request); store.close();
  const db = new DatabaseSync(filePath);
  db.prepare('UPDATE technical_review_snapshots SET data=?').run('{"governanceEligible":true}');
  db.close();
  const reopened = createTechnicalReviewStore({ filePath, resolveEvidence: () => evidence() });
  assert.throws(() => reopened.get(request), hasCode('corrupt_technical_review'));
  assert.throws(() => reopened.review(request), hasCode('corrupt_technical_review'));
  reopened.close();
});

test('concurrent conflicting writers yield one durable winner', async (t) => {
  const filePath = fixture(t);
  const initial = createTechnicalReviewStore({ filePath, resolveEvidence: () => evidence() }); initial.close();
  const moduleUrl = new URL('../src/technical-review-store.js', import.meta.url).href;
  const script = `const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{const {createTechnicalReviewStore}=await import(workerData.url);
    const safe={goalProof:'not_evaluated',principleAttribution:'not_evaluated',governanceEligible:false};
    const request={producerId:'producer-1',eventId:'event-1'};
    const store=createTechnicalReviewStore({filePath:workerData.file,resolveEvidence:()=>({identity:{...safe,...request,status:'match',code:'receipt_matches_persisted_identity',attestation:'record_consistency',payload:{value:workerData.value}},artifacts:{...safe,status:'match',reason:'all_artifacts_match'}})});
    parentPort.postMessage('ready');parentPort.once('message',()=>{try{parentPort.postMessage(store.review(request).status)}catch(e){parentPort.postMessage(e.code)}finally{store.close()}})})().catch(e=>parentPort.postMessage('error:'+e.message));`;
  const workers = [1, 2].map((value) => new Worker(script, { eval: true, workerData: { file: filePath, url: moduleUrl, value } }));
  t.after(() => workers.forEach((worker) => worker.terminate()));
  const ready = workers.map((worker) => new Promise((resolve, reject) => { worker.once('message', (message) => message === 'ready' ? resolve() : reject(new Error(message))); worker.once('error', reject); }));
  await Promise.all(ready);
  const outcomes = workers.map((worker) => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }));
  workers.forEach((worker) => worker.postMessage('start'));
  assert.deepEqual((await Promise.all(outcomes)).sort(), ['created', 'technical_review_conflict']);
  const store = createTechnicalReviewStore({ filePath, resolveEvidence: () => evidence() });
  assert.ok(store.get(request)); store.close();
});
