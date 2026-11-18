/**
 * DR-17 experiment (v2): does the metric distinguish a miss from a false alarm?
 *
 * ## What was wrong with v1
 *
 * v1 reported 0% miss and 0% false alarm — a suspiciously perfect score. The cause was in my
 * own case set: every `needsHelp: true` case was written to CONTAIN one of the detector's 14
 * keywords, and every `needsHelp: false` case was written to avoid them. That measures my
 * construction, not the detector. The labels were independent; the TEXT was not.
 *
 * ## What v2 does instead
 *
 * The text is now the real-world failure message, exactly as tools produce it. I do not look
 * at RELEVANT_WORDS while writing a case. Some genuinely runtime-shaped failures are said
 * without the magic words ("the artifact does not match what was declared"), and some
 * irrelevant failures happen to contain them ("timeout waiting for the language server",
 * which is a typo-class problem, not a recoverable step). Those are precisely the cases where
 * a keyword detector can be wrong, and they are what make the rates meaningful.
 *
 * The label stays independent: `needsHelp` is a judgement about the step ("would the runtime's
 * assistance address this?"), not a judgement about the detector.
 */
import { createInterventionPolicy } from '../src/intervention.js';

const CASES = [
  // ---- genuinely runtime-shaped: a step failed in a way the runtime can address ----
  { id: 'artifact-mismatch', text: 'the produced artifact does not match what the task declared', needsHelp: true },
  { id: 'ledger-gap', text: 'the write landed on disk but no ledger row was recorded for it', needsHelp: true },
  { id: 'crash-midway', text: 'the process died with 3 of 7 files written', needsHelp: true },
  { id: 'stale-cursor', text: 'the checkpoint cursor no longer matches the journal entries', needsHelp: true },
  { id: 'deadline', text: 'killed after the deadline while the tool was still running', needsHelp: true },
  { id: 'cap-reached', text: 'attempts_used reached the per-run cap; no further attempt is allowed', needsHelp: true },
  { id: 'compensation-unsettled', text: 'the compensation step did not settle the target fact', needsHelp: true },
  { id: 'double-claim', text: 'two attempts claim the same fence token', needsHelp: true },
  { id: 'dispatch-vanished', text: 'dispatch entered but no executor recorded the call', needsHelp: true },
  { id: 'needs-rollback', text: 'the previous change must be undone before this task can proceed', needsHelp: true },
  { id: 'same-input-twice', text: 'the same command failed twice with an identical message', needsHelp: true },
  { id: 'tool-half-ran', text: 'the tool reported success but the output file is only half written', needsHelp: true },

  // ---- real failures the runtime's assistance would NOT address ----
  { id: 'typo-path', text: 'cannot read "D:\\work\\src\\indxe.js": the file does not exist', needsHelp: false },
  { id: 'syntax-error', text: 'SyntaxError: Unexpected token } in the module body', needsHelp: false },
  { id: 'missing-arg', text: 'invalid arguments: missing required property "file_path"', needsHelp: false },
  { id: 'old-string', text: 'old_string was not found in the target file', needsHelp: false },
  { id: 'perm-denied', text: 'EACCES: permission denied writing to the profile directory', needsHelp: false },
  { id: 'net-down', text: 'Could not connect to server:443 after 21260 ms', needsHelp: false },
  { id: 'no-match', text: 'rg: no matches found for the pattern in the tree', needsHelp: false },
  { id: 'bad-flag', text: 'unknown option --frobnicate for this command', needsHelp: false },
  { id: 'enc-issue', text: 'the file is not valid UTF-8; decoding stopped at byte 12', needsHelp: false },
  { id: 'tool-missing', text: 'command not found: ffprobe is not on PATH', needsHelp: false },
  // These DO contain the detector's vocabulary but are not recoverable runtime steps.
  { id: 'ls-timeout', text: 'timeout waiting for the language server to index the workspace', needsHelp: false },
  { id: 'lint-verification', text: 'verification step skipped: no linter configured for this file type', needsHelp: false },
  { id: 'user-retry', text: 'the user asked to retry the search with a narrower query', needsHelp: false },
  { id: 'git-partial', text: 'partial output shown: use --all to see the remaining entries', needsHelp: false },
];

function runPolicy(policy) {
  const decisions = new Map();
  for (const c of CASES) {
    const out = policy.evaluate({ agentId: 'eval-agent', tool: 't', message: c.text });
    decisions.set(c.id, out.hint !== undefined ? 'hinted' : out.skipped ?? 'unknown');
  }
  return decisions;
}

function score(decisions, label) {
  let tp = 0, fn = 0, fp = 0, tn = 0;
  const misses = [], falseAlarms = [];
  for (const c of CASES) {
    const spoke = decisions.get(c.id) === 'hinted';
    if (c.needsHelp && spoke) tp++;
    else if (c.needsHelp && !spoke) { fn++; misses.push(c.id); }
    else if (!c.needsHelp && spoke) { fp++; falseAlarms.push(c.id); }
    else tn++;
  }
  const positives = tp + fn, negatives = fp + tn;
  return {
    label, tp, fn, fp, tn, positives, negatives, misses, falseAlarms,
    missRate: positives === 0 ? null : fn / positives,
    falseAlarmRate: negatives === 0 ? null : fp / negatives,
  };
}

const pct = (v) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

function report(s) {
  console.log(`\n=== ${s.label} ===`);
  console.log(`  tp=${s.tp} fn=${s.fn} fp=${s.fp} tn=${s.tn}`);
  console.log(`  miss rate   : ${pct(s.missRate)}  (fn=${s.fn}/${s.positives})`);
  console.log(`  false alarm : ${pct(s.falseAlarmRate)}  (fp=${s.fp}/${s.negatives})`);
  if (s.misses.length) console.log(`  missed      : ${s.misses.join(', ')}`);
  if (s.falseAlarms.length) console.log(`  false alarms: ${s.falseAlarms.join(', ')}`);
}

const pos = CASES.filter((c) => c.needsHelp).length;
console.log(`case set: ${CASES.length} cases (${pos} need help, ${CASES.length - pos} do not)`);
console.log('text is the real failure message; cases were written WITHOUT consulting RELEVANT_WORDS.');

const real = createInterventionPolicy({ threshold: 1, cooldownMs: 0 });
const realScore = score(runPolicy(real), 'arm 1: detector as shipped');
report(realScore);

const offScore = score(new Map(CASES.map((c) => [c.id, 'skipped'])), 'arm 2: detector OFF');
report(offScore);

const onAllScore = score(new Map(CASES.map((c) => [c.id, 'hinted'])), 'arm 3: detector ON-ALL');
report(onAllScore);

console.log('\n=== ablation check ===');
const missWorse = (offScore.missRate ?? 0) > (realScore.missRate ?? 0);
const falseAlarmWorse = (onAllScore.falseAlarmRate ?? 0) > (realScore.falseAlarmRate ?? 0);
console.log(`OFF     makes miss rate worse        : ${missWorse ? 'YES' : 'NO'}  (${pct(realScore.missRate)} -> ${pct(offScore.missRate)})`);
console.log(`ON-ALL  makes false alarm worse      : ${falseAlarmWorse ? 'YES' : 'NO'}  (${pct(realScore.falseAlarmRate)} -> ${pct(onAllScore.falseAlarmRate)})`);

const ok = missWorse && falseAlarmWorse;
console.log(`\nDR-17 ablation: ${ok ? 'PASS' : 'FAIL'}`);
console.log(`detector measured performance: miss ${pct(realScore.missRate)}, false alarm ${pct(realScore.falseAlarmRate)} `
  + `over ${realScore.positives}+${realScore.negatives} labelled cases`);

console.log('\n__RESULT__' + JSON.stringify({
  cases: CASES.length,
  asShipped: { missRate: realScore.missRate, falseAlarmRate: realScore.falseAlarmRate },
  detectorOff: { missRate: offScore.missRate, falseAlarmRate: offScore.falseAlarmRate },
  detectorOnAll: { missRate: onAllScore.missRate, falseAlarmRate: onAllScore.falseAlarmRate },
  misses: realScore.misses,
  falseAlarms: realScore.falseAlarms,
  missWorse, falseAlarmWorse, pass: ok,
}));

process.exit(ok ? 0 : 1);
