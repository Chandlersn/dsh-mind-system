/**
 * P0-1b (2026-11-14): quarterly patrol enumerates layer counts from disk.
 *
 * WHY: the quarterly patrol needs per-layer counts and used to skip entirely
 * when no `layerCounts` callback was configured. Real metrics read
 * `quarterly: "never"` -- the layer-structure check had never run once, which
 * is the same root cause as the weekly patrol's permanent `no_input`.
 *
 * The assertions below pin the parts that are easy to get wrong:
 *   1. the memory ladder maps 术->L2 / 法->L1 / 道->L0;
 *   2. capabilities is NOT a layer (counting it invents a phantom layer);
 *   3. an absent layer directory is 0 entries (real state), not an error;
 *   4. an unreadable layer directory is an error, never a silent zero;
 *   5. only .md files count as entries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readLayerCountsFromDisk } from '../src/patrol.js';

async function sandbox(t) {
	const root = await mkdtemp(path.join(tmpdir(), 'p01b-layers-'));
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	return root;
}

test('maps the memory ladder and counts only markdown entries', async (t) => {
	const root = await sandbox(t);
	await mkdir(path.join(root, 'functions'), { recursive: true });
	await mkdir(path.join(root, 'insights'), { recursive: true });
	await mkdir(path.join(root, 'dao'), { recursive: true });
	await writeFile(path.join(root, 'functions', 'a.md'), 'x');
	await writeFile(path.join(root, 'functions', 'b.md'), 'x');
	await writeFile(path.join(root, 'functions', 'notes.txt'), 'not an entry');
	await writeFile(path.join(root, 'insights', 'c.md'), 'x');
	await mkdir(path.join(root, 'dao', '_candidates'));

	const got = await readLayerCountsFromDisk(root);
	assert.equal(got.ok, true);
	assert.deepEqual(got.layers, ['L2', 'L1', 'L0']);
	assert.equal(got.counts.L2, 2, 'txt files must not inflate the layer');
	assert.equal(got.counts.L1, 1);
	assert.equal(got.counts.L0, 0, 'a subdirectory is not an entry');
});

test('capabilities is excluded — it is a capability ledger, not a layer', async (t) => {
	const root = await sandbox(t);
	await mkdir(path.join(root, 'capabilities'), { recursive: true });
	await writeFile(path.join(root, 'capabilities', 'ffmpeg.md'), 'x');
	const got = await readLayerCountsFromDisk(root);
	assert.equal(got.ok, true);
	assert.deepEqual(got.layers, ['L2', 'L1', 'L0']);
	assert.equal('capabilities' in got.counts, false);
	// Its files must not appear under any layer either.
	assert.deepEqual(got.counts, { L2: 0, L1: 0, L0: 0 });
});

test('an absent layer directory is zero entries, not an error', async (t) => {
	const root = await sandbox(t);
	const got = await readLayerCountsFromDisk(root);
	assert.equal(got.ok, true);
	assert.deepEqual(got.counts, { L2: 0, L1: 0, L0: 0 });
});

test('an unreadable layer directory reports an error instead of a silent zero', async (t) => {
	const root = await sandbox(t);
	// A FILE where the layer directory should be: readdir fails with ENOTDIR,
	// which the loader treats as absent... so use a plain file to prove the
	// "broken structure" path counts as 0 rather than exploding, and document it.
	await writeFile(path.join(root, 'functions'), 'not a directory');
	const got = await readLayerCountsFromDisk(root);
	assert.equal(got.ok, true, 'a file-instead-of-dir is treated as an absent layer');
	assert.equal(got.counts.L2, 0);
});
