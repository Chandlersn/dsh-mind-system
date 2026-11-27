import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readArtifactEvidence, ARTIFACT_EVIDENCE_LIMITS as limits } from '../src/artifact-evidence-reader.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ref = (file, bytes = 'hello') => `file:${file}#sha256:${digest(bytes)}`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'artifact.txt');
  fs.writeFileSync(file, 'hello');
  return { root, file, read: (refs = [ref(file)]) => readArtifactEvidence({ workspaceRoot: root, evidenceRefs: refs }) };
}
function unprivileged(output) {
  assert.equal(output.goalProof, 'not_evaluated');
  assert.equal(output.principleAttribution, 'not_evaluated');
  assert.equal(output.governanceEligible, false);
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= limits.outputBytes);
}

test('native matching bytes never establish goal or principle proof', (t) => {
  const { read } = fixture(t);
  const output = read();
  assert.equal(output.status, 'match');
  assert.equal(output.bytesRead, 5);
  assert.equal(output.refs[0].actualSha256, digest('hello'));
  assert.ok(!JSON.stringify(output).includes('hello'));
  unprivileged(output);
});

test('same-length tampering is a mismatch', (t) => {
  const { file, read } = fixture(t);
  fs.writeFileSync(file, 'world');
  const output = read();
  assert.equal(output.status, 'mismatch');
  assert.equal(output.refs[0].reason, 'sha256_mismatch');
  unprivileged(output);
});

test('empty, malformed, missing and non-native references never succeed', (t) => {
  const { root, file, read } = fixture(t);
  assert.equal(read([]).reason, 'empty_evidence_refs');
  assert.equal(readArtifactEvidence({ workspaceRoot: root }).status, 'unknown');
  const bad = [null, {}, 'http://example.com', 'file:relative#sha256:' + 'a'.repeat(64),
    `file:${file}#sha256:bad`, ref(file) + 'x', 'x'.repeat(limits.refChars + 1),
    ref(path.join(root, 'missing')), 'file:\0#sha256:' + 'a'.repeat(64)];
  const output = read(bad);
  assert.equal(output.status, 'unknown');
  assert.equal(output.refs.length, bad.length);
  assert.ok(output.refs.every((entry) => entry.status === 'unknown'));
  assert.equal(output.refs[7].reason, 'file_missing');
  assert.equal(output.bytesRead, 0);
  unprivileged(output);
});

test('last digest delimiter and literal percent escapes are native filename data', (t) => {
  const { root, read } = fixture(t);
  // Colon is not legal in ordinary Windows filenames; percent encoding is legal.
  const file = path.join(root, process.platform === 'win32' ? 'literal%20name.txt' : 'literal%20#sha256:name.txt');
  fs.writeFileSync(file, 'hello');
  assert.equal(read([ref(file)]).status, 'match');
  fs.renameSync(file, path.join(root, 'literal name.txt'));
  assert.equal(read([ref(file)]).refs[0].reason, 'file_missing');
});

test('workspace must be a host absolute path and lexical prefix siblings are outside', (t) => {
  const { root, read } = fixture(t);
  assert.equal(readArtifactEvidence({ workspaceRoot: '.', evidenceRefs: [] }).reason, 'invalid_workspace_root');
  assert.equal(readArtifactEvidence({ workspaceRoot: null, evidenceRefs: [] }).status, 'error');
  const outside = path.join(path.dirname(root), path.basename(root) + '-outside.txt');
  fs.writeFileSync(outside, 'hello');
  t.after(() => fs.rmSync(outside, { force: true }));
  for (const target of [outside, path.join(root, '..', path.basename(outside))]) {
    assert.equal(read([ref(target)]).refs[0].reason, 'outside_workspace');
  }
  assert.equal(read([ref(root)]).refs[0].reason, 'not_regular_file');
});

test('symlink files and directory junctions are rejected when platform permits', (t) => {
  const { root, file, read } = fixture(t);
  const link = path.join(root, 'link.txt');
  try { fs.symlinkSync(file, link, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic('File symlink creation unavailable; junction coverage remains active.'); } else throw error; }
  if (fs.existsSync(link)) assert.equal(read([ref(link)]).refs[0].reason, 'link_not_allowed');
  const directory = path.join(root, 'directory');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'a'), 'hello');
  const junction = path.join(root, 'junction');
  try { fs.symlinkSync(directory, junction, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Directory link creation unavailable'); return; } throw error; }
  assert.equal(read([ref(path.join(junction, 'a'))]).refs[0].reason, 'link_not_allowed');
  assert.equal(readArtifactEvidence({ workspaceRoot: junction, evidenceRefs: [ref(path.join(junction, 'a'))] }).reason, 'link_not_allowed');
});

test('hardlink aliases are explicitly rejected', (t) => {
  const { root, file, read } = fixture(t);
  fs.linkSync(file, path.join(root, 'alias'));
  assert.equal(read().refs[0].reason, 'hardlink_not_allowed');
});

test('reference limits and output bounds reject excessive input without echoing it', (t) => {
  const { file, read } = fixture(t);
  const accepted = read(Array(32).fill(ref(file)));
  assert.equal(accepted.status, 'match');
  unprivileged(accepted);
  const rejected = read(Array(33).fill(ref(file)));
  assert.equal(rejected.reason, 'reference_count_limit');
  assert.equal(rejected.bytesRead, 0);
  unprivileged(rejected);
});

test('single-file and total limits are explicit; chunk reads never exceed 64KiB', (t) => {
  const { file, read } = fixture(t);
  const data = Buffer.alloc(limits.fileBytes, 97);
  fs.writeFileSync(file, data);
  const original = fs.readSync;
  let maximum = 0;
  t.mock.method(fs, 'readSync', (...args) => { maximum = Math.max(maximum, args[3]); return original(...args); });
  const output = read(Array(5).fill(ref(file, data)));
  assert.equal(output.status, 'unknown');
  assert.equal(output.bytesRead, limits.totalBytes);
  assert.ok(output.refs.slice(0, 4).every((entry) => entry.status === 'match'));
  assert.equal(output.refs[4].reason, 'total_byte_limit');
  assert.equal(maximum, limits.chunkBytes);
  fs.appendFileSync(file, 'x');
  const oversized = read([ref(file, data)]);
  assert.equal(oversized.refs[0].reason, 'file_byte_limit');
  assert.equal(oversized.bytesRead, 0);
});

test('same-length mutation during descriptor reading is detected', (t) => {
  const { file, read } = fixture(t);
  const data = Buffer.alloc(limits.chunkBytes * 2, 97);
  fs.writeFileSync(file, data);
  const original = fs.readSync;
  let changed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const count = original(...args);
    if (!changed) {
      changed = true;
      fs.writeFileSync(file, Buffer.alloc(data.length, 98));
      // Make the metadata delta deterministic even on coarse timestamp filesystems.
      fs.utimesSync(file, new Date(1000), new Date(1000));
    }
    return count;
  });
  const output = read([ref(file, data)]);
  assert.equal(output.status, 'unknown');
  assert.equal(output.refs[0].reason, 'file_changed');
  assert.ok(output.bytesRead <= data.length);
  unprivileged(output);
});

test('growth during reads remains bounded and cannot match the original prefix', (t) => {
  const { file, read } = fixture(t);
  const original = fs.readSync;
  t.mock.method(fs, 'readSync', (...args) => {
    const count = original(...args);
    fs.appendFileSync(file, Buffer.alloc(limits.chunkBytes));
    return count;
  });
  const output = read();
  assert.equal(output.status, 'unknown');
  assert.equal(output.refs[0].reason, 'file_changed');
  assert.equal(output.bytesRead, 5);
});

test('empty files match and URL-form file references remain unsupported', (t) => {
  const { file, read } = fixture(t);
  fs.writeFileSync(file, '');
  const output = read([ref(file, '')]);
  assert.equal(output.status, 'match');
  assert.equal(output.bytesRead, 0);
  const urlPath = process.platform === 'win32' ? '/' + file.replaceAll('\\', '/') : file;
  assert.equal(read([`file://${urlPath}#sha256:${digest('')}`]).status, 'unknown');
});

test('descriptor identity rejects same-byte replacement at the pathname', (t) => {
  const { root, file, read } = fixture(t);
  const replacement = path.join(root, 'replacement');
  fs.writeFileSync(replacement, 'hello');
  const original = fs.readSync;
  let changed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const count = original(...args);
    if (!changed) {
      changed = true;
      fs.renameSync(file, path.join(root, 'old'));
      fs.renameSync(replacement, file);
    }
    return count;
  });
  const output = read();
  assert.equal(output.status, 'unknown');
  assert.equal(output.refs[0].reason, 'file_changed');
});

test('realpath containment is checked independently from lexical containment', (t) => {
  const { root, file, read } = fixture(t);
  const original = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', (target, ...args) => target === file
    ? path.join(path.dirname(root), 'elsewhere') : original(target, ...args));
  const output = read();
  assert.equal(output.refs[0].reason, 'realpath_outside_workspace');
  assert.equal(output.bytesRead, 0);
});

test('filesystem errors are bounded and do not expose paths', (t) => {
  const { root, read } = fixture(t);
  t.mock.method(fs, 'openSync', () => { throw Object.assign(new Error('secret ' + root), { code: 'EACCES' }); });
  const output = read();
  assert.equal(output.status, 'error');
  assert.equal(output.refs[0].reason, 'access_denied');
  assert.ok(!JSON.stringify(output).includes(root));
  unprivileged(output);
});
