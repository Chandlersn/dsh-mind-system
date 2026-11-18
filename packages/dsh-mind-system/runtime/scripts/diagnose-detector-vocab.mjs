/**
 * What do REAL failure messages look like on this machine, and how many does the detector catch?
 *
 * The 91.7% miss rate in verify-dr17-labelled.mjs came from an authored case set. Before
 * changing the detector I want the same measurement over text that no one wrote for this
 * purpose: the 2012 recorded failure signatures in the CLIS ledger, which accumulated from
 * actual tool failures over weeks.
 *
 * This is a diagnostic, not a verdict: the ledger carries no `needsHelp` label, so it cannot
 * produce a miss rate. What it CAN answer is the prior question - of the failures that actually
 * happen here, what fraction does the keyword list even consider? That number is what tells me
 * whether the fix belongs in the vocabulary or somewhere else entirely.
 */
import { readFileSync } from 'node:fs';
import { RELEVANT_WORDS_DEV as WORDS } from '../src/intervention.js';

const ledger = 'C:/Users/lyq/.dsh/storages/clis-interventions.jsonl';
const records = readFileSync(ledger, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .filter((r) => typeof r.signature === 'string');

console.log(`records with a signature: ${records.length}`);

// Rebuild the failure text the way the runtime sees it: the signature is `tool:text`.
const texts = records.map((r) => {
  const idx = r.signature.indexOf(':');
  return { tool: idx === -1 ? 'unknown' : r.signature.slice(0, idx), text: idx === -1 ? r.signature : r.signature.slice(idx + 1) };
});

const hit = (text) => WORDS.some((w) => text.toLowerCase().includes(w));
const matched = texts.filter((t) => hit(t.text));
console.log(`\nfailures the current keyword list would consider: ${matched.length}/${texts.length} `
  + `(${((matched.length / texts.length) * 100).toFixed(1)}%)`);

console.log('\n=== by tool: how many failures are even candidates ===');
const byTool = new Map();
for (const t of texts) {
  const e = byTool.get(t.tool) ?? { total: 0, matched: 0 };
  e.total++;
  if (hit(t.text)) e.matched++;
  byTool.set(t.tool, e);
}
for (const [tool, e] of [...byTool].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`  ${tool.padEnd(22)} ${String(e.total).padStart(5)} total, ${String(e.matched).padStart(4)} candidates `
    + `(${((e.matched / e.total) * 100).toFixed(1)}%)`);
}

console.log('\n=== the 12 most common failures, and whether the list sees them ===');
const freq = new Map();
for (const t of texts) {
  const key = t.text.slice(0, 90);
  freq.set(key, (freq.get(key) ?? 0) + 1);
}
for (const [text, count] of [...freq].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  const seen = hit(text) ? 'CANDIDATE' : 'invisible';
  console.log(`  ${String(count).padStart(4)}x [${seen}] ${text.replace(/\s+/g, ' ').slice(0, 100)}`);
}
