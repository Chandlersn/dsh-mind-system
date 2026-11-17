import { RuntimeContractError } from './contracts.js';

/**
 * Condition primitives: the closed set of ways a generated recipe may choose which step runs next.
 *
 * ## Why a closed set again
 *
 * A branch decided by arbitrary code would let a recipe steer itself around its own acceptance rule —
 * take the path where the verifier passes rather than the path that does the work. So conditions are data:
 * they observe one declared fact and compare it. The vocabulary is small on purpose, and an unknown
 * condition is an error rather than a default.
 *
 * ## What a condition may observe
 *
 * Only facts the runner already has: the persisted step cursor, and the existence/content of a named file
 * inside the workspace. It cannot read arbitrary state, call tools, or inspect the verifier's verdict.
 */
const fail = (code, message) => { throw new RuntimeContractError(code, message); };

const CONDITIONS = Object.freeze({
  /**
   * `{ kind: 'file_exists', file }` — true when the named workspace file exists.
   * Use to pick a path based on what earlier steps produced.
   */
  file_exists: {
    describe: 'a named workspace file exists',
    validate: (params) => requireBare(params?.file, 'file'),
    evaluate: ({ params, readBytes, workspace }) => readBytes(`${workspace}/${params.file}`, { allowMissing: true }) !== null,
  },
  /**
   * `{ kind: 'file_sha256', file, equals }` — true when the file's digest matches.
   * Use when the branch depends on exact content, not merely presence.
   */
  file_sha256: {
    describe: 'a named workspace file has a specific sha256',
    validate: (params) => {
      requireBare(params?.file, 'file');
      if (typeof params?.equals !== 'string' || !/^[a-f0-9]{64}$/.test(params.equals)) {
        fail('invalid_condition', 'file_sha256 needs a sha256 to compare against.');
      }
    },
    evaluate: ({ params, readBytes, workspace, digest }) => {
      const bytes = readBytes(`${workspace}/${params.file}`, { allowMissing: true });
      return bytes !== null && digest(bytes) === params.equals;
    },
  },
  /**
   * `{ kind: 'step_less_than', value }` — true while the step cursor is below a bound.
   * Use to bound a retry loop expressed as a jump backwards.
   */
  step_less_than: {
    describe: 'the step cursor is below a bound',
    validate: (params) => {
      if (!Number.isSafeInteger(params?.value) || params.value < 0 || params.value > 1000) {
        fail('invalid_condition', 'step_less_than needs a non-negative integer bound.');
      }
    },
    evaluate: ({ params, state }) => (Number.isSafeInteger(state?.step) ? state.step : 0) < params.value,
  },
  /**
   * `{ kind: 'always', value }` — a constant. Present so an unconditional jump stays declarative rather
   * than being expressed as a condition that happens to be true.
   */
  always: {
    describe: 'a constant boolean',
    validate: (params) => {
      if (typeof params?.value !== 'boolean') fail('invalid_condition', 'always needs a boolean value.');
    },
    evaluate: ({ params }) => params.value === true,
  },
});

export const CONDITION_KINDS = Object.freeze(Object.keys(CONDITIONS));

export function describeConditions() {
  return Object.freeze(Object.entries(CONDITIONS).map(([kind, entry]) => Object.freeze({
    kind, describe: entry.describe })));
}

function requireBare(value, name) {
  if (typeof value !== 'string' || !value || value.includes('/') || value.includes('\\') || value === '..') {
    fail('invalid_condition', `${name} must be a bare filename inside the workspace.`);
  }
}

/**
 * Validate a declared condition and return a synchronous evaluator.
 *
 * @param {{kind: string, parameters?: object}} condition
 */
export function buildCondition(condition) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    fail('invalid_condition', 'A condition must be an object.');
  }
  for (const key of Object.keys(condition)) {
    if (!['kind', 'parameters'].includes(key)) fail('invalid_condition', `Unknown condition field: ${key}.`);
  }
  if (typeof condition.kind !== 'string' || !Object.hasOwn(CONDITIONS, condition.kind)) {
    fail('invalid_condition',
      `Unknown condition kind. Registered: ${CONDITION_KINDS.join(', ')}.`);
  }
  const parameters = condition.parameters ?? {};
  if (typeof parameters !== 'object' || Array.isArray(parameters)) {
    fail('invalid_condition', 'Condition parameters must be an object.');
  }
  const entry = CONDITIONS[condition.kind];
  entry.validate(parameters);
  return Object.freeze({
    kind: condition.kind,
    describe: entry.describe,
    evaluate: (context) => entry.evaluate({ ...context, params: parameters }),
  });
}
