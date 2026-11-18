import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectModuleClosure } from './build/module-closure.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-knowledge-mutations-')));
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
  // Stage the real import graph: a hand-written list silently misses new dependencies.
  const testsInOrder = ['test/knowledge.test.js'];
  for (const file of collectModuleClosure(source, testsInOrder)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(source, file)));
  }
  const tests = testsInOrder.map((file) => join(root, file));
  const baseline = run(['--test', ...tests], 'baseline');
  assert.equal(baseline.status, 0, baseline.output);
  const mutants = [
    { name: 'scratch_relabelled_formal', file: 'src/knowledge.js',
      old: "    verified: ref.domain === 'formal' ? result.verified === true : false });",
      replacement: '    verified: true });',
      test: /not ok \d+ - reading keeps the domain identity/ },
    { name: 'stored_reported_as_indexed', file: 'src/knowledge.js',
      old: '  const indexed = stored && outcome.indexed === true;',
      replacement: '  const indexed = stored;',
      test: /not ok \d+ - a write reports storage and indexing as separate facts/ },
    { name: 'failed_write_reported_stored', file: 'src/knowledge.js',
      old: '  const stored = outcome.stored === true;',
      replacement: '  const stored = true;',
      test: /not ok \d+ - a write reports storage and indexing as separate facts/ },
    { name: 'daily_origin_anywhere', file: 'src/knowledge.js',
      old: "  if (origin === 'daily' && ref.domain !== 'formal') {",
      replacement: '  if (false) {',
      test: /not ok \d+ - a verification sample cannot be written with the daily origin/ },
    { name: 'outbox_not_idempotent', file: 'src/knowledge.js',
      old: '      if (existing) return Object.freeze({ ...existing, duplicate: true });',
      replacement: '      if (false) return Object.freeze({ ...existing, duplicate: true });',
      test: /not ok \d+ - the governance outbox is idempotent on replay/ },
    { name: 'failed_delivery_looks_delivered', file: 'src/knowledge.js',
      old: "      entry.status = 'delivered';\n      entry.deliveredAt = at();",
      replacement: "      entry.status = 'pending';\n      entry.deliveredAt = at();",
      test: /not ok \d+ - a failed delivery stays pending/ },
    { name: 'unknown_domain_accepted', file: 'src/knowledge.js',
      old: "  if (!['formal', 'workspace', 'scratch'].includes(domain)) fail('invalid_knowledge_ref', 'Unknown knowledge domain.');",
      replacement: "  if (domain === '') fail('invalid_knowledge_ref', 'Unknown knowledge domain.');",
      test: /not ok \d+ - a knowledge reference carries its domain/ },
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
  assert.ok(basename(root).startsWith('runtime-knowledge-mutations-'));
  rmSync(root, { recursive: true, force: true });
}
