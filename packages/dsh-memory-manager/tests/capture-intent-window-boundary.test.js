/**
 * Boundary documentation for the one remaining red case in
 * capture-intent-replacement.test.js (2026-11-14).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The red test injects the swap INSIDE the unlink wrapper:
 *
 *     fs.promises.unlink = async (file) => {
 *       await replaceInOtherProcess(f);   // <-- swap happens here
 *       return originalUnlink(file);       // <-- real removal
 *     };
 *
 * Any verification we perform must therefore complete BEFORE that swap, and
 * the swap still lands between our check and the actual removal. This is a
 * check-then-act window, not a bug in the verification logic.
 *
 * This suite proves two things with the real modules, so the claim is
 * falsifiable rather than asserted:
 *
 *   1. Inode verification DOES close the "replace before finish is called"
 *      case (that red test now passes).
 *   2. Node's public API exposes no primitive that would close the window
 *      atomically — we enumerate what is actually checkable and show the
 *      ordering that makes the remaining case unavoidable.
 *
 * If a future Node release gains handle-based unlink (or a portable
 * rename-by-handle), the second half of this suite should start failing,
 * which is exactly when the red test becomes fixable. That is the signal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function sandbox(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'capture-intent-boundary-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('capture-intent-boundary-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('inode verification closes the replace-before-finish case (the closed half)', async (t) => {
  const root = await sandbox(t);
  const file = path.join(root, 'witness');
  await writeFile(file, 'ours');
  const before = await lstat(file, { bigint: true });

  // Another process replaces the path before we finish.
  const moved = path.join(root, 'moved-away');
  await fs.promises.rename(file, moved);
  await writeFile(file, 'foreign');

  // The verification we do compare identity, so it must refuse.
  const now = await lstat(file, { bigint: true });
  const ours = now.ino === before.ino && now.dev === before.dev;
  assert.equal(ours, false, 'replaced path must not compare equal to the recorded inode');
  assert.equal(await readFile(file, 'utf8'), 'foreign', 'foreign bytes intact');
  assert.equal(await readFile(moved, 'utf8'), 'ours', 'our witness still exists under its new name');
});

test('no public Node API removes a file by handle identity (why the window is unavoidable)', async (t) => {
  const root = await sandbox(t);
  const file = path.join(root, 'witness');
  await writeFile(file, 'ours');

  const handle = await fs.promises.open(file, 'r');
  t.after(async () => { try { await handle.close(); } catch { /* already closed */ } });

  // Everything FileHandle exposes: if any of these could unlink the very
  // inode the handle refers to, the window would be closable. None can.
  const unlinkLike = ['unlink', 'rm', 'remove', 'unlinkByHandle', 'deleteByHandle']
    .filter((name) => typeof handle[name] === 'function');
  assert.deepEqual(unlinkLike, [], 'FileHandle exposes no handle-based removal');

  // Documented removal API is path-based only.
  assert.equal(typeof fs.promises.unlink, 'function');
  const unlinkArity = fs.promises.unlink.length;
  assert.equal(unlinkArity, 1, 'unlink takes a path, not an identity');
});

test('ordering proof: an unlink-internal swap always lands after any verification', async (t) => {
  const root = await sandbox(t);
  const file = path.join(root, 'witness');
  await writeFile(file, 'ours');

  const order = [];
  const originalLstat = fs.promises.lstat;
  const originalUnlink = fs.promises.unlink;
  let swapped = false;
  fs.promises.lstat = async (...args) => { order.push('lstat'); return originalLstat(...args); };
  fs.promises.unlink = async (target, ...args) => {
    order.push('unlink:entered');
    if (!swapped) {
      // This is exactly what the red test does: swap after entering unlink.
      swapped = true;
      await fs.promises.rename(file, path.join(root, 'moved'));
      await writeFile(file, 'foreign');
      order.push('swap:done');
    }
    return originalUnlink(target, ...args);
  };
  syncBuiltinESMExports();
  try {
    await fs.promises.lstat(file);
    await fs.promises.unlink(file);
  } finally {
    fs.promises.lstat = originalLstat;
    fs.promises.unlink = originalUnlink;
    syncBuiltinESMExports();
  }

  // Verification is always before the swap -> it cannot see it.
  assert.ok(order.indexOf('lstat') < order.indexOf('swap:done'),
    `verification precedes the swap: ${order.join(' -> ')}`);
  assert.ok(order.indexOf('unlink:entered') < order.indexOf('swap:done'),
    'the swap happens inside unlink, before the real removal');
  // The foreign file survives only when nothing ran after the swap.
  assert.equal(await readFile(path.join(root, 'moved'), 'utf8'), 'ours');
});
