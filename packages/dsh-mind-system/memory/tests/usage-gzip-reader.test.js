import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { mkdir, mkdtemp, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { readUsageFile, readUsage, usageFiles, usagePath, USAGE_GZIP_MAX_COMPRESSED_BYTES } from '../src/usage.js';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-gzip-reader-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const descriptor = (file) => ({ file, month: '', encoding: 'gzip' });

test('legacy enumeration opens small and large files without reading content', async (t) => {
  const dir = await fixture(t);
  const legacy = usagePath(dir);
  await writeFile(legacy, 'row\n');
  const originalReadFile = fsPromises.readFile;
  const originalOpen = fsPromises.open;
  let opens = 0;
  fsPromises.readFile = async (file, ...args) => {
    if (file === legacy) throw new Error('enumeration must not read legacy content');
    return originalReadFile(file, ...args);
  };
  fsPromises.open = async (file, ...args) => {
    const handle = await originalOpen(file, ...args);
    if (file === legacy) {
      opens++;
      handle.read = async () => { throw new Error('enumeration must not read legacy content'); };
      handle.readFile = async () => { throw new Error('enumeration must not read legacy content'); };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await usageFiles(dir), [{ file: legacy, name: 'legacy', source: 'legacy', month: '' }]);
    await truncate(legacy, 64 * 1024 * 1024);
    assert.deepEqual(await usageFiles(dir), [{ file: legacy, name: 'legacy', source: 'legacy', month: '' }]);
    assert.equal(opens, 2);
  } finally {
    fsPromises.readFile = originalReadFile;
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test('legacy enumeration propagates access and I/O errors from open', async (t) => {
  const dir = await fixture(t);
  const legacy = usagePath(dir);
  await writeFile(legacy, 'row\n');
  const originalOpen = fsPromises.open;
  let attempts = 0;
  try {
    for (const code of ['EACCES', 'EIO']) {
      fsPromises.open = async (file, ...args) => {
        if (file === legacy) { attempts++; throw Object.assign(new Error('injected open failure'), { code }); }
        return originalOpen(file, ...args);
      };
      syncBuiltinESMExports();
      await assert.rejects(usageFiles(dir), { code });
    }
    assert.equal(attempts, 2);
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test('legacy enumeration rejects a file replaced before opening', async (t) => {
  const dir = await fixture(t);
  const legacy = usagePath(dir);
  await writeFile(legacy, 'old\n');
  const originalOpen = fsPromises.open;
  let injected = false;
  fsPromises.open = async (file, ...args) => {
    if (file === legacy && !injected) {
      injected = true;
      await fsPromises.rename(legacy, `${legacy}.old`);
      await writeFile(legacy, 'new\n');
    }
    return originalOpen(file, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(usageFiles(dir), { code: 'USAGE_SOURCE_CHANGED' });
    assert.equal(injected, true);
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test('legacy enumeration rejects a file removed before opening', async (t) => {
  const dir = await fixture(t);
  const legacy = usagePath(dir);
  await writeFile(legacy, 'old\n');
  const originalOpen = fsPromises.open;
  let injected = false;
  fsPromises.open = async (file, ...args) => {
    if (file === legacy && !injected) { injected = true; await unlink(legacy); }
    return originalOpen(file, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(usageFiles(dir), { code: 'USAGE_SOURCE_CHANGED' });
    assert.equal(injected, true);
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test('legacy enumeration rejects directories', async (t) => {
  const dir = await fixture(t);
  await mkdir(usagePath(dir));
  await assert.rejects(usageFiles(dir), { code: 'USAGE_LINK_NOT_ALLOWED' });
});

test('legacy enumeration rejects a path changed after opening', async (t) => {
  const dir = await fixture(t);
  const legacy = usagePath(dir);
  const other = path.join(dir, 'other');
  await writeFile(legacy, 'same\n');
  await writeFile(other, 'same\n');
  const originalLstat = fsPromises.lstat;
  let calls = 0;
  fsPromises.lstat = async (file, ...args) => {
    if (file === legacy && ++calls === 2) return originalLstat(other, ...args);
    return originalLstat(file, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(usageFiles(dir), { code: 'USAGE_SOURCE_CHANGED' });
    assert.equal(calls, 2);
  } finally {
    fsPromises.lstat = originalLstat;
    syncBuiltinESMExports();
  }
});

test('legacy enumeration rejects a symlink signal before opening', async (t) => {
  const dir = await fixture(t);
  const legacy = usagePath(dir);
  const originalLstat = fsPromises.lstat;
  const originalOpen = fsPromises.open;
  let opened = false;
  fsPromises.lstat = async (file, ...args) => file === legacy
    ? { isSymbolicLink: () => true, isFile: () => false }
    : originalLstat(file, ...args);
  fsPromises.open = async (file, ...args) => { if (file === legacy) opened = true; return originalOpen(file, ...args); };
  syncBuiltinESMExports();
  try {
    await assert.rejects(usageFiles(dir), { code: 'USAGE_LINK_NOT_ALLOWED' });
    assert.equal(opened, false);
  } finally {
    fsPromises.lstat = originalLstat;
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test('legacy enumeration rejects dangling links without following them', async (t) => {
  const dir = await fixture(t);
  const legacy = usagePath(dir);
  try { await symlink(path.join(dir, 'missing'), legacy, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip(`symlink unavailable: ${error.code}`); throw error; }
  const originalOpen = fsPromises.open;
  let followed = false;
  fsPromises.open = async (file, ...args) => { if (file === legacy) followed = true; return originalOpen(file, ...args); };
  syncBuiltinESMExports();
  try {
    await assert.rejects(usageFiles(dir), { code: 'USAGE_LINK_NOT_ALLOWED' });
    assert.equal(followed, false);
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test('explicit gzip read preserves UTF-8 bytes and row order', async (t) => {
  const dir = await fixture(t);
  const plain = '{"t":"2026-01-01","kind":"positive","note":"你好"}\n{"kind":"read"}\n';
  const file = path.join(dir, 'history.gz');
  await writeFile(file, gzipSync(Buffer.from(plain)));
  const output = await readUsageFile(descriptor(file));
  assert.deepEqual(Buffer.from(output), Buffer.from(plain));
  assert.deepEqual(output.split('\n'), plain.split('\n'));
});

test('plain and gzip reject invalid UTF-8 and preserve valid BOM bytes', async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, 'history');
  const invalid = Buffer.from([0x61, 0xc3, 0x28]);
  const valid = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好\n')]);
  for (const bytes of [invalid, valid]) {
    await writeFile(file, bytes);
    await writeFile(`${file}.gz`, gzipSync(bytes));
    for (const desc of [{ file }, descriptor(`${file}.gz`)]) {
      if (bytes === invalid) await assert.rejects(readUsageFile(desc), { code: 'USAGE_UTF8_INVALID' });
      else assert.deepEqual(Buffer.from(await readUsageFile(desc), 'utf8'), bytes);
    }
  }
});

test('plain data obeys the uncompressed byte limit', async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, 'history');
  await writeFile(file, 'abcdef');
  await assert.rejects(readUsageFile({ file }, { maxUncompressedBytes: 5 }), { code: 'USAGE_DECOMPRESSED_LIMIT' });
  assert.equal(await readUsageFile({ file }, { maxUncompressedBytes: 6 }), 'abcdef');
});

test('default enumeration never chooses gzip or double reads both sources', async (t) => {
  const dir = await fixture(t);
  const raw = usagePath(dir);
  const rows = `${JSON.stringify({ t: new Date().toISOString(), kind: 'read', href: 'functions/x.md' })}\n`;
  await writeFile(`${raw}.gz`, gzipSync(rows));
  assert.deepEqual(await usageFiles(dir), []);
  assert.deepEqual(await readUsage(dir), []);
  await writeFile(raw, rows);
  assert.equal((await usageFiles(dir)).length, 1);
  assert.equal((await readUsage(dir)).length, 1);
  assert.equal(await readUsageFile({ file: raw, month: '' }), rows);
});

test('bad and truncated gzip fail without falling back', async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, 'history.gz');
  for (const bytes of [Buffer.from('broken'), gzipSync('record\n').subarray(0, 8)]) {
    await writeFile(file, bytes);
    await assert.rejects(readUsageFile(descriptor(file)), { code: 'USAGE_GZIP_INVALID' });
  }
  await unlink(file);
  await assert.rejects(readUsageFile(descriptor(file)), { code: 'ENOENT' });
});

test('gzip bomb and oversized compressed source fail with explicit limits', async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, 'history.gz');
  await writeFile(file, gzipSync(Buffer.alloc(128 * 1024, 65)));
  await assert.rejects(readUsageFile(descriptor(file), { maxUncompressedBytes: 1024 }), { code: 'USAGE_DECOMPRESSED_LIMIT' });
  await truncate(file, USAGE_GZIP_MAX_COMPRESSED_BYTES + 1);
  await assert.rejects(readUsageFile(descriptor(file)), { code: 'USAGE_COMPRESSED_LIMIT' });
});

test('missing shard directory is empty but an invalid directory is an error', async (t) => {
  const dir = await fixture(t);
  assert.deepEqual(await usageFiles(dir), []);
  await writeFile(path.join(dir, '.usage'), 'not a directory');
  await assert.rejects(usageFiles(dir), { code: 'ENOTDIR' });
  await assert.rejects(readUsage(dir), { code: 'ENOTDIR' });
});

test('concurrent source growth while reading is rejected', async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, 'history.gz');
  await writeFile(file, gzipSync('record\n'));
  const original = fsPromises.open;
  let injected = false;
  fsPromises.open = async (...args) => {
    const handle = await original(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...params) => {
      const result = await read(...params);
      if (!injected) {
        injected = true;
        await fsPromises.appendFile(file, 'x');
      }
      return result;
    };
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(readUsageFile(descriptor(file)), { code: 'USAGE_SOURCE_CHANGED' });
    assert.equal(injected, true);
  } finally {
    fsPromises.open = original;
    syncBuiltinESMExports();
  }
});

test('shard enumeration permission failures do not become empty results', async (t) => {
  const dir = await fixture(t);
  const original = fsPromises.readdir;
  fsPromises.readdir = async () => { throw Object.assign(new Error('injected denial'), { code: 'EACCES' }); };
  syncBuiltinESMExports();
  try {
    await assert.rejects(usageFiles(dir), { code: 'EACCES' });
    await assert.rejects(readUsage(dir), { code: 'EACCES' });
  } finally {
    fsPromises.readdir = original;
    syncBuiltinESMExports();
  }
});

test('missing archive directory is optional but archive listing failures propagate', async (t) => {
  const dir = await fixture(t);
  await mkdir(path.join(dir, '.usage'));
  assert.deepEqual(await readUsage(dir), []);
  const archive = path.join(dir, '.usage', 'archive');
  await writeFile(archive, 'not a directory');
  await assert.rejects(readUsage(dir), { code: 'ENOTDIR' });
  await unlink(archive);
  await mkdir(archive);
  const original = fsPromises.readdir;
  fsPromises.readdir = async (p, ...args) => {
    if (p === archive) throw Object.assign(new Error('injected denial'), { code: 'EACCES' });
    return original(p, ...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(readUsage(dir), { code: 'EACCES' }); }
  finally { fsPromises.readdir = original; syncBuiltinESMExports(); }
});

test('dangling shard or archive junction is not treated as an absent directory', async (t) => {
  for (const segment of ['shard', 'archive']) {
    const dir = await fixture(t);
    const target = path.join(dir, 'target');
    const link = segment === 'shard' ? path.join(dir, '.usage') : path.join(dir, '.usage', 'archive');
    await mkdir(path.dirname(link), { recursive: true });
    await mkdir(target);
    try { await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`link unavailable: ${error.code}`); throw error; }
    await rm(target, { recursive: true });
    await assert.rejects(readUsage(dir));
  }
});

test('selected shard and archive disappearing after listing are errors', async (t) => {
  for (const segment of ['shard', 'archive']) {
    const dir = await fixture(t);
    const folder = segment === 'shard' ? path.join(dir, '.usage') : path.join(dir, '.usage', 'archive');
    await mkdir(folder, { recursive: true });
    const date = new Date();
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const file = path.join(folder, `${month}.jsonl`);
    await writeFile(file, `${JSON.stringify({ t: date.toISOString(), kind: 'read', href: 'functions/x.md' })}\n`);
    const original = fsPromises.readdir;
    let injected = false;
    fsPromises.readdir = async (p, ...args) => {
      const result = await original(p, ...args);
      if (p === folder && !injected) { injected = true; await unlink(file); }
      return result;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(readUsage(dir), { code: 'ENOENT' });
      assert.equal(injected, true);
    } finally { fsPromises.readdir = original; syncBuiltinESMExports(); }
  }
});

test('invalid paths, types and limits are errors', async (t) => {
  const dir = await fixture(t);
  await assert.rejects(readUsageFile(descriptor(dir)), { code: 'USAGE_SOURCE_CHANGED' });
  await assert.rejects(readUsageFile({ file: path.join(dir, 'missing') }), { code: 'ENOENT' });
  await assert.rejects(readUsageFile(descriptor(path.join(dir, 'missing')), { maxUncompressedBytes: 0 }), RangeError);
  await assert.rejects(readUsageFile({ file: 'x', encoding: 'unknown' }), TypeError);
});
