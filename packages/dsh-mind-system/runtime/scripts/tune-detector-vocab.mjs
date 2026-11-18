/**
 * Candidate vocabulary for the detector, checked against BOTH sides before it is adopted.
 *
 * The word list is the detector's only signal, so widening it trades misses for false alarms.
 * This script applies a candidate list to the same labelled case set DR-17 uses and prints the
 * resulting confusion matrix, so the trade-off is visible instead of assumed.
 *
 * It also runs the candidate against the real failure ledger to confirm the widened list does
 * not start matching the ordinary noise (typos, parse errors, missing arguments) that the
 * existing test explicitly requires to stay invisible.
 */
import { readFileSync } from 'node:fs';
import { CASES } from './dr17-cases.mjs';

/** The shipped list, for baseline comparison. */
const SHIPPED = ['budget_exceeded', 'deadline', 'timeout', 'verification', 'outcome_unknown',
  'not_observed', 'reconciling', 'partial', 'atomic', 'half_', 'inconsistent', 'resume', 'rollback', 'retry'];

/**
 * Candidate additions. Each one names a *shape the runtime can act on*, phrased the way a real
 * failure message phrases it 鈥?not the way the runtime's own error codes do.
 */
const CANDIDATE = [
  ...SHIPPED,
  // an artifact that does not satisfy what the task declared
  'does not match', 'mismatch', 'differs', 'not satisfy', 'violated', 'unexpected content',
  // work that half-landed or is in an unknown state
  'half written', 'half-written', 'only half', 'not settle', 'did not settle',
  'no ledger row', 'not recorded', 'unrecorded', 'orphan',
  'in an unknown state', 'outcome is unknown', 'unknown outcome',
  // progress that cannot continue without undo/recovery
  'must be undone', 'cannot proceed', 'cannot continue', 'no longer matches',
  'stale', 'out of date', 'cursor', 'checkpoint', 'journal',
  // caps and repeated identical failure
  'reached the', 'cap', 'exhausted', 'no further attempt',
  'failed twice', 'identically', 'repeatedly failed',
  // competing ownership / lost dispatch
  'same fence', 'claim the same', 'two attempts', 'no executor',
  // a process that died partway through its writes
  'died with', 'process died', 'crashed', 'was killed mid',
];

const hit = (text, words) => words.some((w) => text.toLowerCase().includes(w));

function score(words, label) {
  let tp = 0, fn = 0, fp = 0, tn = 0;
  const misses = [], falseAlarms = [];
  for (const c of CASES) {
    const spoke = hit(c.text, words);
    if (c.needsHelp && spoke) tp++;
    else if (c.needsHelp && !spoke) { fn++; misses.push(c.id); }
    else if (!c.needsHelp && spoke) { fp++; falseAlarms.push(c.id); }
    else tn++;
  }
  return {
    label, tp, fn, fp, tn,
    missRate: fn / (tp + fn),
    falseAlarmRate: fp / (fp + tn),
    misses, falseAlarms,
  };
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const show = (s) => {
  console.log(`\n${s.label}`);
  console.log(`  tp=${s.tp} fn=${s.fn} fp=${s.fp} tn=${s.tn}`);
  console.log(`  miss=${pct(s.missRate)}  false alarm=${pct(s.falseAlarmRate)}`);
  if (s.misses.length) console.log(`  still missed: ${s.misses.join(', ')}`);
  if (s.falseAlarms.length) console.log(`  false alarms: ${s.falseAlarms.join(', ')}`);
};

console.log('=== on the labelled DR-17 case set ===');
const before = score(SHIPPED, 'shipped vocabulary');
const after = score(CANDIDATE, 'candidate vocabulary');
show(before);
show(after);

// ---------------------------------------------------------------------------
// The noise side: a widened list must not start speaking on ordinary mistakes.
// ---------------------------------------------------------------------------
const ledger = 'C:/Users/lyq/.dsh/storages/clis-interventions.jsonl';
let records = [];
try {
  records = readFileSync(ledger, 'utf8').split('\n').filter((l) => l.trim() !== '')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean).filter((r) => typeof r.signature === 'string');
} catch {
  console.log('\n(ledger not readable; skipping the real-noise check)');
}

if (records.length > 0) {
  const texts = records.map((r) => {
    const i = r.signature.indexOf(':');
    return i === -1 ? r.signature : r.signature.slice(i + 1);
  });
  const beforeN = texts.filter((t) => hit(t, SHIPPED)).length;
  const afterN = texts.filter((t) => hit(t, CANDIDATE)).length;
  console.log('\n=== on 2021 real recorded failures ===');
  console.log(`  shipped  : ${beforeN}/${texts.length} (${pct(beforeN / texts.length)}) considered`);
  console.log(`  candidate: ${afterN}/${texts.length} (${pct(afterN / texts.length)}) considered`);
  console.log('  NOTE: most real failures are typos/parse errors the design says to ignore,');
  console.log('        so this number should stay low; a jump toward 100% would mean the list');
  console.log('        now matches ordinary noise.');

  // What the widened list newly catches on real data, most frequent first.
  const newly = new Map();
  for (const t of texts) {
    if (hit(t, CANDIDATE) && !hit(t, SHIPPED)) {
      const key = t.replace(/\s+/g, ' ').slice(0, 90);
      newly.set(key, (newly.get(key) ?? 0) + 1);
    }
  }
  console.log('\n=== newly considered, top 10 ===');
  for (const [text, n] of [...newly].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(n).padStart(3)}x ${text}`);
  }
}

console.log('\n__RESULT__' + JSON.stringify({
  before: { missRate: before.missRate, falseAlarmRate: before.falseAlarmRate },
  after: { missRate: after.missRate, falseAlarmRate: after.falseAlarmRate },
  stillMissed: after.misses,
  newFalseAlarms: after.falseAlarms,
}));
