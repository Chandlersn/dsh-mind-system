import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, mkdir, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { inspectGrowthArtifact, growthQuestionId } from '../src/growth-artifact.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'growth-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace');
  await mkdir(cwd);
  return { root, cwd };
}

test('artifact hash changes with bytes and question binds both call and version', async t => {
  const { cwd } = await fixture(t);
  const file = path.join(cwd, 'result.txt');
  await writeFile(file, 'first');
  const first = await inspectGrowthArtifact(file, { cwd });
  await writeFile(file, 'second');
  const second = await inspectGrowthArtifact(file, { cwd });
  assert.notEqual(first.sha256, second.sha256);
  assert.notEqual(growthQuestionId('a', 'checkpoint', first), growthQuestionId('a', 'checkpoint', second));
  assert.notEqual(growthQuestionId('a', 'checkpoint', first), growthQuestionId('b', 'checkpoint', first));
  assert.notEqual(growthQuestionId('a', 'checkpoint', first), growthQuestionId('a', 'other-call', first));
  assert.equal(first.sha256, createHash('sha256').update('first').digest('hex'));
  assert.equal(first.bytes, 5);
});

test('outside-workspace files cannot be attached as artifacts', async t => {
  const { cwd, root } = await fixture(t);
  const file = path.join(root, 'outside.txt');
  await writeFile(file, 'outside');
  await assert.rejects(inspectGrowthArtifact(file, { cwd }), /outside_scope/);
});

test('memory root is an explicit additional read scope', async t => {
  const { cwd, root } = await fixture(t);
  const memoryRoot = path.join(root, 'memory');
  await mkdir(memoryRoot);
  const file = path.join(memoryRoot, 'MEMORY.md');
  await writeFile(file, '# memory');
  assert.equal((await inspectGrowthArtifact(file, { cwd, memoryRoot })).bytes, 8);
});

test('oversized files and directories do not become result evidence', async t => {
  const { cwd } = await fixture(t);
  const file = path.join(cwd, 'large.txt');
  await writeFile(file, Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(inspectGrowthArtifact(file, { cwd }), /size_or_type/);
  await assert.rejects(inspectGrowthArtifact(cwd, { cwd }));
});

test('empty and exactly maximum-sized files hash only actual bytes', async t => {
  const { cwd } = await fixture(t);
  const file = path.join(cwd, 'boundary.bin');
  for (const data of [Buffer.alloc(0), Buffer.alloc(4 * 1024 * 1024, 0x71)]) {
    await writeFile(file, data);
    const artifact = await inspectGrowthArtifact('boundary.bin', { cwd });
    assert.equal(artifact.bytes, data.length);
    assert.equal(artifact.sha256, createHash('sha256').update(data).digest('hex'));
  }
});

test('sibling prefixes, traversal and junction escapes are outside scope', async t => {
  const { root, cwd } = await fixture(t);
  const sibling = path.join(root, 'workspace-other');
  await mkdir(sibling);
  const outside = path.join(sibling, 'outside.txt');
  await writeFile(outside, 'outside');
  const junction = path.join(cwd, 'linked');
  await symlink(sibling, junction, process.platform === 'win32' ? 'junction' : 'dir');
  for (const target of [outside, '../workspace-other/outside.txt', path.join(junction, 'outside.txt')]) {
    await assert.rejects(inspectGrowthArtifact(target, { cwd }), /outside_scope/);
  }
});

test('additional read scope must be absolute and both roots must be directories', async t => {
  const { cwd } = await fixture(t);
  const file = path.join(cwd, 'result.txt');
  await writeFile(file, 'result');
  for (const memoryRoot of ['.', '', 1, {}]) {
    await assert.rejects(inspectGrowthArtifact(file, { cwd, memoryRoot }), /scope_invalid/);
  }
  await assert.rejects(inspectGrowthArtifact(file, { cwd, memoryRoot: file }), /scope_not_directory/);
  await assert.rejects(inspectGrowthArtifact(file, { cwd: '.' }), /workspace_unavailable/);
});

test('path replacement between checking and opening is rejected before reading', async t => {
  const { cwd } = await fixture(t);
  const file = path.join(cwd, 'result.txt');
  await writeFile(file, 'first');
  const originalOpen = fs.open;
  let read = false;
  let closed = false;
  t.mock.method(fs, 'open', async (...args) => {
    await rename(file, path.join(cwd, 'previous.txt'));
    await writeFile(file, 'other');
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    const originalClose = handle.close.bind(handle);
    handle.read = (...readArgs) => { read = true; return originalRead(...readArgs); };
    handle.close = async () => { closed = true; return originalClose(); };
    return handle;
  });
  await assert.rejects(inspectGrowthArtifact(file, { cwd }), /path_changed/);
  assert.equal(read, false);
  assert.equal(closed, true);
});

test('parent replacement by an outside junction is rejected before reading', async t => {
  const { root, cwd } = await fixture(t);
  const directory = path.join(cwd, 'nested');
  const outside = path.join(root, 'outside');
  await mkdir(directory);
  await mkdir(outside);
  const file = path.join(directory, 'result.txt');
  await writeFile(file, 'first');
  await writeFile(path.join(outside, 'result.txt'), 'other');
  const originalOpen = fs.open;
  let read = false;
  t.mock.method(fs, 'open', async (...args) => {
    await rename(directory, path.join(cwd, 'previous'));
    await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    handle.read = (...readArgs) => { read = true; return originalRead(...readArgs); };
    return handle;
  });
  await assert.rejects(inspectGrowthArtifact(file, { cwd }), /path_changed/);
  assert.equal(read, false);
});

test('same pathname with another file after reading is not current-byte evidence', async t => {
  const { cwd } = await fixture(t);
  const file = path.join(cwd, 'result.txt');
  await writeFile(file, 'first');
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    let swapped = false;
    handle.read = async (...readArgs) => {
      const result = await originalRead(...readArgs);
      if (!swapped) {
        swapped = true;
        await rename(file, path.join(cwd, 'previous.txt'));
        await writeFile(file, 'other');
      }
      return result;
    };
    return handle;
  });
  await assert.rejects(inspectGrowthArtifact(file, { cwd }), /changed/);
});

test('growth beyond the byte budget during reading is rejected', async t => {
  const { cwd } = await fixture(t);
  const file = path.join(cwd, 'result.txt');
  await writeFile(file, 'first');
  const originalOpen = fs.open;
  let bytesRead = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    let grown = false;
    handle.read = async (...readArgs) => {
      if (!grown) {
        grown = true;
        await writeFile(file, Buffer.alloc(4 * 1024 * 1024 + 100));
      }
      const result = await originalRead(...readArgs);
      bytesRead += result.bytesRead;
      return result;
    };
    return handle;
  });
  await assert.rejects(inspectGrowthArtifact(file, { cwd }), /changed_during_read/);
  assert.ok(bytesRead <= 4 * 1024 * 1024 + 1);
});

test('nanosecond metadata changes are detected even within one millisecond', async t => {
  const { cwd } = await fixture(t);
  const file = path.join(cwd, 'result.txt');
  await writeFile(file, 'first');
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    const originalStat = handle.stat.bind(handle);
    let calls = 0;
    handle.stat = async options => {
      const stat = await originalStat(options);
      if (++calls > 1) stat.ctimeNs += 1n;
      return stat;
    };
    return handle;
  });
  await assert.rejects(inspectGrowthArtifact(file, { cwd }), /changed_during_read/);
});

test('malformed question identities cannot collapse to the same JSON null tuple', async t => {
  const { cwd } = await fixture(t);
  const file = path.join(cwd, 'result.txt');
  await writeFile(file, 'first');
  const artifact = await inspectGrowthArtifact(file, { cwd });
  const composite = growthQuestionId('call_first|fc_first', 'call_second|fc_second', artifact);
  assert.match(composite, /^growth:[a-f0-9]{64}$/);
  assert.notEqual(composite, growthQuestionId('call_first', 'fc_first|call_second|fc_second', artifact));
  for (const id of [undefined, null, '', {}, 'bad id', 'bad\u0000id', 'x'.repeat(513)]) {
    assert.throws(() => growthQuestionId(id, 'call', artifact), /identity_invalid/);
    assert.throws(() => growthQuestionId('cycle', id, artifact), /identity_invalid/);
  }
  for (const patch of [{ sha256: undefined }, { sha256: 'x'.repeat(64) }, { bytes: -1 }, { bytes: 0.5 }, { bytes: 4 * 1024 * 1024 + 1 }, { path: 'relative.txt' }]) {
    assert.throws(() => growthQuestionId('cycle', 'call', { ...artifact, ...patch }), /identity_invalid/);
  }
});
