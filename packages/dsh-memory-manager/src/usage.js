/**
 * Usage signals — the data that lets the memory sort itself.
 *
 * The index/insight layer is written by the model; which rows are actually USED
 * is a different signal. Every recall injection, explicit file read, correction
 * and positive confirmation appends one line to <root>/.usage.jsonl (a dot-file
 * so no zone listing, search or lint sees it), and memory_check / memory_usage
 * turn those lines into layer suggestions.
 */
import { appendFile, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { readIfExists } from './util.js';
import { redactSecrets } from './secrets.js';

export function usagePath(root) {
	return path.join(root, '.usage.jsonl');
}

/**
 * Monthly shard directory (2026-11-16). The ledger is an append-only EVENT log:
 * every recall injection writes a line, so a real root reached 4.3k lines / 420KB
 * in a month of use and there was no rotation of any kind. Two consequences:
 * every `readUsage` parsed the whole file (cost grows forever), and the file
 * itself would eventually become the largest thing in the memory root.
 *
 * Sharding by month bounds the cost of a 30-day window to ~2 files. It is NOT
 * deduplication: recall rows must stay as events, because "how often was this
 * put in front of the model" is what weights recall. We only change WHERE the
 * rows live, never how many there are.
 */
export function usageShardDir(root) {
	return path.join(root, '.usage');
}

/** `.usage/YYYY-MM.jsonl` for the entry's own timestamp (UTC month). */
export function usageShardPath(root, date = new Date()) {
	const d = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
	const yyyy = d.getUTCFullYear();
	const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
	return path.join(usageShardDir(root), `${yyyy}-${mm}.jsonl`);
}

/**
 * One canonical identity per skill in the ledger (5.27.0): the index row links
 * to the host bundle with an absolute file:/// URL, the tools and the activate
 * gate speak the relative `skills/<name>/SKILL.md` form — without folding, the
 * SAME skill would accumulate signals under two hrefs and each reader would
 * see half the evidence. Everything else passes through untouched.
 */
export function canonicalHref(href) {
	const m = /(?:^|[\\/])skills[\\/]+([^\\/]+)[\\/]+SKILL\.md$/i.exec(String(href ?? ''));
	return m ? `skills/${m[1]}/SKILL.md` : String(href ?? '');
}

export async function appendUsage(root, entry) {
	try {
		await mkdir(root, { recursive: true });
		// REDACT HERE TOO (5.27.0): util.js calls writeText "the single choke
		// point" for credentials, but this path appends directly — a note like
		// "the token leaked here" used to land in .usage.jsonl as plaintext, and
		// R21 never scans the dot-file. Same tier-1 rule as every other writer.
		const folded = { ...entry, href: canonicalHref(entry.href) };
		if (typeof folded.note === 'string') folded.note = redactSecrets(folded.note).text;
		const now = new Date();
		const line = `${JSON.stringify({ t: now.toISOString(), ...folded })}\n`;
		// Write into the month shard. The legacy single file is NOT appended to any
		// more, but it stays readable forever (see readUsage) — rotation without a
		// migration step, so an existing root loses nothing.
		await mkdir(usageShardDir(root), { recursive: true });
		await appendFile(usageShardPath(root, now), line, 'utf8');
	} catch {
		/* usage logging must never break a step or a tool call */
	}
}

/**
 * Archive directory for compacted shards. Old months are downsampled here: the
 * raw `recall` rows in a closed month are folded into per-(href, day) counts,
 * while read/correction/positive rows are kept verbatim (they are rare, and each
 * one carries a judgement).
 */
export function usageArchiveDir(root) {
	return path.join(usageShardDir(root), 'archive');
}

export function usageArchivePath(root, month) {
	return path.join(usageArchiveDir(root), `${month}.jsonl`);
}

/**
 * Downsample closed months (2026-11-16).
 *
 * The ledger grew ~4.7k lines/month and NOTHING ever removed a line. Sharding
 * bounded the read cost of a 30-day window, but the disk still grows forever.
 *
 * What compaction may and may not do:
 *   · `recall` is a poll: "how often was this put in front of the model". Folding
 *     it into `{href, day, n}` keeps that number exactly — recall counts stay
 *     recoverable, which is what weights recall. Nothing is lost that any
 *     judgement depends on.
 *   · read / correction / positive are NOT folded: each is a distinct event with
 *     its own weight in badRate and layer decisions, and folding them would
 *     erase "how many corrections" — the one signal the user produces directly.
 *
 * Safety: the compacted file is written and re-read (row count verified) BEFORE
 * the source shard is removed. A failed verification keeps the original, so a
 * crash can only ever leave MORE data, never less.
 */
export async function compactUsage(root, { olderThanDays = 90, now = Date.now() } = {}) {
	const cutoff = now - olderThanDays * 86400_000;
	const cutoffMonth = (() => {
		const d = new Date(cutoff);
		return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
	})();
	const stats = { compacted: [], skipped: [], rawRows: 0, keptRows: 0 };
	let shards = [];
	try {
		shards = (await readdir(usageShardDir(root))).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort();
	} catch {
		return stats;
	}
	for (const name of shards) {
		const month = name.slice(0, 7);
		// Only whole months that are entirely older than the threshold.
		if (!(month < cutoffMonth)) {
			stats.skipped.push(month);
			continue;
		}
		const src = path.join(usageShardDir(root), name);
		const text = (await readIfExists(src)) ?? '';
		const raw = text.split('\n').filter((l) => l.trim());
		if (!raw.length) continue;
		// Fold: recall → {href, day, n}; everything else survives verbatim.
		const folded = new Map();
		const kept = [];
		for (const line of raw) {
			let e;
			try {
				e = JSON.parse(line);
			} catch {
				continue; // corrupt line: drop it (it carried no readable fact)
			}
			const t = Date.parse(e.t);
			if (!Number.isFinite(t)) continue;
			if (e.kind === 'recall' && e.href) {
				const day = new Date(t).toISOString().slice(0, 10);
				const key = `${canonicalHref(e.href)}\u0000${day}`;
				const hit = folded.get(key);
				if (hit) hit.n++;
				else folded.set(key, { t: `${day}T00:00:00.000Z`, href: canonicalHref(e.href), kind: 'recall', n: 1 });
			} else {
				kept.push(JSON.stringify(e));
			}
		}
		const compactedLines = [...folded.values()].map((r) => JSON.stringify(r));
		const all = [...compactedLines, ...kept];
		if (all.length >= raw.length) {
			// Nothing gained (a month with no recall rows): leave it alone rather
			// than rewrite an identical file.
			stats.skipped.push(month);
			continue;
		}
		await mkdir(usageArchiveDir(root), { recursive: true });
		const dest = usageArchivePath(root, month);
		await writeFile(dest, `${all.join('\n')}\n`, 'utf8');
		// VERIFY BEFORE DELETE: the archive must be readable and carry exactly the
		// rows we intended. A partial write must leave the original in place.
		const check = (await readIfExists(dest)) ?? '';
		const checkRows = check.split('\n').filter((l) => l.trim()).length;
		if (checkRows !== all.length) {
			stats.skipped.push(month);
			continue;
		}
		await unlink(src);
		stats.compacted.push(month);
		stats.rawRows += raw.length;
		stats.keptRows += all.length;
	}
	return stats;
}

/**
 * Every ledger file to read, oldest first: the legacy `.usage.jsonl` plus the
 * monthly shards. Reading BOTH is what makes the format change safe — an old
 * root has only the legacy file, a new one may have both, and no window ever
 * sees a gap.
 */
export async function usageFiles(root) {
	const files = [];
	const legacy = usagePath(root);
	if ((await readIfExists(legacy)) !== undefined) files.push({ file: legacy, month: '' });
	let shards = [];
	try {
		shards = (await readdir(usageShardDir(root))).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort();
	} catch {
		/* no shard dir yet */
	}
	for (const name of shards) files.push({ file: path.join(usageShardDir(root), name), month: name.slice(0, 7) });
	return files;
}

/**
 * Usage entries newer than `days`, newest last. Bad lines are skipped.
 *
 * Reads the legacy single file AND every monthly shard, so a root written before
 * the split keeps all of its history. Shards outside the window are skipped by
 * NAME before being read — the whole point of sharding is that a 30-day query
 * does not parse years of log.
 */
export async function readUsage(root, days = 30) {
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
	// Month shards strictly older than the window can be skipped unread: their
	// newest possible line is the last instant of that month.
	const cutoffMonth = (() => {
		const d = new Date(cutoff);
		return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
	})();
	const out = [];
	for (const { file, month } of await usageFiles(root)) {
		if (month && month < cutoffMonth) continue;
		const text = (await readIfExists(file)) ?? '';
		for (const line of text.split('\n')) {
			const s = line.trim();
			if (!s) continue;
			try {
				const e = JSON.parse(s);
				const t = Date.parse(e.t);
				if (!Number.isFinite(t) || t < cutoff) continue;
				// Fold on READ as well as write: pre-fold lines in an existing ledger
				// (and recall lines written with the absolute bundle href) aggregate
				// under one identity, so evidence is never split across two hrefs.
				//
				// Compacted recall rows carry `n` (how many injections that href saw
				// that day). Expand into n equivalent events so every consumer keeps
				// seeing the true exposure count — compaction changes the storage
				// shape, never the numbers a judgement reads.
				const n = Number.isSafeInteger(e.n) && e.n > 1 ? e.n : 1;
				for (let i = 0; i < n; i++) out.push({ ...e, href: canonicalHref(e.href), ms: t });
			} catch {
				/* skip corrupt line */
			}
		}
	}
	// Also read compacted months: they hold history that predates the window's
	// shard, and dropping them would make old exposure vanish from the totals.
	try {
		const archived = (await readdir(usageArchiveDir(root))).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort();
		for (const name of archived) {
			const month = name.slice(0, 7);
			if (month < cutoffMonth) continue;
			const text = (await readIfExists(usageArchivePath(root, month))) ?? '';
			for (const line of text.split('\n')) {
				const s = line.trim();
				if (!s) continue;
				try {
					const e = JSON.parse(s);
					const t = Date.parse(e.t);
					if (!Number.isFinite(t) || t < cutoff) continue;
					const n = Number.isSafeInteger(e.n) && e.n > 1 ? e.n : 1;
					for (let i = 0; i < n; i++) out.push({ ...e, href: canonicalHref(e.href), ms: t });
				} catch {
					/* skip */
				}
			}
		}
	} catch {
		/* no archive dir */
	}
	return out;
}

/**
 * Aggregate usage per target and suggest a layer (实验 / 专项 / 通用).
 *
 * SELF-REFERENCE FIX (2026-10-27): `recall` is the plugin's OWN action, not the
 * user's. Counting it as a "use" put the same fact on both sides of every
 * derived ratio — recall inflated the denominator of badRate (so a genuinely
 * corrected memory looked fine), inflated the numerator of `uses` (so the same
 * hot rows won the RRF ranking, were recalled more, and grew hotter), and
 * satisfied the skill-nomination use floor. Measured on a real root: 627 of 667
 * ledger lines were self-produced recalls; the one area with BOTH corrections
 * reported a 1% correction rate that its engagement rate says is 29%.
 *
 * So the fields are now split by WHO produced them:
 *   exposure  = recalls + reads   — how often the memory was PUT in front of the
 *                                   model (demand created by the plugin)
 *   engage    = reads + verdicts  — the model actually touched it
 *   uses      = engage            — the ONLY thing layer suggestions / heat /
 *                                   nomination may use (kept under the old name
 *                                   so every consumer reads the honest number)
 *   badRate   = corrections / (reads + corrections) — denominator EXCLUDES the
 *                                   plugin's own recall, so recall can no longer
 *                                   dilute a real correction rate
 */
export function summarizeUsage(entries) {
	const map = new Map();
	// Keep the correction/positive order per href so a flip (positive -> correction
	// or the other way round) can be counted: a memory that keeps being confirmed
	// and then overturned is not the same as one that is simply used.
	const verdicts = new Map();
	for (const e of entries) {
		const href = String(e.href ?? '').trim();
		if (!href) continue;
		const cur = map.get(href) ?? { href, recalls: 0, reads: 0, corrections: 0, positives: 0, lifecycle: 0, last: 0 };
		if (e.kind === 'recall') cur.recalls++;
		else if (e.kind === 'read') cur.reads++;
		else if (e.kind === 'correction') cur.corrections++;
		else if (e.kind === 'positive') cur.positives++;
		// Lifecycle stamps (crystallize/activate/retire) belong to the LEDGER, not
		// to the skill body (the user's ruling: a skill stays the current
		// procedure; dated logs grow without bound). They count as neither uses
		// nor verdicts — pure provenance.
		else if (e.kind === 'lifecycle') cur.lifecycle++;
		if (e.kind === 'correction' || e.kind === 'positive') {
			const seq = verdicts.get(href) ?? [];
			// The NOTE is what makes a flip meaningful (see the flips computation
			// below): without it, two corrections about DIFFERENT subjects read as
			// "the same conclusion was overturned twice".
			seq.push({ kind: e.kind, ms: e.ms, note: String(e.note ?? '').trim() });
			verdicts.set(href, seq);
		}
		cur.last = Math.max(cur.last, e.ms);
		map.set(href, cur);
	}
	const items = [...map.values()];
	for (const it of items) {
		// Exposure is reported, never used as evidence of use.
		it.exposure = it.recalls + it.reads;
		// Engagement: the model opened the file or formed a verdict about it.
		// A recall the model ignored is not a use — that is the whole point.
		const uses = it.reads + it.corrections + it.positives;
		// Denominator excludes recall: corrections measure the quality of what the
		// model actually engaged with, not of everything the plugin pushed at it.
		const engaged = it.reads + it.corrections;
		const badRate = engaged ? it.corrections / engaged : it.corrections ? 1 : 0;
		// Layer suggestion mirrors the article's data-driven promotion: usage wins,
		// confirmation gates promotion, correction rate gates generality.
		if (uses >= 10 && it.positives >= 2 && badRate < 0.2) it.layer = '通用';
		else if (uses >= 3 && it.positives >= 1) it.layer = '专项';
		else it.layer = '实验';
		it.uses = uses;
		it.badRate = Number(badRate.toFixed(2));
		// FLIPS measure ONE conclusion being overturned, not one FILE collecting
		// verdicts about different subjects. The old count flipped on any
		// correction→positive→correction sequence on the same href, which is how
		// functions/memory-manager.md was reported as "结论被反复推翻（翻转 2 次）"
		// from three verdicts about three unrelated matters (duplicate-row cleanup,
		// then a capability-ledger semantics correction). A file is a container;
		// only a repeated VERDICT ON THE SAME SUBJECT is instability.
		//
		// Two verdicts belong to the same subject when their notes share content:
		// exact match, or one contains the other (short note inside a long one).
		// A verdict without a note cannot be attributed to a subject, so it can
		// only flip against an adjacent note-less verdict — that keeps the signal
		// honest (we never invent a subject link we cannot see) while the tool's
		// own description nudges the model to pass `note`.
		const seq = (verdicts.get(it.href) ?? []).sort((a, b) => a.ms - b.ms);
		const sameSubject = (a, b) => {
			if (!a.note || !b.note) return !a.note && !b.note;
			return a.note === b.note || a.note.includes(b.note) || b.note.includes(a.note);
		};
		let flips = 0;
		for (let i = 1; i < seq.length; i++) {
			if (seq[i].kind !== seq[i - 1].kind && sameSubject(seq[i], seq[i - 1])) flips++;
		}
		it.flips = flips;
	}
	items.sort((a, b) => b.uses - a.uses || b.exposure - a.exposure || b.last - a.last);
	return items;
}

/**
 * Insight trust from usage evidence (Hindsight-borrowed: beliefs carry proof
 * counts, and new evidence REFINES rather than silently replaces).
 *
 *   positives 0, corrections 0  → 待验证（沉淀了但还没被用过/验证过）
 *   corrections >= positives>0  → 动摇（被纠正追平了认可：该精炼或取代了）
 *   positives >= 3              → 稳固（反复被确认）
 *   positives >= 1              → 已验证
 */
export function insightTrust(item) {
	const p = item?.positives ?? 0;
	const c = item?.corrections ?? 0;
	if (p === 0) return { level: '待验证', positives: 0, corrections: c };
	if (c >= p) return { level: '动摇', positives: p, corrections: c };
	if (p >= 3) return { level: '稳固', positives: p, corrections: c };
	return { level: '已验证', positives: p, corrections: c };
}

/** The head line written into every insight file; the panel renders it for free. */
export function trustLineFor(trust) {
	return `> 信任：${trust.level}（认可 ${trust.positives} · 纠正 ${trust.corrections}，由 memory_insight 按 .usage.jsonl 自动刷新）`;
}

/**
 * Replace or insert the trust line right after the `> 性质：` head line.
 * BOTH branches matter: files created by the 5.16.1 template already carry the
 * line (replace), files written by an earlier generation do not (insert) — and
 * the insert needs the `m` flag, or `^` anchors at the very start of the body
 * (the `# 标题` line) and silently never matches. An insight update must never
 * return without its trust line: the recall marker and R22 both key on it.
 */
export function refreshTrustLine(text, line) {
	if (/^> 信任：.*$/m.test(text)) return text.replace(/^> 信任：.*$/m, line);
	const withInsert = text.replace(/^(> 性质：[^\n]*\n)/m, `$1${line}\n`);
	if (withInsert !== text) return withInsert;
	// No `> 性质：` head at all (a hand-written or truncated file): put the line
	// under the title instead of dropping it.
	const afterTitle = text.replace(/^(#[^\n]*\n\n?)/m, `$1${line}\n`);
	if (afterTitle !== text) return afterTitle;
	return `${line}\n${text}`;
}
