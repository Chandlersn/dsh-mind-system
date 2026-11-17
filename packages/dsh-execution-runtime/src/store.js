import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
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
      CREATE UNIQUE INDEX IF NOT EXISTS analyses_one_unresolved ON analyses(task_id)
        WHERE status IN ('pending', 'proposed');
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
      if (this.#db.prepare("SELECT 1 FROM attempts WHERE task_id = ? AND status != 'settled'").get(taskId)) {
        throw error('attempt_unresolved', 'Business effects must be resolved before analysis.');
      }
      if (this.#db.prepare("SELECT 1 FROM analyses WHERE task_id = ? AND status IN ('pending', 'proposed')").get(taskId)) {
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
      bytes_read, created_at, updated_at FROM analyses WHERE task_id = ? AND analysis_id = ?`).get(taskId, analysisId);
    return row ? { analysisId: row.analysis_id, status: row.status, evidenceRefs: JSON.parse(row.evidence_refs_json),
      result: row.result_json === null ? null : JSON.parse(row.result_json), readsUsed: row.reads_used,
      bytesRead: row.bytes_read, createdAt: row.created_at, updatedAt: row.updated_at } : null;
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
