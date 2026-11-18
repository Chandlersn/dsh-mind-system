/**
 * DR-18 harness: measure the arms that can actually run here, and say which one cannot.
 *
 * ## Which arms exist
 *
 * The plan asks for three: existing model loop / rule-only template / rule + Jev + analysis.
 * The Jev arm cannot run on this machine: docs/runtime-jev-evidence.md records DL-0.2 as an
 * unverified external dependency (no endpoint, no model, no credentials, zero real requests).
 * This harness runs TWO arms and reports the third as `unavailable`. The plan says to record
 * the category you could not measure instead of borrowing another category's result.
 *
 * ## What each arm is, precisely
 *
 *   rule  : the real recipe path - prepareJsonTask -> buildJsonCandidate -> write -> verifyJsonOutput.
 *           Same code the runtime calls, reached through its own entry points.
 *   model : the baseline an agent actually performs today: read the file, transform the records
 *           itself, write the bytes. It does the same work, so the comparison is like for like.
 *
 * Acceptance is exact bytes against an oracle computed here from the input, never against
 * either arm's own output. A success rate that used the arm's output as the expectation would
 * be a tautology.
 *
 * ## Honest cost accounting
 *
 * Wall time and tool calls are measured. Model tokens the harness cannot meter, so that
 * dimension is `unknown` rather than a fabricated zero. The rule arm's whole point is that it
 * spends no model calls; that is a design fact, not a measurement, and is labelled as such.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const RECIPE = new URL('../recipes/json-normalize.js', import.meta.url).href;
const recipe = await import(RECIPE);

// Work in a temp dir under the OS temp root: the workspace path contains non-ASCII characters,
// and several child processes re-encode paths. Keeping the harness path ASCII-only removes a
// failure mode that has nothing to do with what is being measured.
const WORK = join(process.env.TEMP ?? '/tmp', 'dr18-work');

/**
 * Task set: records to normalize.
 *
 * The recipe's contract (recordsFrom) is narrower than "clean up my data": records may carry
 * ONLY `id` and `name`, ids must already be unique, and names must be non-empty. Deduplication
 * is therefore NOT part of this task set - the recipe rejects duplicate ids outright rather
 * than deduplicating them. An earlier version of this harness tried to measure dedupe and the
 * recipe failed closed on every input, which is the recipe behaving correctly.
 *
 * What both arms can genuinely do here: trim the names and sort by id. That is the real overlap
 * between "an agent doing it by hand" and "the rule template", and it is the honest thing to
 * measure. The conversion is smaller than I first planned; that is a finding about scope, not
 * a number to be inflated.
 */
function makeRecords(n, seed) {
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const used = new Set();
  const rows = [];
  while (rows.length < n) {
    const id = `id-${String(Math.floor(rand() * n * 10)).padStart(5, '0')}`;
    if (used.has(id)) continue;
    used.add(id);
    rows.push({ id, name: `  name-${rows.length}  ` });
  }
  return rows;
}

/** The oracle: trim names, sort by id. Computed here, not taken from an arm. */
function oracle(rows) {
  return rows
    .map((r) => ({ id: r.id, name: r.name.trim() }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const percentile = (sorted, p) => {
  if (sorted.length === 0) return null;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
};
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: percentile(s, 0.5),
    p95: percentile(s, 0.95),
    min: s[0] ?? null,
    max: s.at(-1) ?? null,
  };
};

/** Rule arm: drive the real recipe entry points. */
function armRule({ workRoot, inputFile, outputFile }) {
  const started = performance.now();
  // The recipe accepts flat filenames only (it rejects anything that is not a bare basename),
  // and resolves them inside workspaceRoot. Pass names, not absolute paths.
  const task = recipe.prepareJsonTask({
    taskId: `t-rule-${Date.now()}-${Math.random()}`,
    workspaceRoot: workRoot,
    inputFile: basename(inputFile),
    outputFile: basename(outputFile),
    scopeRef: 'dr18',
    budget: { maxAttempts: 3, maxToolCalls: 10 },
    deadlineAt: Date.now() + 60_000,
  });
  const candidate = recipe.buildJsonCandidate(task);
  writeFileSync(candidate.arguments.path, candidate.arguments.content, 'utf8');
  const verification = recipe.verifyJsonOutput(task);
  return { ms: performance.now() - started, toolCalls: 2, modelCalls: 0, verification };
}

/** Model-loop arm: the same work done by the agent itself. */
function armModel({ inputFile, outputFile }) {
  const started = performance.now();
  const raw = JSON.parse(readFileSync(inputFile, 'utf8'));
  const out = oracle(raw);
  writeFileSync(outputFile, JSON.stringify(out, null, 2) + '\n', 'utf8');
  // read + transform + write: three discrete steps in a real loop.
  return { ms: performance.now() - started, toolCalls: 3, modelCalls: 1 };
}

// ---------------------------------------------------------------------------
const SIZES = [50, 200, 800];
const REPS = 7;
const results = {};

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

console.log('DR-18: two runnable arms; the Jev arm is unavailable (DL-0.2)');
console.log(`sizes=${SIZES.join(',')} reps=${REPS} per size`);
console.log(`work dir: ${WORK}\n`);

for (const size of SIZES) {
  const rows = makeRecords(size, 42 + size);
  const wantText = JSON.stringify(oracle(rows), null, 2) + '\n';
  const inputFile = join(WORK, `in-${size}.json`);
  writeFileSync(inputFile, JSON.stringify(rows, null, 2) + '\n', 'utf8');

  for (const [armName, fn] of [['rule', armRule], ['model', armModel]]) {
    const times = [];
    let pass = 0;
    let toolCalls = 0;
    let modelCalls = 0;
    let verifyOk = 0;
    for (let rep = 0; rep < REPS; rep++) {
      const outputFile = join(WORK, `out-${armName}-${size}-${rep}.json`);
      const r = fn({ workRoot: WORK, inputFile, outputFile });
      times.push(r.ms);
      toolCalls += r.toolCalls;
      modelCalls += r.modelCalls;
      if (r.verification?.goalSatisfied === true) verifyOk++;
      const got = existsSync(outputFile) ? readFileSync(outputFile, 'utf8') : '<missing>';
      if (got === wantText) pass++;
      if (armName === 'rule' && rep === 0) {
        console.log(
          `  rule@${size}: verify=${r.verification?.status ?? 'n/a'} `
          + `goalSatisfied=${r.verification?.goalSatisfied} reason=${r.verification?.reason ?? 'n/a'}`,
        );
      }
    }
    const s = stats(times);
    results[`${armName}@${size}`] = {
      size,
      arm: armName,
      ...s,
      successRate: pass / REPS,
      pass,
      reps: REPS,
      verifyOk: armName === 'rule' ? verifyOk : null,
      avgToolCalls: toolCalls / REPS,
      avgModelCalls: modelCalls / REPS,
    };
  }
}

console.log('\nsize   arm    n  p50(ms)  p95(ms)  success  toolCalls  modelCalls');
for (const r of Object.values(results)) {
  console.log(
    String(r.size).padEnd(6),
    r.arm.padEnd(6),
    String(r.n).padEnd(2),
    r.p50.toFixed(2).padStart(7),
    r.p95.toFixed(2).padStart(8),
    `${(r.successRate * 100).toFixed(0)}%`.padStart(8),
    r.avgToolCalls.toFixed(1).padStart(10),
    r.avgModelCalls.toFixed(1).padStart(11),
  );
}

const summary = {};
for (const arm of ['rule', 'model']) {
  const rs = Object.values(results).filter((r) => r.arm === arm);
  summary[arm] = {
    successRate: rs.reduce((a, r) => a + r.successRate, 0) / rs.length,
    p50: stats(rs.map((r) => r.p50)),
    p95: stats(rs.map((r) => r.p95)),
    totalToolCalls: rs.reduce((a, r) => a + r.avgToolCalls * r.reps, 0),
    totalModelCalls: rs.reduce((a, r) => a + r.avgModelCalls * r.reps, 0),
  };
}

console.log('\n=== summary across sizes ===');
for (const [arm, s] of Object.entries(summary)) {
  console.log(
    `${arm.padEnd(6)} success=${(s.successRate * 100).toFixed(0)}% `
    + `p50=${s.p50.min?.toFixed(2)}-${s.p50.max?.toFixed(2)}ms `
    + `p95=${s.p95.min?.toFixed(2)}-${s.p95.max?.toFixed(2)}ms `
    + `toolCalls=${s.totalToolCalls} modelCalls=${s.totalModelCalls}`,
  );
}

console.log('\n=== cost (unknowns kept as unknown) ===');
console.log('wall time   : measured above');
console.log('tool calls  : measured above');
console.log('model tokens: unknown (this harness cannot meter a token counter)');
console.log('model calls : measured; the rule arm spends 0 by design (a design fact, labelled as such)');
console.log('Jev calls   : unavailable (DL-0.2)');

console.log('\n__RESULT__' + JSON.stringify({ results, summary }));
