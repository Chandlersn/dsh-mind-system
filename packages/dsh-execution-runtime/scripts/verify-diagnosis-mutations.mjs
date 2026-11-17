import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-diagnosis-mutations-')));
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
  for (const file of ['src/contracts.js', 'src/diagnosis.js', 'test/diagnosis.test.js']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(source, file)));
  }
  const tests = [join(root, 'test/diagnosis.test.js')];
  const baseline = run(['--test', ...tests], 'baseline');
  assert.equal(baseline.status, 0, baseline.output);
  const mutants = [
    { name: 'every_error_diagnosed', file: 'src/diagnosis.js',
      old: '  if (signatureFailures < threshold && repairAttempts < threshold) {',
      replacement: '  if (false) {',
      test: /not ok \d+ - a first occurrence is repaired directly/ },
    { name: 'self_explanatory_diagnosed', file: 'src/diagnosis.js',
      old: '  if (selfExplanatory === true) {',
      replacement: '  if (false) {',
      test: /not ok \d+ - a self-explanatory error is repaired directly/ },
    { name: 'unknown_allowed_confidence', file: 'src/diagnosis.js',
      old: "  if (value.structure === 'unknown' && Object.hasOwn(value, 'confidence')) {",
      replacement: '  if (false) {',
      test: /not ok \d+ - unknown is a first-class diagnosis/ },
    { name: 'unknown_marks_resolved', file: 'src/diagnosis.js',
      old: "    resolved: value.structure !== 'unknown' });",
      replacement: '    resolved: true });',
      test: /not ok \d+ - unknown is a first-class diagnosis/ },
    { name: 'diagnosis_authorizes_repair', file: 'src/diagnosis.js',
      old: '      repairAuthorized: false,\n      note:',
      replacement: '      repairAuthorized: true,\n      note:',
      test: /not ok \d+ - a resolved diagnosis carries structure and evidence but never authorizes repair/ },
    { name: 'unknown_proceeds_instead_of_stopping', file: 'src/diagnosis.js',
      old: "    return Object.freeze({ status: 'waiting_human', reason: 'diagnosis_unknown', repairAuthorized: false,",
      replacement: "    return Object.freeze({ status: 'waiting_analysis', reason: 'diagnosis_unknown', repairAuthorized: false,",
      test: /not ok \d+ - an unknown or unavailable diagnosis stops for a human/ },
    { name: 'diagnosis_can_repeat_within_task', file: 'src/diagnosis.js',
      old: '      if (count >= maxCallsPerTask) {',
      replacement: '      if (false) {',
      test: /not ok \d+ - diagnosis is called at most once per task/ },
    { name: 'malformed_diagnosis_loosened', file: 'src/diagnosis.js',
      old: "        return Object.freeze({ status: 'unavailable', diagnostic: null, reason: 'invalid_diagnosis' });",
      replacement: "        return Object.freeze({ status: 'resolved', diagnostic: { structure: 'unknown', resolved: true } });",
      test: /not ok \d+ - a transport failure or malformed answer is unavailable/ },
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
  assert.ok(basename(root).startsWith('runtime-diagnosis-mutations-'));
  rmSync(root, { recursive: true, force: true });
}
