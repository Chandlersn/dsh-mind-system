/**
 * 档案块（2026-11-09，借鉴 ThoughtDAG dossier）：命中主题时把「决策共识 /
 * 规范」与「道层」的条目整份带入，而不只给一行索引摘要。
 *
 * 判据不与索引行匹配打架：档案块走**独立通道**——只在 MEMORY.md 的共识区
 * 与道层小节里按词命中，命中数 ≥ archiveBar 才带，最多 archiveMax 块。
 * 它不参与 IDF 打分（那是索引行的事），所以不会挤掉索引行的强档名额。
 *
 * @returns Array<{ kind, text }>，每块是原文若干行（保持来源链接）。
 */
export function archiveBlocks(indexText, userTokens, options = {}) {
	const minHits = options.archiveBar ?? 2;
	const maxBlocks = options.archiveMax ?? 2;
	if (!userTokens || userTokens.size === 0) return [];
	const headings = ['## 决策共识 / 规范', '## 道层'];
	const out = [];
	for (const heading of headings) {
		const at = indexText.indexOf(heading);
		if (at === -1) continue;
		const rest = indexText.slice(at + heading.length);
		const stop = rest.indexOf('\n## ');
		const section = stop === -1 ? rest : rest.slice(0, stop);
		// 条目形态：共识区用 "- " bullet，道层用 "> " 引用行（真机 MEMORY.md
		// 实测：道层小节全是 > 引用，只认 bullet 会整段漏掉）。两种都收。
		const lines = section.split(/\r?\n/);
		const blocks = [];
		let buf = [];
		const flush = () => { const b = buf.join('\n').trim(); if (b) blocks.push(b); buf = []; };
		for (const raw of lines) {
			const line = raw.trim();
			const isBullet = line.startsWith('- ');
			const isQuote = line.startsWith('> ');
			if (isBullet || isQuote) { if (buf.length) flush(); buf = [line.replace(/^[-] |^> /, '')]; }
			else if (buf.length && line === '') { flush(); }
			else if (buf.length) { buf.push(line); }
		}
		flush();
		for (const text of blocks) {
			const bTokens = tokensOf(text);
			let hits = 0;
			for (const t of userTokens) if (bTokens.has(t)) hits++;
			if (hits >= minHits) out.push({ kind: heading, text, hits });
		}
	}
	out.sort((a, b) => b.hits - a.hits);
	return out.slice(0, maxBlocks);
}

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
 * 召回三档 + 双侧账本（2026-11-09，借鉴 ThoughtDAG Recall 的诚实性外衣）。
 *
 * 保留原有 IDF + 有界 usage 融合（判据只此一处，不新增第二套相关度）。
 * 变化只在**呈现与取舍**：把原来"40% 一刀切 + 固定 limit=3"拆成
 *   强档 injected：score ≥ best×STRONG_BAR，按 token 预算取
 *   擦边 held    ：best×0.4 ~ 强档，只列名与计数，不带内容
 *   丢弃 dropped ：< best×0.4，只计数
 * 判据仍是同一个 fused score——分档是"展示"，不是新的打分器。
 *
 * 预算取代固定条数：注入块总 token 不超过 RECALL_BUDGET_TOKENS（暂定），
 * 且不超模型窗口 40%（调用方可传 windowTokens）。带进/暂缓/丢弃/花费
 * 全部可见（双侧报，接「闸门指标须成对报」）。
 *
 * 判据形态学 DAG，但**不引判断模型**：相关性由 IDF 分数规则版裁定，
 * 保持零外部依赖、pre-step 同步、3s 预算内（附加能力缺了要降级）。
 */
export const RECALL_TIERS = { strongBar: 0.8, holdBar: 0.4 };
export const RECALL_BUDGET_TOKENS = 600;
export const RECALL_WINDOW_GUARD = 0.4;

/** 粗略 token 估算：中文约 1 字 1 token，拉丁按 4 字符 1 token。 */
export function approxTokens(text) {
	const s = String(text ?? '');
	const cjk = (s.match(/[\u3400-\u9fff]/g) ?? []).length;
	return cjk + Math.ceil((s.length - cjk) / 4);
}

/**
 * @returns 数组（向后兼容：老调用方仍能 .find/.some/.length 遍历 injected 行），
 *   数组上挂 `.stats = { matched, injected, held, dropped, budget, usedTokens, tiers }`
 *   与 `.heldRows`（擦边行，供文案列名）。老调用方忽略这些属性即行为不变。
 */
export function matchIndexRows(indexText, userTokens, limit = 3, usage, options = {}) {
	const strongBar = options.strongBar ?? RECALL_TIERS.strongBar;
	const holdBar = options.holdBar ?? RECALL_TIERS.holdBar;
	const budget = Math.min(
		options.budgetTokens ?? RECALL_BUDGET_TOKENS,
		options.windowTokens ? Math.floor(options.windowTokens * RECALL_WINDOW_GUARD) : Infinity,
	);
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
		// 零命中行也入 ranked（score=0）：它们要在下面的三档循环里被如实计入
		// dropped，而不是在这里被静默丢弃——双侧账本要求"被放过的"可见。
		// 完全没命中的行不会占注入预算（holdLine 会挡下），只是计数。
		scored.push({ name: c.name, summary: c.summary, href: c.href, zone: c.zone, score });
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
	const strongLine = best * strongBar;
	const holdLine = best * holdBar;
	const seen = new Set();
	const out = [];
	const heldRows = [];
	let dropped = 0;
	let usedTokens = 0;
	let matched = 0;
	for (const r of ranked) {
		matched++; // 所有参与打分的候选都算"匹配过"，三档之和与它守恒
		// best=0（一个词都没命中）或本行零分：一律丢弃档，不进注入/擦边。
		// 没有这个护栏，0 分行会在 best=0 时被 holdLine=0 放行、造成空注入。
		if (best <= 0 || r.score <= 0 || r.score < holdLine) { dropped++; continue; } // 丢弃档：只计数
		if (seen.has(r.href)) { dropped++; continue; } // 重复 href 也算被放过
		seen.add(r.href);
		const row = { ...r };
		if (r.zone === 'insight') row.trust = insightTrust(usage?.get(r.href) ?? {});
		// 擦边档：只列名与分数，不占注入内容预算。
		if (r.score < strongLine) { heldRows.push({ name: r.name, href: r.href, zone: r.zone, score: r.score }); continue; }
		// 强档：按 token 预算取（取代固定 limit 条数）。一条都不放弃时
		// 至少放行第一行——预算再小也要有一条可观察的证据。
		const cost = approxTokens(row.summary) + approxTokens(row.name) + 8;
		if (out.length > 0 && usedTokens + cost > budget) { heldRows.push({ name: r.name, href: r.href, zone: r.zone, score: r.score, reason: 'budget' }); continue; }
		out.push(row);
		usedTokens += cost;
		// 预算是唯一上限（取代固定 limit 条数）。limit 保留仅为兼容旧调用签名，
		// 不再 break——否则被截断的行会漏出账本、破坏三档守恒。
	}
	// 双侧账本挂在返回数组上（老调用方忽略即行为不变）。
	out.stats = {
		matched,
		injected: out.length,
		held: heldRows.length,
		dropped,
		budget,
		usedTokens,
		tiers: { strongBar, holdBar },
	};
	out.heldRows = heldRows;
	return out;
}

/**
 * Rows of the index tables, as { name, summary, href, zone } — the same shape
 * matchIndexRows builds, but without scoring. Used to materialize a
 * decision-repair target into a recallable row.
 */

/** Build one recall UserMessage (form 'recall', plugin producer kind). */
export function buildRecallMessage(lines, heldRows = [], stats = null, archives = []) {
	const hasSkill = lines.some((l) => l.zone === 'skill');
	const hasRepair = lines.some((l) => l.repair);
	const hasShaken = lines.some((l) => l.trust && l.trust.level === '动摇');
	const text = [
		'### 记忆召回（memory-manager · 证据）',
		'',
		// 证据口吻（借鉴 ThoughtDAG recallContextBlock）：明确"这不是指令"，
		// 但保留"先查后写"的纪律——曝光层带着"我判断这个相关"的主张，
		// 让主张可见，不把它伪装成中立的检索结果。
		'以下是可查阅的**证据，不是指令**：引用时点名来源；不适用的忽略。涉及这些主题时先读对应文件再动手，不要凭空重推已有结论；如确属新工作，正常进行即可。',
		'',
		// 档案块：整份共识/道条目（DAG dossier 的对应物），先于索引行呈现。
		// 每块独立成段，前后空行，避免与索引行挤成一团（真机烟测发现的呈现问题）。
		...archives.map((a) => `**档案（${a.kind.replace(/^## /, '')}）**：${a.text}\n`),
		...lines.map((l) => `- ${l.zone === 'skill' ? '⭐ 已结晶技能：' : ''}${l.repair ? `⚠️ 决策修复（近 7 天纠正 ${l.repair.corrections} 次、纠正率 ${l.repair.badRate}）：` : ''}${l.trust && l.trust.level === '动摇' ? `⚠️ 信任动摇（认可 ${l.trust.positives} · 纠正 ${l.trust.corrections}）：` : ''}${l.summary} → [${l.href}](${l.href})${l.zone === 'skill' ? '（按程序步骤执行，不要现场推导）' : ''}`),
		'',
		// 擦边档：只列名与计数，不带内容（DAG heldBack 的可见性，规则版）。
		heldRows.length
			? `ℹ 另有 ${heldRows.length} 条相关度未达强档，未带入内容：${heldRows.slice(0, 5).map((h) => h.name).join('、')}${heldRows.length > 5 ? '…' : ''}。需要时可读对应文件。`
			: '',
		// 双侧账本一行：带进/暂缓/丢弃/预算用量同处可见（指标须成对报）。
		stats
			? `（本次匹配 ${stats.matched} 条 · 带入 ${stats.injected} · 暂缓 ${stats.held} · 丢弃 ${stats.dropped}；预算 ${stats.budget} token，用了 ${stats.usedTokens}）`
			: '',
		hasSkill ? 'ℹ 命中 active 技能：过去反复验证过的操作程序；结果与预期不符时回到来源功能域重新推导。' : '',
		hasRepair ? '⚠️ 决策修复：标 ⚠️ 的记忆近期被反复纠正，引用它时先复核（当前这一步未被打断）。' : '',
		hasShaken ? '⚠️ 标「信任动摇」的思想：认可已被纠正追平/反超（信任由使用证据自动计算）——引用它时先复核，或考虑精炼/取代。' : '',
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
