import { RuntimeContractError, requireString } from './contracts.js';
import { buildRecipeFromSpec } from './recipe-factory.js';

/**
 * Recipe library: persist the specifications that actually worked, so a later task can reuse them instead
 * of re-describing the same recipe.
 *
 * ## What this adds, and what it deliberately does not
 *
 * Until now a generated recipe lived only in memory: the process restarted, and everything the system had
 * learned about *how* to do a kind of work was gone. This stores the specification, not the recipe object,
 * because a recipe carries executable callbacks and persisting those would mean loading code from the
 * database — a far larger trust surface than loading data.
 *
 * It does **not** decide that a stored specification is correct. A recipe recorded here still has to pass
 * the same admission, the same verifier, and the same closed vocabularies on every run. Reuse is not
 * precedent: "this worked before" is not an acceptance argument, and the library never becomes one.
 *
 * ## Why usage is counted, not assumed
 *
 * A specification earns visibility through runs that actually completed and verified. Counting attempts
 * would let a recipe that always fails look popular, so only verified success contributes, and the count
 * is of *distinct tasks* — one task retried three times is one use, not three.
 */

const fail = (code, message) => { throw new RuntimeContractError(code, message); };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS recipe_library (
  recipe_key TEXT PRIMARY KEY NOT NULL,
  spec_json TEXT NOT NULL,
  goal_pattern TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  verified_runs INTEGER NOT NULL DEFAULT 0,
  failed_runs INTEGER NOT NULL DEFAULT 0,
  last_task_id TEXT
);
`;

/**
 * Derive a stable key for a specification.
 *
 * The key includes the declared version, so editing a spec produces a new entry rather than silently
 * rewriting the one an earlier task pinned. Two specs that differ only in key order are the same recipe,
 * which is why the serialization sorts keys.
 */
function stableKey(spec) {
  return `${spec.recipeId}:${spec.version ?? '1'}`;
}

/** Serialize with sorted keys so two equivalent specifications share one entry. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Create the library over an existing store's database handle.
 *
 * @param {object} input
 * @param {object} input.db An open `node:sqlite` database (the runtime store's own handle).
 * @param {() => number} [input.now]
 */
export function createRecipeLibrary({ db, now = () => Date.now() }) {
  if (!db || typeof db.prepare !== 'function') fail('invalid_library', 'An open database handle is required.');
  db.exec(SCHEMA);

  const row = (key) => db.prepare('SELECT * FROM recipe_library WHERE recipe_key = ?').get(key) ?? null;

  return Object.freeze({
    /**
     * Record or update a specification.
     *
     * Re-recording the same key refreshes the goal pattern but keeps the counters: the entry's history is
     * about the identity, not about one submission.
     */
    record(spec, { goalPattern = null, toolEffects } = {}) {
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        fail('invalid_recipe_spec', 'A specification object is required.');
      }
      requireString(spec.recipeId, 'spec.recipeId');
      // Validate by building it, against the caller-supplied trusted effect table. A specification that
      // cannot produce a recipe must never reach the library, or a later task would fail at run time on an
      // entry that looked usable. The effects come from the host, never from the stored spec.
      buildRecipeFromSpec(spec, { toolEffects });
      const key = stableKey(spec);
      const at = now();
      const existing = row(key);
      if (existing === null) {
        db.prepare(`INSERT INTO recipe_library
          (recipe_key, spec_json, goal_pattern, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
          .run(key, canonical(spec), goalPattern, at, at);
      } else {
        db.prepare('UPDATE recipe_library SET goal_pattern = ?, updated_at = ? WHERE recipe_key = ?')
          .run(goalPattern ?? existing.goal_pattern, at, key);
      }
      return { recipeKey: key, created: existing === null };
    },

    /**
     * Record the outcome of a run that used a specification.
     *
     * Only a verified completion counts as a success. A run that ended `waiting_analysis`, `blocked` or
     * `reconciling` is a failure for this purpose: it did not demonstrate the recipe works.
     */
    recordOutcome({ recipeKey, status, taskId }) {
      requireString(recipeKey, 'recipeKey');
      requireString(taskId, 'taskId');
      if (row(recipeKey) === null) fail('recipe_not_in_library', `${recipeKey} is not recorded.`);
      const succeeded = status === 'completed';
      db.prepare(`UPDATE recipe_library SET
        verified_runs = verified_runs + ?, failed_runs = failed_runs + ?, last_task_id = ?, updated_at = ?
        WHERE recipe_key = ?`).run(succeeded ? 1 : 0, succeeded ? 0 : 1, taskId, now(), recipeKey);
      return { succeeded };
    },

    /** Read one entry, returning the specification as data with its usage counts. */
    read(recipeKey) {
      const found = row(recipeKey);
      if (found === null) return null;
      return Object.freeze({ recipeKey: found.recipe_key, spec: JSON.parse(found.spec_json),
        goalPattern: found.goal_pattern, verifiedRuns: found.verified_runs, failedRuns: found.failed_runs,
        createdAt: found.created_at, updatedAt: found.updated_at });
    },

    /**
     * List entries ordered by demonstrated success.
     *
     * `minVerifiedRuns` exists so a caller can ask for "recipes that have worked more than once" rather
     * than receiving everything ever tried. The default of 1 includes a single success on purpose: the
     * library is a memory aid, not an authorization, so it does not need to clear a bar to be *listed* —
     * only to be treated as better than an untried specification.
     */
    list({ minVerifiedRuns = 1, limit = 50 } = {}) {
      const rows = db.prepare(`SELECT * FROM recipe_library WHERE verified_runs >= ?
        ORDER BY verified_runs DESC, updated_at DESC LIMIT ?`).all(minVerifiedRuns, limit);
      return Object.freeze(rows.map((found) => Object.freeze({
        recipeKey: found.recipe_key, spec: JSON.parse(found.spec_json), goalPattern: found.goal_pattern,
        verifiedRuns: found.verified_runs, failedRuns: found.failed_runs, updatedAt: found.updated_at })));
    },

    /**
     * Suggest entries that could serve a goal.
     *
     * Matching is deliberately crude — a substring test over the recorded goal pattern and the recipe id.
     * A semantic match would need a model, and a model deciding "this recipe fits" is exactly the kind of
     * judgement this layer must not make on its own: it returns candidates for a caller to inspect, and
     * never runs one.
     */
    suggest(goal, { limit = 5 } = {}) {
      if (typeof goal !== 'string' || !goal.trim()) return Object.freeze([]);
      const needle = goal.toLowerCase();
      // Only entries with at least one verified run are offered: suggesting a recipe that has only ever
      // failed would present an unproven — in fact disproven — approach as if it were worth repeating.
      const rows = db.prepare('SELECT * FROM recipe_library WHERE verified_runs >= 1 '
        + 'ORDER BY verified_runs DESC, updated_at DESC').all();
      return Object.freeze(rows
        .map((found) => ({ found, score: matchScore(needle, found) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || right.found.verified_runs - left.found.verified_runs)
        .slice(0, limit)
        .map((item) => Object.freeze({ recipeKey: item.found.recipe_key,
          spec: JSON.parse(item.found.spec_json), goalPattern: item.found.goal_pattern,
          verifiedRuns: item.found.verified_runs, score: item.score })));
    },
  });
}

/**
 * Score how well an entry matches a goal.
 *
 * Word overlap rather than pure substring: a goal rarely reproduces the recorded wording exactly, and a
 * substring test would answer zero for a paraphrased request. The score is only used for ordering.
 */
function matchScore(needle, found) {
  const words = needle.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2);
  if (words.length === 0) return 0;
  const haystack = `${found.goal_pattern ?? ''} ${found.recipe_key}`.toLowerCase();
  const hits = words.filter((word) => haystack.includes(word)).length;
  return hits === 0 ? 0 : hits / words.length;
}
