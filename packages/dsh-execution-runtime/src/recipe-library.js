import { RuntimeContractError, requireString } from './contracts.js';
import { buildRecipeFromSpec, recipeIdentity } from './recipe-factory.js';

/**
 * Recipe library: persist specifications and their historical selected-verifier counts for later inspection.
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
 * Counters aggregate recorded outcomes from all origins. Completed means the selected verifier passed;
 * failed and cancelled runs count as failures. Historical failures may include other statuses under the
 * previous rule. Updates can be lost or duplicated; historical origin breakdowns cannot be recovered.
 * These aggregates do not independently prove a goal.
 */

const COUNT_BASIS = Object.freeze({
  origins: 'all_origins',
  historicalOriginSplit: 'unknown',
  success: 'selected_verifier_completion',
  failure: 'failed_or_cancelled_historical_other_statuses_possible',
  updateReliability: 'updates_may_be_lost_or_duplicated',
  taskUnique: false,
  productionEvidence: false,
  independentGoalProof: false,
});

// Only statuses confirmed by the runtime's run contract are terminal outcomes.
export function classifyRunOutcome(status) {
  if (status === 'completed') return true;
  if (status === 'failed' || status === 'cancelled') return false;
  return null;
}

const fail = (code, message) => { throw new RuntimeContractError(code, message); };

const MAX_TEXT_BYTES = 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const textProjection = (column) => `typeof(${column}) AS ${column}_type,
  CASE WHEN length(CAST(${column} AS BLOB)) <= ${MAX_TEXT_BYTES}
    THEN CAST(${column} AS BLOB) END AS ${column}_bytes`;
const projection = ['recipe_key', 'spec_json', 'identity_json', 'goal_pattern']
  .map(textProjection).join(', ') + ', created_at, updated_at, verified_runs, failed_runs';

function persistedText(row, column, { nullable = false, code = 'recipe_library_corrupt' } = {}) {
  if (nullable && row[`${column}_type`] === 'null') return null;
  try {
    if (row[`${column}_type`] !== 'text' || !(row[`${column}_bytes`] instanceof Uint8Array)) throw new Error();
    const value = decoder.decode(row[`${column}_bytes`]);
    if (value.includes('\0') || !Buffer.from(value, 'utf8').equals(Buffer.from(row[`${column}_bytes`]))) throw new Error();
    return value;
  } catch {
    fail(code, `Invalid persisted recipe ${column}.`);
  }
}

function validKey(key) {
  requireString(key, 'recipeKey');
  if (key.includes('\0')) fail('recipe_identity_unverifiable', 'Recipe key contains a NUL character.');
}

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
  if (!db.prepare('PRAGMA table_info(recipe_library)').all().some((column) => column.name === 'identity_json')) {
    db.exec('ALTER TABLE recipe_library ADD COLUMN identity_json TEXT');
  }

  const normalizeRow = (found) => ({ ...found,
    recipe_key: persistedText(found, 'recipe_key'),
    goal_pattern: persistedText(found, 'goal_pattern', { nullable: true }),
  });
  const row = (key) => {
    validKey(key);
    const found = db.prepare(`SELECT ${projection} FROM recipe_library WHERE recipe_key = ?`).get(key);
    return found ? normalizeRow(found) : null;
  };

  const assertIdentity = (key, identity) => {
    const existing = row(key);
    if (existing === null) return false;
    try {
      const savedIdentity = persistedText(existing, 'identity_json', { code: 'recipe_identity_unverifiable' });
      const saved = JSON.parse(savedIdentity);
      const spec = JSON.parse(persistedText(existing, 'spec_json', { code: 'recipe_identity_unverifiable' }));
      const reconstructed = buildRecipeFromSpec(spec, { toolEffects: saved.toolEffects });
      if (existing.recipe_key !== key || stableKey(spec) !== key || recipeIdentity(reconstructed) !== savedIdentity) {
        throw new Error('invalid identity');
      }
    } catch {
      fail('recipe_identity_unverifiable', `Recipe ${key} has an unverifiable persisted identity.`);
    }
    if (identity !== persistedText(existing, 'identity_json', { code: 'recipe_identity_unverifiable' })) {
      fail('recipe_identity_collision', `Recipe ${key} has a different identity.`);
    }
    return true;
  };

  const describeRow = (found) => {
    let spec;
    try {
      spec = JSON.parse(persistedText(found, 'spec_json'));
    } catch {
      fail('recipe_library_corrupt', `Recipe ${found.recipe_key} has malformed persisted specification JSON.`);
    }
    let reuseStatus = 'identity_verified_requires_admission';
    try {
      const identity = persistedText(found, 'identity_json', { code: 'recipe_identity_unverifiable' });
      if (!assertIdentity(found.recipe_key, identity)) fail('recipe_identity_unverifiable', 'Recipe disappeared while checking its identity.');
    } catch (error) {
      if (error?.code !== 'recipe_identity_unverifiable') throw error;
      reuseStatus = 'identity_unverifiable';
    }
    return { spec, reuseStatus, countBasis: COUNT_BASIS };
  };

  return Object.freeze({
    assertIdentity,
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
      const recipe = buildRecipeFromSpec(spec, { toolEffects });
      const identity = recipeIdentity(recipe);
      const key = stableKey(spec);
      const at = now();
      const exists = assertIdentity(key, identity);
      const existing = exists ? row(key) : null;
      if (existing === null) {
        db.prepare(`INSERT INTO recipe_library
          (recipe_key, spec_json, goal_pattern, created_at, updated_at, identity_json) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(key, canonical(spec), goalPattern, at, at, identity);
      } else {
        db.prepare('UPDATE recipe_library SET goal_pattern = ?, updated_at = ? WHERE recipe_key = ?')
          .run(goalPattern ?? existing.goal_pattern, at, key);
      }
      return { recipeKey: key, created: existing === null };
    },

    /**
     * Record the outcome of a run that used a specification.
     *
     * Pending states are not outcomes. Historical counters retain their original unsplit meaning.
     */
    recordOutcome({ recipeKey, status, taskId }) {
      validKey(recipeKey);
      requireString(taskId, 'taskId');
      if (row(recipeKey) === null) fail('recipe_not_in_library', `${recipeKey} is not recorded.`);
      const succeeded = classifyRunOutcome(status);
      if (succeeded === null) return { succeeded };
      db.prepare(`UPDATE recipe_library SET
        verified_runs = verified_runs + ?, failed_runs = failed_runs + ?, last_task_id = ?, updated_at = ?
        WHERE recipe_key = ?`).run(succeeded ? 1 : 0, succeeded ? 0 : 1, taskId, now(), recipeKey);
      return { succeeded };
    },

    /** Read one entry, returning the specification as data with its usage counts. */
    read(recipeKey) {
      const found = row(recipeKey);
      if (found === null) return null;
      return Object.freeze({ recipeKey: found.recipe_key, ...describeRow(found),
        goalPattern: found.goal_pattern, verifiedRuns: found.verified_runs, failedRuns: found.failed_runs,
        createdAt: found.created_at, updatedAt: found.updated_at });
    },

    /**
     * List entries ordered by historical selected-verifier completion counts.
     *
     * `minVerifiedRuns` exists so a caller can ask for "recipes that have worked more than once" rather
     * than receiving everything ever tried. The default of 1 includes a single success on purpose: the
     * library is a memory aid, not an authorization, so it does not need to clear a bar to be *listed* —
     * only to be treated as better than an untried specification.
     */
    list({ minVerifiedRuns = 1, limit = 50 } = {}) {
      const rows = db.prepare(`SELECT ${projection} FROM recipe_library WHERE verified_runs >= ?
        ORDER BY verified_runs DESC, updated_at DESC LIMIT ?`).all(minVerifiedRuns, limit).map(normalizeRow);
      return Object.freeze(rows.map((found) => Object.freeze({
        recipeKey: found.recipe_key, ...describeRow(found), goalPattern: found.goal_pattern,
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
      const rows = db.prepare(`SELECT ${projection} FROM recipe_library WHERE verified_runs >= 1 `
        + 'ORDER BY verified_runs DESC, updated_at DESC').all().map(normalizeRow);
      return Object.freeze(rows
        .map((found) => ({ found, score: matchScore(needle, found) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || right.found.verified_runs - left.found.verified_runs)
        .slice(0, limit)
        .map((item) => Object.freeze({ recipeKey: item.found.recipe_key,
          ...describeRow(item.found), goalPattern: item.found.goal_pattern,
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
