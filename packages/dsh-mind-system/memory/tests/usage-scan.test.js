import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanUsage } from '../src/usage.js';

const now = Date.parse('2026-11-24T12:00:00Z');
const event = (href, extra = {}) => JSON.stringify({ t: '2026-11-24T11:00:00Z', href, kind: 'read', ...extra });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-usage-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('good rows survive bad rows, BOM, bad UTF-8 and truncated tail without leaking them', async (t) => {
  const root = await fixture(t);
  const bad = 'SECRET_CONTENT_NOT_A_ROW';
  const bytes = Buffer.concat([Buffer.from(`\ufeff${event('a')}\n${bad}\n`), Buffer.from([0xff, 10]), Buffer.from(`${event('b')}\n${bad}`)]);
  await writeFile(path.join(root, '.usage.jsonl'), bytes);
  const r = await scanUsage(root, { now });
  assert.equal(r.scanStatus, 'incomplete');
  assert.equal(r.snapshot, 'unknown');
  assert.equal(r.logicalCompleteness, 'unknown');
  assert.deepEqual(r.entries.map((e) => e.href), ['a', 'b']);
  assert.equal(r.invalidRows, 3);
  assert.equal(r.invalidRowsLowerBound, true);
  assert.ok(r.reasons.includes('invalid_utf8'));
  assert.ok(r.reasons.includes('truncated_tail'));
  assert.ok(!JSON.stringify(r).includes(bad));
});

test('sources use legacy, shard and archive order and conflicting month is incomplete', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, '.usage', 'archive'), { recursive: true });
  await writeFile(path.join(root, '.usage.jsonl'), `${event('legacy')}\n`);
  await writeFile(path.join(root, '.usage', '2026-11.jsonl'), `${event('shard')}\n`);
  await writeFile(path.join(root, '.usage', 'archive', '2026-11.jsonl'), `${event('archive')}\n`);
  const r = await scanUsage(root, { now });
  assert.equal(r.scanStatus, 'incomplete');
  assert.ok(r.reasons.includes('conflicting_sources'));
  assert.deepEqual(r.entries.map((e) => e.href), ['legacy', 'shard', 'archive']);
  assert.deepEqual(r.sources.map((s) => s.name), ['.usage.jsonl', '.usage/2026-11.jsonl', '.usage/archive/2026-11.jsonl']);
});

test('empty roots, inaccessible roots and time windows report separate semantics', async (t) => {
  const root = await fixture(t);
  let r = await scanUsage(root, { now });
  assert.equal(r.scanStatus, 'complete');
  assert.equal(r.snapshot, 'unknown');
  r = await scanUsage(path.join(root, 'missing'), { now });
  assert.equal(r.scanStatus, 'unknown');
  await writeFile(path.join(root, '.usage.jsonl'), `${event('old', {t:'2026-10-01T00:00:00Z'})}\n${event('new')}\n`);
  r = await scanUsage(root, { now, days: 30 });
  assert.deepEqual(r.entries.map((e) => e.href), ['new']);
});

test('limits refuse pathological expansion, bytes, lines and file count', async (t) => {
  const root = await fixture(t);
  const legacy = path.join(root, '.usage.jsonl');
  await writeFile(legacy, `${event('huge', { n: 1000000000 })}\n`);
  let r = await scanUsage(root, { now, maxExpanded: 3 });
  assert.equal(r.scanStatus, 'unknown');
  assert.ok(r.reasons.includes('expanded_limit'));
  assert.equal(r.entries.length, 0);
  r = await scanUsage(root, { now, maxBytes: 4 });
  assert.ok(r.reasons.includes('byte_limit'));
  await writeFile(legacy, `${event('a')}\n${event('b')}\n`);
  r = await scanUsage(root, { now, maxLines: 1 });
  assert.equal(r.entries.length, 1);
  assert.ok(r.reasons.includes('line_limit'));
  await mkdir(path.join(root, '.usage'));
  await writeFile(path.join(root, '.usage', '2026-11.jsonl'), `${event('c')}\n`);
  r = await scanUsage(root, { now, maxFiles: 1 });
  assert.ok(r.reasons.includes('file_limit'));
  assert.equal(r.invalidRowsLowerBound, true);
});

test('invalid timestamps and oversized rows remain visible as incomplete', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, '.usage.jsonl'), `${event('bad', {t:'invalid'})}\n${'x'.repeat(300)}\n${event('valid')}\n`);
  const r = await scanUsage(root, { now, maxLineBytes: 128 });
  assert.equal(r.scanStatus, 'incomplete');
  assert.equal(r.invalidRows, 2);
  assert.ok(r.reasons.includes('invalid_time'));
  assert.ok(r.reasons.includes('line_too_large'));
  assert.deepEqual(r.entries.map((e) => e.href), ['valid']);
});

test('directory enumeration failure is unknown and does not leak the error', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, '.usage'));
  const original = fsPromises.opendir;
  fsPromises.opendir = async () => { throw Object.assign(new Error('SECRET_IN_ERROR'), { code: 'EACCES' }); };
  syncBuiltinESMExports();
  try {
    const r = await scanUsage(root, { now });
    assert.equal(r.scanStatus, 'unknown');
    assert.ok(r.reasons.includes('directory_unavailable'));
    assert.ok(!JSON.stringify(r).includes('SECRET_IN_ERROR'));
  } finally { fsPromises.opendir = original; syncBuiltinESMExports(); }
});

test('directory junctions to outside data are rejected', async (t) => {
  for (const which of ['shard', 'archive']) {
    const root = await fixture(t);
    const outside = await fixture(t);
    await writeFile(path.join(outside, '2026-11.jsonl'), `${event('outside_secret')}\n`);
    const link = which === 'shard' ? path.join(root, '.usage') : path.join(root, '.usage', 'archive');
    await mkdir(path.dirname(link), { recursive: true });
    try { await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) return t.skip(`junction unavailable: ${e.code}`); throw e; }
    const r = await scanUsage(root, { now });
    assert.equal(r.scanStatus, 'unknown');
    assert.ok(r.reasons.includes('directory_unavailable'));
    assert.ok(!JSON.stringify(r).includes('outside_secret'));
  }
});

test('file symlinks to outside data are rejected', async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  const target = path.join(outside, 'secret.jsonl');
  await writeFile(target, `${event('outside_secret')}\n`);
  await mkdir(path.join(root, '.usage'));
  try { await symlink(target, path.join(root, '.usage', '2026-11.jsonl'), 'file'); }
  catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) return t.skip(`file symlink unavailable: ${e.code}`); throw e; }
  const r = await scanUsage(root, { now });
  assert.equal(r.scanStatus, 'unknown');
  assert.ok(r.reasons.includes('source_unavailable'));
  assert.ok(!JSON.stringify(r).includes('outside_secret'));
});

test('a file reported as a symbolic link is rejected before open', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, '.usage'));
  const file = path.join(root, '.usage', '2026-11.jsonl');
  await writeFile(file, `${event('link_secret')}\n`);
  const original = fsPromises.lstat;
  let injected = false;
  fsPromises.lstat = async (...args) => {
    if (args[0] === file) { injected = true; return { isSymbolicLink: () => true }; }
    return original(...args);
  };
  syncBuiltinESMExports();
  try {
    const r = await scanUsage(root, { now });
    assert.equal(injected, true);
    assert.equal(r.scanStatus, 'unknown');
    assert.ok(r.reasons.includes('source_unavailable'));
    assert.ok(!JSON.stringify(r).includes('link_secret'));
  } finally { fsPromises.lstat = original; syncBuiltinESMExports(); }
});

test('unreadable file and concurrent append or truncate produce unknown', async (t) => {
  for (const mode of ['EACCES', 'append', 'truncate']) {
    const root = await fixture(t);
    const file = path.join(root, '.usage.jsonl');
    await writeFile(file, `${event('a')}\n`);
    const original = fsPromises.open;
    let injected = false;
    fsPromises.open = async (...args) => {
      if (args[0] !== file) return original(...args);
      if (mode === 'EACCES') { injected = true; throw Object.assign(new Error('denied SECRET'), { code: 'EACCES' }); }
      const handle = await original(...args);
      const read = handle.read.bind(handle);
      handle.read = async (...params) => {
        const result = await read(...params);
        if (!injected) {
          injected = true;
          if (mode === 'append') await fsPromises.appendFile(file, 'x');
          else await fsPromises.truncate(file, 0);
        }
        return result;
      };
      return handle;
    };
    syncBuiltinESMExports();
    try {
      const r = await scanUsage(root, { now });
      assert.equal(injected, true);
      assert.equal(r.scanStatus, 'unknown');
      assert.equal(r.entries.length, 0);
      assert.ok(!JSON.stringify(r).includes('SECRET'));
    } finally { fsPromises.open = original; syncBuiltinESMExports(); }
  }
});
