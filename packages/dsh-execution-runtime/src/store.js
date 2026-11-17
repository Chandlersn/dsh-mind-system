import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { RuntimeContractError, jsonSnapshot, requireString, validateBudget, validateCandidate, validateTask, validateVerification } from './contracts.js';

const error = (code, message) => new RuntimeContractError(code, message);

/** A phase-zero transactional prototype; ownership and leases are not yet implemented. */
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
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
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
    })) {
      if (!columns.has(name)) this.#db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${declaration}`);
    }
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
        analysisCalls: row.analysis_calls_used },
      state: JSON.parse(row.state_json), reason: row.reason,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
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

  reserveAttempt(taskId, input, { expectedVersion, attemptId = randomUUID() } = {}) {
    const candidate = validateCandidate(input);
    requireString(attemptId, 'attemptId');
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      const task = JSON.parse(row.task_json);
      if (row.status !== 'running') throw error('run_not_running', 'The run cannot dispatch new work.');
      if (this.#db.prepare("SELECT 1 FROM attempts WHERE task_id = ? AND status != 'settled'").get(taskId)) {
        throw error('attempt_unresolved', 'Resolve the previous attempt before reserving another.');
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

  markStarted(taskId, attemptId, { expectedVersion } = {}) {
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
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

  recordOutcome(taskId, attemptId, outcomeInput, verificationInput, { expectedVersion, notStartedStatus = 'failed', nextState } = {}) {
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
      const attempt = this.#db.prepare('SELECT * FROM attempts WHERE task_id = ? AND attempt_id = ?')
        .get(taskId, attemptId);
      if (!attempt || attempt.status === 'settled') throw error('invalid_attempt_state', 'The attempt is absent or already settled.');
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

  /** Freeze unfinished work; this does not prove the previous owner is dead. */
  recoverRun(taskId, { expectedVersion } = {}) {
    return this.#transaction(() => {
      const row = this.#row(taskId);
      this.#version(row, expectedVersion);
      const unresolved = this.listUnresolved(taskId);
      if (!unresolved.length) return this.getRun(taskId);
      this.#db.prepare("UPDATE attempts SET status = 'unknown' WHERE task_id = ? AND status != 'settled'").run(taskId);
      this.#db.prepare("UPDATE runs SET status = 'reconciling', version = version + 1, updated_at = ? WHERE task_id = ?")
        .run(this.#now(), taskId);
      this.#event(taskId, null, 'recovery_required', { attemptIds: unresolved.map((item) => item.attemptId) });
      return this.getRun(taskId);
    });
  }

  listUnresolved(taskId) {
    this.#row(taskId);
    return this.#db.prepare("SELECT * FROM attempts WHERE task_id = ? AND status != 'settled' ORDER BY created_at, attempt_id")
      .all(taskId).map((row) => ({
        attemptId: row.attempt_id, status: row.status, candidate: JSON.parse(row.candidate_json),
        outcome: row.outcome_json === null ? null : JSON.parse(row.outcome_json),
        verification: row.verification_json === null ? null : JSON.parse(row.verification_json),
      }));
  }

  readEvents(taskId) {
    this.#row(taskId);
    return this.#db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY sequence').all(taskId)
      .map((row) => ({ sequence: row.sequence, eventId: row.event_id, attemptId: row.attempt_id,
        kind: row.kind, payload: JSON.parse(row.payload_json), createdAt: row.created_at }));
  }
}
