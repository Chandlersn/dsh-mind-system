import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, basename } from 'node:path';
import { RuntimeContractError, validateCandidate, validateTask } from '../src/contracts.js';

export const RECIPE_ID = 'json-normalize';
export const RECIPE_VERSION = '1';
const fail = (code, message) => { throw new RuntimeContractError(code, message); };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function filename(value) {
  if (typeof value !== 'string' || value !== basename(value) || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/.test(value)) {
    fail('invalid_scope', 'The recipe accepts flat JSON filenames only.');
  }
  return value;
}

function regularFile(path, { allowMissing = false } = {}) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('invalid_scope', 'Recipe files must be regular non-symlink files.');
    return stat;
  } catch (failure) {
    if (allowMissing && failure.code === 'ENOENT') return null;
    throw failure;
  }
}

function recordsFrom(bytes) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('invalid_recipe_input', 'The source must contain valid JSON.'); }
  if (!Array.isArray(value) || value.length > 10_000) fail('invalid_recipe_input', 'The source must be a bounded array.');
  const ids = new Set();
  for (const record of value) {
    if (!record || Array.isArray(record) || typeof record.id !== 'string' || !record.id
      || typeof record.name !== 'string' || !record.name.trim()
      || Object.keys(record).some((key) => !['id', 'name'].includes(key)) || ids.has(record.id)) {
      fail('invalid_recipe_input', 'Records must have unique string ids and non-empty names.');
    }
    ids.add(record.id);
  }
  return value;
}

function paths(task) {
  if (task.recipeId !== RECIPE_ID || task.recipeVersion !== RECIPE_VERSION) {
    fail('recipe_version_mismatch', 'The task recipe version is not supported.');
  }
  const root = realpathSync(task.workspaceRoot);
  const input = join(root, filename(task.inputs.inputFile));
  const output = join(root, filename(task.inputs.outputFile));
  if (input.toLowerCase() === output.toLowerCase()) fail('invalid_scope', 'Input and output files must differ.');
  regularFile(input);
  return { root, input, output };
}

/** Prepare a fixed-input fixture task; bootstrap reads are not yet runtime-metered. */
export function prepareJsonTask({ taskId, workspaceRoot, inputFile, outputFile, scopeRef, budget, deadlineAt }) {
  const root = realpathSync(workspaceRoot);
  if (!lstatSync(root).isDirectory()) fail('invalid_scope', 'The workspace must be a directory.');
  const input = join(root, filename(inputFile));
  const output = join(root, filename(outputFile));
  if (input.toLowerCase() === output.toLowerCase()) fail('invalid_scope', 'Input and output files must differ.');
  regularFile(input);
  if (regularFile(output, { allowMissing: true })) fail('output_exists', 'The fixture recipe only creates a new output.');
  const bytes = readFileSync(input);
  if (bytes.length > 1024 * 1024) fail('invalid_recipe_input', 'The source exceeds the recipe byte limit.');
  recordsFrom(bytes);
  return validateTask({ taskId, workspaceRoot: root, recipeId: RECIPE_ID, recipeVersion: RECIPE_VERSION,
    scopeRef, goal: 'Create a sorted JSON array with trimmed names and preserve the source file.',
    inputs: { inputFile, outputFile, inputSha256: digest(bytes) }, budget, deadlineAt });
}

export function buildJsonCandidate(task) {
  const { input, output } = paths(task);
  if (regularFile(output, { allowMissing: true })) fail('output_exists', 'The output already exists; reconcile before creating it.');
  const bytes = readFileSync(input);
  if (digest(bytes) !== task.inputs.inputSha256) fail('input_changed', 'The source changed after task preparation.');
  const records = recordsFrom(bytes);
  const normalized = records.map(({ id, name }) => ({ id, name: name.trim() }))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const content = `${JSON.stringify(normalized, null, 2)}\n`;
  return validateCandidate({
    candidateId: 'create-normalized-json', toolName: 'runtime.write_json',
    arguments: { path: output, content, createOnly: true },
    preconditionIds: ['source-hash-unchanged', 'output-absent', 'workspace-scope'],
    postconditionIds: ['normalized-records-match-source', 'source-hash-unchanged'],
    inputVersion: task.inputs.inputSha256, progressKey: 'verified-normalized-output',
    effect: 'reversible_write', idempotencyKey: `${task.taskId}:create-normalized-json`,
    recoveryContractId: 'inspect-output-before-retry',
    source: { recipeId: RECIPE_ID, version: RECIPE_VERSION },
  });
}

/** Re-read target facts independently; never trust the tool's success flag. */
export function verifyJsonOutput(task) {
  const unknown = (reason) => ({ status: 'unknown', progress: 'unknown', goalSatisfied: null,
    verifierId: 'json-source-output', verifierVersion: '1', evidenceRefs: [], reason });
  try {
    const { input, output } = paths(task);
    const sourceBytes = readFileSync(input);
    const sourceHash = digest(sourceBytes);
    if (sourceHash !== task.inputs.inputSha256) return unknown('input_changed');
    const source = recordsFrom(sourceBytes);
    if (!regularFile(output, { allowMissing: true })) {
      return { ...unknown('output_absent'), status: 'fail', progress: 'unchanged', goalSatisfied: false,
        evidenceRefs: [`file:${input}#sha256:${sourceHash}`] };
    }
    const outputBytes = readFileSync(output);
    const refs = [`file:${input}#sha256:${sourceHash}`, `file:${output}#sha256:${digest(outputBytes)}`];
    let actual;
    try { actual = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(outputBytes)); }
    catch { return { ...unknown('output_invalid_json'), status: 'fail', progress: 'unchanged', goalSatisfied: false, evidenceRefs: refs }; }
    const byId = new Map(source.map((record) => [record.id, record.name]));
    const seen = new Set();
    let previous = null;
    let valid = Array.isArray(actual) && actual.length === source.length;
    if (valid) {
      for (const record of actual) {
        if (!record || Array.isArray(record) || Object.keys(record).length !== 2
          || !Object.hasOwn(record, 'id') || !Object.hasOwn(record, 'name')
          || typeof record.id !== 'string' || !byId.has(record.id) || seen.has(record.id)
          || record.name !== byId.get(record.id).trim() || (previous !== null && record.id < previous)) {
          valid = false;
          break;
        }
        seen.add(record.id);
        previous = record.id;
      }
    }
    return { status: valid ? 'pass' : 'fail', progress: valid ? 'advanced' : 'unchanged', goalSatisfied: valid,
      verifierId: 'json-source-output', verifierVersion: '1', evidenceRefs: refs,
      reason: valid ? 'source_and_output_verified' : 'output_mismatch' };
  } catch (failure) {
    return unknown(typeof failure.code === 'string' ? failure.code : 'verification_unavailable');
  }
}
