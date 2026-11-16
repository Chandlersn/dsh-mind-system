/**
 * LayerTrace — the execution-side record that makes "how did this rule reach
 * that action" answerable from disk.
 *
 * WHY THIS EXISTS (plan node V-1, and the acceptance rows F2 / F3 / N3):
 * The decision ledger already records WHAT the valve decided. It cannot answer
 * three questions a rollback or a post-mortem actually asks:
 *
 *   layer_path      Which layers did this decision travel through, in order?
 *                   Without it a single-layer check and a full L0→L3 pass look
 *                   identical in the ledger, so F2/F3 can never be accepted.
 *   rule_versions   WHICH VERSION of each rule was in force at that moment?
 *                   A rule edited after the fact otherwise makes old decisions
 *                   look like they were made under the current text.
 *   budget_usage    How close to the ceiling was the batch? An "ok" that only
 *                   just fit is not the same evidence as one with headroom.
 *   gate_decisions  Which gates ran, and which were SKIPPED and why? A gate that
 *                   never ran must never read as a gate that passed.
 *
 * DESIGN RULES (non-negotiable, same discipline as the rest of the package):
 *   1. Never rewrite an old trace. Migration maps names at read time only
 *      (see layerchange.js) — history stays as it was written.
 *   2. Unknown stays unknown. A field that could not be observed is `null`,
 *      never a zero or an empty object that reads like "nothing happened".
 *   3. Recording must never break execution: every writer here is best-effort
 *      and returns a boolean, exactly like appendDecision.
 *   4. No second store. Traces ride the SAME ledger file so a reader cannot
 *      see decisions without their traces.
 */
import { appendDecision } from './store.js';

/** The four contract fields. Anything else on a trace is extra. */
export const TRACE_FIELDS = Object.freeze(['layer_path', 'rule_versions', 'budget_usage', 'gate_decisions']);

/**
 * A layer path is an ordered list of layer names the decision actually visited.
 * We keep it a plain array of non-empty strings so it survives JSON round-trips
 * and can be rendered as an arrow chain.
 *
 * @param {unknown} value
 * @returns {string[] | null} null = not observed (never [] which reads as "no layers")
 */
export function normalizeLayerPath(value) {
	if (!Array.isArray(value)) return null;
	const out = value.map((v) => String(v ?? '').trim()).filter(Boolean);
	return out.length ? out : null;
}

/**
 * rule_versions maps layer → version string. A missing version is unknown, so we
 * keep only entries that actually carry a non-empty string; an entirely empty
 * map becomes null (unknown) rather than `{}` (which would claim "no rules").
 */
export function normalizeRuleVersions(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const out = {};
	for (const [k, v] of Object.entries(value)) {
		const key = String(k ?? '').trim();
		const ver = typeof v === 'string' ? v.trim() : '';
		if (key && ver) out[key] = ver;
	}
	return Object.keys(out).length ? out : null;
}

/**
 * budget_usage = { items, rows, maxItems, maxRows, over }.
 * We record BOTH the actual sizes and the ceilings, because "44 of 120" is
 * evidence and "ok" is not. Non-finite numbers become null, never 0.
 */
export function normalizeBudgetUsage(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const num = (v) => (Number.isFinite(v) ? v : null);
	const usage = {
		items: num(value.items),
		rows: num(value.rows),
		maxItems: num(value.maxItems),
		maxRows: num(value.maxRows),
		over: typeof value.over === 'boolean' ? value.over : null,
	};
	if (Object.values(usage).every((v) => v === null)) return null;
	return usage;
}

/**
 * gate_decisions = [{ gate, result, reason? }].
 * `result` is deliberately a small closed set so a reader can never confuse
 * "skipped" with "passed": passed | failed | skipped | human_gate.
 */
export const GATE_RESULTS = Object.freeze(['passed', 'failed', 'skipped', 'human_gate']);

export function normalizeGateDecisions(value) {
	if (!Array.isArray(value)) return null;
	const out = [];
	for (const g of value) {
		if (!g || typeof g !== 'object') continue;
		const gate = String(g.gate ?? '').trim();
		const result = String(g.result ?? '').trim();
		if (!gate || !GATE_RESULTS.includes(result)) continue;
		const row = { gate, result };
		const reason = typeof g.reason === 'string' ? g.reason.trim() : '';
		if (reason) row.reason = reason;
		out.push(row);
	}
	return out.length ? out : null;
}

/**
 * Build a trace payload from a raw attempt. Every field is normalized to
 * null-when-unknown; the caller decides whether a null field is acceptable for
 * the path it is on (a single-layer check legitimately has a one-element path,
 * but a claimed full-chain pass with a null path is a lie and the acceptance
 * check in verifyTraceFields will reject it).
 */
export function buildTrace({ layerPath, ruleVersions, budgetUsage, gateDecisions, ...rest } = {}) {
	return {
		...rest,
		layer_path: normalizeLayerPath(layerPath),
		rule_versions: normalizeRuleVersions(ruleVersions),
		budget_usage: normalizeBudgetUsage(budgetUsage),
		gate_decisions: normalizeGateDecisions(gateDecisions),
	};
}

/**
 * Append one trace to the SAME ledger the decisions live in.
 * `kind: 'trace'` marks the row so readers can separate decision rows from
 * trace rows without a second file.
 */
export async function appendTrace(storageDir, payload) {
	const trace = buildTrace(payload ?? {});
	return appendDecision(storageDir, { kind: 'trace', ...trace });
}

/**
 * Acceptance check for V-1: does this trace satisfy the contract?
 *
 * Returns { ok, missing[], skipped_gates[] }.
 * The one rule worth spelling out: a gate that was SKIPPED does not count as
 * evidence that the gate passed, so it is reported separately and does NOT by
 * itself make the trace incomplete — but `missing` lists fields that were never
 * observed, and those must be empty for a trace to be accepted.
 */
export function verifyTraceFields(trace) {
	const missing = [];
	const skipped = [];
	if (!trace || typeof trace !== 'object') return { ok: false, missing: [...TRACE_FIELDS], skipped_gates: [] };
	if (!normalizeLayerPath(trace.layer_path)) missing.push('layer_path');
	if (!normalizeRuleVersions(trace.rule_versions)) missing.push('rule_versions');
	if (!normalizeBudgetUsage(trace.budget_usage)) missing.push('budget_usage');
	if (!normalizeGateDecisions(trace.gate_decisions)) missing.push('gate_decisions');
	for (const g of normalizeGateDecisions(trace.gate_decisions) ?? []) {
		if (g.result === 'skipped') skipped.push(g.gate);
	}
	return { ok: missing.length === 0, missing, skipped_gates: skipped };
}

/** Trace rows only (decision rows carry no `kind: 'trace'`). */
export function traceRows(entries) {
	return Array.isArray(entries) ? entries.filter((e) => e && e.kind === 'trace') : [];
}

/**
 * Fold a layer path into a display chain: `L0 → L3 → L1`.
 * Kept here (not in the client) so the panel and the report agree by
 * construction — the display must not reinterpret the stored order.
 */
export function layerChain(trace) {
	const path = normalizeLayerPath(trace?.layer_path);
	return path ? path.join(' → ') : null;
}
