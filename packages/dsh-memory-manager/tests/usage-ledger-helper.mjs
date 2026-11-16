/**
 * Shared test helper for the usage ledger.
 *
 * The ledger moved to monthly shards (`.usage/YYYY-MM.jsonl`) with the legacy
 * `.usage.jsonl` still readable. Tests therefore must not hardcode either path:
 *   - to INSPECT what was logged, read both (newest wins for ordering)
 *   - to WAIT for an event, poll both
 *   - to SEED history, the legacy file is still valid input (that is the
 *     compatibility contract), and seeding it keeps old tests meaningful
 */
import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';

/** Every ledger file that exists for this root, legacy first then shards. */
export async function usageLedgerFiles(root) {
	const files = [];
	const legacy = path.join(root, '.usage.jsonl');
	try {
		await readFile(legacy, 'utf8');
		files.push(legacy);
	} catch {
		/* absent */
	}
	try {
		const dir = path.join(root, '.usage');
		for (const n of (await readdir(dir)).filter((x) => /^\d{4}-\d{2}\.jsonl$/.test(x)).sort()) {
			files.push(path.join(dir, n));
		}
	} catch {
		/* no shard dir */
	}
	return files;
}

/** Concatenated text of the whole ledger (new and old layout). */
export async function readUsageLedgerText(root) {
	let out = '';
	for (const f of await usageLedgerFiles(root)) {
		try {
			out += `${await readFile(f, 'utf8')}\n`;
		} catch {
			/* raced away */
		}
	}
	return out;
}

/**
 * Poll the WHOLE ledger until `needle` appears (or the budget runs out).
 * Returns the text at match time, or '' when it never showed up.
 */
export async function waitForUsageText(root, needle, tries = 1000) {
	for (let i = 0; i < tries; i++) {
		const text = await readUsageLedgerText(root);
		if (text.includes(needle)) return text;
		await new Promise((r) => setTimeout(r, 1));
	}
	return '';
}
