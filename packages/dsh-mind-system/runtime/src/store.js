import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateRepairAction } from './analyzer.js';
import { RuntimeContractError, jsonSnapshot, requireString, validateBudget, validateCandidate, validateTask, validateVerification } from './contracts.js';

const error = (code, message) => new RuntimeContractError(code, message);
const sha256 = (raw) => createHash('sha256').update(raw, 'utf8').digest('hex');
const EVIDENCE_LIMIT = 4 * 1024 * 1024;
const READ_LIMIT = 32 * 1024;

// Inspect descriptors to avoid silently dropping JSON data or executing getters.
function storageSnapshot(value, visiting = new Set(), depth = 0) {
  if (depth > 100) throw error('invalid_json', 'JSON nesting exceeds the storage limit.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string' && value.isWellFormed()) return value;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
    && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  if (typeof value !== 'object' || value === null || visiting.has(value)) {
    throw error('invalid_json', 'Evidence must be lossless JSON.');
  }
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) {
    throw error('invalid_json', 'Evidence must contain plain JSON objects.');
  }
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) throw error('invalid_json', 'JSON arrays must be dense.');
  visiting.add(value);
  const result = array ? [] : Object.create(null);
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !key.isWellFormed() || !descriptor.enumerable
      || !Object.hasOwn(descriptor, 'value')
      || (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
      throw error('invalid_json', 'JSON properties must be enumerable data properties.');
    }
    result[key] = storageSnapshot(descriptor.value, visiting, depth + 1);
  }
  visiting.delete(value);
  return result;
}

/**
 * Column list for `repairs`, shared by the initial schema and the in-place rebuild below.
 * Keeping one source means adding a permitted CHECK value can never desynchronize the two, which is
 * what previously forced hand-written `'observed'`-style string probes of the stored DDL.
 */
const REPAIRS_COLUMNS = `
        repair_id TEXT PRIMARY KEY NOT NULL,
        analysis_id TEXT NOT NULL UNIQUE REFERENCES analyses(analysis_id),
        task_id TEXT NOT NULL REFERENCES runs(task_id), signature TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('retry_with', 'gather_evidence', 'abort', 'rollback_to')),
        status TEXT NOT NULL CHECK(status IN ('reserved', 'settled', 'blocked', 'unknown', 'observed', 'restored')),
        candidate_json TEXT, attempt_id TEXT UNIQUE REFERENCES attempts(attempt_id),
        attempt_floor INTEGER NOT NULL, outcome_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`;

/** Executed transactional store: budgets, leases/fencing, events, evidence, repair and recovery state. */
export class RuntimeStore {
  #db;
  #now;

  constructor(filename, { now = Date.now } = {}) {
    this.#now = now;
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS runs (
        task_id TEXT PRIMARY KEY, task_json TEXT NOT NULL,
        status TEXT NOT NULL, version INTEGER NOT NULL,
        attempts_used INTEGER NOT NULL DEFAULT 0,
        tool_calls_used INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        fence INTEGER NOT NULL DEFAULT 0,
        owner_id TEXT, owner_expires_at INTEGER, environment_json TEXT,
        recovery_reads_used INTEGER NOT NULL DEFAULT 0,
        compensations_used INTEGER NOT NULL DEFAULT 0,
        recovery_started_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS attempts (
        attempt_id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES runs(task_id),
        candidate_json TEXT NOT NULL, status TEXT NOT NULL,
        outcome_json TEXT, verification_json TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES runs(task_id), attempt_id TEXT,
        kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence (
        ref TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES runs(task_id),
        label TEXT NOT NULL, raw_json TEXT NOT NULL, sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK(bytes >= 0 AND bytes <= 4194304), created_at INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS evidence_no_update BEFORE UPDATE ON evidence
        BEGIN SELECT RAISE(ABORT, 'Runtime evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS evidence_no_delete BEFORE DELETE ON evidence
        BEGIN SELECT RAISE(ABORT, 'Runtime evidence is immutable'); END;
      CREATE TABLE IF NOT EXISTS analyses (
        analysis_id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES runs(task_id),
        status TEXT NOT NULL CHECK(status IN ('pending', 'proposed', 'analysis_parse_failed',
          'analysis_timeout', 'analysis_cancelled', 'analysis_failed', 'analysis_package_failed')),
        evidence_refs_json TEXT NOT NULL DEFAULT '[]', result_json TEXT,
        reads_used INTEGER NOT NULL DEFAULT 0 CHECK(reads_used BETWEEN 0 AND 2),
        bytes_read INTEGER NOT NULL DEFAULT 0 CHECK(bytes_read BETWEEN 0 AND 32768),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repairs (
        ${REPAIRS_COLUMNS}
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        checkpoint_id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES runs(task_id),
        step_index INTEGER NOT NULL, attempt_floor INTEGER NOT NULL DEFAULT 0,
        state_json TEXT NOT NULL, environment_json TEXT NOT NULL,
        evidence_ref TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repair_failures (
        task_id TEXT NOT NULL REFERENCES runs(task_id), signature TEXT NOT NULL,
        failures INTEGER NOT NULL CHECK(failures >= 0), PRIMARY KEY(task_id, signature)
      );
      CREATE TABLE IF NOT EXISTS compensations (
        compensation_id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES runs(task_id),
        source_attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
        status TEXT NOT NULL CHECK(status IN ('completed', 'unverified', 'diverged', 'unsupported')),
        plan_json TEXT NOT NULL, evidence_ref TEXT, created_at INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS analyses_result_immutable BEFORE UPDATE ON analyses
        WHEN OLD.result_json IS NOT NULL AND
          (NEW.result_json IS NOT OLD.result_json OR NEW.status IS NOT OLD.status)
        BEGIN SELECT RAISE(ABORT, 'Runtime analysis results are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'Runtime events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'Runtime events are immutable'); END;
    `);
    const columns = new Set(this.#db.prepare('PRAGMA table_info(runs)').all().map((column) => column.name));
    for (const [name, declaration] of Object.entries({
      state_json: "TEXT NOT NULL DEFAULT '{}'", reason: 'TEXT',
      io_operations_used: 'INTEGER NOT NULL DEFAULT 0',
      decision_requests_used: 'INTEGER NOT NULL DEFAULT 0',
      analysis_calls_used: 'INTEGER NOT NULL DEFAULT 0',
      fence: 'INTEGER NOT NULL DEFAULT 0',
      owner_id: 'TEXT',
      owner_expires_at: 'INTEGER',
      environment_json: 'TEXT',
      recovery_reads_used: 'INTEGER NOT NULL DEFAULT 0',
      compensations_used: 'INTEGER NOT NULL DEFAULT 0',
      recovery_started_at: 'INTEGER',
    })) {
      if (!columns.has(name)) this.#db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${declaration}`);
    }
    this.#transaction(() => {
      const analysisColumns = this.#db.prepare('PRAGMA table_info(analyses)').all();
      if (!analysisColumns.some((column) => column.name === 'consumed_at')) {
        this.#db.exec('ALTER TABLE analyses ADD COLUMN consumed_at INTEGER');
      }
      this.#db.exec(`DROP INDEX IF EXISTS analyses_one_unresolved;
        CREATE UNIQUE INDEX analyses_one_unresolved ON analyses(task_id)
          WHERE status IN ('pending', 'proposed') AND consumed_at IS NULL`);
      // An older database can carry a narrower CHECK on repairs.kind/status. Comparing the stored DDL
      // against REPAIRS_COLUMNS (whitespace-insensitive, `IF NOT EXISTS` normalized away) means widening
      // either CHECK list activates this rebuild on its own; a substring probe had to be hand-edited each
      // time and would silently leave an old file rejecting the new value. The comparison must also be
      // idempotent: SQLite keeps the original statement text, so without normalizing the prefix every
      // reopen would rebuild the table and destroy table-bound triggers.
      const repairsRow = this.#db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'repairs'").get();
      const normalize = (sql) => sql.replace(/\s+/g, ' ').replace(/^CREATE TABLE IF NOT EXISTS /, 'CREATE TABLE ').trim();
      const wanted = normalize(`CREATE TABLE repairs (${REPAIRS_COLUMNS})`);
      if (repairsRow?.sql && normalize(repairsRow.sql) !== wanted) {
        this.#db.exec(`ALTER TABLE repairs RENAME TO repairs_legacy;
          CREATE TABLE repairs (${REPAIRS_COLUMNS});
          INSERT INTO repairs SELECT * FROM repairs_legacy;
          DROP TABLE repairs_legacy;`);
      }
    });
  }

  close() { this.#db.close(); }

  #transaction(operation) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#db.exec('COMMIT');
      return result;
    } catch (failure) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw failure;
    }
  }

  #event(taskId, attemptId, kind, payload) {
    this.#db.prepare(`INSERT INTO events
      (event_id, task_id, attempt_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), taskId, attemptId, kind, JSON.stringify(jsonSnapshot(payload)), this.#now());
  }

  #row(taskId) {
    const row = this.#db.prepare('SELECT * FROM runs WHERE task_id = ?').get(taskId);
    if (!row) throw error('run_not_found', 'The requested run does not exist.');
    return row;
  }

  #version(row, expectedVersion) {
    if (!Number.isSafeInteger(expectedVersion) || row.version !== expectedVersion) {
      throw error('stale_run', 'The run changed; reload before issuing a new operation.');
    }
  }

  createRun(input) {
    const task = validateTask(input);
    const now = this.#now();
    if (task.deadlineAt <= now) throw error('budget_exceeded', 'The task deadline has already elapsed.');
    return this.#transaction(() => {
      this.#db.prepare(`INSERT INTO runs
        (task_id, task_json, status, version, created_at, updated_at) VALUES (?, ?, 'running', 0, ?, ?)`)
        .run(task.taskId, JSON.stringify(task), now, now);
      this.#event(task.taskId, null, 'run_created', { task });
      return this.getRun(task.taskId);
    });
  }

  getRun(taskId) {
    const row = this.#row(taskId);
    return {
      task: JSON.parse(row.task_json), status: row.status, version: row.version,
      usage: { attempts: row.attempts_used, toolCalls: row.tool_calls_used },
      budgetUsage: { attempts: row.attempts_used, toolCalls: row.tool_calls_used,
        ioOperations: row.io_operations_used, decisionRequests: row.decision_requests_used,
        analysisCalls: row.analysis_calls_used,
        // Recovery work is reported separately from business work so neither can hide the other.
        recovery: { reads: row.recovery_reads_used, compensations: row.compensations_used,
          startedAt: row.recovery_started_at } },
      state: JSON.parse(row.state_json), reason: row.reason,
      fence: row.fence,
      owner: row.owner_id === null ? null : { ownerId: row.owner_id, expiresAt: row.owner_expires_at },
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  /**
   * Take a single-writer lease. A new owner increments the fence so any older holder loses write authority
   * even after it wakes up; the previous holder is never trusted to report its own liveness.
   */
  acquireLease(taskId, { expectedVersion, ownerId, ttlMs = 30_000 } = {}) {
    requireString(ownerId, 'ownerId');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000) {
      throw error('invalid_lease', 'A lease needs a bounded positive TTL.');
    }
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      if (row.status !== 'running') throw error('run_not_running', 'Only a running task can be leased.');
      if (row.owner_id === ownerId && row.owner_expires_at !== null && row.owner_expires_at > this.#now()) {
        throw error('lease_conflict', 'This owner already holds an unexpired lease.');
      }
      const fence = row.fence + 1;
      const expiresAt = this.#now() + ttlMs;
      this.#db.prepare('UPDATE runs SET owner_id = ?, owner_expires_at = ?, fence = ?, version = version + 1, updated_at = ? WHERE task_id = ?')
        .run(ownerId, expiresAt, fence, this.#now(), taskId);
      this.#event(taskId, null, 'lease_acquired', { ownerId, fence, expiresAt });
      return { run: this.getRun(taskId), fence };
    });
  }

  /** Release a held lease without reusing its fence; a later owner always gets a newer fence. */
  releaseLease(taskId, { expectedVersion, ownerId, fence } = {}) {
    requireString(ownerId, 'ownerId');
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      if (row.owner_id !== ownerId || row.fence !== fence) {
        throw error('stale_owner', 'Only the current fenced owner may release the lease.');
      }
      this.#db.prepare('UPDATE runs SET owner_id = NULL, owner_expires_at = NULL, version = version + 1, updated_at = ? WHERE task_id = ?')
        .run(this.#now(), taskId);
      this.#event(taskId, null, 'lease_released', { ownerId, fence });
      return this.getRun(taskId);
    });
  }

  /** Reject writes from an owner whose fence was superseded, even if it still believes it is running. */
  #assertFence(row, fence) {
    if (fence === undefined) return;
    if (!Number.isSafeInteger(fence) || row.fence !== fence) {
      throw error('stale_owner', 'The writer fence was superseded by a newer owner.');
    }
  }

  setState(taskId, input, { expectedVersion } = {}) {
    const state = jsonSnapshot(input);
    if (!state || Array.isArray(state) || typeof state !== 'object') throw error('invalid_state', 'Recipe state must be an object.');
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      if (row.status !== 'running') throw error('run_not_running', 'The run cannot change recipe state.');
      this.#db.prepare('UPDATE runs SET state_json = ?, version = version + 1, updated_at = ? WHERE task_id = ?')
        .run(JSON.stringify(state), this.#now(), taskId);
      this.#event(taskId, null, 'state_updated', { state });
      return this.getRun(taskId);
    });
  }

  reserveBudget(taskId, kind, amount, { expectedVersion } = {}) {
    const mapping = {
      ioOperations: ['io_operations_used', 'maxIoOperations'],
      decisionRequests: ['decision_requests_used', 'maxDecisionRequests'],
      analysisCalls: ['analysis_calls_used', 'maxAnalysisCalls'],
    };
    if (!Object.hasOwn(mapping, kind) || !Number.isSafeInteger(amount) || amount < 1) {
      throw error('invalid_budget', 'A known budget dimension and positive amount are required.');
    }
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      if (row.status !== 'running') throw error('run_not_running', 'The run cannot reserve work.');
      const task = JSON.parse(row.task_json);
      const [column, limitName] = mapping[kind];
      if (this.#now() >= task.deadlineAt || row[column] + amount > validateBudget(task.budget)[limitName]) {
        throw error('budget_exceeded', `The task has no ${kind} budget remaining.`);
      }
      this.#db.prepare(`UPDATE runs SET ${column} = ${column} + ?, version = version + 1, updated_at = ? WHERE task_id = ?`)
        .run(amount, this.#now(), taskId);
      this.#event(taskId, null, 'budget_reserved', { kind, amount });
      return this.getRun(taskId);
    });
  }

  observe(taskId, kind, payload, { expectedVersion } = {}) {
    requireString(kind, 'event kind');
    const value = jsonSnapshot(payload);
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      this.#event(taskId, null, kind, value);
      this.#db.prepare('UPDATE runs SET version = version + 1, updated_at = ? WHERE task_id = ?')
        .run(this.#now(), taskId);
      return this.getRun(taskId);
    });
  }

  stopRun(taskId, status, reason, { expectedVersion } = {}) {
    if (!['failed', 'cancelled', 'waiting_analysis', 'waiting_human', 'reconciling'].includes(status)) {
      throw error('invalid_state', 'An explicit stop state is required.');
    }
    requireString(reason, 'stop reason');
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      if (row.status !== 'running') return this.getRun(taskId);
      const unresolved = this.listUnresolved(taskId);
      const actualStatus = unresolved.length ? 'reconciling' : status;
      this.#db.prepare('UPDATE runs SET status = ?, reason = ?, version = version + 1, updated_at = ? WHERE task_id = ?')
        .run(actualStatus, reason, this.#now(), taskId);
      this.#event(taskId, null, 'run_stopped', { status: actualStatus, reason });
      return this.getRun(taskId);
    });
  }

  reserveAttempt(taskId, input, { expectedVersion, attemptId = randomUUID(), fence } = {}) {
    const candidate = validateCandidate(input);
    requireString(attemptId, 'attemptId');
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      this.#assertFence(row, fence);
      const task = JSON.parse(row.task_json);
      if (row.status !== 'running') throw error('run_not_running', 'The run cannot dispatch new work.');
      if (this.#db.prepare("SELECT 1 FROM attempts WHERE task_id = ? AND status IN ('reserved', 'started', 'unknown')").get(taskId)) {
        throw error('attempt_unresolved', 'Resolve the previous attempt before reserving another.');
      }
      const key = candidate.idempotencyKey;
      if (typeof key === 'string' && key.length > 0 && key.length <= 256) {
        // Block only effects already known to be applied and verified. A known-bad effect stays correctable,
        // and unresolved work is already stopped by the check above.
        const claimed = this.#db.prepare(`SELECT 1 FROM attempts WHERE task_id = ?
          AND json_extract(candidate_json, '$.toolName') = ?
          AND json_extract(candidate_json, '$.idempotencyKey') = ?
          AND (status = 'reconciled_applied'
            OR (status = 'settled' AND json_extract(outcome_json, '$.status') = 'succeeded'
              AND json_extract(verification_json, '$.status') = 'pass'))
          LIMIT 1`).get(taskId, candidate.toolName, key);
        if (claimed) throw error('idempotency_conflict', 'This idempotency key already applied a verified effect.');
      }
      if (candidate.source.recipeId !== task.recipeId || candidate.source.version !== task.recipeVersion) {
        throw error('recipe_version_mismatch', 'The candidate does not belong to this task recipe version.');
      }
      if (this.#now() >= task.deadlineAt || row.attempts_used >= task.budget.maxAttempts
        || row.tool_calls_used >= task.budget.maxToolCalls) {
        throw error('budget_exceeded', 'The task has no dispatch budget remaining.');
      }
      this.#db.prepare(`INSERT INTO attempts
        (attempt_id, task_id, candidate_json, status, created_at) VALUES (?, ?, ?, 'reserved', ?)`)
        .run(attemptId, taskId, JSON.stringify(candidate), this.#now());
      this.#db.prepare(`UPDATE runs SET attempts_used = attempts_used + 1,
        tool_calls_used = tool_calls_used + 1, version = version + 1, updated_at = ? WHERE task_id = ?`)
        .run(this.#now(), taskId);
      this.#event(taskId, attemptId, 'attempt_reserved', { candidate });
      return { attemptId, run: this.getRun(taskId) };
    });
  }

  markStarted(taskId, attemptId, { expectedVersion, fence } = {}) {
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      this.#assertFence(row, fence);
      const task = JSON.parse(row.task_json);
      if (row.status !== 'running' || this.#now() >= task.deadlineAt) {
        throw error('dispatch_not_allowed', 'Dispatch is frozen or its deadline has elapsed.');
      }
      const attempt = this.#db.prepare('SELECT * FROM attempts WHERE task_id = ? AND attempt_id = ?')
        .get(taskId, attemptId);
      if (!attempt || attempt.status !== 'reserved') throw error('invalid_attempt_state', 'Only a reserved attempt may start.');
      this.#db.prepare("UPDATE attempts SET status = 'started' WHERE attempt_id = ?").run(attemptId);
      this.#db.prepare('UPDATE runs SET version = version + 1, updated_at = ? WHERE task_id = ?')
        .run(this.#now(), taskId);
      this.#event(taskId, attemptId, 'dispatch_started', {});
      return this.getRun(taskId);
    });
  }

  recordOutcome(taskId, attemptId, outcomeInput, verificationInput, { expectedVersion, notStartedStatus = 'failed', nextState, fence } = {}) {
    const state = nextState === undefined ? undefined : jsonSnapshot(nextState);
    if (state !== undefined && (!state || typeof state !== 'object' || Array.isArray(state))) {
      throw error('invalid_state', 'The next recipe state must be an object.');
    }
    if (!['failed', 'cancelled', 'waiting_human'].includes(notStartedStatus)) {
      throw error('invalid_state', 'Invalid state for a non-dispatched attempt.');
    }
    const outcome = jsonSnapshot(outcomeInput);
    const verification = validateVerification(verificationInput);
    if (!['succeeded', 'failed', 'not_started', 'outcome_unknown'].includes(outcome?.status)) {
      throw error('invalid_outcome', 'An explicit execution outcome is required.');
    }
    if (outcome.status !== 'succeeded' && verification.status === 'pass') {
      throw error('invalid_outcome', 'An unsuccessful or unknown execution cannot pass verification.');
    }
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      this.#assertFence(row, fence);
      const attempt = this.#db.prepare('SELECT * FROM attempts WHERE task_id = ? AND attempt_id = ?')
        .get(taskId, attemptId);
      if (!attempt || attempt.status === 'settled' || attempt.status.startsWith('reconciled_')) throw error('invalid_attempt_state', 'The attempt is absent or already resolved.');
      if (row.status !== 'running') throw error('run_not_running', 'Only the current running owner may record an outcome.');
      if (attempt.status === 'reserved' && outcome.status !== 'not_started') {
        throw error('invalid_attempt_state', 'A tool outcome requires a persisted dispatch-start record.');
      }
      const unknown = outcome.status === 'outcome_unknown' || verification.status === 'unknown';
      const status = unknown ? 'reconciling'
        : outcome.status === 'not_started' ? notStartedStatus
          : verification.goalSatisfied === true ? 'completed'
          : verification.status === 'pass' ? 'running' : 'waiting_analysis';
      this.#db.prepare('UPDATE attempts SET status = ?, outcome_json = ?, verification_json = ? WHERE attempt_id = ?')
        .run(unknown ? 'unknown' : 'settled', JSON.stringify(outcome), JSON.stringify(verification), attemptId);
      const reason = ['running', 'completed'].includes(status) ? null
        : typeof verification.reason === 'string' ? verification.reason
          : typeof outcome.error?.code === 'string' ? outcome.error.code : null;
      this.#db.prepare('UPDATE runs SET status = ?, reason = ?, state_json = ?, version = version + 1, updated_at = ? WHERE task_id = ?')
        .run(status, reason, state === undefined ? row.state_json : JSON.stringify(state), this.#now(), taskId);
      this.#event(taskId, attemptId, 'outcome_recorded', { outcome, verification, status,
        ...(state === undefined ? {} : { nextState: state }) });
      return this.getRun(taskId);
    });
  }

  /**
   * Pause a running task. Outstanding work must already be settled or frozen; pause never cancels a write
   * that a downstream tool may still complete, and it bumps the fence so the pausing side is no longer a writer.
   */
  pauseRun(taskId, { expectedVersion, fence, reason = 'paused', environment } = {}) {
    requireString(reason, 'pause reason');
    if (environment !== undefined && (typeof environment !== 'object' || environment === null || Array.isArray(environment))) {
      throw error('invalid_environment', 'The paused environment snapshot must be a plain object.');
    }
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      this.#assertFence(row, fence);
      if (row.status !== 'running') throw error('run_not_running', 'Only a running task can be paused.');
      const unresolved = this.listUnresolved(taskId);
      if (unresolved.length) throw error('attempt_unresolved', 'Settle or reconcile outstanding work before pausing.');
      // Record what the run was paused under, so a later resume can detect a changed template or authority.
      const task = JSON.parse(row.task_json);
      const snapshotEnvironment = environment === undefined
        ? { recipeId: task.recipeId, recipeVersion: task.recipeVersion, scopeRef: task.scopeRef,
          workspaceRoot: task.workspaceRoot, allowedTools: [] }
        : jsonSnapshot(environment);
      this.#db.prepare(`UPDATE runs SET status = 'paused', reason = ?, fence = fence + 1, environment_json = ?,
        owner_id = NULL, owner_expires_at = NULL, version = version + 1, updated_at = ? WHERE task_id = ?`)
        .run(reason, JSON.stringify(snapshotEnvironment), this.#now(), taskId);
      this.#event(taskId, null, 'run_paused', { reason });
      return this.getRun(taskId);
    });
  }

  /**
   * Resume a paused task for a new owner. The caller must present the recipe/authority snapshot that was
   * current when the run paused; a changed template or authorization is refused instead of resumed blind.
   */
  resumeRun(taskId, { expectedVersion, environment, requireEnvironment = true } = {}) {
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      if (row.status !== 'paused') throw error('invalid_state', 'Only a paused task can be resumed.');
      const task = JSON.parse(row.task_json);
      if (this.#now() >= task.deadlineAt) throw error('budget_exceeded', 'The task deadline elapsed while paused.');
      if (requireEnvironment) {
        if (!row.environment_json) throw error('resume_environment_missing', 'This run has no recorded environment to compare.');
        if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
          throw error('resume_environment_required', 'Resume must present the current template and authority snapshot.');
        }
        const recorded = JSON.parse(row.environment_json);
        for (const key of ['recipeId', 'recipeVersion', 'scopeRef', 'workspaceRoot', 'allowedTools']) {
          const same = Array.isArray(recorded[key])
            ? Array.isArray(environment[key]) && [...recorded[key]].sort().join('\u0000') === [...environment[key]].sort().join('\u0000')
            : recorded[key] === environment[key];
          if (!same) throw error('resume_environment_changed', `Resume refused: ${key} changed while the run was paused.`);
        }
      }
      this.#db.prepare(`UPDATE runs SET status = 'running', reason = NULL, fence = fence + 1,
        owner_id = NULL, owner_expires_at = NULL, version = version + 1, updated_at = ? WHERE task_id = ?`)
        .run(this.#now(), taskId);
      this.#event(taskId, null, 'run_resumed', { fence: row.fence + 1 });
      return this.getRun(taskId);
    });
  }

  /** Record one compensation attempt against a settled business attempt. */
  recordCompensation(taskId, input, options = {}) {
    try {
      return this.#recordCompensation(taskId, input, options);
    } catch (failure) {
      // Persist the exhaustion after the failed transaction rolled back, then rethrow unchanged.
      if (failure instanceof RuntimeContractError && failure.code === 'recovery_exhausted') {
        this.#recordRecoveryExhaustion(taskId, { kind: 'compensation',
          reason: failure.recoveryReason ?? 'count' });
      }
      throw failure;
    }
  }

  #recordCompensation(taskId, input, { expectedVersion } = {}) {
    const plan = storageSnapshot(input?.plan);
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw error('invalid_compensation', 'A plan is required.');
    if (!['completed', 'unverified', 'diverged', 'unsupported'].includes(input.status)) {
      throw error('invalid_compensation', 'Compensation needs an explicit outcome status.');
    }
    if (input.status === 'completed' && input.verifiedByTarget !== true) {
      throw error('invalid_compensation', 'A completed compensation requires an observed target fact.');
    }
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      const attempt = this.#db.prepare('SELECT * FROM attempts WHERE task_id = ? AND attempt_id = ?')
        .get(taskId, plan.sourceAttemptId);
      if (!attempt || attempt.status !== 'settled') {
        throw error('invalid_compensation', 'Compensation requires a settled source attempt.');
      }
      // A compensation is recovery work: it draws on the recovery reserve, never on business budget.
      // The limit is per run, so a failed compensation goes to a human instead of buying another try.
      this.#chargeRecoveryWithinTx(taskId, { column: 'compensations_used',
        limitName: 'maxCompensations', kind: 'compensation' });
      const completed = input.status === 'completed';
      this.#db.prepare(`INSERT INTO compensations (compensation_id, task_id, source_attempt_id, status,
        plan_json, evidence_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(plan.compensationId, taskId, plan.sourceAttemptId, input.status, JSON.stringify(plan),
          input.evidenceRef ?? null, this.#now());
      // A rollback is only "done" when the target fact says so; anything else stays open for the caller.
      const nextStatus = completed ? row.status : row.status === 'running' ? 'waiting_human' : row.status;
      const nextReason = completed ? row.reason : input.status === 'unsupported' ? 'compensation_unsupported' : 'compensation_unresolved';
      this.#db.prepare('UPDATE runs SET status = ?, reason = ?, version = version + 1, updated_at = ? WHERE task_id = ?')
        .run(nextStatus, nextReason, this.#now(), taskId);
      this.#event(taskId, plan.sourceAttemptId, 'compensation_recorded',
        { compensationId: plan.compensationId, status: input.status, evidenceRef: input.evidenceRef ?? null });
      return { compensation: this.getCompensation(taskId, plan.compensationId), run: this.getRun(taskId) };
    });
  }

  getCompensation(taskId, compensationId) {
    this.#row(taskId);
    requireString(compensationId, 'compensationId');
    const row = this.#db.prepare('SELECT * FROM compensations WHERE task_id = ? AND compensation_id = ?')
      .get(taskId, compensationId);
    return row ? { compensationId: row.compensation_id, sourceAttemptId: row.source_attempt_id,
      status: row.status, plan: JSON.parse(row.plan_json), evidenceRef: row.evidence_ref,
      createdAt: row.created_at } : null;
  }

  listCompensations(taskId) {
    this.#row(taskId);
    return this.#db.prepare('SELECT * FROM compensations WHERE task_id = ? ORDER BY rowid')
      .all(taskId).map((row) => ({ compensationId: row.compensation_id, sourceAttemptId: row.source_attempt_id,
        status: row.status, evidenceRef: row.evidence_ref, createdAt: row.created_at }));
  }

  /**
   * Record a business cursor checkpoint. The environment and evidence are stored with it because a
   * checkpoint is only meaningful as "this state, under these conditions, proven by this fact" — a bare
   * state blob could be replayed into a context it was never verified in.
   */
  recordCheckpoint(taskId, input, { expectedVersion } = {}) {
    const value = storageSnapshot(input);
    requireString(value?.evidenceRef, 'checkpoint evidence reference');
    if (!Number.isSafeInteger(value?.stepIndex) || value.stepIndex < 0) throw error('invalid_checkpoint', 'A step index is required.');
    if (!value.state || typeof value.state !== 'object' || Array.isArray(value.state)) {
      throw error('invalid_checkpoint', 'A checkpoint records the verified business state.');
    }
    if (!value.environment || typeof value.environment !== 'object' || Array.isArray(value.environment)) {
      throw error('invalid_checkpoint', 'A checkpoint records the environment it was taken under.');
    }
    const checkpointId = randomUUID();
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      // Remember which attempts existed at this moment. "What happened after the checkpoint" is then a
      // recorded fact, so a rollback can be refused for effects that cannot be undone instead of trusting
      // a proposal to declare itself safe.
      const attemptFloor = this.#db.prepare('SELECT coalesce(max(rowid), 0) AS floor FROM attempts').get().floor;
      this.#db.prepare(`INSERT INTO checkpoints (checkpoint_id, task_id, step_index, attempt_floor, state_json,
        environment_json, evidence_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(checkpointId, taskId, value.stepIndex, attemptFloor, JSON.stringify(value.state),
          JSON.stringify(value.environment), value.evidenceRef, this.#now());
      // Checkpoints are metadata about verified progress; they advance the version like any event.
      this.#db.prepare('UPDATE runs SET version = version + 1, updated_at = ? WHERE task_id = ?')
        .run(this.#now(), taskId);
      this.#event(taskId, value.attemptId ?? null, 'checkpoint_recorded', { checkpointId, stepIndex: value.stepIndex });
      return { checkpointId, run: this.getRun(taskId) };
    });
  }

  /**
   * Restore the business cursor to a recorded checkpoint. This is the write half of rollback: the caller
   * must already have planned it (environment comparison, effect class) and the store re-checks the facts
   * it owns — that the run is the same run, that the target checkpoint exists for this task, and that the
   * run is in a state where restoring is meaningful. It never invents a compensated state.
   */
  restoreCheckpoint(taskId, checkpointId, { expectedVersion } = {}) {
    requireString(checkpointId, 'checkpointId');
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      if (row.status !== 'running') throw error('run_not_running', 'A rollback can only be applied to a running task.');
      const checkpoint = this.getCheckpoint(taskId, checkpointId);
      if (!checkpoint) throw error('invalid_checkpoint', 'The rollback target is not a checkpoint of this task.');
      // Any unresolved attempt means the business reality is unknown; restoring over it would bury that.
      if (this.listUnresolved(taskId).length) throw error('attempt_unresolved', 'Unknown effects must be reconciled before a rollback.');
      this.#db.prepare('UPDATE runs SET state_json = ?, version = version + 1, updated_at = ? WHERE task_id = ?')
        .run(JSON.stringify(checkpoint.state), this.#now(), taskId);
      this.#event(taskId, null, 'checkpoint_restored', { checkpointId, stepIndex: checkpoint.stepIndex,
        evidenceRef: checkpoint.evidenceRef });
      return this.getRun(taskId);
    });
  }

  getCheckpoint(taskId, checkpointId) {
    this.#row(taskId);
    const row = this.#db.prepare('SELECT * FROM checkpoints WHERE task_id = ? AND checkpoint_id = ?')
      .get(taskId, checkpointId);
    return row ? { checkpointId: row.checkpoint_id, stepIndex: row.step_index, attemptFloor: row.attempt_floor,
      state: JSON.parse(row.state_json),
      environment: JSON.parse(row.environment_json), evidenceRef: row.evidence_ref, createdAt: row.created_at } : null;
  }

  /**
   * Attempts that ran after a checkpoint was taken. A rollback must be able to see what it is undoing;
   * deriving that from recorded attempts (with their declared effects) is what keeps the decision honest.
   */
  readAttemptsAfter(taskId, checkpointId) {
    this.#row(taskId);
    const checkpoint = this.getCheckpoint(taskId, checkpointId);
    if (!checkpoint) throw error('invalid_checkpoint', 'The rollback target is not a checkpoint of this task.');
    return this.#db.prepare('SELECT * FROM attempts WHERE task_id = ? AND rowid > ? ORDER BY rowid')
      .all(taskId, checkpoint.attemptFloor).map((row) => ({
        attemptId: row.attempt_id,
        candidate: JSON.parse(row.candidate_json),
        status: row.status,
        outcome: row.outcome_json ? JSON.parse(row.outcome_json) : null,
        verification: row.verification_json ? JSON.parse(row.verification_json) : null,
        createdAt: row.created_at,
      }));
  }

  /** Most recent checkpoints first; a rollback target is chosen from recorded facts, never from a model claim. */
  listCheckpoints(taskId, { limit = 5 } = {}) {
    this.#row(taskId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw error('invalid_checkpoint', 'Checkpoint limit must be from 1 to 20.');
    return this.#db.prepare('SELECT checkpoint_id FROM checkpoints WHERE task_id = ? ORDER BY step_index DESC, rowid DESC LIMIT ?')
      .all(taskId, limit).map((row) => this.getCheckpoint(taskId, row.checkpoint_id));
  }

  /** Freeze unfinished work; this does not prove the previous owner is dead. */
  recoverRun(taskId, { expectedVersion } = {}) {
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      const unresolved = this.listUnresolved(taskId);
      if (!unresolved.length) return this.getRun(taskId);
      this.#db.prepare("UPDATE attempts SET status = 'unknown' WHERE task_id = ? AND status IN ('reserved', 'started')").run(taskId);
      this.#db.prepare("UPDATE runs SET status = 'reconciling', version = version + 1, updated_at = ? WHERE task_id = ?")
        .run(this.#now(), taskId);
      this.#event(taskId, null, 'recovery_required', { attemptIds: unresolved.map((item) => item.attemptId) });
      return this.getRun(taskId);
    });
  }

  listUnresolved(taskId) {
    this.#row(taskId);
    return this.#db.prepare("SELECT * FROM attempts WHERE task_id = ? AND status IN ('reserved', 'started', 'unknown') ORDER BY created_at, attempt_id")
      .all(taskId).map((row) => ({
        attemptId: row.attempt_id, status: row.status, candidate: JSON.parse(row.candidate_json),
        outcome: row.outcome_json === null ? null : JSON.parse(row.outcome_json),
        verification: row.verification_json === null ? null : JSON.parse(row.verification_json),
      }));
  }

  /**
   * Recovery reserve accounting, called inside the caller's transaction so the charge and the refusal
   * decision see one snapshot. The reserve exists so a stopped run can be reconciled or compensated
   * without spending business budget, and it has to actually bound that work: a declared limit that is
   * never read would let recovery run unbounded while every test stayed green.
   *
   * The window starts at the first recovery action and is measured against `recoveryTimeoutMs`.
   */
  #chargeRecoveryWithinTx(taskId, { column, limitName, kind }) {
    const row = this.#row(taskId);
    const budget = validateBudget(JSON.parse(row.task_json).budget);
    const now = this.#now();
    const startedAt = row.recovery_started_at ?? now;
    const overCount = row[column] + 1 > budget[limitName];
    const overTime = now - startedAt > budget.recoveryTimeoutMs;
    if (overCount || overTime) {
      // Carry the reason on the error: callers must not re-derive it from message text.
      const exhaustion = error('recovery_exhausted', `The ${kind} reserve is exhausted.`);
      exhaustion.recoveryReason = overCount ? 'count' : 'timeout';
      throw exhaustion;
    }
    this.#db.prepare(`UPDATE runs SET ${column} = ${column} + 1, recovery_started_at = ?,
      version = version + 1, updated_at = ? WHERE task_id = ?`).run(startedAt, now, taskId);
    this.#event(taskId, null, 'recovery_charged', { kind, used: row[column] + 1, limit: budget[limitName] });
    return true;
  }

  /**
   * A refused recovery action is recorded in its own commit after the failed transaction rolled back, so
   * the exhaustion is visible in persisted state instead of only living in a thrown error.
   */
  #recordRecoveryExhaustion(taskId, { kind, reason }) {
    return this.#transaction(() => {
      const row = this.#row(taskId);
      const budget = validateBudget(JSON.parse(row.task_json).budget);
      const column = kind === 'recoveryRead' ? 'recovery_reads_used' : 'compensations_used';
      const limitName = kind === 'recoveryRead' ? 'maxRecoveryReads' : 'maxCompensations';
      // Only a stopped run is handed to a human; work still running or already resolved is left alone.
      const nextStatus = row.status === 'reconciling' ? 'waiting_human' : row.status;
      this.#db.prepare('UPDATE runs SET status = ?, reason = ?, version = version + 1, updated_at = ? WHERE task_id = ?')
        .run(nextStatus, 'recovery_exhausted', this.#now(), taskId);
      this.#event(taskId, null, 'recovery_exhausted', { kind, used: row[column],
        limit: budget[limitName], timedOut: reason === 'timeout', timeoutMs: budget.recoveryTimeoutMs });
      return this.getRun(taskId);
    });
  }

  /**
   * Resolve one frozen attempt with explicit external evidence. Reconciliation never invents success:
   * it records whether the business effect exists and leaves the goal to a later verified step.
   */
  reconcileAttempt(taskId, attemptId, { expectedVersion, resolution, evidenceRef, note = null } = {}) {
    requireString(attemptId, 'attemptId');
    requireString(evidenceRef, 'reconciliation evidence reference');
    if (!['applied', 'absent'].includes(resolution)) {
      throw error('invalid_reconciliation', 'Reconciliation must state whether the effect was applied or absent.');
    }
    if (note !== null && typeof note !== 'string') throw error('invalid_reconciliation', 'A reconciliation note must be text.');
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      const attempt = this.#db.prepare('SELECT * FROM attempts WHERE task_id = ? AND attempt_id = ?').get(taskId, attemptId);
      if (!attempt) throw error('invalid_attempt_state', 'The attempt does not belong to this task.');
      if (!['started', 'unknown', 'reserved'].includes(attempt.status)) {
        throw error('invalid_attempt_state', 'Only unresolved work may be reconciled.');
      }
      // Charge the recovery reserve before doing any work: reconciliation is recovery, not business.
      this.#chargeRecoveryWithinTx(taskId, { column: 'recovery_reads_used',
        limitName: 'maxRecoveryReads', kind: 'recoveryRead' });
      const status = resolution === 'applied' ? 'reconciled_applied' : 'reconciled_absent';
      const outcome = { status: resolution === 'applied' ? 'succeeded' : 'failed',
        reconciled: true, resolution, evidenceRef, ...(note === null ? {} : { note }),
        error: { code: `reconciled_${resolution}`, message: 'Reconciled from external evidence; this is not goal verification.' } };
      const verification = validateVerification({ status: 'unknown', progress: 'unknown', goalSatisfied: null,
        verifierId: 'runtime-reconciliation', verifierVersion: '1', evidenceRefs: [evidenceRef],
        reason: `reconciled_${resolution}` });
      this.#db.prepare('UPDATE attempts SET status = ?, outcome_json = ?, verification_json = ? WHERE attempt_id = ?')
        .run(status, JSON.stringify(outcome), JSON.stringify(verification), attemptId);
      const remaining = this.#db.prepare("SELECT count(*) AS count FROM attempts WHERE task_id = ? AND status IN ('reserved', 'started', 'unknown')")
        .get(taskId).count;
      const nextStatus = remaining ? 'reconciling' : 'waiting_analysis';
      this.#db.prepare('UPDATE runs SET status = ?, reason = ?, version = version + 1, updated_at = ? WHERE task_id = ?')
        .run(nextStatus, remaining ? 'reconciliation_incomplete' : `reconciled_${resolution}`, this.#now(), taskId);
      this.#event(taskId, attemptId, 'attempt_reconciled', { resolution, evidenceRef, remaining });
      return this.getRun(taskId);
    });
  }

  /** True when this tool and key already applied an effect that passed verification. */
  idempotencyClaimed(taskId, key, toolName) {
    requireString(key, 'idempotencyKey');
    requireString(toolName, 'toolName');
    this.#row(taskId);
    return this.#db.prepare(`SELECT 1 FROM attempts WHERE task_id = ?
      AND json_extract(candidate_json, '$.toolName') = ?
      AND json_extract(candidate_json, '$.idempotencyKey') = ?
      AND (status = 'reconciled_applied'
        OR (status = 'settled' AND json_extract(outcome_json, '$.status') = 'succeeded'
          AND json_extract(verification_json, '$.status') = 'pass'))
      LIMIT 1`).get(taskId, toolName, key) !== undefined;
  }

  putEvidence(taskId, label, value, { expectedVersion } = {}) {
    requireString(label, 'evidence label');
    const raw = JSON.stringify(storageSnapshot(value));
    const bytes = Buffer.byteLength(raw, 'utf8');
    if (bytes > EVIDENCE_LIMIT) throw error('evidence_too_large', 'Evidence exceeds the 4 MiB JSON limit.');
    const hash = sha256(raw);
    const ref = `runtime-evidence:${randomUUID()}#sha256:${hash}`;
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      this.#db.prepare(`INSERT INTO evidence (ref, task_id, label, raw_json, sha256, bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(ref, taskId, label, raw, hash, bytes, this.#now());
      this.#event(taskId, null, 'evidence_stored', { ref, label, bytes });
      this.#db.prepare('UPDATE runs SET version = version + 1, updated_at = ? WHERE task_id = ?')
        .run(this.#now(), taskId);
      return { ref, bytes, run: this.getRun(taskId) };
    });
  }

  #pendingAnalysis(row, analysisId) {
    const analysis = this.#db.prepare('SELECT * FROM analyses WHERE task_id = ? AND analysis_id = ?')
      .get(row.task_id, analysisId);
    if (row.status !== 'analyzing' || !analysis || analysis.status !== 'pending') {
      throw error('invalid_analysis_state', 'Only the active pending analysis may change.');
    }
    return analysis;
  }

  reserveAnalysis(taskId, { expectedVersion, analysisId = randomUUID() } = {}) {
    requireString(analysisId, 'analysisId');
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      if (row.status !== 'waiting_analysis') throw error('invalid_analysis_state', 'The run is not waiting for analysis.');
      if (this.#db.prepare("SELECT 1 FROM attempts WHERE task_id = ? AND status IN ('reserved', 'started', 'unknown')").get(taskId)) {
        throw error('attempt_unresolved', 'Business effects must be resolved before analysis.');
      }
      if (this.#db.prepare("SELECT 1 FROM analyses WHERE task_id = ? AND status IN ('pending', 'proposed') AND consumed_at IS NULL").get(taskId)) {
        throw error('analysis_unresolved', 'Resolve the previous analysis before reserving another.');
      }
      const task = JSON.parse(row.task_json);
      if (this.#now() >= task.deadlineAt || row.analysis_calls_used >= validateBudget(task.budget).maxAnalysisCalls) {
        throw error('budget_exceeded', 'The task has no analysis budget remaining.');
      }
      this.#db.prepare(`INSERT INTO analyses (analysis_id, task_id, status, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, ?)`).run(analysisId, taskId, this.#now(), this.#now());
      this.#db.prepare(`UPDATE runs SET status = 'analyzing', reason = NULL,
        analysis_calls_used = analysis_calls_used + 1, version = version + 1, updated_at = ? WHERE task_id = ?`)
        .run(this.#now(), taskId);
      this.#event(taskId, null, 'analysis_reserved', { analysisId });
      return { analysisId, run: this.getRun(taskId) };
    });
  }

  bindAnalysisEvidence(taskId, analysisId, refs, { expectedVersion } = {}) {
    if (!Array.isArray(refs) || refs.length > 32 || new Set(refs).size !== refs.length) {
      throw error('invalid_evidence_refs', 'Analysis evidence must contain at most 32 unique references.');
    }
    for (const ref of refs) requireString(ref, 'evidence ref');
    const snapshot = [...refs];
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      this.#pendingAnalysis(row, analysisId);
      this.#db.prepare('UPDATE analyses SET evidence_refs_json = ?, updated_at = ? WHERE analysis_id = ?')
        .run(JSON.stringify(snapshot), this.#now(), analysisId);
      this.#db.prepare('UPDATE runs SET version = version + 1, updated_at = ? WHERE task_id = ?')
        .run(this.#now(), taskId);
      this.#event(taskId, null, 'analysis_evidence_bound', { analysisId, refs: snapshot });
      return this.getRun(taskId);
    });
  }

  readAnalysisEvidence(taskId, analysisId, ref, { expectedVersion, maxBytes = 16_384 } = {}) {
    requireString(ref, 'evidence ref');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > READ_LIMIT) {
      throw error('invalid_evidence_limit', 'Evidence reads require a byte limit from 1 to 32768.');
    }
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      const analysis = this.#pendingAnalysis(row, analysisId);
      if (!JSON.parse(analysis.evidence_refs_json).includes(ref) || !/^runtime-evidence:[0-9a-f-]{36}#sha256:[0-9a-f]{64}$/.test(ref)) {
        throw error('evidence_not_allowed', 'The reference is not readable analysis evidence.');
      }
      const task = JSON.parse(row.task_json);
      if (this.#now() >= task.deadlineAt || row.io_operations_used >= validateBudget(task.budget).maxIoOperations) {
        throw error('budget_exceeded', 'The task has no evidence I/O budget remaining.');
      }
      if (analysis.reads_used >= 2 || analysis.bytes_read >= READ_LIMIT) {
        throw error('analysis_read_limit', 'The analysis has exhausted its evidence reads.');
      }
      // Select metadata before loading raw evidence so foreign rows cannot enter this read path.
      const metadata = this.#db.prepare('SELECT label, bytes, sha256 FROM evidence WHERE task_id = ? AND ref = ?').get(taskId, ref);
      if (!metadata) throw error('evidence_not_allowed', 'Evidence must belong to the analysis task.');
      const { raw_json: raw } = this.#db.prepare('SELECT raw_json FROM evidence WHERE task_id = ? AND ref = ?').get(taskId, ref);
      if (sha256(raw) !== metadata.sha256 || !ref.endsWith(`#sha256:${metadata.sha256}`)
        || Buffer.byteLength(raw, 'utf8') !== metadata.bytes) {
        throw error('evidence_integrity_error', 'Stored evidence failed its SHA-256 integrity check.');
      }
      const buffer = Buffer.from(raw, 'utf8');
      let end = Math.min(buffer.length, maxBytes, READ_LIMIT - analysis.bytes_read);
      // A UTF-8 prefix ends before an incomplete code point, without replacement characters.
      while (end < buffer.length && end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
      const text = buffer.subarray(0, end).toString('utf8');
      this.#db.prepare(`UPDATE analyses SET reads_used = reads_used + 1, bytes_read = bytes_read + ?,
        updated_at = ? WHERE analysis_id = ?`).run(end, this.#now(), analysisId);
      this.#db.prepare(`UPDATE runs SET io_operations_used = io_operations_used + 1,
        version = version + 1, updated_at = ? WHERE task_id = ?`).run(this.#now(), taskId);
      this.#event(taskId, null, 'analysis_evidence_read', { analysisId, ref, bytes: end, omittedBytes: metadata.bytes - end });
      return { ref, label: metadata.label, text, bytes: end, omittedBytes: metadata.bytes - end, run: this.getRun(taskId) };
    });
  }

  /** Bounded recent evidence metadata for reuse by a later analysis package. */
  listEvidence(taskId, { limit = 8 } = {}) {
    this.#row(taskId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) {
      throw error('invalid_evidence_limit', 'Evidence listing must be from 1 to 16 entries.');
    }
    return this.#db.prepare(`SELECT ref, label, bytes, created_at FROM evidence WHERE task_id = ?
      ORDER BY rowid DESC LIMIT ?`).all(taskId, limit)
      .map((row) => ({ ref: row.ref, label: row.label, bytes: row.bytes, createdAt: row.created_at }));
  }

  recordAnalysis(taskId, analysisId, input, { expectedVersion } = {}) {
    const result = storageSnapshot(input);
    const statuses = ['proposed', 'analysis_parse_failed', 'analysis_timeout', 'analysis_cancelled', 'analysis_failed', 'analysis_package_failed'];
    if (!result || Array.isArray(result) || !statuses.includes(result.status)
      || Object.keys(result).some((key) => !['status', result.status === 'proposed' ? 'repair' : 'error'].includes(key))) {
      throw error('invalid_analysis_result', 'An explicit bounded analysis result is required.');
    }
    if (result.status !== 'proposed') {
      if (!result.error || Array.isArray(result.error) || typeof result.error !== 'object'
        || Object.keys(result.error).some((key) => !['code', 'message'].includes(key))) {
        throw error('invalid_analysis_result', 'Analysis errors require a bounded code and message.');
      }
      requireString(result.error.code, 'analysis error code');
      requireString(result.error.message, 'analysis error message');
    }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') >= READ_LIMIT) {
      throw error('invalid_analysis_result', 'Analysis results must be smaller than 32 KiB.');
    }
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      const analysis = this.#pendingAnalysis(row, analysisId);
      if (result.status === 'proposed') {
        result.repair = validateRepairAction(result.repair, { allowedEvidenceRefs: JSON.parse(analysis.evidence_refs_json) });
      }
      const status = result.status === 'proposed'
        ? result.repair.requiresHumanReview ? 'waiting_human' : 'waiting_analysis'
        : result.status === 'analysis_cancelled' ? 'cancelled' : 'waiting_human';
      const reason = result.status === 'proposed' ? 'repair_proposed' : result.status;
      this.#db.prepare('UPDATE analyses SET status = ?, result_json = ?, updated_at = ? WHERE analysis_id = ?')
        .run(result.status, JSON.stringify(result), this.#now(), analysisId);
      this.#db.prepare('UPDATE runs SET status = ?, reason = ?, version = version + 1, updated_at = ? WHERE task_id = ?')
        .run(status, reason, this.#now(), taskId);
      this.#event(taskId, null, 'analysis_recorded', { analysisId, result });
      return this.getRun(taskId);
    });
  }

  getAnalysis(taskId, analysisId) {
    this.#row(taskId);
    const row = this.#db.prepare(`SELECT analysis_id, status, evidence_refs_json, result_json, reads_used,
      bytes_read, created_at, updated_at, consumed_at FROM analyses WHERE task_id = ? AND analysis_id = ?`).get(taskId, analysisId);
    return row ? { analysisId: row.analysis_id, status: row.status, evidenceRefs: JSON.parse(row.evidence_refs_json),
      result: row.result_json === null ? null : JSON.parse(row.result_json), readsUsed: row.reads_used,
      bytesRead: row.bytes_read, createdAt: row.created_at, updatedAt: row.updated_at, consumedAt: row.consumed_at } : null;
  }

  startRepair(taskId, analysisId, { expectedVersion, signature, repairId = randomUUID() } = {}) {
    requireString(analysisId, 'analysisId');
    requireString(repairId, 'repairId');
    // The trusted runtime supplies this stable signature, never the analyzer response.
    requireString(signature, 'signature');
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      const analysis = this.getAnalysis(taskId, analysisId);
      if (row.status !== 'waiting_analysis' || row.reason !== 'repair_proposed'
        || !analysis || analysis.status !== 'proposed' || analysis.consumedAt !== null) {
        throw error('invalid_repair_state', 'Only an unconsumed proposal waiting for repair may start.');
      }
      if (this.listUnresolved(taskId).length) throw error('attempt_unresolved', 'Resolve business work before repair.');
      const action = validateRepairAction(analysis.result?.repair, { allowedEvidenceRefs: analysis.evidenceRefs });
      if (action.requiresHumanReview) throw error('repair_requires_review', 'The repair requires human review.');
      // A rollback is a state restore, so it is admissible here; the scheduler plans it against recorded
      // checkpoints and refuses effects that cannot be undone. Persisting it is what makes the branch real.
      const task = JSON.parse(row.task_json);
      if (this.getRepairFailures(taskId, signature) >= 2) throw error('repair_limit', 'This repair signature has failed twice.');
      if (this.#now() >= task.deadlineAt || (action.kind === 'retry_with'
        && (row.attempts_used >= task.budget.maxAttempts || row.tool_calls_used >= task.budget.maxToolCalls))) {
        throw error('budget_exceeded', 'The task has no repair budget remaining.');
      }
      const now = this.#now();
      const floor = this.#db.prepare('SELECT coalesce(max(rowid), 0) AS floor FROM attempts').get().floor;
      const aborted = action.kind === 'abort';
      this.#db.prepare(`INSERT INTO repairs (repair_id, analysis_id, task_id, signature, kind, status,
        candidate_json, attempt_floor, outcome_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(repairId, analysisId, taskId, signature, action.kind, aborted ? 'settled' : 'reserved',
          action.kind === 'retry_with' ? JSON.stringify(action.candidate) : null, floor,
          aborted ? JSON.stringify({ reason: action.reason }) : null, now, now);
      this.#db.prepare('UPDATE analyses SET consumed_at = ? WHERE analysis_id = ?').run(now, analysisId);
      this.#db.prepare('UPDATE runs SET status = ?, reason = ?, version = version + 1, updated_at = ? WHERE task_id = ?')
        .run(aborted ? 'cancelled' : 'running', aborted ? action.reason : null, now, taskId);
      this.#event(taskId, null, aborted ? 'repair_aborted' : 'repair_started',
        { repairId, analysisId, signature, kind: action.kind });
      return { repairId, repair: { ...action, id: repairId, signature }, run: this.getRun(taskId) };
    });
  }

  getRepair(taskId, repairId) {
    this.#row(taskId);
    const row = this.#db.prepare('SELECT * FROM repairs WHERE task_id = ? AND repair_id = ?').get(taskId, repairId);
    return row ? { id: row.repair_id, analysisId: row.analysis_id, kind: row.kind, signature: row.signature,
      status: row.status, candidate: row.candidate_json === null ? null : JSON.parse(row.candidate_json),
      attemptId: row.attempt_id, outcome: row.outcome_json === null ? null : JSON.parse(row.outcome_json),
      createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  getRepairFailures(taskId, signature) {
    this.#row(taskId);
    requireString(signature, 'signature');
    return this.#db.prepare('SELECT failures FROM repair_failures WHERE task_id = ? AND signature = ?')
      .get(taskId, signature)?.failures ?? 0;
  }

  /** Bounded repair history for the next candidate decision; never includes raw model output. */
  readRepairTrace(taskId, { limit = 3 } = {}) {
    this.#row(taskId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
      throw error('invalid_repair_trace', 'Repair trace limit must be from 1 to 10.');
    }
    return this.#db.prepare(`SELECT repair_id, analysis_id, kind, signature, status, attempt_id, outcome_json
      FROM repairs WHERE task_id = ? ORDER BY rowid DESC LIMIT ?`).all(taskId, limit).reverse().map((row) => {
      const outcome = row.outcome_json === null ? null : JSON.parse(row.outcome_json);
      return { repairId: row.repair_id, analysisId: row.analysis_id, kind: row.kind, signature: row.signature,
        status: row.status, attemptId: row.attempt_id,
        succeeded: typeof outcome?.succeeded === 'boolean' ? outcome.succeeded : null };
    });
  }

  /**
   * Cross-task repair evidence grouped by repair signature.
   *
   * This is the only read path that spans tasks, and it exists so a pattern can be justified by many
   * independent runs instead of one task repairing itself. It returns signatures only — no pattern text —
   * so nothing here can authorize a rule; the resolver still needs a confirmed approval and a registered
   * body. `independentTasks` is counted by DISTINCT task id, which is what makes self-repair worthless
   * as evidence.
   */
  listPatternEvidence({ limit = 500 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) {
      throw error('invalid_pattern_evidence', 'Pattern evidence limit must be from 1 to 2000.');
    }
    const rows = this.#db.prepare(`SELECT signature, task_id, repair_id, status, outcome_json
      FROM repairs WHERE status IN ('settled', 'blocked', 'restored') ORDER BY rowid DESC LIMIT ?`).all(limit);
    const bySignature = new Map();
    for (const row of rows) {
      const outcome = row.outcome_json === null ? null : JSON.parse(row.outcome_json);
      const entry = bySignature.get(row.signature) ?? { signature: row.signature, repairs: [] };
      entry.repairs.push({ repairId: row.repair_id, taskId: row.task_id, status: row.status,
        succeeded: typeof outcome?.succeeded === 'boolean' ? outcome.succeeded : null });
      bySignature.set(row.signature, entry);
    }
    return [...bySignature.values()].map((entry) => Object.freeze({
      patternId: entry.signature,
      samples: entry.repairs.length,
      independentTasks: new Set(entry.repairs.map((item) => item.taskId)).size,
      repairs: Object.freeze(entry.repairs.map((item) => Object.freeze(item))),
    }));
  }

  finishRepair(taskId, repairId, { attemptId, status, succeeded, reason, expectedVersion } = {}) {
    requireString(repairId, 'repairId');
    if (!['settled', 'blocked', 'unknown', 'observed', 'restored'].includes(status) || (succeeded !== undefined && typeof succeeded !== 'boolean')) {
      throw error('invalid_repair_outcome', 'A valid repair status and optional boolean success are required.');
    }
    if (attemptId !== undefined) requireString(attemptId, 'attemptId');
    if (reason !== undefined) requireString(reason, 'reason');
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      const repair = this.#db.prepare('SELECT * FROM repairs WHERE task_id = ? AND repair_id = ?').get(taskId, repairId);
      if (!repair || repair.status !== 'reserved') throw error('invalid_repair_state', 'Only a reserved same-task repair may finish.');
      let actualSuccess = false;
      if (status === 'observed') {        // Evidence gathering observes; it neither dispatches business work nor proves success.
        if (attemptId !== undefined || succeeded !== undefined || row.status !== 'running'
          || this.#db.prepare('SELECT 1 FROM attempts WHERE task_id = ? AND rowid > ?').get(taskId, repair.attempt_floor)) {
          throw error('invalid_repair_outcome', 'Observed repair work must not dispatch or claim an outcome.');
        }
      } else if (status === 'restored') {
        // A rollback restores a recorded cursor; it produces no attempt of its own, so it must not be able to
        // claim a success that only a freshly verified attempt could justify.
        if (attemptId !== undefined || succeeded === true || row.status !== 'running') {
          throw error('invalid_repair_outcome', 'A restored repair settles a cursor, not an attempt.');
        }
        actualSuccess = true;
      } else if (status === 'blocked') {
        if (attemptId !== undefined || succeeded === true || row.status !== 'running'
          || this.#db.prepare('SELECT 1 FROM attempts WHERE task_id = ? AND rowid > ?').get(taskId, repair.attempt_floor)) {
          throw error('invalid_repair_outcome', 'A blocked repair must have no attempted work.');
        }
      } else {
        const attempt = this.#db.prepare('SELECT rowid AS ordinal, * FROM attempts WHERE task_id = ? AND attempt_id = ?')
          .get(taskId, attemptId ?? null);
        if (!attempt || attempt.ordinal <= repair.attempt_floor
          || (repair.candidate_json !== null && !isDeepStrictEqual(JSON.parse(attempt.candidate_json), JSON.parse(repair.candidate_json)))) {
          throw error('invalid_repair_attempt', 'Repair work must match a newer same-task attempt.');
        }
        if (status === 'unknown') {
          if (attempt.status === 'settled' || row.status !== 'reconciling' || succeeded !== undefined) {
            throw error('invalid_repair_outcome', 'Unknown repair work must remain unresolved and reconciling.');
          }
        } else {
          if (!['running', 'completed', 'waiting_analysis', 'reconciling', 'failed', 'waiting_human', 'cancelled'].includes(row.status)
            || attempt.status !== 'settled' || !attempt.outcome_json || !attempt.verification_json) {
            throw error('invalid_repair_outcome', 'Settled repair work requires a stored settled outcome and verification.');
          }
          const outcome = JSON.parse(attempt.outcome_json);
          const verification = validateVerification(JSON.parse(attempt.verification_json));
          if (!['succeeded', 'failed', 'not_started'].includes(outcome.status)) {
            throw error('invalid_repair_outcome', 'Settled repair work requires an actual execution outcome.');
          }
          actualSuccess = outcome.status === 'succeeded' && verification.status === 'pass'
            && (verification.goalSatisfied === true || verification.progress === 'advanced');
          if (succeeded !== undefined && succeeded !== actualSuccess) {
            throw error('invalid_repair_outcome', 'Claimed repair success disagrees with stored verification.');
          }
        }
      }
      const failed = status === 'blocked' || (status === 'settled' && !actualSuccess && row.status !== 'cancelled');
      if (failed) this.#db.prepare(`INSERT INTO repair_failures (task_id, signature, failures) VALUES (?, ?, 1)
        ON CONFLICT(task_id, signature) DO UPDATE SET failures = failures + 1`).run(taskId, repair.signature);
      const limited = this.getRepairFailures(taskId, repair.signature) >= 2;
      const now = this.#now();
      const metadata = { ...(['unknown', 'observed'].includes(status) ? {} : { succeeded: actualSuccess }), ...(reason === undefined ? {} : { reason }) };
      this.#db.prepare('UPDATE repairs SET status = ?, attempt_id = ?, outcome_json = ?, updated_at = ? WHERE repair_id = ?')
        .run(status, attemptId ?? null, JSON.stringify(metadata), now, repairId);
      const nextStatus = row.status === 'reconciling' ? row.status : limited ? 'waiting_human'
        : status === 'observed' ? 'waiting_analysis'
        : status === 'restored' ? 'waiting_analysis'
        : status === 'blocked' ? 'failed' : failed && row.status === 'running' ? 'waiting_analysis' : row.status;
      const nextReason = row.status === 'reconciling' ? row.reason : limited ? 'repair_limit'
        : status === 'observed' ? 'evidence_gathered'
        : status === 'restored' ? 'checkpoint_restored'
        : status === 'blocked' ? reason ?? 'repair_blocked'
          : failed && row.status === 'running' ? 'repair_no_progress' : row.reason;
      this.#db.prepare('UPDATE runs SET status = ?, reason = ?, version = version + 1, updated_at = ? WHERE task_id = ?')
        .run(nextStatus, nextReason, now, taskId);
      this.#event(taskId, attemptId ?? null, 'repair_finished', { repairId, status, ...metadata });
      return this.getRun(taskId);
    });
  }

  getLatestAttempt(taskId) {
    this.#row(taskId);
    const row = this.#db.prepare(`SELECT attempt_id, candidate_json, outcome_json, verification_json, status
      FROM attempts WHERE task_id = ? ORDER BY rowid DESC LIMIT 1`).get(taskId);
    return row ? { attemptId: row.attempt_id, candidate: JSON.parse(row.candidate_json), status: row.status,
      outcome: row.outcome_json === null ? null : JSON.parse(row.outcome_json),
      verification: row.verification_json === null ? null : JSON.parse(row.verification_json) } : null;
  }

  readRecentTrace(taskId, { limit = 3 } = {}) {
    this.#row(taskId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
      throw error('invalid_trace_limit', 'Recent trace limit must be from 1 to 10.');
    }
    return this.#db.prepare(`SELECT event_id, sequence, kind, attempt_id, created_at
      FROM events WHERE task_id = ? ORDER BY sequence DESC LIMIT ?`).all(taskId, limit)
      .reverse().map((row) => ({ eventId: row.event_id, sequence: row.sequence, kind: row.kind,
        attemptId: row.attempt_id, createdAt: row.created_at }));
  }

  readEvents(taskId) {
    this.#row(taskId);
    return this.#db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY sequence').all(taskId)
      .map((row) => ({ sequence: row.sequence, eventId: row.event_id, attemptId: row.attempt_id,
        kind: row.kind, payload: JSON.parse(row.payload_json), createdAt: row.created_at }));
  }
}
