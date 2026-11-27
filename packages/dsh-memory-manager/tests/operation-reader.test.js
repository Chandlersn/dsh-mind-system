import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readOperationRows } from '../src/operation-reader.js';

const REQUEST = '12345678-1234-4234-8234-123456789abc';
const OTHER = '12345678-1234-4234-9234-123456789abc';
const LEDGER = '.write-ledger.jsonl';
const writeRow = (extra = {}) => ({ t: '2026-11-23T01:00:00.000Z', key: 'functions/example.md', hash: 'a123', tool: 'memory_write', request_id: REQUEST, ...extra });
const encode = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
async function fixture(t, data = '') {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'operation-reader-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^operation-reader-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  if (data !== null) await fs.writeFile(path.join(root, LEDGER), data);
  return root;
}
const query = root => readOperationRows({ root, requestId: REQUEST });
function check(result, status, reason) {
  assert.equal(result.status, status);
  if (reason) assert.equal(result.reason, reason);
  assert.equal(result.scanComplete, status === 'match' || status === 'no_matching_rows');
  assert.equal(result.execution, 'not_observed');
  assert.equal(result.adoption, 'not_observed');
  assert.equal(result.absenceMeansNoWrites, false);
  if (!result.scanComplete) assert.deepEqual(result.rows, []);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
}

test('preserves repeated targets and raw delete IDs in physical order, without content fields', async t => {
  const rows = [writeRow({ hash: 'first', content: 'SECRET' }), writeRow({ hash: 'second', bytes: 8 }),
    { key: 'functions/example.md', op: 'delete_intent', id: 'original-delete-id', tool: 'memory_delete', to: 'functions/archive.md', request_id: REQUEST },
    { key: 'functions/example.md', op: 'delete', id: 'original-delete-id', tool: 'memory_delete', to: 'functions/archive.md', request_id: REQUEST }];
  const root = await fixture(t, encode(rows));
  const result = await query(root);
  check(result, 'match');
  const { content, ...first } = rows[0];
  assert.deepEqual(result.rows, [first, ...rows.slice(1)]);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.ok(!JSON.stringify(result).includes(root));
});

test('legacy rows are valid and never correlated by target, time, or hash', async t => {
  const legacy = writeRow(); delete legacy.request_id;
  const root = await fixture(t, encode([legacy, { key: 'functions/old.md', hash: 'old' },
    { key: 'functions/old.md', op: 'delete', id: 'legacy-delete' }, writeRow({ request_id: OTHER })]));
  check(await query(root), 'no_matching_rows');
  await fs.appendFile(path.join(root, LEDGER), encode([writeRow()]));
  assert.equal((await query(root)).rows.length, 1);
});

test('empty ledger is a complete scan, not proof of no writes', async t => {
  check(await query(await fixture(t)), 'no_matching_rows');
});

test('rejects invalid input and noncanonical UUIDs without touching the filesystem', async t => {
  const root = await fixture(t, null);
  const inputs = [undefined, null, [], {}, { root, requestId: REQUEST.toUpperCase() },
    { root, requestId: REQUEST + '\n' }, { root, requestId: REQUEST.replace('-4234-', '-1234-') },
    { root, requestId: REQUEST.replace('-8234-', '-7234-') }, { root, requestId: 'x' },
    { root: '', requestId: REQUEST }, { root: 'relative', requestId: REQUEST },
    { root: root + '\0', requestId: REQUEST }, { root, requestId: 42 }];
  const spy = t.mock.method(fs, 'lstat', () => { throw new Error('Unexpected filesystem access'); });
  for (const input of inputs) check(await readOperationRows(input), 'error', 'invalid_input');
  assert.equal(spy.mock.callCount(), 0);
  spy.mock.restore();
  assert.deepEqual(await fs.readdir(root), []);
});

test('missing root or ledger creates nothing', async t => {
  const root = await fixture(t, null);
  check(await query(root), 'missing', 'ledger_missing');
  check(await query(path.join(root, 'absent')), 'missing', 'root_missing');
  assert.deepEqual(await fs.readdir(root), []);
});

test('unrelated corrupt tail invalidates earlier matches', async t => {
  const root = await fixture(t, encode([writeRow()]) + '{bad-json}\n');
  check(await query(root), 'unknown', 'malformed_row');
});

test('rejects invalid UTF-8, truncated UTF-8 and unterminated final JSON', async t => {
  const root = await fixture(t);
  for (const tail of [Buffer.from([0xc3, 0x28, 10]), Buffer.from([0xe2, 0x82, 10]),
    Buffer.from([0xe2, 0x82]), Buffer.from(JSON.stringify(writeRow()))]) {
    await fs.writeFile(path.join(root, LEDGER), Buffer.concat([Buffer.from(encode([writeRow()])), tail]));
    const result = await query(root);
    check(result, 'unknown');
    assert.ok(['malformed_row', 'truncated_line'].includes(result.reason));
  }
});

test('unknown and malformed row shapes fail closed, including unrelated rows', async t => {
  const root = await fixture(t);
  const malformed = [null, [], 1, {}, { key: 'functions/x.md' }, writeRow({ op: 'future' }),
    writeRow({ key: '/absolute/path' }), writeRow({ key: 'C:/private/file' }),
    writeRow({ key: '../escape.md' }), writeRow({ key: 'functions\\file.md' }),
    writeRow({ hash: {} }), writeRow({ bytes: -1 }), writeRow({ t: 'bad' }),
    writeRow({ tool: '/absolute/private' }), writeRow({ request_id: OTHER.toUpperCase() }),
    { key: 'functions/x.md', op: 'delete', id: '' }, { key: 'functions/x.md', op: 'delete', id: 'x', to: '../escape' }];
  for (const row of malformed) {
    await fs.writeFile(path.join(root, LEDGER), encode([writeRow(), row]));
    check(await query(root), 'unknown', 'malformed_row');
  }
});

test('byte cap refuses before opening or allocating the file body', async t => {
  const root = await fixture(t);
  await fs.truncate(path.join(root, LEDGER), 8 * 1024 * 1024 + 1);
  const spy = t.mock.method(fs, 'open', () => { throw new Error('Unexpected open'); });
  check(await query(root), 'incomplete', 'byte_limit');
  assert.equal(spy.mock.callCount(), 0);
  spy.mock.restore();
});

test('accepts exactly 8 MiB with bounded reads across chunk and UTF-8 boundaries', async t => {
  const base = JSON.stringify(writeRow({ request_id: OTHER, ignored: '' }));
  const line = base.replace('"ignored":""', '"ignored":"' + 'x'.repeat(65535 - Buffer.byteLength(base)) + '"') + '\n';
  const data = line.repeat(128);
  assert.equal(Buffer.byteLength(data), 8 * 1024 * 1024);
  const root = await fixture(t, data);
  check(await query(root), 'no_matching_rows');
  const unicode = JSON.stringify(writeRow({ key: 'functions/界.md' }));
  const prefixLength = 65535 - Buffer.byteLength(unicode.slice(0, unicode.indexOf('界')));
  const prefix = base.replace('"ignored":""', '"ignored":"' + 'x'.repeat(prefixLength - Buffer.byteLength(base) - 1) + '"') + '\n';
  assert.equal(Buffer.byteLength(prefix + unicode.slice(0, unicode.indexOf('界'))), 65535);
  await fs.writeFile(path.join(root, LEDGER), prefix + unicode + '\n');
  check(await query(root), 'match');
});

test('line cap rejects huge unrelated rows and permits the exact bound', async t => {
  const root = await fixture(t);
  const base = JSON.stringify(writeRow({ request_id: OTHER, ignored: '' }));
  const exact = base.replace('"ignored":""', '"ignored":"' + 'x'.repeat(65536 - Buffer.byteLength(base)) + '"');
  assert.equal(Buffer.byteLength(exact), 65536);
  await fs.writeFile(path.join(root, LEDGER), exact + '\n');
  check(await query(root), 'no_matching_rows');
  await fs.writeFile(path.join(root, LEDGER), exact + ' \n');
  check(await query(root), 'incomplete', 'line_limit');
});

test('row cap includes unrelated and legacy rows and accepts exactly 10000', async t => {
  const root = await fixture(t, encode(Array.from({ length: 10000 }, () => ({ key: 'functions/x.md', hash: 'a' }))));
  check(await query(root), 'no_matching_rows');
  await fs.appendFile(path.join(root, LEDGER), encode([writeRow()]));
  check(await query(root), 'incomplete', 'row_limit');
});

test('match cap accepts 256, still checks unrelated tail, and refuses 257', async t => {
  const root = await fixture(t, encode(Array.from({ length: 256 }, () => writeRow())));
  assert.equal((await query(root)).rows.length, 256);
  await fs.appendFile(path.join(root, LEDGER), 'false\n');
  check(await query(root), 'unknown', 'malformed_row');
  await fs.writeFile(path.join(root, LEDGER), encode(Array.from({ length: 257 }, () => writeRow())));
  check(await query(root), 'incomplete', 'match_limit');
});

test('response cap counts UTF-8 bytes and discards oversized metadata results', async t => {
  const row = writeRow({ key: 'functions/' + '界'.repeat(1200) + '.md' });
  const root = await fixture(t, encode(Array.from({ length: 20 }, () => row)));
  check(await query(root), 'incomplete', 'response_limit');
  await fs.writeFile(path.join(root, LEDGER), encode([writeRow({ key: 'functions/' + 'a'.repeat(4096) })]));
  check(await query(root), 'unknown', 'malformed_row');
});

test('refuses nonregular root and ledger paths', async t => {
  const root = await fixture(t);
  check(await query(path.join(root, LEDGER)), 'unknown', 'unsafe_root');
  const directoryRoot = await fixture(t, null);
  await fs.mkdir(path.join(directoryRoot, LEDGER));
  check(await query(directoryRoot), 'unknown', 'unsafe_ledger');
});

test('refuses root symlinks/junctions and ledger symlinks when supported', async t => {
  const root = await fixture(t, encode([writeRow()]));
  const parent = await fixture(t, null);
  const alias = path.join(parent, 'alias');
  await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  check(await query(alias), 'unknown', 'unsafe_root');
  check(await query(alias + path.sep), 'unknown', 'unsafe_root');
  const linkedRoot = await fixture(t, null);
  try { await fs.symlink(path.join(root, LEDGER), path.join(linkedRoot, LEDGER), 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic('File symlink unavailable; junction assertion passed'); return; }
    throw error;
  }
  check(await query(linkedRoot), 'unknown', 'unsafe_ledger');
});

test('read errors are sanitized and never expose paths or error contents', async t => {
  const root = await fixture(t);
  const spy = t.mock.method(fs, 'open', async () => { throw new Error(root + ' SECRET'); });
  const result = await query(root);
  check(result, 'error', 'read_failed');
  assert.ok(!JSON.stringify(result).includes(root));
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  spy.mock.restore();
});

test('detects cooperative mutation during read without a public injection API', async t => {
  const root = await fixture(t, encode([writeRow()]));
  const originalOpen = fs.open;
  const spy = t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const response = await originalRead(...readArgs);
      await fs.appendFile(path.join(root, LEDGER), encode([writeRow({ request_id: OTHER })]));
      return response;
    };
    return handle;
  });
  check(await query(root), 'unknown', 'identity_changed');
  spy.mock.restore();
});

test('successful and failed scans leave ledger bytes, timestamps, and neighboring files unchanged', async t => {
  const root = await fixture(t, encode([writeRow()]));
  await fs.writeFile(path.join(root, 'neighbor.txt'), 'untouched');
  for (const tail of ['', '{broken}\n']) {
    if (tail) await fs.appendFile(path.join(root, LEDGER), tail);
    const before = await fs.readFile(path.join(root, LEDGER));
    const stats = await fs.stat(path.join(root, LEDGER));
    await query(root);
    assert.deepEqual(await fs.readFile(path.join(root, LEDGER)), before);
    const after = await fs.stat(path.join(root, LEDGER));
    assert.equal(after.mtimeMs, stats.mtimeMs);
    assert.equal(after.ctimeMs, stats.ctimeMs);
    assert.equal(await fs.readFile(path.join(root, 'neighbor.txt'), 'utf8'), 'untouched');
    assert.deepEqual((await fs.readdir(root)).sort(), [LEDGER, 'neighbor.txt'].sort());
  }
});
