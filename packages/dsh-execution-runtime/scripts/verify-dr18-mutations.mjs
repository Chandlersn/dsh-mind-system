import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'dr18-mutations-'));
const checked = realpathSync(root);
try {
  for (const directory of ['src', 'recipes']) cpSync(join(source, directory), join(root, directory), { recursive: true });
  mkdirSync(join(root, 'scripts'));
  cpSync(join(source, 'test', 'helpers'), join(root, 'test', 'helpers'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const path = join(root, 'scripts', 'verify-dr18-arms.mjs');
  const original = readFileSync(join(source, 'scripts', 'verify-dr18-arms.mjs'), 'utf8');
  writeFileSync(path, original);
  const invoke = () => spawnSync(process.execPath, [path], { cwd: root, stdio: 'ignore' });
  const baseline = invoke();
  assert.ifError(baseline.error);
  assert.equal(baseline.status, 0, 'The copied baseline must execute before testing a mutation.');
  const mutated = original.replace('name: name.trim()', 'name: name');
  assert.notEqual(mutated, original, 'The missing-trim mutation must actually change the local arm.');
  writeFileSync(path, mutated);
  const syntax = spawnSync(process.execPath, ['--check', path], { stdio: 'ignore' });
  assert.equal(syntax.status, 0, 'A syntax error is not evidence of independent acceptance.');
  const result = invoke();
  assert.ifError(result.error);
  assert.equal(result.status, 1, 'The external oracle must make the harness fail when local normalization is broken.');
  console.log(JSON.stringify({ baselineExitCode: baseline.status,
    mutations: [{ name: 'local_arm_skips_trim', syntaxExitCode: syntax.status, exitCode: result.status, killed: true }] }, null, 2));
} finally {
  assert.equal(realpathSync(root), checked);
  assert.equal(dirname(checked), realpathSync(tmpdir()));
  assert.ok(checked.includes('dr18-mutations-'));
  rmSync(checked, { recursive: true, force: true });
}
