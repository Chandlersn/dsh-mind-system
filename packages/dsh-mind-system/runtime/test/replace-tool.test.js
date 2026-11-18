/**
 * Focused contract tests for the opt-in, host-owned `runtime_replace_json` tool.
 *
 * The tool is the write half of jsonNormalizeRepairPolicy: that policy grants no writes itself and only
 * nominates `runtime_replace_json` with an exact path/hash. These tests pin the *tool's* own guardrails
 * independently of the policy, in the order that matters: refuse a wrong hash, refuse a symlink or an
 * escape, refuse a multi-link target, and only then replace correctly while preserving the inode.
 *
 * Comments and assertions are in English per project convention; user-facing reports are not written here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { createReplaceTool } from '../src/write-tools.js';

const digest = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-replace-'));
  return { root, tool: createReplaceTool({ root }) };
};

test('the tool is named runtime_replace_json and exposes a strict schema', () => {
  const { root, tool } = fresh();
  try {
    assert.equal(tool.name, 'runtime_replace_json');
    assert.match(tool.name, /^[a-zA-Z0-9_-]+$/);
    assert.deepEqual(tool.parameters.required, ['path', 'content', 'expectedSha256']);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(tool.parameters.properties.expectedSha256.pattern, '^[a-f0-9]{64}$');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('happy path: a valid hash and repaired content replace in place and preserve the inode', async () => {
  const { root, tool } = fresh();
  try {
    const target = join(root, 'out.json');
    const original = '{ "a" : 1 }';
    writeFileSync(target, original, 'utf8');
    const before = statSync(target);
    const repaired = '{"a":1}';
    const result = await tool.execute({ path: 'out.json', content: repaired, expectedSha256: digest(original) });
    assert.equal(result.replaced, true);
    assert.equal(readFileSync(target, 'utf8'), repaired);
    assert.equal(result.bytes, Buffer.byteLength(repaired, 'utf8'));
    // Inode preserved: an in-place rewrite, not a temp rename that breaks hard links.
    assert.equal(result.inode, before.ino);
    assert.equal(statSync(target).ino, before.ino);
    assert.equal(statSync(target).nlink, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a wrong hash is denied and the original bytes are untouched', async () => {
  const { root, tool } = fresh();
  try {
    const target = join(root, 'out.json');
    writeFileSync(target, '{"a":1}', 'utf8');
    const before = statSync(target);
    await assert.rejects(
      () => tool.execute({ path: 'out.json', content: '{"a":2}', expectedSha256: digest('{"other":0}') }),
      (e) => e.code === 'hash_mismatch',
    );
    assert.equal(readFileSync(target, 'utf8'), '{"a":1}');
    assert.equal(statSync(target).ino, before.ino);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed hash is denied before any read', async () => {
  const { root, tool } = fresh();
  try {
    writeFileSync(join(root, 'out.json'), '{"a":1}', 'utf8');
    await assert.rejects(
      () => tool.execute({ path: 'out.json', content: '{}', expectedSha256: 'not-a-hash' }),
      (e) => e.code === 'invalid_hash',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a symlink target is denied', async (t) => {
  const { root, tool } = fresh();
  const elsewhere = mkdtempSync(join(tmpdir(), 'runtime-replace-elsewhere-'));
  try {
    const outside = join(elsewhere, 'real.json');
    writeFileSync(outside, '{"a":1}', 'utf8');
    const link = join(root, 'link.json');
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'file' : undefined);
    } catch (error) {
      t.skip(`cannot create a file symlink here: ${error.code}`);
      return;
    }
    await assert.rejects(
      () => tool.execute({ path: 'link.json', content: '{}', expectedSha256: digest('{"a":1}') }),
      (e) => e.code === 'target_not_regular' || e.code === 'out_of_scope',
    );
    assert.equal(readFileSync(outside, 'utf8'), '{"a":1}', 'the symlink target is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('a path escaping the workspace is denied', async () => {
  const { root, tool } = fresh();
  try {
    await assert.rejects(
      () => tool.execute({ path: '../escaped.json', content: '{}', expectedSha256: digest('{}') }),
      (e) => e.code === 'out_of_scope',
    );
    const outside = join(tmpdir(), 'runtime-replace-outside.json');
    writeFileSync(outside, '{}', 'utf8');
    try {
      await assert.rejects(
        () => tool.execute({ path: outside, content: '{}', expectedSha256: digest('{}') }),
        (e) => e.code === 'out_of_scope',
      );
    } finally {
      rmSync(outside, { force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a multi-link target (nlink > 1) is denied', async (t) => {
  const { root, tool } = fresh();
  try {
    const target = join(root, 'out.json');
    writeFileSync(target, '{"a":1}', 'utf8');
    const other = join(root, 'hardlink.json');
    try {
      // Hard links require local filesystem support; skip when the platform refuses.
      (await import('node:fs')).linkSync(target, other);
    } catch (error) {
      t.skip(`cannot create a hard link here: ${error.code}`);
      return;
    }
    await assert.rejects(
      () => tool.execute({ path: 'out.json', content: '{"a":2}', expectedSha256: digest('{"a":1}') }),
      (e) => e.code === 'target_linked',
    );
    assert.equal(readFileSync(target, 'utf8'), '{"a":1}');
    assert.equal(readFileSync(other, 'utf8'), '{"a":1}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing target is denied rather than created', async () => {
  const { root, tool } = fresh();
  try {
    await assert.rejects(
      () => tool.execute({ path: 'missing.json', content: '{}', expectedSha256: digest('') }),
      (e) => e.code === 'target_not_regular' || e.code === 'ENOENT',
    );
    assert.equal(existsSync(join(root, 'missing.json')), false, 'replacement never creates files');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid replacement JSON is denied and the original bytes survive', async () => {
  const { root, tool } = fresh();
  try {
    const target = join(root, 'out.json');
    writeFileSync(target, '{"a":1}', 'utf8');
    await assert.rejects(
      () => tool.execute({ path: 'out.json', content: 'not json', expectedSha256: digest('{"a":1}') }),
      (e) => e.code === 'invalid_content',
    );
    assert.equal(readFileSync(target, 'utf8'), '{"a":1}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
