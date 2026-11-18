import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { jsonSnapshot, RuntimeContractError, validateCandidate, validateTask } from '../src/contracts.js';

const issuedContexts = new WeakSet();
const REQUIRED = ['source-hash-unchanged', 'owned-output-unchanged', 'workspace-scope'];
const POSTCONDITIONS = ['normalized-records-match-source', 'source-hash-unchanged'];
const HASH = /^[a-f0-9]{64}$/;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { throw new RuntimeContractError('repair_not_authorized', message); };
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const sameIds = (actual, expected) => Array.isArray(actual) && actual.length === expected.length
  && new Set(actual).size === actual.length && expected.every((id) => actual.includes(id));

function filename(value) {
  if (typeof value !== 'string' || basename(value) !== value
    || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/.test(value)) {
    fail('Repair requires flat, safe JSON filenames.');
  }
  return value;
}

function facts(task, state) {
  if (task.recipeId !== 'json-normalize' || task.recipeVersion !== '1') {
    fail('Repair requires json-normalize@1.');
  }
  if (!isAbsolute(task.workspaceRoot) || resolve(task.workspaceRoot) !== task.workspaceRoot) {
    fail('Repair requires the original absolute canonical workspace.');
  }
  const inputs = state?.inputs;
  if (!inputs || !HASH.test(inputs.inputSha256) || inputs.inputFile !== task.inputs.inputFile
    || inputs.outputFile !== task.inputs.outputFile
    || (task.inputs.inputSha256 !== undefined && task.inputs.inputSha256 !== inputs.inputSha256)) {
    fail('Repair requires the original prepared input facts.');
  }
  const inputPath = join(task.workspaceRoot, filename(inputs.inputFile));
  const outputPath = join(task.workspaceRoot, filename(inputs.outputFile));
  if (inputPath.toLowerCase() === outputPath.toLowerCase()) fail('Input and output must differ.');
  return { inputPath, outputPath, inputSha256: inputs.inputSha256 };
}

function binding({ task, state, candidate, repairContext }) {
  if (!repairContext || !issuedContexts.has(repairContext)
    || !isDeepStrictEqual(task, repairContext.task) || !isDeepStrictEqual(state, repairContext.state)) {
    fail('A native original ownership context and unchanged task/state are required.');
  }
  if (candidate?.toolName !== 'runtime_replace_json' || candidate.effect !== 'reversible_write'
    || candidate.source?.recipeId !== 'json-normalize' || candidate.source?.version !== '1'
    || candidate.inputVersion !== repairContext.inputSha256
    || !sameIds(candidate.preconditionIds, REQUIRED) || !sameIds(candidate.postconditionIds, POSTCONDITIONS)) {
    fail('Repair cannot alter the recipe, input version, required checks, effects, or postconditions.');
  }
  const args = candidate.arguments;
  if (!args || Object.keys(args).length !== 3
    || !['path', 'content', 'expectedSha256'].every((key) => Object.hasOwn(args, key))
    || args.path !== repairContext.outputPath || args.expectedSha256 !== repairContext.observedSha256
    || typeof args.content !== 'string') {
    fail('Repair requires the exact owned output, verifier hash, and concrete replacement content.');
  }
  return repairContext;
}

function regularFile(path, io) {
  const stat = io.lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) fail('Repair requires regular non-symlink files.');
}

function predicate(check) {
  return (context) => {
    // Propagate capability failures so the native controller can account for I/O and cancellation.
    try {
      const prepared = binding(context);
      return check(context, prepared) ? { verdict: 'allow' } : { verdict: 'deny', reason: 'repair_facts_changed' };
    } catch (error) {
      if (error instanceof RuntimeContractError && error.code === 'repair_not_authorized') {
        return { verdict: 'deny', reason: error.code };
      }
      throw error;
    }
  };
}

/**
 * Native authority for a host-owned runtime_replace_json tool; this policy performs no writes.
 * prepare accepts only the original create-only attempt from trusted runtime storage. Preserve
 * the returned object's identity outside model output. A subsequent replace attempt cannot
 * establish ownership; the controller must retain the original context separately for retries.
 * Admission must additionally validate the concrete arguments with the strict host schema.
 */
export const jsonNormalizeRepairPolicy = freeze({
  allowedTools: ['runtime_replace_json'],
  toolEffects: { 'runtime_replace_json': 'reversible_write' },
  requiredPreconditionIds: REQUIRED,
  postconditionIds: POSTCONDITIONS,
  verificationIoReserve: 5,
  prepare({ task, state, previousAttempt }) {
    const taskSnapshot = validateTask(task);
    const stateSnapshot = jsonSnapshot(state);
    const prepared = facts(taskSnapshot, stateSnapshot);
    const previous = previousAttempt;
    if (previous?.status !== 'settled' || previous.outcome?.status !== 'succeeded') {
      fail('Only a settled successful original creation establishes ownership.');
    }
    const original = validateCandidate(previous.candidate);
    // A previous repair may re-establish context only when it was itself an owned replacement of the same
    // artifact; the ownership still traces back to the original create-only action recorded in the task.
    const viaRepair = original.toolName === 'runtime_replace_json';
    if (!viaRepair && (original.toolName !== 'runtime_write_json' || original.arguments.createOnly !== true)) {
      fail('Ownership must come from the original scoped create-only recipe action.');
    }
    if (original.arguments.path !== prepared.outputPath || typeof original.arguments.content !== 'string'
      || original.effect !== 'reversible_write' || original.inputVersion !== prepared.inputSha256
      || original.source.recipeId !== 'json-normalize' || original.source.version !== '1'
      || !sameIds(original.postconditionIds, POSTCONDITIONS)) {
      fail('Ownership must come from the original scoped create-only recipe action.');
    }
    if (!viaRepair && !sameIds(Object.keys(original.arguments), ['path', 'content', 'createOnly'])) {
      fail('Ownership must come from the original scoped create-only recipe action.');
    }
    if (!viaRepair && !sameIds(original.preconditionIds, ['source-hash-unchanged', 'output-absent', 'workspace-scope'])) {
      fail('Ownership must come from the original scoped create-only recipe action.');
    }
    if (viaRepair && !sameIds(original.preconditionIds, REQUIRED)) {
      fail('A repeated repair must carry the repair policy preconditions.');
    }
    const verification = previous.verification;
    if (verification?.status !== 'fail' || verification.goalSatisfied !== false
      || verification.verifierId !== 'json-source-output' || verification.verifierVersion !== '1'
      || !Array.isArray(verification.evidenceRefs)) {
      fail('Repair requires failed verification by json-source-output@1.');
    }
    const prefix = `file:${prepared.outputPath}#sha256:`;
    const outputRefs = verification.evidenceRefs.filter((ref) => typeof ref === 'string' && ref.startsWith(prefix));
    if (outputRefs.length !== 1 || !HASH.test(outputRefs[0].slice(prefix.length))
      || !verification.evidenceRefs.includes(`file:${prepared.inputPath}#sha256:${prepared.inputSha256}`)) {
      fail('Verification must prove exact source and owned output hashes.');
    }
    const context = freeze(jsonSnapshot({ task: taskSnapshot, state: stateSnapshot, ...prepared,
      observedSha256: outputRefs[0].slice(prefix.length), originalAttemptId: previous.attemptId ?? null }));
    issuedContexts.add(context);
    return context;
  },
  preconditions: {
    'source-hash-unchanged': predicate(({ io }, context) => {
      regularFile(context.inputPath, io);
      return digest(io.readFileSync(context.inputPath)) === context.inputSha256;
    }),
    'owned-output-unchanged': predicate(({ io }, context) => {
      regularFile(context.outputPath, io);
      return digest(io.readFileSync(context.outputPath)) === context.observedSha256;
    }),
    'workspace-scope': predicate(({ io }, context) => {
      return io.realpathSync(context.task.workspaceRoot) === context.task.workspaceRoot
        && io.lstatSync(context.task.workspaceRoot).isDirectory();
    }),
  },
});
