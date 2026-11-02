/**
 * Canonical file templates + markdown surgery (index rows, sections, open-item
 * resolution). Pure text handling — no Host dependency, no tool definitions.
 */
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { oneLine, writeText } from './util.js';
import {
	FUNC_TABLE_HEADING,
	INSIGHT_TABLE_HEADING,
	CAP_TABLE_HEADING,
	CAP_TABLE_SUFFIX,
	LEGACY_CAP_TABLE_HEADING,
	SKILL_TABLE_HEADING,
	FUNC_TABLE_HEADER,
	INSIGHT_TABLE_HEADER,
	CAP_TABLE_HEADER,
	SKILL_TABLE_HEADER,
	LEGACY_FUNC_TABLE_HEADER,
	LEGACY_INSIGHT_TABLE_HEADER,
	LEGACY_CAP_TABLE_HEADER,
	LEGACY_SKILL_TABLE_HEADER,
	GUARD_LINE,
} from './constants.js';

// ---------------------------------------------------------------------------
// canonical file templates
// ---------------------------------------------------------------------------

export function memoryIndexTemplate() {
	return [
		'# 记忆管理（索引 + 纪律）',
		'',
		'> 读取纪律：先查本索引（行内摘要足以判断相关性），再打开对应 functions/ 文件；日期不是骨架，只做迭代标签。',
		'> 数据流：每日记录（原始层，自由格式）→ memory_write 蒸馏出 functions/ 迭代块 → memory_insight 提取 insights/ 思想 → memory_index 收进本索引（整合展示层）→ memory_skill 把反复验证的操作程序结晶为宿主技能目录包（使用环收口）。本文件是派生物，不与单次写入强绑。',
		'> 性质三分：可复跑的操作进 functions/，可重套的原则进 insights/（回链来源），反复执行且被验证的操作程序结晶为宿主技能目录包 <dshHome>/skills/<kebab>/（candidate→active→retired）；共识/规范与环境常量只留在本文件。',
		'',
		`${FUNC_TABLE_HEADING}（functions/）`,
		'',
		FUNC_TABLE_HEADER,
		'|---|---|',
		'',
		`${INSIGHT_TABLE_HEADING}（insights/）`,
		'',
		INSIGHT_TABLE_HEADER,
		'|---|---|',
		'',
		`${CAP_TABLE_HEADING}${CAP_TABLE_SUFFIX}`,
		'',
		CAP_TABLE_HEADER,
		'|---|---|',
		'',
		`${SKILL_TABLE_HEADING}（宿主目录包）`,
		'',
		SKILL_TABLE_HEADER,
		'|---|---|---|',
		'',
		'## 决策共识 / 规范（跨功能、约束级）',
		'',
		'- ',
		'',
		'## 环境常量（易忘）',
		'',
		'- ',
		'',
		'## 细节指针（跨功能的详细论证存放处）',
		'',
		'- ',
		'',
	].join('\n');
}

export function functionFileTemplate(feature, date, guard = false) {
	return [
		`# ${feature}迭代历程`,
		'',
		`> 范围：${feature} 的代码路径、约束与迭代决策；本文件自包含，细节不回指 MEMORY.md。`,
		...(guard ? [GUARD_LINE] : []),
		'',
		`## 当前状态摘要（截至 ${date}）`,
		'',
		'- （当前稳定行为 / 关键约束 / 隐患）',
		'',
		'---',
		'',
		'<!-- 迭代块按时间顺序追加在文件末尾：最早在上，最新在下；每块只写蒸馏结论（动因/改动/判据/待观察 各一句），过程流水留在会话与代码里 -->',
		'',
	].join('\n');
}

export function dailyTemplate(date) {
	return [
		`# ${date} 记录`,
		'',
		'> 本文件是原始层：任务与对话过程的第一手数据，内容与格式由你（模型/harness）自主决策，插件不做任何约束。蒸馏时插件从这里归纳功能划分——记录得越真实，功能域的依据越扎实。',
		'> 只有一条轻过滤：执行式日志（命令输出、PID、退出码、耗时流水）别抄——会话与日志文件里本来就有，抄进来只会稀释蒸馏原料。值得记的是日志里没有的：判断与取舍、用户原话、踩坑的因果、待验证的下一步。',
		'',
	].join('\n');
}

export function insightTemplate(theme, principle, srcLine, evolution, applicability, open, date) {
	const parts = [
		`# 创新优化思想：${theme}`,
		'',
		'> 性质：可重套的原则（不是可重跑的操作）；操作细节留在来源 functions/ 文件。',
		'> 信任：待验证（认可 0 · 纠正 0，由 memory_insight 按 .usage.jsonl 自动刷新）',
		`> 来源：${srcLine}`,
		'',
		'## 核心原则',
		'',
		`- ${principle}`,
		'',
		'## 思想演进',
		'',
		`- ${date} 首次沉淀`,
	];
	if (evolution) parts.push(`- ${oneLine(evolution)}`);
	parts.push('', '## 适用面（超出来源功能的部分）', '');
	if (applicability) parts.push(`- ${oneLine(applicability)}`, '');
	parts.push('## 待观察', '');
	if (open) parts.push(`- ${oneLine(open)}`, '');
	return parts.join('\n');
}

// ---------------------------------------------------------------------------
// markdown surgery (index rows / sections)
// ---------------------------------------------------------------------------

export function sepOf(headerRow) {
	const cols = headerRow.split('|').length - 2;
	return '|' + Array.from({ length: cols }, () => '---').join('|') + '|';
}

/**
 * A zone's current header row maps to the pre-5.15.0 four-column header it
 * replaced. A root written by either generation must be recognized as the same
 * table, or the twin/self-heal logic silently ignores the old half.
 */
const HEADER_LINEAGE = new Map([
	[FUNC_TABLE_HEADER, LEGACY_FUNC_TABLE_HEADER],
	[INSIGHT_TABLE_HEADER, LEGACY_INSIGHT_TABLE_HEADER],
	[CAP_TABLE_HEADER, LEGACY_CAP_TABLE_HEADER],
	[SKILL_TABLE_HEADER, LEGACY_SKILL_TABLE_HEADER],
]);

/**
 * The slug a row's first CONTENT cell stands for. `'| a | b |'.split('|')`
 * yields ['', ' a ', ' b ', ''], so the name lives at index 1 — and since 5.15.0
 * that cell carries the link (`[name](functions/name.md)`) instead of plain
 * text. Both shapes must map to the same key, or an upsert appends a row for a
 * slug that is already there.
 */
export function rowSlug(line) {
	const cells = String(line ?? '').split('|');
	const first = (cells.length >= 2 ? cells[1] : cells[0] ?? '').trim();
	const m = /^\[([^\]]+)\]\([^)]*\)$/.exec(first);
	return m ? m[1] : first;
}

/**
 * Upsert one index row into the table under `headingPrefix` (first cell match).
 * Creates the section at the end when the table is missing.
 *
 * `group` (optional) writes the row into a `### 索引·<group>` sub-section — the
 * scale escape hatch: past ~40 function rows the single table is split by
 * domain, and the index must still upsert into the RIGHT sub-table instead of
 * appending to whichever table happens to come first.
 */
/**
 * Remove one row (by first-cell slug) from the table under `headingPrefix`,
 * wherever it lives — the flat table or any `### 索引·<域>` sub-section. The
 * mirror of upsertIndexRow for the delete path (a deleted artifact must not
 * leave a dangling index row behind). Same rowSlug resolution, same section
 * bounds, no other line touched. Returns the text unchanged when absent.
 */
export function dropIndexRow(indexText, headingPrefix, headerRow, firstCell) {
	const lines = String(indexText ?? '').split('\n');
	let secStart = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith(headingPrefix)) {
			secStart = i;
			break;
		}
	}
	if (secStart === -1) return indexText;
	let secEnd = lines.length;
	for (let i = secStart + 1; i < lines.length; i++) {
		if (lines[i].startsWith('## ')) {
			secEnd = i;
			break;
		}
	}
	const before = lines.length;
	for (let i = secEnd - 1; i > secStart; i--) {
		if (!lines[i].startsWith('|')) continue;
		if (rowSlug(lines[i]) === firstCell) lines.splice(i, 1);
	}
	return lines.length === before ? indexText : lines.join('\n');
}

export function upsertIndexRow(indexText, headingPrefix, headerRow, firstCell, newRow, group) {
	const lines = indexText.split('\n');
	let secStart = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith(headingPrefix)) {
			secStart = i;
			break;
		}
		// 5.15.2 renamed the capability heading (`## 能力台账（可用工具 / MCP /
		// CLI）` → `## 能力台账 细节子目录（…）`). Migrate the old anchor IN
		// PLACE: a pre-rename root must hit the same table here, not fall
		// through to the create path and twin it.
		if (headingPrefix === CAP_TABLE_HEADING && lines[i].startsWith(LEGACY_CAP_TABLE_HEADING)) {
			lines[i] = `${CAP_TABLE_HEADING}（可用工具 / MCP / CLI）`;
			secStart = i;
			break;
		}
	}
	if (secStart === -1) {
		const t = indexText.replace(/\n*$/, '\n');
		// A self-describing anchor (it already carries the 细节 note) gets no
		// suffix — stacking `（细节在子目录）` after it produced the doubled
		// paren this rename set out to remove.
		const heading = /细节/.test(headingPrefix) ? headingPrefix : `${headingPrefix}（细节在子目录）`;
		if (group) {
			return `${t}\n${heading}\n\n### 索引·${group}\n\n${headerRow}\n${sepOf(headerRow)}\n${newRow}\n`;
		}
		return `${t}\n${heading}\n\n${headerRow}\n${sepOf(headerRow)}\n${newRow}\n`;
	}
	// Self-heal: a heading that only STARTS WITH the anchor prefix (an older
	// template generation, e.g. `## 功能域（细节在子目录，本表只留指针）` under a
	// `## 功能域` anchor) is the same table duplicated by the fallback path.
	// Keep the first occurrence; drop every later one including its data rows,
	// so the next upsert edits the real table instead of appending a twin.
	// Generation-rename twins (heading no longer shares the prefix but carries
	// the same table header row, e.g. `## 功能域（…）` vs `## 功能模块索引…`)
	// are recognized by that header row instead of the heading text.
	for (let i = lines.length - 1; i > secStart; i--) {
		if (!lines[i].startsWith('## ')) continue;
		// Accept this zone's CURRENT header AND the legacy four-column one: a root
		// written by either generation is the same table, not a twin.
		const legacyHeader = HEADER_LINEAGE.get(headerRow);
		const sameTable = lines[i].startsWith(headingPrefix) || lines[i + 2] === headerRow || (legacyHeader && lines[i + 2] === legacyHeader);
		if (!sameTable) continue;
		let end = i + 1;
		while (end < lines.length && !lines[end].startsWith('## ')) end++;
		lines.splice(i, end - i);
	}
	// Section bounds: the next `## ` heading ends this section (a `### ` sub
	// heading does not, it belongs to the same zone).
	let secEnd = lines.length;
	for (let i = secStart + 1; i < lines.length; i++) {
		if (lines[i].startsWith('## ')) {
			secEnd = i;
			break;
		}
	}
	// Upsert into the first table inside [from, to): replace the row whose first
	// cell matches, else append after the last row. Returns false when the range
	// holds no table at all.
	const upsertIn = (from, to) => {
		let headIdx = -1;
		for (let i = from; i < to; i++) {
			if (lines[i].startsWith('|')) {
				headIdx = i;
				break;
			}
		}
		if (headIdx === -1) return false;
		let end = headIdx + 1;
		while (end < to && lines[end].startsWith('|')) end++;
		for (let i = headIdx + 1; i < end; i++) {
			if (rowSlug(lines[i]) === firstCell) {
				lines[i] = newRow;
				return true;
			}
		}
		lines.splice(end, 0, newRow);
		return true;
	};
	if (group) {
		const subHead = `### 索引·${group}`;
		// Grouping is a MIGRATION: if the row already exists in another table of
		// this zone (typically the flat top-level table it is moving out of),
		// drop those copies first — otherwise splitting the table duplicates the
		// row and trips R15 on the very next check.
		for (let i = lines.length - 1; i > secStart; i--) {
			if (i >= secEnd) continue;
			if (!lines[i].startsWith('|')) continue;
			if (rowSlug(lines[i]) === firstCell) lines.splice(i, 1);
		}
		// Bounds may have shifted after the purge; re-derive them.
		secEnd = lines.length;
		for (let i = secStart + 1; i < lines.length; i++) {
			if (lines[i].startsWith('## ')) {
				secEnd = i;
				break;
			}
		}
		let subStart = -1;
		for (let i = secStart + 1; i < secEnd; i++) {
			if (lines[i].startsWith(subHead)) {
				subStart = i;
				break;
			}
		}
		if (subStart === -1) {
			// New sub-section at the end of the zone (trailing blanks trimmed).
			let at = secEnd;
			while (at > secStart + 1 && lines[at - 1].trim() === '') at--;
			lines.splice(at, 0, '', subHead, '', headerRow, sepOf(headerRow), newRow);
			return lines.join('\n');
		}
		let subEnd = secEnd;
		for (let i = subStart + 1; i < secEnd; i++) {
			if (lines[i].startsWith('### ')) {
				subEnd = i;
				break;
			}
		}
		if (!upsertIn(subStart + 1, subEnd)) lines.splice(subStart + 1, 0, '', headerRow, sepOf(headerRow), newRow);
		return lines.join('\n');
	}
	let headIdx = -1;
	// UNGROUPED upsert is a migration OUT of any `### 索引·<group>` sub-table:
	// the row must not survive in a sub-section while landing in the flat table
	// (that duplication is exactly what R15 catches on the next check). Purge
	// matching rows inside sub-sections ONLY (the flat table keeps its in-place
	// replace), then drop sub-sections left with no data row.
	{
		let inSub = false;
		for (let i = secStart + 1; i < secEnd; i++) {
			if (lines[i].startsWith('## ')) break;
			if (lines[i].startsWith('### ')) {
				inSub = lines[i].startsWith('### 索引·');
				continue;
			}
			if (!inSub || !lines[i].startsWith('|')) continue;
			if (rowSlug(lines[i]) === firstCell) lines.splice(i, 1);
		}
	}
	for (let i = lines.length - 1; i > secStart; i--) {
		if (i >= secEnd || !lines[i].startsWith('### 索引·')) continue;
		let j = i + 1;
		while (j < secEnd && !lines[j].startsWith('#')) j++;
		const hasData = lines
			.slice(i, j)
			.some((l) => l.startsWith('|') && l !== headerRow && !/^[-: |]+$/.test(l));
		if (!hasData) {
			let from = i;
			while (from > secStart && lines[from - 1].trim() === '') from--;
			let to = j;
			while (to < secEnd && lines[to].trim() === '') to++;
			lines.splice(from, to - from);
		}
	}
	secEnd = lines.length;
	for (let i = secStart + 1; i < lines.length; i++) {
		if (lines[i].startsWith('## ')) {
			secEnd = i;
			break;
		}
	}
	for (let i = secStart + 1; i < secEnd; i++) {
		if (lines[i].startsWith('|')) {
			headIdx = i;
			break;
		}
	}
	if (headIdx === -1) {
		lines.splice(secStart + 1, 0, '', headerRow, sepOf(headerRow), newRow);
		return lines.join('\n');
	}
	let end = headIdx + 1;
	while (end < lines.length && lines[end].startsWith('|')) end++;
	for (let i = headIdx + 1; i < end; i++) {
		if (rowSlug(lines[i]) === firstCell) {
			lines[i] = newRow;
			return lines.join('\n');
		}
	}
	lines.splice(end, 0, newRow);
	return lines.join('\n');
}

/**
 * Append one bullet under `sectionHeading` (section created at end when
 * missing). An exact duplicate of an existing bullet in the same section is
 * detected and reported instead of appended — the daily thread is an audit
 * trail, so a repeated line is a data bug, not content.
 */
export function appendUnderHeading(text, sectionHeading, line) {
	const lines = text.split('\n');
	let secStart = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith(sectionHeading)) {
			secStart = i;
			break;
		}
	}
	if (secStart === -1) {
		const t = text.replace(/\n*$/, '\n');
		return { text: `${t}\n${sectionHeading}\n\n${line}\n`, duplicate: false };
	}
	let end = secStart + 1;
	while (end < lines.length && !lines[end].startsWith('## ')) end++;
	const body = lines.slice(secStart + 1, end);
	if (body.some((l) => l.trim() === line.trim())) {
		return { text: lines.join('\n'), duplicate: true };
	}
	let at = end;
	while (at > secStart + 1 && lines[at - 1].trim() === '') at--;
	lines.splice(at, 0, line);
	return { text: lines.join('\n'), duplicate: false };
}

/**
 * Mark still-open daily-log entries that reference `feature` with a ✅ resolved
 * stamp (the R2 "勾掉" move): the thread stays in the day it was raised, gains
 * a bare ✅ (no second pointer), and is never re-copied forward. The raw layer
 * is free-form, so this scans every bullet that links the feature file — no
 * fixed section heading is required. Applies to every daily log from
 * `sinceDate` to today. Returns files touched.
 */
export async function resolveOpenItems(root, feature, sinceDate, today) {
	const touched = [];
	try {
		for (const f of await readdir(root)) {
			if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue;
			if (f.slice(0, 10) < sinceDate) continue;
			if (f.slice(0, 10) > today) continue;
			const p = path.join(root, f);
			const text = await readFile(p, 'utf8');
			const lines = text.split('\n');
			let changed = false;
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].includes('✅')) continue;
				if (!lines[i].includes(`functions/${feature}.md`)) continue;
				// Only thread lines (raise site): a bullet that links the feature
				// file. Resolution notes are added inline at the raise site.
				if (!/^- .+→/.test(lines[i])) continue;
				// The raise-site line already ends with a link to the same file —
				// appending the full resolution pointer would duplicate the target
				// twice in one row. Stamp a bare marker instead.
				lines[i] = `${lines[i]}（✅ ${today} 已解决）`;
				changed = true;
			}
			if (changed) {
				await writeText(p, lines.join('\n'));
				touched.push(f);
			}
		}
	} catch {
		/* root absent */
	}
	return touched;
}

/** Replace the `## 当前状态摘要` heading date + bullets with fresh content. */
export function refreshSummarySection(fnText, date, currentState) {
	const lines = fnText.split('\n');
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith('## 当前状态摘要')) {
			start = i;
			break;
		}
	}
	const newHeading = `## 当前状态摘要（截至 ${date}）`;
	const body = currentState
		.split('\n')
		.map((s) => `- ${oneLine(s)}`)
		.filter((s) => s !== '- ');
	if (start === -1) {
		let at = lines.length;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].startsWith('## ')) {
				at = i;
				break;
			}
		}
		lines.splice(at, 0, newHeading, '', ...body, '');
		return lines.join('\n');
	}
	let end = start + 1;
	while (end < lines.length && !lines[end].startsWith('## ') && lines[end].trim() !== '---') end++;
	lines.splice(start, end - start, newHeading, '', ...body, '');
	return lines.join('\n');
}

/** Replace one section's body (up to the next `## ` heading) with `body`. */
export function replaceSection(text, heading, body) {
	const lines = text.split('\n');
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith(heading)) {
			start = i;
			break;
		}
	}
	if (start === -1) return text;
	let end = start + 1;
	while (end < lines.length && !lines[end].startsWith('## ')) end++;
	lines.splice(start + 1, end - start - 1, '', body, '');
	return lines.join('\n');
}

