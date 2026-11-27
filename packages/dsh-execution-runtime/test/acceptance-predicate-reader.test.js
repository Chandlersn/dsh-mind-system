import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readAcceptancePredicate } from '../src/acceptance-predicate-reader.js';
import { ARTIFACT_EVIDENCE_LIMITS } from '../src/artifact-evidence-reader.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const contract = (name = 'output.txt', bytes = 'secret-content') => ({ schemaVersion: 1,
  predicate: { id: 'file_sha256', version: 1 }, output: { path: name, sha256: hash(bytes) } });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-reader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'output.txt');
  fs.writeFileSync(file, 'secret-content');
  return { root, file, read: (value = contract()) => readAcceptancePredicate({ workspaceRoot: root, contract: value }) };
}
function safe(output, ...secrets) {
  assert.equal(output.goalProof, 'not_evaluated');
  assert.equal(output.principleAttribution, 'not_evaluated');
  assert.equal(output.governanceEligible, false);
  const encoded = JSON.stringify(output);
  assert.ok(Buffer.byteLength(encoded) < 512);
  for (const secret of secrets) assert.ok(!encoded.includes(secret));
}

test('actual bytes determine a deterministic read-time result without writes', (t) => {
  const { root, file, read } = fixture(t);
  const before = fs.readFileSync(file);
  const metadata = fs.statSync(file, { bigint: true });
  const passing = read();
  assert.equal(passing.status, 'pass');
  assert.equal(passing.reason, 'sha256_match');
  assert.deepEqual(read(), passing);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, metadata.mtimeNs);
  assert.deepEqual(fs.readdirSync(root), ['output.txt']);
  safe(passing, root, file, 'secret-content', hash('secret-content'));
  fs.writeFileSync(file, 'changed-bytes!');
  const failing = read();
  assert.equal(failing.status, 'fail');
  assert.equal(failing.reason, 'sha256_mismatch');
  safe(failing, root, file, hash('secret-content'), hash('changed-bytes!'));
});

test('missing, permission errors and byte limit cannot fail or pass', (t) => {
  const { root, file, read } = fixture(t);
  const missing = read(contract('missing.txt'));
  assert.equal(missing.status, 'unknown');
  safe(missing, root, 'missing.txt');
  const original = fs.openSync;
  const mocked = t.mock.method(fs, 'openSync', () => { throw Object.assign(new Error(`secret ${root}`), { code: 'EACCES' }); });
  const denied = read();
  assert.equal(denied.status, 'error');
  safe(denied, root);
  mocked.mock.restore();
  assert.equal(fs.openSync, original);
  fs.truncateSync(file, ARTIFACT_EVIDENCE_LIMITS.fileBytes + 1);
  const oversized = read();
  assert.equal(oversized.status, 'unknown');
  safe(oversized, root);
});

test('invalid contracts, traversal and injected results are denied', (t) => {
  const { root, read } = fixture(t);
  for (const name of ['../outside', 'a/../../outside', '/outside', 'C:/outside', 'a\\outside']) {
    assert.equal(read(contract(name)).status, 'error');
  }
  const invalid = contract();
  invalid.predicate.id = 'forged';
  assert.equal(read(invalid).reason, 'invalid_contract');
  invalid.predicate.id = 'file_sha256';
  invalid.output.extra = 'forged';
  assert.equal(read(invalid).reason, 'invalid_contract');
  const forged = readAcceptancePredicate({ workspaceRoot: root, contract: contract(), result: { status: 'match' } });
  assert.equal(forged.reason, 'invalid_input');
  assert.equal(readAcceptancePredicate({ workspaceRoot: '.', contract: contract() }).reason, 'invalid_workspace_root');
  let invoked = false;
  const input = { workspaceRoot: root };
  Object.defineProperty(input, 'contract', { enumerable: true, get() { invoked = true; return contract(); } });
  assert.equal(readAcceptancePredicate(input).reason, 'invalid_input');
  assert.equal(invoked, false);
  safe(forged, root);
});

test('file hardlinks and directory links cannot establish a match', (t) => {
  const { root, file, read } = fixture(t);
  const hard = path.join(root, 'hard.txt');
  fs.linkSync(file, hard);
  assert.equal(read().status, 'unknown');
  fs.unlinkSync(hard);
  const directory = path.join(root, 'directory');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'file.txt'), 'secret-content');
  const link = path.join(root, 'linked');
  try { fs.symlinkSync(directory, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic('Directory links unavailable'); return; }
    throw error;
  }
  const output = read(contract('linked/file.txt'));
  assert.equal(output.status, 'unknown');
  safe(output, root, link);
});
