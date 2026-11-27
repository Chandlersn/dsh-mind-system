import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readUsageCorrelation } from '../src/usage-correlation-reader.js';

const id = '11111111-1111-4111-8111-111111111111';
const row = (href = 'functions/one.md') => ({ t: '2026-01-01T00:00:00.000Z', href, kind: 'positive', note: 'hello', correlationId: id });
const line = value => `${JSON.stringify(value)}\n`;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-correlation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('scans all source types and reports duplicates and overflow', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, '.usage', 'archive'), { recursive: true });
  await fs.writeFile(path.join(root, '.usage.jsonl'), line(row()));
  await fs.writeFile(path.join(root, '.usage', '2020-01.jsonl'), line(row('functions/two.md')));
  await fs.writeFile(path.join(root, '.usage', 'archive', '2010-01.jsonl'), line(row('functions/three.md')));
  const result = await readUsageCorrelation(root, id);
  assert.equal(result.status, 'observed');
  assert.equal(result.scope, 'selected_sources_complete');
  assert.equal(result.snapshot, 'unknown');
  assert.equal(result.duplicate, true);
  assert.equal(result.overflow, true);
  assert.equal(result.rows.length, 2);
  assert.notEqual(result.rows[0].objectKey, result.rows[1].objectKey);
});

test('invalid ID, absent sources and empty file are distinct', async t => {
  const root = await fixture(t);
  assert.equal((await readUsageCorrelation(root, 'invalid')).status, 'error');
  assert.equal((await readUsageCorrelation(root, id)).sourceState, 'absent');
  await fs.writeFile(path.join(root, '.usage.jsonl'), '');
  const result = await readUsageCorrelation(root, id);
  assert.equal(result.status, 'not_observed');
  assert.equal(result.sourceState, 'present');
});

test('rejects malformed, truncated, unsafe and over-limit content', async t => {
  const root = await fixture(t), file = path.join(root, '.usage.jsonl');
  for (const data of [Buffer.from('{"x":1}'), Buffer.from('{oops}\n'), Buffer.from([0xff, 10]), Buffer.from(line({ ...row(), note: 'sk-abcdefghijklmnopqrstuvwxyz123456789' })), Buffer.from('x'.repeat(65537) + '\n'), Buffer.alloc(8 * 1024 * 1024 + 1)]) {
    await fs.writeFile(file, data);
    assert.equal((await readUsageCorrelation(root, id)).status, 'incomplete');
  }
  await fs.writeFile(file, line({ ...row(), kind: 'recall' }));
  assert.equal((await readUsageCorrelation(root, id)).reason, 'invalid_matching_row');
});

test('detects changes during read and performs no writes', async t => {
  const root = await fixture(t), file = path.join(root, '.usage.jsonl');
  const content = line(row());
  await fs.writeFile(file, content);
  const original = fs.open;
  fs.open = async (...args) => {
    const handle = await original(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...readArgs) => { const result = await read(...readArgs); await fs.appendFile(file, line(row())); return result; };
    return handle;
  };
  try { assert.equal((await readUsageCorrelation(root, id)).reason, 'source_changed'); }
  finally { fs.open = original; }
  await fs.writeFile(file, content);
  const before = await fs.readFile(file);
  await readUsageCorrelation(root, id);
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual(await fs.readdir(root), ['.usage.jsonl']);
});

test('preserves missing and empty notes and bounds rows and source enumeration', async t => {
  const root = await fixture(t), file = path.join(root, '.usage.jsonl');
  const missing = row(); delete missing.note;
  await fs.writeFile(file, line(missing) + line({ ...row('functions/two.md'), note: '' }));
  const result = await readUsageCorrelation(root, id);
  assert.deepEqual(result.rows.map(r => r.noteStatus), ['missing_normalized_empty', 'available']);
  await fs.writeFile(file, '{}\n'.repeat(100001));
  assert.equal((await readUsageCorrelation(root, id)).reason, 'row_limit');
  await fs.writeFile(file, '');
  const dir = path.join(root, '.usage');
  await fs.mkdir(dir);
  await Promise.all(Array.from({ length: 257 }, (_, i) => fs.writeFile(path.join(dir, `other-${i}`), '')));
  assert.equal((await readUsageCorrelation(root, id)).reason, 'enumeration_limit');
});

test('detects inode identities that collide when converted to Number', async t => {
  const root = await fixture(t), file = path.join(root, '.usage.jsonl');
  await fs.writeFile(file, line(row()));
  const original = fs.lstat;
  let calls = 0;
  fs.lstat = async (...args) => {
    const info = await original(...args);
    if (args[0] === file && ++calls === 1) {
      const actual = info.ino;
      assert.equal(typeof actual, 'bigint');
      Object.defineProperty(info, 'ino', { value: 9007199254740992n });
    } else if (args[0] === file) {
      Object.defineProperty(info, 'ino', { value: 9007199254740993n });
    }
    return info;
  };
  const open = fs.open;
  fs.open = async (...args) => {
    const handle = await open(...args), stat = handle.stat.bind(handle);
    handle.stat = async (...options) => {
      const info = await stat(...options);
      Object.defineProperty(info, 'ino', { value: 9007199254740993n });
      return info;
    };
    return handle;
  };
  try {
    assert.equal(Number(9007199254740992n), Number(9007199254740993n));
    assert.equal((await readUsageCorrelation(root, id)).reason, 'source_changed');
  } finally { fs.lstat = original; fs.open = open; }
});

test('rejects symlink sources when supported', async t => {
  const root = await fixture(t), target = path.join(root, 'target');
  await fs.writeFile(target, line(row()));
  try { await fs.symlink(target, path.join(root, '.usage.jsonl')); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) return t.skip('symlink creation unavailable'); throw e; }
  assert.equal((await readUsageCorrelation(root, id)).status, 'incomplete');
});
