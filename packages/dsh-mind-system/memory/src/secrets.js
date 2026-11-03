/**
 * Memory defence (Hindsight-borrowed, adapted): scan every write for credential
 * material before it reaches disk. Two tiers with two actions:
 *
 * - TIER 1 — credentials (API keys, tokens, private keys, JWTs): REDACT before
 *   write. A secret in a plain-text memory root is an accident waiting to be
 *   synced; the `[REDACTED:kind]` marker preserves the fact that something was
 *   here without the payload.
 * - TIER 2 — personal identifiers (mainland-China ID / phone): never modified
 *   (they are often legitimate facts), only reported by the health check (R21)
 *   so the model/user can decide.
 *
 * Patterns are high-entropy / fixed-prefix on purpose: false positives would
 * silently mangle knowledge, which is worse than a missed exotic secret.
 * Deliberately NOT matched: `sk-xxx` placeholders (too short), `D:\dsh` style
 * env assignments (no 16+ credential charset), bare words like "apiKey 管理".
 */

/** Tier 1: redacted on write. [kind, pattern] — all global. */
const TIER1 = [
	['openai-key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g],
	['github-token', /\bgh[pousr]_[A-Za-z0-9]{36}\b/g],
	['github-fine-grained', /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g],
	['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
	['aws-key', /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g],
	['gcloud-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
	['stripe-key', /\b[rs]k_live_[A-Za-z0-9]{20,}\b/g],
	['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g],
	['hf-token', /\bhf_[A-Za-z0-9]{34,}\b/g],
	['telegram-bot', /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g],
	['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
	['private-key-block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g],
	// key=value / key: value assignments where the NAME says credential and the
	// VALUE is credential-shaped (16+ chars of the credential alphabet).
	['credential-assignment', /(?:api[_-]?key|secret|token|passwd|password|private[_-]?token)\s*[:=]\s*(?:"[A-Za-z0-9+/_=-]{16,}"|'[A-Za-z0-9+/_=-]{16,}'|[A-Za-z0-9+/_=-]{16,})/gi],
];

/** Tier 2: reported by the health check, never rewritten. */
const TIER2 = [
	['cn-id', /(?<![0-9])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9])/g],
	['cn-phone', /(?<![0-9])1[3-9]\d{9}(?![0-9])/g],
];

/**
 * Redact all tier-1 findings. Returns `{ text, hits }`; `hits` lists the kinds
 * found (deduped) so callers can surface a warning in the tool receipt.
 */
export function redactSecrets(text) {
	let out = String(text ?? '');
	const hits = [];
	for (const [kind, re] of TIER1) {
		out = out.replace(re, () => {
			if (!hits.includes(kind)) hits.push(kind);
			return `[REDACTED:${kind}]`;
		});
	}
	return { text: out, hits };
}

/** Count every tier-1/tier-2 finding without modifying anything (health check). */
export function scanSecrets(text) {
	const findings = [];
	const body = String(text ?? '');
	for (const [kind, re] of TIER1) {
		const m = body.match(re);
		if (m) findings.push({ kind, tier: 1, count: m.length });
	}
	for (const [kind, re] of TIER2) {
		const m = body.match(re);
		if (m) findings.push({ kind, tier: 2, count: m.length });
	}
	return findings;
}
