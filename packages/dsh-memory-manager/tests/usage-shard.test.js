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
	const readUsageBody = src.slice(src.indexOf('export async function readUsage'), src.indexOf('export function summarizeUsage'));
	ok(readUsageBody.includes('usageFiles('), 'readUsage enumerates every ledger file via usageFiles()');
	ok(!/readIfExists\(usagePath\(/.test(readUsageBody), 'readUsage does not read the legacy path alone');

	const srv = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
	// Every place that needs the WHOLE ledger must use usageFiles().
	const directSingle = [...srv.matchAll(/readIfExists\(usagePath\(root\)\)/g)].length;
	ok(directSingle === 0, `server.js never reads the legacy ledger alone (${directSingle} direct reads)`);
	ok((srv.match(/usageFiles\(root\)/g) ?? []).length >= 3,
		`server.js uses usageFiles() everywhere it needs the whole ledger (${(srv.match(/usageFiles\(root\)/g) ?? []).length} sites)`);
}

// --- 9. compaction: shrink the file WITHOUT losing the exposure count ------
// The ledger grows forever (~4.7k lines/month). Compaction folds old recall rows
// into per-(href, day) counts. The contract: the TOTAL exposure number a reader
// sees must be identical before and after, and read/correction must survive
// verbatim (they are judgements, not polls).
{
	const { compactUsage, usageArchivePath } = await import('../src/usage.js');
	const dir = root();
	mkdirSync(usageShardDir(dir), { recursive: true });
	// A closed month, 200 days ago: 40 recall injections over 4 days + 2 judgements.
	const old = new Date(Date.now() - 200 * 86400_000);
	const oldMonth = `${old.getUTCFullYear()}-${String(old.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;
	const dayIso = (d) => new Date(old.getTime() + d * 86400_000).toISOString();
	const rows = [];
	for (let d = 0; d < 4; d++) for (let i = 0; i < 10; i++) rows.push(JSON.stringify({ t: dayIso(d), href: 'functions/a.md', kind: 'recall' }));
	rows.push(JSON.stringify({ t: dayIso(0), href: 'functions/a.md', kind: 'correction', note: 'wrong' }));
	rows.push(JSON.stringify({ t: dayIso(1), href: 'functions/b.md', kind: 'read' }));
	writeFileSync(path.join(usageShardDir(dir), oldMonth), `${rows.join('\n')}\n`, 'utf8');

	// Baseline: what a wide read reports BEFORE compaction.
	const before = await readUsage(dir, 400);
	const beforeRecall = before.filter((r) => r.kind === 'recall' && r.href === 'functions/a.md').length;
	const beforeCorr = before.filter((r) => r.kind === 'correction').length;
	const beforeRead = before.filter((r) => r.kind === 'read').length;
	ok(beforeRecall === 40, `baseline sees 40 recall injections (${beforeRecall})`);

	const stats = await compactUsage(dir, { olderThanDays: 90 });
	ok(stats.compacted.includes(oldMonth.slice(0, 7)), `the closed month was compacted (${stats.compacted.join(',')})`);
	ok(stats.keptRows < stats.rawRows, `compaction actually shrank the row count (${stats.rawRows} -> ${stats.keptRows})`);
	ok(!existsSync(path.join(usageShardDir(dir), oldMonth)), 'the raw shard was removed after verification');
	ok(existsSync(usageArchivePath(dir, oldMonth.slice(0, 7))), 'the archive file exists');

	const after = await readUsage(dir, 400);
	const afterRecall = after.filter((r) => r.kind === 'recall' && r.href === 'functions/a.md').length;
	const afterCorr = after.filter((r) => r.kind === 'correction').length;
	const afterRead = after.filter((r) => r.kind === 'read').length;
	// THE assertion that matters: the exposure number is unchanged.
	ok(afterRecall === beforeRecall, `recall count survives compaction exactly (${beforeRecall} -> ${afterRecall})`);
	ok(afterCorr === beforeCorr && afterCorr === 1, `corrections are kept verbatim, not folded (${afterCorr})`);
	ok(afterRead === beforeRead && afterRead === 1, `reads are kept verbatim (${afterRead})`);

	// The archive is human-inspectable and self-describing.
	const arch = readFileSync(usageArchivePath(dir, oldMonth.slice(0, 7)), 'utf8').split('\n').filter(Boolean);
	const recallLines = arch.map((l) => JSON.parse(l)).filter((e) => e.kind === 'recall');
	ok(recallLines.length === 4, `one folded recall line per (href, day) — 4 days (${recallLines.length})`);
	ok(recallLines.every((e) => e.n === 10), 'each folded line carries n=10 injections');

	rmSync(dir, { recursive: true, force: true });
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
