/** Isolated tests for the dispatch-sample rotation primitive. No real data. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
	mkdtempSync,
	rmSync,
	readFileSync,
	writeFileSync,
	existsSync,
	mkdirSync,
	symlinkSync,
	readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { rotateDispatchSamples } from '../src/rotation.js';
import { sampleFilePath, readTrend, readTrendSync } from '../src/sampling.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** @returns {string} Fresh isolated data root. */
function sandbox() {
	return mkdtempSync(join(tmpdir(), 'mind-rotation-'));
}

/**
 * @param {number} at Epoch milliseconds.
 * @param {string} tag Stable payload tag.
 * @returns {string} One JSONL line, same shape as recordSample emits.
 */
function row(at, tag) {
	return `${JSON.stringify({
		t: new Date(at).toISOString(),
		situation: 'diagnose',
		unknown: false,
		hits: [tag],
	})}\n`;
}

/**
 * @param {string} home Data root.
 * @param {string[]} lines JSONL lines.
 */
function seed(home, lines) {
	const path = sampleFilePath(home);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, lines.join(''), 'utf8');
	return path;
}

/**
 * @param {string} dir Directory to scan recursively.
 * @returns {string[]} Absolute paths of every regular file below `dir`.
 */
function allFiles(dir) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...allFiles(full));
		else out.push(full);
	}
	return out;
}

/**
 * @param {string} home Data root.
 * @returns {string[]} Contents of every `.dropped` quarantine file.
 */
function droppedBodies(home) {
	const stage = join(dirname(sampleFilePath(home)), '.stage', 'samples');
	return allFiles(stage)
		.filter((p) => p.endsWith('.dropped'))
		.map((p) => readFileSync(p, 'utf8'));
}

test('happy path: old rows leave the live file and survive in the dropped archive', async () => {
	const home = sandbox();
	try {
		const now = Date.now();
		const freshA = row(now, 'now');
		const freshB = row(now - 10 * 60 * 1000, 'ten-min');
		const old = row(now - 31 * DAY_MS, 'old-31d');
		const path = seed(home, [freshA, freshB, old]);

		const result = await rotateDispatchSamples({ dshHome: home, now, days: 30 });
		assert.equal(result.status, 'rotated');
		assert.equal(result.kept, 2);
		assert.equal(result.droppedRows, 1);
		assert.equal(result.merged, 0);

		const live = readFileSync(path, 'utf8');
		// Rotation sorts rows by `t` for deterministic merging.
		assert.equal(live, `${freshB}${freshA}`);
		assert.ok(!live.includes('old-31d'), 'dropped bytes must be absent from the live ledger');
		assert.ok(!existsSync(result.staged), 'successful rotation archives staging, it does not leave a .moved file');

		const bodies = droppedBodies(home);
		assert.equal(bodies.length, 1);
		assert.ok(bodies[0].includes('old-31d'), 'no byte is destroyed; the old row is quarantined');
		assert.ok(bodies[0].includes('now') && bodies[0].includes('ten-min'), 'archive keeps all original bytes');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('already_current: no writes, no new files, source byte-identical', async () => {
	const home = sandbox();
	try {
		const now = Date.now();
		const lines = [row(now, 'a'), row(now - 1000, 'b')];
		const path = seed(home, lines);
		const before = readFileSync(path);
		const filesBefore = allFiles(home).sort();

		const result = await rotateDispatchSamples({ dshHome: home, now, days: 30 });
		assert.equal(result.status, 'already_current');
		assert.deepEqual(readFileSync(path), before);
		assert.deepEqual(allFiles(home).sort(), filesBefore, 'no staging directory or archive may be created');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('bad row: read_failed, source byte-identical, no staging created', async () => {
	const home = sandbox();
	try {
		const now = Date.now();
		const lines = [row(now, 'good'), 'not-json\n', row(now - 31 * DAY_MS, 'old')];
		const path = seed(home, lines);
		const before = readFileSync(path);

		const result = await rotateDispatchSamples({ dshHome: home, now, days: 30 });
		assert.equal(result.status, 'read_failed');
		assert.equal(result.reason, 'invalid_json');
		assert.deepEqual(readFileSync(path), before);
		assert.equal(allFiles(home).length, 1, 'no staging file or archive may appear');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('symlink and directory sources are refused and left untouched', async () => {
	const home = sandbox();
	try {
		const now = Date.now();
		const target = seed(home, [row(now, 'target'), row(now - 31 * DAY_MS, 'old')]);
		const before = readFileSync(target);

		const linkHome = join(home, 'link-home');
		mkdirSync(join(linkHome, 'storages'), { recursive: true });
		const link = join(linkHome, 'storages', 'mind-dispatch-samples.jsonl');
		// Windows without developer mode cannot create a file symlink; a
		// directory junction is a reparse point that lstat also reports as a
		// symbolic link, so it exercises the same refusal branch.
		symlinkSync(dirname(target), link, 'junction');
		const linked = await rotateDispatchSamples({ dshHome: linkHome, now, days: 30 });
		assert.equal(linked.status, 'read_failed');
		assert.equal(linked.reason, 'source_is_symlink');

		const dirHome = join(home, 'dir-home');
		mkdirSync(join(dirHome, 'storages', 'mind-dispatch-samples.jsonl'), { recursive: true });
		const asDir = await rotateDispatchSamples({ dshHome: dirHome, now, days: 30 });
		assert.equal(asDir.status, 'read_failed');
		assert.equal(asDir.reason, 'source_not_regular_file');

		assert.deepEqual(readFileSync(target), before, 'original source is untouched');
		assert.equal(allFiles(join(home, 'link-home', 'storages', '.stage')).length, 0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

/**
 * Spawn a child that appends a payload through a real file handle.
 * `order=pre`: open the handle BEFORE the rename, wait for the `go` flag, then
 * write through the (now staged) inode.
 * `order=post`: wait until the canonical path disappears, open it (creating a
 * fresh file), then write through that handle.
 *
 * @param {string} home Data root.
 * @param {string} order 'pre' or 'post'.
 * @param {string} payload JSONL line to append.
 * @param {string} readyFile Flag file the child touches when its handle is open.
 * @param {string} goFile Flag file the parent writes to release the child.
 * @returns {Promise<number>} Child exit code.
 */
function spawnAppender(home, order, payload, readyFile, goFile) {
	const script = `
const fs = require('node:fs');
const [home, order, payload, ready, go] = process.argv.slice(1);
const path = require('node:path').join(home, 'storages', 'mind-dispatch-samples.jsonl');
const wait = (f) => new Promise((res) => { const t = setInterval(() => { if (fs.existsSync(f)) { clearInterval(t); res(); } }, 5); });
(async () => {
  if (order === 'pre') {
    const fd = fs.openSync(path, 'a');
    fs.writeFileSync(ready, 'ready');
    await wait(go);
    fs.writeSync(fd, payload, null, 'utf8');
    fs.closeSync(fd);
  } else {
    fs.writeFileSync(ready, 'ready');
    await wait(go);
    const fd = fs.openSync(path, 'a');
    fs.writeSync(fd, payload, null, 'utf8');
    fs.closeSync(fd);
  }
})().catch((e) => { console.error(e); process.exit(1); });
`;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['-e', script, home, order, payload, readyFile, goFile], {
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		let stderr = '';
		child.stderr.on('data', (buf) => { stderr += String(buf); });
		child.on('error', reject);
		child.on('exit', (code) => {
			if (code !== 0) reject(new Error(`appender exit ${code}: ${stderr}`));
			else resolve(code);
		});
	});
}

/**
 * @param {string} file Flag file path.
 */
function waitFor(file) {
	const deadline = Date.now() + 5000;
	while (!existsSync(file)) {
		if (Date.now() > deadline) throw new Error(`timeout waiting for ${file}`);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
	}
}

for (const order of ['pre', 'post']) {
	for (let iteration = 0; iteration < 6; iteration += 1) {
		test(`concurrent append ${order} #${iteration + 1}: payload is never lost`, async () => {
			const home = sandbox();
			const readyFile = join(home, 'ready.flag');
			const goFile = join(home, 'go.flag');
			try {
				const now = Date.now();
				// The payload timestamp chooses where the bytes must survive:
				// 'pre' writes into the staged inode (old row -> dropped archive),
				// 'post' writes into a fresh canonical file (fresh row -> merged).
				const payloadAt = order === 'pre' ? now - 40 * DAY_MS : now - 1000;
				const payload = row(payloadAt, `payload-${order}-${iteration}`);
				const path = seed(home, [row(now, 'now'), row(now - 35 * DAY_MS, 'old')]);

				let child;
				if (order === 'pre') {
					child = spawnAppender(home, order, payload, readyFile, goFile);
					waitFor(readyFile); // child's handle is open on the live inode
				}

				const rotating = rotateDispatchSamples({ dshHome: home, now, days: 30 });
				if (order === 'post') {
					child = spawnAppender(home, order, payload, readyFile, goFile);
					waitFor(readyFile);
				}
				// Release the child once the rename has happened (or is imminent).
				const deadline = Date.now() + 2000;
				while (existsSync(path) && Date.now() < deadline) {
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
				}
				writeFileSync(goFile, 'go');
				const result = await rotating;
				await child;

				assert.equal(result.status, 'rotated', JSON.stringify(result));
				const live = readFileSync(path, 'utf8');
				const archived = droppedBodies(home).join('');
				const where = live.includes(payload) ? 'canonical' : archived.includes(payload) ? 'dropped' : 'LOST';
				assert.notEqual(where, 'LOST', `payload must survive (${order} #${iteration + 1})`);
				if (order === 'post') {
					assert.equal(where, 'canonical', 'a post-rename append must be merged into the live ledger');
				}
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
}

test('reader-invisibility: trend output is byte-identical before and after rotation', async () => {
	const home = sandbox();
	try {
		const now = Date.now();
		seed(home, [
			row(now, 'now'),
			row(now - 10 * 60 * 1000, 'ten-min'),
			row(now - 31 * DAY_MS, 'old'),
			row(now - 45 * DAY_MS, 'older'),
		]);
		const beforeAsync = JSON.stringify(await readTrend(home));
		const beforeSync = JSON.stringify(readTrendSync(home));

		const result = await rotateDispatchSamples({ dshHome: home, now, days: 30 });
		assert.equal(result.status, 'rotated');

		assert.equal(JSON.stringify(await readTrend(home)), beforeAsync);
		assert.equal(JSON.stringify(readTrendSync(home)), beforeSync);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('invalid inputs return invalid_input without touching disk', async () => {
	const bad = [
		undefined,
		{ dshHome: '' },
		{ dshHome: 42 },
		{ dshHome: '/tmp/x', days: 0 },
		{ dshHome: '/tmp/x', days: -1 },
		{ dshHome: '/tmp/x', now: NaN },
	];
	for (const options of bad) {
		// eslint-disable-next-line no-await-in-loop
		const result = await rotateDispatchSamples(options);
		assert.equal(result.status, 'invalid_input', JSON.stringify(options));
	}
});
