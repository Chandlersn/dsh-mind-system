import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, basename } from 'node:path';
import { RuntimeContractError, failureCode, validateCandidate, validateTask } from '../src/contracts.js';

/**
 * A second, deliberately different recipe.
 *
 * The JSON recipe compares parsed structures; this one has to parse a line-oriented format, keep a
 * header, respect quoting, and verify byte-level determinism. It exists to prove the recipe contract is
 * general rather than shaped around one template: if the engine only worked for JSON, this file could
 * not be written without touching the scheduler.
 */
export const RECIPE_ID = 'csv-normalize';
export const RECIPE_VERSION = '1';
export const VERIFIER_ID = 'csv-source-output';
const fail = (code, message) => { throw new RuntimeContractError(code, message); };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const LOCAL_IO = { lstatSync, readFileSync, realpathSync };
const MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 10_000;

function filename(value, extension) {
  const pattern = new RegExp(`^[A-Za-z0-9_-][A-Za-z0-9_.-]*\\.${extension}$`);
  if (typeof value !== 'string' || value !== basename(value) || !pattern.test(value)) {
    fail('invalid_scope', `The recipe accepts flat .${extension} filenames only.`);
  }
  return value;
}

function regularFile(path, { allowMissing = false } = {}, io = LOCAL_IO) {
  try {
    const stat = io.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('invalid_scope', 'Recipe files must be regular non-symlink files.');
    return stat;
  } catch (failure) {
    if (allowMissing && failureCode(failure) === 'ENOENT') return null;
    throw failure;
  }
}

/** RFC4180-style field split for a single line; quotes may contain commas and doubled quotes. */
function splitRow(line) {
  const fields = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') { value += '"'; index += 1; }
        else quoted = false;
      } else value += char;
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(value);
      value = '';
    } else value += char;
  }
  fields.push(value);
  return fields;
}

function rowsFrom(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('invalid_recipe_input', 'The source must be valid UTF-8.'); }
  // A trailing newline is the normal case; it must not produce a phantom empty row.
  const lines = text.replace(/\n$/, '').split('\n');
  if (lines.length < 1 || lines.length > MAX_ROWS + 1) fail('invalid_recipe_input', 'The source must be a bounded table.');
  if (lines[0] !== 'id,name') fail('invalid_recipe_input', 'The header must be exactly "id,name".');
  const rows = lines.slice(1).map((line) => {
    const fields = splitRow(line);
    if (fields.length !== 2) fail('invalid_recipe_input', 'Every row must have exactly two fields.');
    return { id: fields[0], name: fields[1] };
  });
  const ids = new Set();
  for (const row of rows) {
    if (!row.id || !row.name.trim() || ids.has(row.id)) {
      fail('invalid_recipe_input', 'Rows must have unique non-empty ids and non-empty names.');
    }
    ids.add(row.id);
  }
  return rows;
}

function paths(task, io = LOCAL_IO) {
  if (task.recipeId !== RECIPE_ID || task.recipeVersion !== RECIPE_VERSION) {
    fail('recipe_version_mismatch', 'The task recipe version is not supported.');
  }
  const root = io.realpathSync(task.workspaceRoot);
  const input = join(root, filename(task.inputs.inputFile, 'csv'));
  const output = join(root, filename(task.inputs.outputFile, 'csv'));
  if (input.toLowerCase() === output.toLowerCase()) fail('invalid_scope', 'Input and output files must differ.');
  regularFile(input, {}, io);
  return { root, input, output };
}

export function prepareCsvTask({ taskId, workspaceRoot, inputFile, outputFile, scopeRef, budget, deadlineAt }, io = LOCAL_IO) {
  const root = io.realpathSync(workspaceRoot);
  if (!io.lstatSync(root).isDirectory()) fail('invalid_scope', 'The workspace must be a directory.');
  const input = join(root, filename(inputFile, 'csv'));
  const output = join(root, filename(outputFile, 'csv'));
  if (input.toLowerCase() === output.toLowerCase()) fail('invalid_scope', 'Input and output files must differ.');
  regularFile(input, {}, io);
  if (regularFile(output, { allowMissing: true }, io)) fail('output_exists', 'The fixture recipe only creates a new output.');
  const bytes = io.readFileSync(input);
  if (bytes.length > MAX_BYTES) fail('invalid_recipe_input', 'The source exceeds the recipe byte limit.');
  rowsFrom(bytes);
  return validateTask({ taskId, workspaceRoot: root, recipeId: RECIPE_ID, recipeVersion: RECIPE_VERSION,
    scopeRef, goal: 'Write a sorted CSV with trimmed names, quoting only where required.',
    inputs: { inputFile, outputFile, inputSha256: digest(bytes) }, budget, deadlineAt });
}

/** Emit a field only when it needs quoting, so the expected bytes are unambiguous. */
const encodeField = (value) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

export function buildCsvCandidate(task, io = LOCAL_IO) {
  const { input, output } = paths(task, io);
  if (regularFile(output, { allowMissing: true }, io)) fail('output_exists', 'The output already exists; reconcile before creating it.');
  const bytes = io.readFileSync(input);
  if (digest(bytes) !== task.inputs.inputSha256) fail('input_changed', 'The source changed after task preparation.');
  const rows = rowsFrom(bytes)
    .map(({ id, name }) => ({ id, name: name.trim() }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const content = `id,name\n${rows.map((row) => `${encodeField(row.id)},${encodeField(row.name)}`).join('\n')}\n`;
  return validateCandidate({
    candidateId: 'create-normalized-csv', toolName: 'runtime_write_text',
    arguments: { path: output, content, createOnly: true },
    preconditionIds: ['csv-source-hash-unchanged', 'csv-output-absent', 'csv-workspace-scope'],
    postconditionIds: ['csv-rows-match-source', 'csv-source-hash-unchanged'],
    inputVersion: task.inputs.inputSha256, progressKey: 'verified-normalized-csv',
    effect: 'reversible_write', idempotencyKey: `${task.taskId}:create-normalized-csv`,
    recoveryContractId: 'inspect-output-before-retry',
    source: { recipeId: RECIPE_ID, version: RECIPE_VERSION },
  });
}

/**
 * Verify by re-reading both files and comparing rendered rows, not by trusting the tool or the bytes we
 * wrote: an identical-looking file produced by some other path must still satisfy the same predicate.
 */
export function verifyCsvOutput(task, io = LOCAL_IO) {
  const unknown = (reason) => ({ status: 'unknown', progress: 'unknown', goalSatisfied: null,
    verifierId: VERIFIER_ID, verifierVersion: '1', evidenceRefs: [], reason });
  try {
    const { input, output } = paths(task, io);
    const sourceBytes = io.readFileSync(input);
    const sourceHash = digest(sourceBytes);
    if (sourceHash !== task.inputs.inputSha256) return unknown('input_changed');
    const source = rowsFrom(sourceBytes);
    if (!regularFile(output, { allowMissing: true }, io)) {
      return { ...unknown('output_absent'), status: 'fail', progress: 'unchanged', goalSatisfied: false,
        evidenceRefs: [`file:${input}#sha256:${sourceHash}`] };
    }
    const outputBytes = io.readFileSync(output);
    const refs = [`file:${input}#sha256:${sourceHash}`, `file:${output}#sha256:${digest(outputBytes)}`];
    let actual;
    try { actual = rowsFrom(outputBytes); }
    catch { return { ...unknown('output_invalid_csv'), status: 'fail', progress: 'unchanged', goalSatisfied: false, evidenceRefs: refs }; }
    const expected = source.map(({ id, name }) => ({ id, name: name.trim() }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    // Compare parsed rows, so quoting style cannot mask a content difference.
    const valid = actual.length === expected.length
      && actual.every((row, index) => row.id === expected[index].id && row.name === expected[index].name);
    return { status: valid ? 'pass' : 'fail', progress: valid ? 'advanced' : 'unchanged', goalSatisfied: valid,
      verifierId: VERIFIER_ID, verifierVersion: '1', evidenceRefs: refs,
      reason: valid ? 'csv_source_and_output_verified' : 'output_mismatch' };
  } catch (failure) {
    if (['budget_exceeded', 'runtime_cancelled', 'io_reservation_exceeded'].includes(failureCode(failure))) throw failure;
    return unknown(failureCode(failure, 'verification_unavailable'));
  }
}

const boundTask = (task, state) => ({ ...task, inputs: state.inputs });

export const csvNormalizeRecipe = Object.freeze({
  id: RECIPE_ID, version: RECIPE_VERSION, ruleVersion: 'csv-normalize-single-action-v1',
  allowedTools: ['runtime_write_text'], toolEffects: { 'runtime_write_text': 'reversible_write' },
  requiredPreconditionIds: ['csv-source-hash-unchanged', 'csv-output-absent', 'csv-workspace-scope'],
  postconditionIds: ['csv-rows-match-source', 'csv-source-hash-unchanged'],
  verificationIoReserve: 5,
  prepare({ task, io }) {
    const prepared = prepareCsvTask({ taskId: task.taskId, workspaceRoot: task.workspaceRoot,
      inputFile: task.inputs.inputFile, outputFile: task.inputs.outputFile, scopeRef: task.scopeRef,
      budget: task.budget, deadlineAt: task.deadlineAt }, io);
    return { inputs: prepared.inputs };
  },
  candidates({ task, state, io, repairHistory }) {
    const previous = Array.isArray(repairHistory) ? repairHistory.filter((item) => item?.kind === 'retry_with') : [];
    if (previous.length) {
      throw new RuntimeContractError('repair_history_present',
        'The recipe must run its native repair controller instead of repeating the original action.');
    }
    return [buildCsvCandidate(boundTask(task, state), io)];
  },
  preconditions: {
    'csv-source-hash-unchanged'({ task, state, io }) {
      const prepared = boundTask(task, state);
      const { input } = paths(prepared, io);
      return { verdict: digest(io.readFileSync(input)) === prepared.inputs.inputSha256 ? 'allow' : 'deny' };
    },
    'csv-output-absent'({ task, state, io }) {
      const prepared = boundTask(task, state);
      const output = join(prepared.workspaceRoot, filename(prepared.inputs.outputFile, 'csv'));
      return { verdict: regularFile(output, { allowMissing: true }, io) === null ? 'allow' : 'deny' };
    },
    'csv-workspace-scope'({ task, state, candidate, io }) {
      const prepared = boundTask(task, state);
      const root = io.realpathSync(prepared.workspaceRoot);
      return { verdict: candidate.arguments.path === join(root, filename(prepared.inputs.outputFile, 'csv'))
        && candidate.arguments.createOnly === true ? 'allow' : 'deny' };
    },
  },
  verifier: { id: VERIFIER_ID, version: '1',
    verify({ task, state, io }) { return verifyCsvOutput(boundTask(task, state), io); } },
});
