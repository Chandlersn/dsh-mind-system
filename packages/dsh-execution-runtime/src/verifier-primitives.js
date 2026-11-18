import { createHash } from 'node:crypto';
import { RuntimeContractError, failureCode } from './contracts.js';

/**
 * Verifier primitives: the closed set of ways this runtime is allowed to decide that a task succeeded.
 *
 * ## Why a closed set, and not a generated verifier
 *
 * A recipe that could invent its own acceptance rule would be judging its own work. The self-iterating
 * loop would then be self-confirming: every failure could be re-described as a success by relaxing the
 * predicate. So a generated recipe may only *select and parameterize* one of these primitives; it can
 * never author a new predicate.
 *
 * ## What stays dynamic
 *
 * Everything that decides *how* to do the work is generated: candidates, preconditions, tool choice. The
 * task itself (goal, scope, inputs) also arrives at runtime rather than being pre-registered. Only the
 * acceptance vocabulary is fixed, because that is the one thing that must not be negotiable by the actor
 * being judged.
 *
 * Each primitive takes its parameters from the task and returns a `verify({ task, state, io })` function
 * shaped like any recipe verifier: `{ status, progress, goalSatisfied, verifierId, verifierVersion,
 * evidenceRefs, reason }`.
 */

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { throw new RuntimeContractError(code, message); };

/** Every primitive records the files it read, so a pass always carries evidence. */
function evidenceOf(input, output, inputBytes, outputBytes) {
  const refs = [`file:${input}#sha256:${digest(inputBytes)}`];
  if (outputBytes !== null) refs.push(`file:${output}#sha256:${digest(outputBytes)}`);
  return refs;
}

const unknown = (verifierId, reason) => ({ status: 'unknown', progress: 'unknown', goalSatisfied: null,
  verifierId, verifierVersion: '1', evidenceRefs: [], reason });

/**
 * The output must exist and its bytes must equal a declared digest.
 * Use when the expected artifact is exactly known ahead of time.
 */
function exactBytes({ expectedSha256 }) {
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    fail('invalid_verifier_primitive', 'exact_bytes needs a sha256 of the expected content.');
  }
  return ({ input, output, readBytes }) => {
    const outputBytes = readBytes(output, { allowMissing: true });
    if (outputBytes === null) {
      return { ...unknown('builtin:exact-bytes', 'output_absent'), status: 'fail', progress: 'unchanged', goalSatisfied: false };
    }
    const actual = digest(outputBytes);
    const inputBytes = readBytes(input);
    return { status: actual === expectedSha256 ? 'pass' : 'fail',
      progress: actual === expectedSha256 ? 'advanced' : 'unchanged', goalSatisfied: actual === expectedSha256,
      verifierId: 'builtin:exact-bytes', verifierVersion: '1',
      evidenceRefs: evidenceOf(input, output, inputBytes, outputBytes),
      reason: actual === expectedSha256 ? 'output_matches_declared_digest' : 'output_differs_from_declared_digest' };
  };
}

/**
 * The output must hold the same *set* of lines as a declared list, order-insensitive.
 * Use for set-like textual results where ordering is incidental.
 */
function lineSet({ expectedLines }) {
  if (!Array.isArray(expectedLines) || expectedLines.some((line) => typeof line !== 'string')) {
    fail('invalid_verifier_primitive', 'line_set needs a list of expected lines.');
  }
  const expected = [...new Set(expectedLines)].sort();
  return ({ input, output, readBytes }) => {
    const outputBytes = readBytes(output, { allowMissing: true });
    if (outputBytes === null) {
      return { ...unknown('builtin:line-set', 'output_absent'), status: 'fail', progress: 'unchanged', goalSatisfied: false };
    }
    const actual = [...new Set(new TextDecoder('utf-8', { fatal: true }).decode(outputBytes)
      .replace(/\n$/, '').split('\n'))].sort();
    const same = actual.length === expected.length && actual.every((line, index) => line === expected[index]);
    return { status: same ? 'pass' : 'fail', progress: same ? 'advanced' : 'unchanged', goalSatisfied: same,
      verifierId: 'builtin:line-set', verifierVersion: '1',
      evidenceRefs: evidenceOf(input, output, readBytes(input), outputBytes),
      reason: same ? 'line_sets_match' : 'line_sets_differ' };
  };
}

/**
 * The output must satisfy a declared structural rule, expressed as data rather than code:
 * `{ type: 'array' | 'object' | 'string', minItems?, maxItems?, requiredKeys?, uniqueBy?, nonEmptyStrings? }`.
 *
 * This is deliberately a small fixed vocabulary. It covers "the artifact is well-formed and respects the
 * declared shape" without letting a caller smuggle in an arbitrary predicate.
 */
function structure({ rule }) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)
    || !['array', 'object', 'string'].includes(rule.type)) {
    fail('invalid_verifier_primitive', 'structure needs a declared { type } rule.');
  }
  return ({ input, output, readBytes }) => {
    const outputBytes = readBytes(output, { allowMissing: true });
    if (outputBytes === null) {
      return { ...unknown('builtin:structure', 'output_absent'), status: 'fail', progress: 'unchanged', goalSatisfied: false };
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(outputBytes); }
    catch { return { ...unknown('builtin:structure', 'output_invalid_utf8'), status: 'fail', progress: 'unchanged', goalSatisfied: false }; }
    let value;
    try { value = JSON.parse(text); }
    catch { return { ...unknown('builtin:structure', 'output_invalid_json'), status: 'fail', progress: 'unchanged', goalSatisfied: false }; }
    const problems = [];
    if (rule.type === 'array') {
      if (!Array.isArray(value)) problems.push('not an array');
      else {
        if (rule.minItems !== undefined && value.length < rule.minItems) problems.push('too few items');
        if (rule.maxItems !== undefined && value.length > rule.maxItems) problems.push('too many items');
        if (rule.uniqueBy !== undefined) {
          const seen = new Set();
          for (const item of value) {
            const key = item?.[rule.uniqueBy];
            if (key === undefined) { problems.push(`missing ${rule.uniqueBy}`); break; }
            if (seen.has(key)) { problems.push(`duplicate ${rule.uniqueBy}`); break; }
            seen.add(key);
          }
        }
        if (rule.nonEmptyStrings !== undefined) {
          for (const field of rule.nonEmptyStrings) {
            if (!value.every((item) => typeof item?.[field] === 'string' && item[field].trim())) {
              problems.push(`empty ${field}`); break;
            }
          }
        }
      }
    } else if (rule.type === 'object') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) problems.push('not an object');
      else for (const key of rule.requiredKeys ?? []) if (!Object.hasOwn(value, key)) problems.push(`missing ${key}`);
    } else if (typeof value !== 'string') problems.push('not a string');
    const ok = problems.length === 0;
    return { status: ok ? 'pass' : 'fail', progress: ok ? 'advanced' : 'unchanged', goalSatisfied: ok,
      verifierId: 'builtin:structure', verifierVersion: '1',
      evidenceRefs: evidenceOf(input, output, readBytes(input), outputBytes),
      reason: ok ? 'output_structure_satisfied' : `output_structure_violated:${problems.join(',')}`.slice(0, 200) };
  };
}

/** The closed vocabulary. A generated recipe names one of these; it cannot add to the list. */
const PRIMITIVES = Object.freeze({
  exact_bytes: { build: exactBytes, describe: 'output bytes equal a declared sha256' },
  line_set: { build: lineSet, describe: 'output line set equals a declared list, order-insensitive' },
  structure: { build: structure, describe: 'output is well-formed and satisfies a declared shape' },
});

export const VERIFIER_PRIMITIVES = Object.freeze(Object.keys(PRIMITIVES));

export function describePrimitives() {
  return Object.freeze(Object.entries(PRIMITIVES).map(([name, entry]) => Object.freeze({
    name, describe: entry.describe })));
}

/**
 * Build a verifier from a declared `{ primitive, parameters }` spec.
 *
 * An unknown primitive is an error, not a fallback: silently substituting a weaker predicate would be the
 * exact failure mode this module exists to prevent.
 */
export function buildVerifier({ primitive, parameters = {} } = {}) {
  if (typeof primitive !== 'string' || !Object.hasOwn(PRIMITIVES, primitive)) {
    fail('invalid_verifier_primitive',
      `Unknown verifier primitive. Registered: ${VERIFIER_PRIMITIVES.join(', ')}.`);
  }
  const factory = PRIMITIVES[primitive].build(parameters);
  return Object.freeze({
    id: `builtin:${primitive.replaceAll('_', '-')}`, version: '1',
    verify({ task, state, io }) {
      // The verifier reads through the task's own I/O so every read stays metered and scoped; it never
      // reaches the filesystem directly.
      const paths = resolvePaths(task, state, parameters?.targetFile ?? null);
      const readBytes = (path, options) => {
        try { return io.readFileSync(path); } catch (error) {
          if (options?.allowMissing && (failureCode(error) === 'ENOENT' || failureCode(error) === 'not_found')) return null;
          throw error;
        }
      };
      try { return factory({ ...paths, readBytes, io }); }
      catch (error) {
        if (['budget_exceeded', 'runtime_cancelled', 'io_reservation_exceeded'].includes(failureCode(error))) throw error;
        return unknown(`builtin:${primitive}`, failureCode(error, 'verification_unavailable'));
      }
    },
  });
}

/**
 * Resolve the input/output pair the verifier reads.
 *
 * By default this is the task's declared input/output. A multi-step task produces intermediate artifacts
 * too, so a primitive may name its own `targetFile` (relative to the workspace); without that, every step
 * would have to write to `outputFile` and a two-step run could never judge its own intermediate results.
 */
function resolvePaths(task, state, targetFile = null) {
  const inputs = state?.inputs ?? task?.inputs ?? {};
  requireStringField(inputs.inputFile, 'inputs.inputFile');
  // A named target replaces the declared output, so the outputFile requirement only applies to the default.
  if (targetFile === null) requireStringField(inputs.outputFile, 'inputs.outputFile');
  const root = task.workspaceRoot;
  requireStringField(root, 'workspaceRoot');
  const join = (name) => (root.endsWith('/') || root.endsWith('\\') ? `${root}${name}` : `${root}/${name}`);
  if (targetFile !== null) {
    requireStringField(targetFile, 'targetFile');
    if (targetFile.includes('/') || targetFile.includes('\\') || targetFile === '..') {
      fail('invalid_verifier_primitive', 'targetFile must be a bare filename inside the workspace.');
    }
    return { input: join(inputs.inputFile), output: join(targetFile) };
  }
  return { input: join(inputs.inputFile), output: join(inputs.outputFile) };
}
function requireStringField(value, name) {
  if (typeof value !== 'string' || !value) fail('invalid_verifier_primitive', `${name} is required to verify.`);
}
