import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-approval-mutations-')));
function run(args, label) {
  const fd = openSync(join(root, `${label}.log`), 'w');
  let result;
  try { result = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd], timeout: 120_000 }); }
  finally { closeSync(fd); }
  return { status: result.status, error: result.error?.code ?? null,
    output: readFileSync(join(root, `${label}.log`), 'utf8') };
}
try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const file of ['src/contracts.js', 'src/pattern-approval.js', 'src/valve-bridge.js',
    'test/pattern-approval.test.js', 'test/valve-bridge.test.js']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(source, file)));
  }
  const tests = [join(root, 'test/pattern-approval.test.js'), join(root, 'test/valve-bridge.test.js')];
  const baseline = run(['--test', ...tests], 'baseline');
  assert.equal(baseline.status, 0, baseline.output);
  const mutants = [
    { name: 'pending_request_authorizes_write', file: 'src/pattern-approval.js',
      old: "  if (!approval || approval.status !== 'confirmed') return { applies: false, reason: 'not_confirmed' };",
      replacement: '  if (!approval) return { applies: false, reason: \'not_confirmed\' };',
      test: /not ok \d+ - a pending request cannot authorize anything/ },
    { name: 'analysis_result_may_sign', file: 'src/pattern-approval.js',
      old: "  if (human !== true) fail('not_human_confirmed'",
      replacement: "  if (false) fail('not_human_confirmed'",
      test: /not ok \d+ - confirmation requires an explicit human act/ },
    { name: 'ticket_not_bound_to_version', file: 'src/pattern-approval.js',
      old: "  if (!HASH.test(patternVersion ?? '') || patternVersion !== value.patternVersion) {",
      replacement: "  if (!HASH.test(patternVersion ?? '')) {",
      test: /not ok \d+ - a ticket is bound to the reviewed pattern version/ },
    { name: 'edited_pattern_keeps_approval', file: 'src/pattern-approval.js',
      old: '  if (version !== approval.patternVersion) return { applies: false, reason: \'pattern_version_changed\' };',
      replacement: '  if (false) return { applies: false, reason: \'pattern_version_changed\' };',
      test: /not ok \d+ - a stale approval for an edited pattern|not ok \d+ - the decision path reports/ },
    { name: 'expiry_ignored', file: 'src/pattern-approval.js',
      old: "  if (now() >= approval.expiresAt) return { applies: false, reason: 'expired' };",
      replacement: "  if (false) return { applies: false, reason: 'expired' };",
      test: /not ok \d+ - an expired request cannot be confirmed/ },
    { name: 'revoked_approval_still_applies', file: 'src/pattern-approval.js',
      old: "  if (value?.status !== 'confirmed') fail('invalid_approval_state', 'Only a confirmed approval may be revoked.');",
      replacement: '  if (false) fail(\'invalid_approval_state\');',
      test: /not ok \d+ - revocation keeps the audit record/ },
    { name: 'borrowed_ticket_accepted', file: 'src/pattern-approval.js',
      old: "      fail('approval_cannot_be_borrowed', `A candidate may not carry ${field}; approval comes only from human confirmation.`);",
      replacement: '      void field;',
      test: /not ok \d+ - a candidate or analysis result cannot smuggle/ },
    { name: 'runtime_signs_own_ticket', file: 'src/valve-bridge.js',
      old: "      result = await confirmRule(rule, { via: 'runtime', ruleVersion: approval.patternVersion });",
      replacement: "      result = await confirmRule(rule, { via: 'runtime', human: true, ruleVersion: approval.patternVersion });",
      test: /not ok \d+ - the runtime never signs its own ticket/ },
    { name: 'valve_rejection_reported_as_success', file: 'src/valve-bridge.js',
      old: '    if (!result || result.ok !== true) {',
      replacement: '    if (false) {',
      test: /not ok \d+ - a rejected or failing store/ },
    { name: 'write_without_effective_approval', file: 'src/valve-bridge.js',
      old: '    if (!decision.applies) {',
      replacement: '    if (false) {',
      test: /not ok \d+ - the runtime cannot write a rule without a confirmed approval/ },
  ];
  const observed = [];
  for (const mutant of mutants) {
    const filename = join(root, mutant.file);
    const original = readFileSync(filename, 'utf8');
    assert.equal(original.split(mutant.old).length, 2, `Mutation must match once: ${mutant.name}`);
    writeFileSync(filename, original.replace(mutant.old, mutant.replacement));
    const syntax = run(['--check', filename], `${mutant.name}-syntax`);
    assert.equal(syntax.status, 0, syntax.output);
    const result = run(['--test', ...tests], mutant.name);
    observed.push({ name: mutant.name, exitCode: result.status,
      killed: result.status === 1 && result.error === null && mutant.test.test(result.output) });
    writeFileSync(filename, original);
  }
  console.log(JSON.stringify({ baselineExitCode: baseline.status, mutants: observed,
    killed: observed.filter((item) => item.killed).length }, null, 2));
  if (observed.some((item) => !item.killed)) process.exitCode = 1;
} finally {
  assert.equal(realpathSync(root), root);
  assert.equal(dirname(root), realpathSync(tmpdir()));
  assert.ok(basename(root).startsWith('runtime-approval-mutations-'));
  rmSync(root, { recursive: true, force: true });
}
