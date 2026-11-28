/**
 * Usage ledger sharding: the append-only event log must not grow unbounded.
 *
 * Why this suite exists (2026-11-16): a real root reached 4374 lines / 420KB in
 * a month with NO rotation of any kind, and every read parsed the whole file.
 * The fix writes into `.usage/YYYY-MM.jsonl` shards. The risk of that change is
 * data loss — an old root has only the legacy `.usage.jsonl`, a new one has
 * shards, and any reader that looks at just one location silently reports a
 * smaller history. These assertions pin the compatibility contract:
 *
 *   1. legacy-only root still reads fully (no migration required)
 *   2. new writes land in a shard, NOT in the legacy file
 *   3. a root with BOTH reads both (no window sees a gap)
 *   4. a 30-day window skips shards that are older than the window (that is the
 *      whole point of sharding) — but a wide window still sees them
 *   5. recall rows stay EVENTS: sharding must not deduplicate them
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const { appendUsage, readUsage, usageFiles, usagePath, usageShardDir, usageShardPath } = await import('../src/usage.js');

let failures = 0;
const ok = (cond, label) => {
	console.log(cond ? `  PASS ${label}` : `  FAIL ${label}`);
	if (!cond) failures++;
};
async function assertRejectsCode(promise, code) {
	try { await promise; } catch (error) {
		ok(error?.code === code, `rejects with ${code} (got ${error?.code})`);
		return;
	}
	ok(false, `expected rejection with ${code}`);
}
const root = () => mkdtempSync(path.join(tmpdir(), 'dsh-usage-shard-'));
const line = (href, kind, t) => `${JSON.stringify({ t, href, kind })}\n`;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400_000).toISOString();

// --- 1. legacy-only root still reads completely ------------------------------
{
	const dir = root();
	writeFileSync(usagePath(dir), line('functions/a.md', 'recall', iso(1)) + line('functions/b.md', 'read', iso(2)), 'utf8');
	const rows = await readUsage(dir, 30);
	ok(rows.length === 2, `legacy-only root reads both rows (${rows.length})`);
	ok(rows.every((r) => typeof r.href === 'string'), 'legacy rows keep their href');
	rmSync(dir, { recursive: true, force: true });
}

// --- 2. new writes go to a shard, not the legacy file -----------------------
{
	const dir = root();
	await appendUsage(dir, { href: 'functions/new.md', kind: 'read' });
	ok(existsSync(usageShardDir(dir)), 'a shard directory is created on write');
	const shards = readdirSync(usageShardDir(dir)).filter((n) => n.endsWith('.jsonl'));
	ok(shards.length === 1, `exactly one shard holds the new row (${shards.length})`);
	ok(!existsSync(usagePath(dir)), 'the legacy file is NOT resurrected by new writes');
	const rows = await readUsage(dir, 30);
	ok(rows.length === 1 && rows[0].href === 'functions/new.md', 'the shard row is read back');
	rmSync(dir, { recursive: true, force: true });
}

// --- 3. both layouts at once: nothing may be dropped ------------------------
{
	const dir = root();
	writeFileSync(usagePath(dir), line('functions/old.md', 'recall', iso(1)), 'utf8');
	await appendUsage(dir, { href: 'functions/new.md', kind: 'read' });
	const rows = await readUsage(dir, 30);
	const hrefs = rows.map((r) => r.href).sort();
	ok(rows.length === 2 && hrefs[0] === 'functions/new.md' && hrefs[1] === 'functions/old.md',
		`a mixed root reads BOTH the legacy file and the shard (${hrefs.join(',')})`);
	const files = await usageFiles(dir);
	ok(files.length === 2, `usageFiles lists legacy + shard (${files.length})`);
	rmSync(dir, { recursive: true, force: true });
}

// --- 4. window pruning: old shards skipped for a short window ---------------
{
	const dir = root();
	mkdirSync(usageShardDir(dir), { recursive: true });
	// A shard from ~200 days ago and one from today.
	const old = new Date(Date.now() - 200 * 86400_000);
	const oldName = `${old.getUTCFullYear()}-${String(old.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;
	writeFileSync(path.join(usageShardDir(dir), oldName), line('functions/ancient.md', 'recall', old.toISOString()), 'utf8');
	await appendUsage(dir, { href: 'functions/today.md', kind: 'read' });

	const recent = await readUsage(dir, 30);
	ok(recent.length === 1 && recent[0].href === 'functions/today.md',
		`a 30-day window skips the 200-day-old shard (${recent.map((r) => r.href).join(',')})`);
	const wide = await readUsage(dir, 400);
	ok(wide.length === 2, `a 400-day window still sees the old shard (${wide.length})`);
	rmSync(dir, { recursive: true, force: true });
}

// --- 5. sharding must NOT deduplicate recall events -------------------------
// recall is an EVENT (one per injection). Collapsing it would destroy the
// exposure count that weights recall, so the same href repeated N times must
// still read back as N rows.
{
	const dir = root();
	for (let i = 0; i < 5; i++) await appendUsage(dir, { href: 'functions/same.md', kind: 'recall' });
	const rows = await readUsage(dir, 30);
	ok(rows.length === 5, `five identical recall injections stay five events (${rows.length})`);
	ok(rows.every((r) => r.href === 'functions/same.md'), 'every event keeps its identity');
	rmSync(dir, { recursive: true, force: true });
}

// --- 6. shard path is derived from the entry's own month --------------------
{
	const dir = root();
	const p = usageShardPath(dir, new Date('2026-03-15T10:00:00Z'));
	ok(p.endsWith(path.join('.usage', '2026-03.jsonl')), `shard name follows the UTC month (${path.basename(p)})`);
	rmSync(dir, { recursive: true, force: true });
}

// --- 7. a corrupt line in a shard must not poison the rest ------------------
{
	const dir = root();
	await appendUsage(dir, { href: 'functions/good1.md', kind: 'read' });
	mkdirSync(usageShardDir(dir), { recursive: true });
	const shard = usageShardPath(dir);
	const existing = existsSync(shard) ? readFileSync(shard, 'utf8') : '';
	writeFileSync(shard, `${existing}{not json at all}\n${line('functions/good2.md', 'read', iso(0))}`, 'utf8');
	const rows = await readUsage(dir, 30);
	ok(rows.length === 2, `a corrupt shard line is skipped, valid rows survive (${rows.length})`);
	rmSync(dir, { recursive: true, force: true });
}

// --- 8. source guards: a reader must not silently go back to one file ------
// The dangerous regression is not "sharding breaks" — it is a reader that keeps
// working while seeing LESS data (tests still green, history quietly gone). These
// source-level assertions fail loudly if a future edit reintroduces a direct
// single-file read in the places that must aggregate the whole ledger.
{
	const src = readFileSync(new URL('../src/usage.js', import.meta.url), 'utf8');
	ok(/export async function usageFiles/.test(src), 'usageFiles exists (the single source of ledger locations)');
	// readUsage must go through usageFiles, not read usagePath directly.
	const readUsageBody = src.slice(src.indexOf('export async function readUsage'), src.indexOf('export function createUsageSnapshot'));
	ok(readUsageBody.includes('usageFiles('), 'readUsage enumerates every ledger file via usageFiles()');
	ok(!/readIfExists\(usagePath\(/.test(readUsageBody), 'readUsage does not read the legacy path alone');

	const srv = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
	const directSingle = [...srv.matchAll(/readIfExists\(usagePath\(root\)\)/g)].length;
	ok(directSingle === 0, `server.js never reads the legacy ledger alone (${directSingle} direct reads)`);
}

// --- 9. disabled compaction preserves all existing bytes -------------------
{
	const { compactUsage, usageArchivePath } = await import('../src/usage.js');
	const dir = root();
	try {
		const month = '2000-01';
		const src = path.join(usageShardDir(dir), `${month}.jsonl`);
		const archive = usageArchivePath(dir, month);
		mkdirSync(path.dirname(archive), { recursive: true });
		const raw = line('functions/a.md', 'recall', '2000-01-01T00:00:00Z').repeat(2)
			+ '{bad json}\n' + '{"kind":"read","t":"invalid"}\n';
		const existing = 'existing archive bytes\n';
		writeFileSync(src, raw);
		writeFileSync(archive, existing);
		const stats = await compactUsage(dir);
		ok(stats.disabled === true && stats.skipped.includes(month) && stats.compacted.length === 0,
			'disabled compaction reports the skipped month');
		ok(readFileSync(src, 'utf8') === raw, 'malformed and invalid timestamp rows survive byte-for-byte');
		ok(readFileSync(archive, 'utf8') === existing, 'existing archive remains byte-for-byte unchanged');
		// Same month in both locations is ambiguous during a migration; the reader
		// must fail closed rather than silently pick one (or double-count).
		await assertRejectsCode(usageFiles(dir), 'USAGE_AMBIGUOUS_MONTH');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// Concurrent source mutation must never be erased by compaction.
{
	const { compactUsage } = await import('../src/usage.js');
	const { appendFile } = await import('node:fs/promises');
	const dir = root();
	try {
		mkdirSync(usageShardDir(dir), { recursive: true });
		const src = path.join(usageShardDir(dir), '2000-01.jsonl');
		const initial = line('functions/a.md', 'recall', '2000-01-01T00:00:00Z').repeat(2);
		const added = line('functions/b.md', 'positive', '2000-01-02T00:00:00Z');
		writeFileSync(src, initial);
		await Promise.all([compactUsage(dir), appendFile(src, added)]);
		ok(readFileSync(src, 'utf8') === initial + added, 'concurrent append remains in the source');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// A filesystem error must not be reported as a successful compaction.
{
	const { compactUsage } = await import('../src/usage.js');
	const dir = root();
	try {
		const obstruction = path.join(dir, '.usage');
		writeFileSync(obstruction, 'not a directory');
		let failed = false;
		try { await compactUsage(dir); } catch { failed = true; }
		ok(failed && readFileSync(obstruction, 'utf8') === 'not a directory',
			'an unreadable shard directory reports failure and remains intact');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// Archive-aware consumers scan archived judgments exactly once; a same-month
// duplicate is the unsafe state that must fail closed.
{
	const { usageArchivePath } = await import('../src/usage.js');
	const { readAdoptionEvidence } = await import('../src/adoption-evidence.js');
	const { traceObject } = await import('../src/object-trace.js');
	const dir = root();
	try {
		const key = 'functions/demo.md';
		const judgment = `${JSON.stringify({ t: '2000-01-01T00:00:00Z', href: key, kind: 'positive', note: 'confirmed' })}\n`;
		const archive = usageArchivePath(dir, '2000-01');
		mkdirSync(path.dirname(archive), { recursive: true });
		writeFileSync(archive, judgment);
		const evidence = await readAdoptionEvidence({ root: dir, objectKey: key });
		const trace = await traceObject({ root: dir, objectKey: key });
		ok(evidence.status === 'ok' && evidence.rows.length === 1 && evidence.rows[0].note === 'confirmed',
			'archive-only verdict is returned by adoption evidence');
		ok(trace.status === 'ok' && trace.hops.adoption.status === 'present'
			&& trace.hops.adoption.evidence[0].note === 'confirmed',
			'archive-only verdict is included in the object trace');
		// A live shard for the SAME month makes the source ambiguous: both readers
		// must report incomplete rather than double-count or silently pick one.
		const raw = path.join(usageShardDir(dir), '2000-01.jsonl');
		writeFileSync(raw, judgment);
		const ambiguousEvidence = await readAdoptionEvidence({ root: dir, objectKey: key });
		const ambiguousTrace = await traceObject({ root: dir, objectKey: key });
		ok(ambiguousEvidence.status === 'incomplete' && ambiguousTrace.status === 'incomplete',
			'same-month live+archive duplicate fails closed in both consumers');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// --- 10. compaction must not touch a month still inside the window --------
{
	const { compactUsage } = await import('../src/usage.js');
	const dir = root();
	await appendUsage(dir, { href: 'functions/recent.md', kind: 'recall' });
	const before = (await readUsage(dir, 30)).length;
	const stats = await compactUsage(dir, { olderThanDays: 90 });
	ok(stats.compacted.length === 0, 'a month inside the window is never compacted');
	ok((await readUsage(dir, 30)).length === before, 'recent rows are untouched');
	rmSync(dir, { recursive: true, force: true });
}

// --- 11. a compacted archive stays readable by every reader ---------------
// server.js counts exposure by reading the ledger; if it ignored the archive the
// number would silently drop after compaction. Source-level guard.
{
	const srv = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
	ok(/usageArchiveDir|usageArchivePath/.test(srv) || /readUsage\(/.test(srv),
		'server.js reaches compacted history (via readUsage or the archive helpers)');
}

console.log(failures === 0 ? 'USAGE ALL PASS' : `${failures} USAGE FAILURES`);
process.exit(failures === 0 ? 0 : 1);
