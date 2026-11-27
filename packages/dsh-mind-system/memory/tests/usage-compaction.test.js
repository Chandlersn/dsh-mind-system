// Rename-first compaction of closed monthly usage shards: a SAFE opt-in
// primitive, NOT production cleanup. Every test uses an isolated mkdtemp root;
// no real ~/.dsh data, no build step. The concurrency tests spawn real child
// processes with flag-file handshakes, so the race is cross-process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, access,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	compactUsage, readUsage, scanUsage, usageShardDir, usageArchiveDir,
	usageArchivePath, usageFiles,
} from '../src/usage.js';
import { traceObject } from '../src/object-trace.js';
import { readAdoptionEvidence } from '../src/adoption-evidence.js';

const DAY = 24 * 60 * 60 * 1000;
const prefix = 'usage-compaction-';
const exists = async (file) => {
	try { await access(file); return true; } catch (error) {
		if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
		throw error;
	}
};

async function fixture(t, label = prefix) {
	const root = await mkdtemp(path.join(tmpdir(), label));
	t.after(async () => {
		assert.equal(path.dirname(root), path.resolve(tmpdir()));
		assert.ok(path.basename(root).startsWith(label));
		await rm(root, { recursive: true, force: true });
	});
	return root;
}

/** A UTC month that is strictly older than a `days` window ending at `now`. */
function closedMonth(now, days) {
	const cutoff = new Date(now - days * DAY);
	cutoff.setUTCDate(1);
	// Go one more month back so the whole month is strictly before the cutoff.
	cutoff.setUTCMonth(cutoff.getUTCMonth() - 1);
	return `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}`;
}

function row(t, kind, extra = {}) {
	return JSON.stringify({ t, kind, href: 'functions/example.md', ...extra });
}

/** Deterministic byte snapshot of every file under a root. */
async function snapshot(root) {
	const out = new Map();
	async function walk(dir) {
		for (const e of await readdir(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) await walk(p);
			else if (e.isFile()) out.set(path.relative(root, p).replace(/\\/g, '/'), await readFile(p));
		}
	}
	if (await exists(root)) await walk(root);
	return out;
}

function assertSameSnapshot(before, after, message) {
	assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `${message}: file set changed`);
	for (const key of before.keys()) {
		assert.deepEqual(after.get(key), before.get(key), `${message}: ${key} changed`);
	}
}

test('disabled by default: an old candidate month is listed but NOTHING is written', async (t) => {
	const root = await fixture(t);
	const now = Date.UTC(2026, 10, 24);
	const month = closedMonth(now, 30);
	const shard = path.join(usageShardDir(root), `${month}.jsonl`);
	await mkdir(usageShardDir(root), { recursive: true });
	await writeFile(shard, `${row(`${month}-15T01:00:00.000Z`, 'recall')}\n`, 'utf8');
	const before = await snapshot(root);

	const result = await compactUsage(root, { olderThanDays: 30, now });
	assert.equal(result.disabled, true);
	assert.equal(result.reason, 'unsafe-concurrent-source-and-incomplete-archive-readers');
	assert.deepEqual(result.skipped, [month]);
	assert.deepEqual(result.compacted, []);
	assertSameSnapshot(before, await snapshot(root), 'disabled path must be byte-identical');
	assert.equal(await exists(usageArchivePath(root, month)), false);
});

test('happy path: 60-day-old closed month compacts; downsample + verbatim rows; equivalence', async (t) => {
	const root = await fixture(t);
	const now = Date.UTC(2026, 10, 24);
	const month = closedMonth(now, 60);
	await mkdir(usageShardDir(root), { recursive: true });
	const monthDay = `${month}-15`;
	const lines = [
		row(`${monthDay}T01:00:00.000Z`, 'recall'),
		row(`${monthDay}T02:30:00.000Z`, 'recall'),
		row(`${monthDay}T03:00:00.000Z`, 'recall', { href: 'insights/other.md' }),
		row(`${monthDay}T04:00:00.000Z`, 'read', { note: 'opened it' }),
		row(`${monthDay}T05:00:00.000Z`, 'correction', { note: 'was wrong' }),
		row(`${monthDay}T06:00:00.000Z`, 'positive', { note: 'confirmed' }),
	];
	const source = path.join(usageShardDir(root), `${month}.jsonl`);
	const originalBytes = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
	await writeFile(source, originalBytes);

	const beforeUsage = await readUsage(root, 120);
	const beforeScan = await scanUsage(root, { days: 120, now });
	const result = await compactUsage(root, { enabled: true, olderThanDays: 30, now });
	assert.equal(result.disabled, false);
	assert.equal(result.compacted.length, 1, JSON.stringify(result));
	assert.equal(result.manualReconcile.length, 0, JSON.stringify(result));
	assert.equal(result.compacted[0].rawRows, 6);
	// recall a.md (2 folded to 1) + recall other.md (1) + read + correction + positive = 5 kept.
	assert.equal(result.compacted[0].keptRows, 5);

	const archive = await readFile(usageArchivePath(root, month), 'utf8');
	const archivedRows = archive.trim().split('\n').map((l) => JSON.parse(l));
	const downsampled = archivedRows.filter((r) => r.kind === 'recall');
	assert.equal(downsampled.length, 2, 'recall rows folded per (href, day)');
	assert.deepEqual(downsampled.map((r) => r.n).sort(), [1, 2]);
	// The representative (earliest) timestamp is preserved verbatim so readers
	// that report exact `t` (traceObject) stay unchanged.
	const aRecalls = downsampled.filter((r) => r.href === 'functions/example.md');
	assert.equal(aRecalls.length, 1);
	assert.equal(aRecalls[0].n, 2);
	assert.equal(aRecalls[0].t, `${monthDay}T01:00:00.000Z`, 'earliest representative timestamp is preserved');
	// Judgment rows are byte-identical.
	for (const kind of ['read', 'correction', 'positive']) {
		const original = lines.find((l) => JSON.parse(l).kind === kind);
		assert.ok(archive.includes(original), `${kind} row must be byte-identical in the archive`);
	}
	// Original bytes preserved at .dropped; source and .moved are gone.
	const dropped = result.compacted[0].droppedArchive;
	assert.equal(await exists(dropped), true);
	assert.deepEqual(await readFile(dropped), originalBytes);
	assert.equal(await exists(source), false, 'live source is gone after compaction');
	assert.equal(await exists(result.compacted[0].staged), false, '.moved staging is gone');
	const stageNames = await readdir(path.join(root, '.usage', '.stage'));
	assert.deepEqual(stageNames.filter((n) => n.endsWith('.moved')), []);
	assert.ok(stageNames.some((n) => n.endsWith('.dropped')));

	// readUsage / scanUsage produce the SAME derived counts (not raw recall rows).
	const afterUsage = await readUsage(root, 120);
	const afterScan = await scanUsage(root, { days: 120, now });
	assert.deepEqual(countByHrefKind(beforeUsage), countByHrefKind(afterUsage));
	assert.equal(afterScan.entries.length, beforeScan.entries.length);
	assert.deepEqual(countByHrefKind(afterScan.entries.map((e) => ({ ...e, ms: Date.parse(e.t) }))),
		countByHrefKind(beforeScan.entries.map((e) => ({ ...e, ms: Date.parse(e.t) }))));
	assert.ok(!afterUsage.some((e) => e.n > 1 && e.kind !== 'recall'), 'only recall rows may carry n');
});

function countByHrefKind(entries) {
	const out = new Map();
	for (const e of entries) {
		const key = `${e.href ?? ''}\u0000${e.kind ?? ''}`;
		out.set(key, (out.get(key) ?? 0) + 1);
	}
	return [...out.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

test('never touches the current/live shard', async (t) => {
	const root = await fixture(t);
	const now = Date.UTC(2026, 10, 24);
	const oldMonth = closedMonth(now, 30);
	const currentMonth = '2026-11';
	await mkdir(usageShardDir(root), { recursive: true });
	const old = path.join(usageShardDir(root), `${oldMonth}.jsonl`);
	const live = path.join(usageShardDir(root), `${currentMonth}.jsonl`);
	const liveBytes = Buffer.from(`${row('2026-11-24T01:00:00.000Z', 'recall')}\n`, 'utf8');
	await writeFile(old, `${row(`${oldMonth}-15T01:00:00.000Z`, 'recall')}\n`);
	await writeFile(live, liveBytes);
	const result = await compactUsage(root, { enabled: true, olderThanDays: 30, now });
	assert.equal(result.compacted.length, 1, JSON.stringify(result));
	assert.deepEqual(await readFile(live), liveBytes, 'current shard must be byte-identical');
});

test('qualification: cutoff month and current UTC month are never compacted', async (t) => {
	const root = await fixture(t);
	// now = 2026-11-24, 30-day cutoff = 2026-10-25 => cutoffMonth = 2026-10.
	const now = Date.UTC(2026, 10, 24);
	const cutoffMonth = '2026-10';
	const currentMonth = '2026-11';
	const oldMonth = '2026-09';
	await mkdir(usageShardDir(root), { recursive: true });
	for (const m of [cutoffMonth, currentMonth, oldMonth]) {
		await writeFile(path.join(usageShardDir(root), `${m}.jsonl`), `${row(`${m}-15T01:00:00.000Z`, 'recall')}\n`);
	}
	const result = await compactUsage(root, { enabled: true, olderThanDays: 30, now });
	assert.deepEqual(result.compacted.map((c) => c.month), [oldMonth], JSON.stringify(result));
	assert.ok(result.skipped.some((s) => s.month === cutoffMonth && s.reason === 'outside_window'));
	assert.ok(result.skipped.some((s) => s.month === currentMonth && s.reason === 'outside_window'));
});

test('same-month duplicate (live + archive) is skipped with no writes', async (t) => {
	const root = await fixture(t);
	const now = Date.UTC(2026, 10, 24);
	const month = closedMonth(now, 30);
	await mkdir(usageArchiveDir(root), { recursive: true });
	const live = path.join(usageShardDir(root), `${month}.jsonl`);
	const archive = usageArchivePath(root, month);
	await writeFile(live, `${row(`${month}-15T01:00:00.000Z`, 'recall')}\n`);
	await writeFile(archive, `${row(`${month}-15T02:00:00.000Z`, 'recall')}\n`);
	const before = await snapshot(root);
	const result = await compactUsage(root, { enabled: true, olderThanDays: 30, now });
	assert.equal(result.compacted.length, 0, JSON.stringify(result));
	assert.ok(result.skipped.some((s) => s.month === month && s.reason === 'archive_exists'), JSON.stringify(result));
	assertSameSnapshot(before, await snapshot(root), 'duplicate month must not change bytes');
});

test('bad line, truncated tail, bad UTF-8 and symlink source are all skipped', async (t) => {
	const root = await fixture(t);
	const now = Date.UTC(2026, 10, 24);
	const month = closedMonth(now, 30);
	await mkdir(usageShardDir(root), { recursive: true });
	const shard = path.join(usageShardDir(root), `${month}.jsonl`);
	const cases = [
		['bad-json', Buffer.from('{not json}\n')],
		['truncated', Buffer.from(`${row(`${month}-15T01:00:00.000Z`, 'recall')}`)], // no final newline is OK for compactParseAll; use a truncated UTF-8 tail instead
		['bad-utf8', Buffer.concat([Buffer.from(`${row(`${month}-15T01:00:00.000Z`, 'recall')}\n`), Buffer.from([0xff, 0xfe, 0xfd])])],
	];
	// A genuinely truncated line: valid JSON is cut mid-object.
	cases[1][1] = Buffer.from(`${row(`${month}-15T01:00:00.000Z`, 'recall').slice(0, 20)}`);
	for (const [label, bytes] of cases) {
		await writeFile(shard, bytes);
		const before = await snapshot(root);
		const result = await compactUsage(root, { enabled: true, olderThanDays: 30, now });
		assert.equal(result.compacted.length, 0, `${label}: must skip`);
		assert.ok(result.skipped.some((s) => s.month === month), `${label}: structured skip: ${JSON.stringify(result)}`);
		assertSameSnapshot(before, await snapshot(root), `${label}: source must stay byte-identical`);
		assert.equal(await exists(usageArchivePath(root, month)), false, `${label}: no archive created`);
	}
	// symlink source: skipped, link itself untouched.
	await rm(shard, { force: true });
	const target = path.join(root, 'target.jsonl');
	await writeFile(target, `${row(`${month}-15T01:00:00.000Z`, 'recall')}\n`);
	try {
		await symlink(target, shard);
	} catch (error) {
		if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`file symlink unavailable: ${error.code}`);
		throw error;
	}
	const result = await compactUsage(root, { enabled: true, olderThanDays: 30, now });
	assert.equal(result.compacted.length, 0, JSON.stringify(result));
	assert.ok(result.skipped.some((s) => s.month === month && s.reason === 'symlink'), JSON.stringify(result));
	assert.equal(await exists(usageArchivePath(root, month)), false);
});

test('a directory at the shard path is skipped as not a regular file', async (t) => {
	const root = await fixture(t);
	const now = Date.UTC(2026, 10, 24);
	const month = closedMonth(now, 30);
	const shard = path.join(usageShardDir(root), `${month}.jsonl`);
	await mkdir(shard, { recursive: true });
	const result = await compactUsage(root, { enabled: true, olderThanDays: 30, now });
	assert.equal(result.compacted.length, 0, JSON.stringify(result));
	assert.ok(result.skipped.some((s) => s.month === month && s.reason === 'not_regular_file'), JSON.stringify(result));
	assert.equal(await exists(usageArchivePath(root, month)), false);
});

// ---------------------------------------------------------------------------
// Reader equivalence: every production reader sees the same results for an
// object whose only usage rows live in the compacted month.
// ---------------------------------------------------------------------------

test('reader equivalence: readUsage, scanUsage, traceObject, readAdoptionEvidence', async (t) => {
	const root = await fixture(t);
	const now = Date.UTC(2026, 10, 24);
	const month = closedMonth(now, 30);
	const key = 'functions/example.md';
	await mkdir(usageShardDir(root), { recursive: true });
	const lines = [
		row(`${month}-10T01:00:00.000Z`, 'recall', { objectKey: key }),
		row(`${month}-10T02:00:00.000Z`, 'read', { objectKey: key }),
		row(`${month}-10T03:00:00.000Z`, 'positive', { objectKey: key, note: 'declared useful' }),
		row(`${month}-10T04:00:00.000Z`, 'correction', { objectKey: key, note: 'wrong detail' }),
	];
	await writeFile(path.join(usageShardDir(root), `${month}.jsonl`), `${lines.join('\n')}\n`);

	const before = {
		usage: await readUsage(root, 120),
		scan: await scanUsage(root, { days: 120, now }),
		trace: await traceObject({ root, objectKey: key }),
		adopt: await readAdoptionEvidence({ root, objectKey: key }),
	};
	const result = await compactUsage(root, { enabled: true, olderThanDays: 30, now });
	assert.equal(result.compacted.length, 1, JSON.stringify(result));
	const after = {
		usage: await readUsage(root, 120),
		scan: await scanUsage(root, { days: 120, now }),
		trace: await traceObject({ root, objectKey: key }),
		adopt: await readAdoptionEvidence({ root, objectKey: key }),
	};
	assert.deepEqual(countByHrefKind(before.usage), countByHrefKind(after.usage));
	assert.equal(before.scan.entries.length, after.scan.entries.length);
	assert.deepEqual(before.trace, after.trace, 'object trace must be unchanged');
	assert.deepEqual(before.adopt, after.adopt, 'adoption evidence must be unchanged');
	// usageFiles enumerates the archive with an explicit source field.
	const files = await usageFiles(root);
	assert.ok(files.some((f) => f.source === 'archive' && f.month === month));
});

// ---------------------------------------------------------------------------
// Cross-process concurrency: two orders, six iterations each.
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[1], source = process.argv[2], payload = process.argv[3], mode = process.argv[4];
fs.writeFileSync(path.join(dir, 'ready'), '');
const until = Date.now() + 15000;
while (Date.now() < until) { if (fs.existsSync(path.join(dir, 'go'))) break; }
let fd = null;
if (mode === 'pre') {
  try { fd = fs.openSync(source, 'a'); } catch (e) { fs.writeFileSync(path.join(dir, 'open-error'), String(e.code)); }
}
try {
  if (fd === null) fs.appendFileSync(source, payload);
  else fs.writeSync(fd, Buffer.from(payload));
  if (fd !== null) fs.closeSync(fd);
  fs.writeFileSync(path.join(dir, 'done'), mode);
} catch (e) { fs.writeFileSync(path.join(dir, 'error'), String(e && e.code)); }
`;

function spawnAppender(control, source, payload, mode) {
	const child = spawn(process.execPath, ['-e', CHILD_SCRIPT, control, source, payload, mode], {
		stdio: 'ignore', windowsHide: true,
	});
	const done = new Promise((resolve) => {
		child.once('error', (error) => resolve({ code: null, error: String(error) }));
		child.once('exit', (code, signal) => resolve({ code, signal }));
	});
	const waitFor = async (name, ms) => {
		const until = Date.now() + ms;
		while (Date.now() < until) {
			if (await exists(path.join(control, name))) return true;
			await new Promise((r) => setTimeout(r, 5));
		}
		return false;
	};
	return { child, done, waitFor };
}

for (const mode of ['pre', 'post']) {
	test(`concurrent append (${mode === 'pre' ? 'pre-rename handle' : 'post-rename fresh shard'}) never loses payload, 6 iterations`, { timeout: 180000 }, async (t) => {
		const ITERATIONS = 6;
		const root = await fixture(t, `usage-race-${mode}-`);
		const control = await mkdtemp(path.join(tmpdir(), 'usage-race-ctl-'));
		t.after(async () => { await rm(control, { recursive: true, force: true }); });
		const now = Date.UTC(2026, 10, 24);
		const month = closedMonth(now, 30);
		const shardDir = usageShardDir(root);
		await mkdir(shardDir, { recursive: true });
		let survived = 0;

		for (let i = 0; i < ITERATIONS; i++) {
			const source = path.join(shardDir, `${month}.jsonl`);
			const payload = row(`${month}-20T12:00:00.000Z`, 'read', { note: `RACE-${mode}-${i}` });
			await rm(usageArchiveDir(root), { recursive: true, force: true });
			await rm(path.join(root, '.usage', '.stage'), { recursive: true, force: true });
			await rm(source, { force: true });
			for (const flag of ['ready', 'go', 'done', 'error', 'open-error']) {
				await rm(path.join(control, flag), { force: true });
			}
			await writeFile(source, `${row(`${month}-15T01:00:00.000Z`, 'recall')}\n`);

			const appender = spawnAppender(control, source, `${payload}\n`, mode);
			assert.equal(await appender.waitFor('ready', 15000), true, 'child never became ready');
			// Releasing immediately around the rename makes both orders occur;
			// each element is time-bounded so a lost race cannot hang the suite.
			await new Promise((r) => setTimeout(r, i % 2 === 0 ? 0 : 2));
			await writeFile(path.join(control, 'go'), 'go');
			await compactUsage(root, { enabled: true, olderThanDays: 30, now });
			const outcome = await appender.done;
			assert.equal(outcome.code, 0, `iteration ${i}: child failed ${JSON.stringify(outcome)}`);

			// The payload must exist in the archive, in staging, or in a fresh
			// live shard — never lost.
			let haystack = '';
			const archive = usageArchivePath(root, month);
			if (await exists(archive)) haystack += await readFile(archive, 'utf8');
			const stageDir = path.join(root, '.usage', '.stage');
			if (await exists(stageDir)) {
				for (const name of await readdir(stageDir)) {
					haystack += await readFile(path.join(stageDir, name), 'utf8');
				}
			}
			if (await exists(source)) haystack += await readFile(source, 'utf8');
			if (haystack.includes(`RACE-${mode}-${i}`)) survived += 1;
			assert.ok(haystack.includes(`RACE-${mode}-${i}`),
				`iteration ${i}: payload lost. status haystack=${JSON.stringify(haystack)}`);
			assert.ok(haystack.includes(`${month}-15T01:00:00.000Z`), `iteration ${i}: original row lost`);
		}
		assert.equal(survived, ITERATIONS, 'every appended payload must survive');
	});
}

// ---------------------------------------------------------------------------
// The deterministic dangerous order: child opens its handle on the real
// source, the parent MOVES the source, and only then does the child write.
// Its bytes must land in the staged inode and reach the .dropped archive.
// ---------------------------------------------------------------------------

const HANDLE_CHILD = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[1], source = process.argv[2], payload = process.argv[3];
const fd = fs.openSync(source, 'a');
fs.writeFileSync(path.join(dir, 'opened'), '');
const until = Date.now() + 15000;
while (Date.now() < until) { if (fs.existsSync(path.join(dir, 'go'))) break; }
try { fs.writeSync(fd, Buffer.from(payload)); fs.closeSync(fd); fs.writeFileSync(path.join(dir, 'written'), 'ok'); }
catch (e) { fs.writeFileSync(path.join(dir, 'write-error'), String(e && e.code)); }
`;

test('a handle opened before the rename writes into the staged inode (the case read+unlink would lose)', { timeout: 60000 }, async (t) => {
	const root = await fixture(t, 'usage-handle-pre-');
	const control = await mkdtemp(path.join(tmpdir(), 'usage-handle-ctl-'));
	t.after(async () => { await rm(control, { recursive: true, force: true }); });
	const now = Date.UTC(2026, 10, 24);
	const month = closedMonth(now, 30);
	const shardDir = usageShardDir(root);
	await mkdir(shardDir, { recursive: true });
	const source = path.join(shardDir, `${month}.jsonl`);
	const payload = row(`${month}-22T09:00:00.000Z`, 'read', { note: 'PRE-HANDLE-BYTES' });
	const original = `${row(`${month}-15T01:00:00.000Z`, 'recall')}\n`;
	await writeFile(source, original);

	const child = spawn(process.execPath, ['-e', HANDLE_CHILD, control, source, `${payload}\n`], {
		stdio: 'ignore', windowsHide: true,
	});
	const done = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
	const waitFor = async (name, ms) => {
		const until = Date.now() + ms;
		while (Date.now() < until) {
			if (await exists(path.join(control, name))) return true;
			await new Promise((r) => setTimeout(r, 5));
		}
		return false;
	};
	assert.equal(await waitFor('opened', 15000), true, 'child must open its handle first');

	// Move the source while the child's handle is open.
	const { rename } = await import('node:fs/promises');
	const stageDir = path.join(root, '.usage', '.stage');
	await mkdir(stageDir, { recursive: true });
	const moved = path.join(stageDir, `${month}.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.moved`);
	await rename(source, moved);
	assert.equal(await exists(source), false);

	// Only now let the child write through the pre-move handle.
	await writeFile(path.join(control, 'go'), 'go');
	assert.equal(await done, 0, 'writing child must exit cleanly');
	assert.equal(await exists(path.join(control, 'write-error')), false);
	assert.match(await readFile(moved, 'utf8'), /PRE-HANDLE-BYTES/, 'bytes landed in staged inode');

	// The payload is physically inside the moved inode, not at the old path.
	// The end-to-end `pre` loop above runs the full protocol (settle-read,
	// archive, .dropped) with the same handle-opened-before-rename condition;
	// this deterministic case pins the underlying filesystem behaviour that
	// read-then-unlink would have lost.
	assert.equal(await exists(source), false, 'a pre-rename handle must not resurrect the old path');
	assert.match(await readFile(moved, 'utf8'), /PRE-HANDLE-BYTES/);
	assert.ok((await readFile(moved, 'utf8')).includes(original.trim()), 'original bytes also in staged inode');
});
