/**
 * Proactive recall: pre-step index matching (tokensOf + matchIndexRows) and the
 * recall message builder. Ranking fuses lexical IDF with usage heat via RRF;
 * decision-repair rows are forced in and visibly marked; insight rows carry
 * their trust level (computed from usage evidence) so a shaken principle is
 * never injected as if it were solid.
 */
import { insightTrust } from './usage.js';

/**
 * The identity of a skill index row from its href (5.27.0, SHARED by recall and
 * the server's panel row reader — the two index parsers must agree on names, or
 * one view clicks what the other cannot find):
 *   file:///.../<name>/SKILL.md  → <name>   (the bundle directory)
 *   skills/<name>.md (legacy)    → <name>   (the file basename)
 * The previous server-side `slice(-2)[0]` gave 'skills' for the legacy form.
 */
export function skillNameOf(href) {
	const segs = String(href ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
	const leaf = segs[segs.length - 1] ?? '';
	if (/^SKILL\.md$/i.test(leaf)) return segs[segs.length - 2] ?? '';
	return leaf.replace(/\.md$/i, '');
}

/** Extract meaningful tokens: CJK bigrams + latin words, minus stopwords. */
export function tokensOf(text) {
	const t = String(text ?? '').toLowerCase();
	const out = new Set();
	for (const w of t.matchAll(/[a-z0-9_\-]{2,}/g)) out.add(w[0]);
	for (let i = 0; i < t.length - 1; i++) {
		const a = t[i];
		const b = t[i + 1];
		if (/[\u4e00-\u9fff]/.test(a) && /[\u4e00-\u9fff]/.test(b)) out.add(a + b);
	}
	for (const stop of ['这个', '那个', '什么', '怎么', '如何', '可以', '我们', '你们', '他们', '一个', '一下', '没有', '不是', '就是', '还有', '或者', '以及', '然后', '但是', '所以', '如果', '因为', 'the', 'and', 'for', 'with', 'this', 'that', 'have', 'not', '但', '的', '了', '吗', '呢', '吧']) {
		out.delete(stop);
	}
	return out;
}

/**
 * Score index rows against the user's tokens and return the top rows whose
 * overlap clears a small threshold. Pure and synchronous: runs in pre-step.
 *
 * v2 ranking (same cost class, much better precision):
 *  - IDF weighting: tokens shared by every row (e.g. 「功能」「记忆」) count for
 *    little; a rare token (「逐帧」「懒加载」) dominates. Without this, a query
 *    mentioning a common word outranks the row that is actually about it.
 *  - Name/slug hits are boosted: the row's own identity matching beats a
 *    passing mention inside its summary.
 *  - Relative threshold: rows scoring under 40% of the best match are dropped,
 *    so one strong hit does not drag three weak ones into the injection.
 *  - Dedupe by href (a table split into ### sub-sections can repeat a row).
 *
 * @param {Map<string, {uses:number,positives:number,corrections:number,badRate:number}>} [usage]
 *   Per-href usage signals (from .usage.jsonl). When present, the lexical IDF
 *   rank is FUSED with a usage rank via RRF (borrowed from MemOS's hybrid
 *   retrieval: FTS5 + vector → RRF), so a row that is both topically relevant
 *   AND repeatedly used wins, and a heavily-corrected row is demoted.
 */
export function matchIndexRows(indexText, userTokens, limit = 3, usage) {
	const candidates = [];
	for (const raw of indexText.split('\n')) {
		const s = raw.trim();
		if (!s.startsWith('|') || s.includes('---')) continue;
		const cells = s.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
		if (cells.length < 2 || !cells[1]) continue;
		// Row shape is column-agnostic: the 4-column generation kept the link in
		// cell 3, the 2/3-column one bakes it into cell 1. Scan every cell so an
		// index written by either generation recalls identically — a mixed root
		// (new rows written by this version, old rows still in the 4-column
		// shape) must not silently lose recall coverage.
		// 5.24.0: a skill row links to its HOST bundle (<...>/<name>/SKILL.md) —
		// an absolute file URL, so the location can be any configured skill root
		// (the real one is <dshHome>/skills, but tests inject a temp dir and the
		// row must still be recognized). A SKILL.md href IS a skill, whatever its
		// parent directories are called; the legacy `skills/<name>.md` form is
		// accepted too so an old root keeps recalling.
		const anyHref = cells.map((c) => /\(([^)\s]+\.md)\)/.exec(c)?.[1]).find(Boolean);
		const isSkillHref = Boolean(anyHref) && (/^skills\//.test(anyHref) || /(?:^|\/)SKILL\.md$/.test(anyHref));
		// Zone → row kind, from ONE map. `dao/` was absent from the old inline
		// allow-list, so a dao row (if anyone hand-wrote one) was dropped here: the
		// layer was writable but unreachable by the only path that puts memory in
		// front of the model.
		const ZONE_KIND = { functions: 'function', insights: 'insight', dao: 'dao', capabilities: 'capability' };
		const zoneKey = Boolean(anyHref) && !isSkillHref ? anyHref.split('/')[0] : null;
		const href = anyHref && (isSkillHref || ZONE_KIND[zoneKey]) ? anyHref : undefined;
		if (!href) continue;
		const zone = isSkillHref ? 'skill' : ZONE_KIND[zoneKey];
		if (!zone) continue;
		// A skill row carries its lifecycle in a status cell. Only ACTIVE skills
		// are recallable — a candidate is an unverified procedure and must not
		// shadow the reasoning it was distilled from. The status cell is the one
		// holding exactly one of the three lifecycle words (works for both the
		// 4-column and the 3-column shape).
		// FAIL-CLOSED (5.27.0, adversarial audit): the old condition was
		// `statusCell && statusCell !== 'active'` — a skill row WITHOUT a status
		// cell (hand-edited, legacy shape) defaulted to trusted and entered recall
		// as ⭐ "follow it, do not re-derive". Missing evidence is evidence of
		// nothing; the bundle-vs-row agreement is re-checked by the health lint
		// (R20e), so the row must prove 'active' to fire.
		const statusCell = cells.find((c) => /^(candidate|active|retired)$/.test(c));
		if (zone === 'skill' && statusCell !== 'active') continue;
		// The skill's identity: a bundle href ends <name>/SKILL.md (take the
		// parent directory); the LEGACY `skills/<name>.md` form takes the file
		// basename. The old slice(-2)[0] gave 'skills' for two-segment legacy
		// hrefs — every legacy row then shared one bogus name and name-hit
		// scoring matched nothing real (audit finding; tested with a legacy row).
		const name = zone === 'skill' ? skillNameOf(href) : href.split('/').pop().replace(/\.md$/, '');
		candidates.push({
			name,
			summary: cells[1],
			href,
			zone,
			nameTokens: tokensOf(name),
			bodyTokens: tokensOf(cells.slice(1).join(' ')),
		});
	}
	if (!candidates.length) return [];
	// Document frequency per token across rows → IDF weights.
	const df = new Map();
	for (const c of candidates) {
		for (const tk of new Set([...c.nameTokens, ...c.bodyTokens])) df.set(tk, (df.get(tk) ?? 0) + 1);
	}
	const n = candidates.length;
	const idf = (tk) => 1 + Math.log(n / Math.max(1, df.get(tk) ?? n));
	const scored = [];
	for (const c of candidates) {
		let score = 0;
		for (const tk of userTokens) {
			if (c.nameTokens.has(tk)) score += 2 * idf(tk);
			else if (c.bodyTokens.has(tk)) score += idf(tk);
		}
		if (score > 0) scored.push({ name: c.name, summary: c.summary, href: c.href, zone: c.zone, score });
	}
	scored.sort((a, b) => b.score - a.score);
	// ---- bounded multiplicative boost from the usage signal ----------------
	// FEEDBACK LOOP FIX (2026-10-27), two separate defects:
	//
	// (1) SELF-REFERENCE. Heat used to be `uses + 2*positives`, and `uses`
	//     included the plugin's own recalls — so a recalled row gained heat, and
	//     heat got it recalled again. Measured on a real root: 627 of 667 ledger
	//     lines were self-produced recalls; the top row was recalled 152 times
	//     against 8 real engagements. Fixed in summarizeUsage: `uses` is now
	//     ENGAGEMENT (read + verdicts), `exposure` is reported separately.
	//
	// (2) RRF DISCARDS MAGNITUDE. The previous fusion was Reciprocal Rank Fusion:
	//     a row's rank replaced its score, so a decisive 4.0-vs-2.0 lexical win
	//     collapsed into "adjacent ranks" and one usage term flipped it. A
	//     tie-breaker had become a second opinion that could outvote the user's
	//     actual words. RRF is right when blending two COMPARABLE retrievers
	//     (FTS5 + vectors); here one signal is the user's text and the other is a
	//     popularity prior, so they are not peers and must not be rank-fused.
	//
	// The fix keeps the lexical score's magnitude and applies usage as a BOUNDED
	// multiplier: at most +15%, so it breaks ties and nudges close calls, and can
	// never overturn a real relevance gap. With no usage data the score is exactly
	// the lexical score, so behavior without history is unchanged.
	let ranked = scored;
	if (usage && usage.size) {
		const MAX_BOOST = 0.15;
		// Heat: engagement + 2*positives, demoted by correction rate.
		const heat = new Map();
		let maxHeat = 0;
		for (const [href, u] of usage) {
			const penalty = 1 - Math.min(0.9, u.badRate ?? 0);
			const h = ((u.uses ?? 0) + 2 * (u.positives ?? 0)) * penalty;
			if (h > 0) {
				heat.set(href, h);
				if (h > maxHeat) maxHeat = h;
			}
		}
		if (maxHeat > 0) {
			const boosted = scored.map((r) => {
				const h = heat.get(r.href);
				// Normalized to [0,1] against the hottest row, then scaled into the
				// boost band. A row with no engagement gets exactly its lexical score.
				const rel = h === undefined ? 0 : h / maxHeat;
				return { ...r, score: r.score * (1 + MAX_BOOST * rel), lexical: r.score, heat: rel };
			});
			boosted.sort((a, b) => b.score - a.score);
			ranked = boosted;
		}
	}
	const best = ranked[0]?.score ?? 0;
	const seen = new Set();
	const out = [];
	for (const r of ranked) {
		// Relative cutoff: under 40% of the best fused score.
		if (r.score < best * 0.4) break;
		if (seen.has(r.href)) continue;
		seen.add(r.href);
		const row = { ...r };
		// Insight rows carry their trust level — the same computation as the head
		// line of the file and the R22 lint, so the recall line and the file can
		// never disagree. A principle without usage evidence yet is 待验证.
		if (r.zone === 'insight') row.trust = insightTrust(usage?.get(r.href) ?? {});
		out.push(row);
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * Rows of the index tables, as { name, summary, href, zone } — the same shape
 * matchIndexRows builds, but without scoring. Used to materialize a
 * decision-repair target into a recallable row.
 */

/** Build one recall UserMessage (form 'recall', plugin producer kind). */
export function buildRecallMessage(lines) {
	const hasSkill = lines.some((l) => l.zone === 'skill');
	const hasRepair = lines.some((l) => l.repair);
	const hasShaken = lines.some((l) => l.trust && l.trust.level === '动摇');
	const text = [
		'### 记忆召回（memory-manager）',
		'',
		'本轮用户输入与以下已有记忆的索引行相关。**先查后写**：涉及这些主题时先读对应文件再行动，不要凭空重推已有结论；如确属新工作，正常进行即可：',
		'',
		...lines.map((l) => `- ${l.zone === 'skill' ? '⭐ 已结晶技能：' : ''}${l.repair ? `⚠️ 决策修复（近 7 天纠正 ${l.repair.corrections} 次、纠正率 ${l.repair.badRate}）：` : ''}${l.trust && l.trust.level === '动摇' ? `⚠️ 信任动摇（认可 ${l.trust.positives} · 纠正 ${l.trust.corrections}）：` : ''}${l.summary} → [${l.href}](${l.href})${l.zone === 'skill' ? '（先读程序按步骤走，不要再现场推导）' : ''}`),
		'',
		hasSkill ? 'ℹ 命中 active 技能：这是过去反复验证过的操作程序，优先直接执行其步骤；执行结果与预期不符时，回到来源功能域重新推导。' : '',
		hasRepair ? '⚠️ 决策修复命中：上面标 ⚠️ 的记忆近期被反复纠正——先读它再动手，别在同一个判断上再错一次（当前这一步未被打断）。' : '',
		hasShaken ? '⚠️ 标「信任动摇」的思想：其认可已被纠正追平/反超（信任由使用证据自动计算，见文件头「> 信任：」行）——引用它时先复核，或考虑精炼/取代它。' : '',
	].filter((s) => s !== '').join('\n');
	return {
		role: 'user',
		content: [{ type: 'text', text }],
		source: {
			kind: 'memory-manager/recall',
			form: 'recall',
		},
	};
}
