import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateCandidate, validateTaskProvenance, validateVerification } from './contracts.js';

export const REPAIR_EVIDENCE_LIMITS = Object.freeze({ databaseBytes: 64 * 1024 * 1024,
  fieldBytes: 256 * 1024, totalBytes: 1024 * 1024, identityBytes: 4096 });
const result = (status, reason, extra = {}) => ({ status, reason, ...extra,
  governanceEligible: false, goalProof: 'not_evaluated', principleAttribution: 'not_evaluated' });
const fail = (status, reason) => { throw Object.assign(new Error(reason), { evidenceStatus: status }); };
const check = (condition, reason) => { if (!condition) fail('mismatch', reason); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Read one producer claim from a trusted host-selected database in one SQLite snapshot.
 * Match means persisted identity consistency, not independent verification or attribution.
 * File references are returned untouched. The host owns path authorization and must not
 * pass a requester-selected path. SQLite may update transient WAL SHM reader marks;
 * this reader never writes persistent records, migrates schemas, or initializes identity.
 */
export function readRepairEvidence({ runtimeFilePath, producerId, eventId } = {}) {
  let db;
  try {
    if (typeof runtimeFilePath !== 'string' || !isAbsolute(runtimeFilePath)
      || [producerId, eventId].some((id) => typeof id !== 'string' || !id.trim() || id.includes('\0')
        || Buffer.byteLength(id) > REPAIR_EVIDENCE_LIMITS.identityBytes)) {
      return result('error', 'invalid_request');
    }
    // Include the WAL in the disk budget; it can contain the newest committed event.
    let diskBytes = 0;
    for (const suffix of ['', '-wal']) {
      let stat;
      try { stat = statSync(runtimeFilePath + suffix); }
      catch (error) {
        if (error.code === 'ENOENT') {
          if (!suffix) return result('missing', 'database_missing');
          continue;
        }
        throw error;
      }
      if (!stat.isFile()) return result('error', 'database_not_file');
      diskBytes += stat.size;
      if (diskBytes > REPAIR_EVIDENCE_LIMITS.databaseBytes) return result('unsupported', 'database_byte_limit');
    }
    db = new DatabaseSync(runtimeFilePath, { readOnly: true });
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; BEGIN');
    let totalBytes = 0;
    // Column names and predicates are private constants. No request text becomes SQL.
    // CASE prevents oversized values from crossing the SQLite/JavaScript boundary.
    const one = (table, columns, predicate, bindings, label) => {
      const projections = columns.flatMap((column) => [
        `length(CAST(${column} AS BLOB)) AS ${column}_bytes`,
        `typeof(${column}) AS ${column}_type`,
        `CASE WHEN length(CAST(${column} AS BLOB)) <= ${REPAIR_EVIDENCE_LIMITS.fieldBytes}
          THEN CASE WHEN typeof(${column}) = 'text' THEN CAST(${column} AS BLOB) ELSE ${column} END ELSE NULL END AS ${column}`,
      ]);
      const rows = db.prepare(`SELECT ${projections.join(', ')} FROM ${table} WHERE ${predicate} LIMIT 2`).all(...bindings);
      if (!rows.length) fail('missing', `${label}_missing`);
      if (rows.length !== 1) fail('mismatch', `${label}_not_unique`);
      const row = rows[0];
      for (const column of columns) {
        const bytes = row[`${column}_bytes`] ?? 0;
        if (bytes > REPAIR_EVIDENCE_LIMITS.fieldBytes) fail('unsupported', `${label}_field_byte_limit`);
        totalBytes += bytes;
        const type = row[`${column}_type`];
        if (!['text', 'integer', 'null'].includes(type)) fail('unsupported', `${label}_storage_type`);
        // Blob decoding preserves embedded NULs that native TEXT conversion can truncate.
        if (type === 'text') row[column] = new TextDecoder('utf-8', { fatal: true }).decode(row[column]);
      }
      if (totalBytes > REPAIR_EVIDENCE_LIMITS.totalBytes) fail('unsupported', 'total_byte_limit');
      return row;
    };
    const parse = (raw) => raw === null ? null : JSON.parse(raw);
    const metadata = one('runtime_metadata', ['value'], "key = 'producer_id'", [], 'producer');
    check(metadata.value === producerId, 'producer_id_mismatch');
    const event = one('events', ['event_id', 'task_id', 'attempt_id', 'kind', 'payload_json'],
      'event_id = ?', [eventId], 'event');
    if (event.kind !== 'repair_finished') fail('unsupported', 'event_kind');
    const payload = parse(event.payload_json);
    if (!object(payload) || !object(payload.evidence) || payload.evidence.schemaVersion !== 1) {
      fail('unsupported', 'evidence_schema');
    }
    const evidence = payload.evidence;
    check(typeof payload.repairId === 'string' && payload.repairId.length > 0, 'repair_id_mismatch');
    const repair = one('repairs', ['repair_id', 'task_id', 'analysis_id', 'status', 'candidate_json',
      'attempt_id', 'attempt_floor', 'outcome_json'], 'repair_id = ?', [payload.repairId], 'repair');
    check(repair.task_id === event.task_id && repair.attempt_id === event.attempt_id, 'repair_link_mismatch');
    const analysis = one('analyses', ['analysis_id', 'task_id', 'consumed_at'],
      'analysis_id = ?', [repair.analysis_id], 'analysis');
    check(analysis.task_id === event.task_id && analysis.consumed_at !== null, 'analysis_link_mismatch');
    check(!db.prepare('SELECT 1 FROM repairs WHERE analysis_id = ? AND repair_id <> ? LIMIT 1')
      .get(repair.analysis_id, repair.repair_id), 'analysis_reused');
    const run = one('runs', ['task_id', 'task_json'], 'task_id = ?', [event.task_id], 'task');
    const task = parse(run.task_json);
    check(object(task) && task.taskId === event.task_id, 'task_id_mismatch');
    const declarations = validateTaskProvenance(task);
    const status = repair.status;
    if (!['settled', 'unknown', 'blocked', 'observed', 'restored'].includes(status)) fail('mismatch', 'repair_status');
    let attempt = null;
    let candidate = null;
    let outcome = null;
    let verification = null;
    let success = status === 'restored';
    if (['settled', 'unknown'].includes(status)) {
      check(typeof event.attempt_id === 'string', 'attempt_required');
      attempt = one('attempts', ['rowid', 'attempt_id', 'task_id', 'candidate_json', 'status', 'outcome_json', 'verification_json'],
        'attempt_id = ?', [event.attempt_id], 'attempt');
      check(attempt.task_id === event.task_id && attempt.rowid > repair.attempt_floor, 'attempt_link_mismatch');
      check(!db.prepare('SELECT 1 FROM repairs WHERE attempt_id = ? AND repair_id <> ? LIMIT 1')
        .get(event.attempt_id, repair.repair_id), 'attempt_reused');
      candidate = validateCandidate(parse(attempt.candidate_json));
      check(repair.candidate_json === null || isDeepStrictEqual(candidate, parse(repair.candidate_json)), 'candidate_mismatch');
      check(candidate.source.recipeId === task.recipeId && candidate.source.version === task.recipeVersion, 'recipe_mismatch');
      outcome = parse(attempt.outcome_json);
      verification = attempt.verification_json === null ? null : validateVerification(parse(attempt.verification_json));
      if (status === 'settled') {
        check(attempt.status === 'settled' && object(outcome) && verification !== null
          && ['succeeded', 'failed', 'not_started'].includes(outcome.status)
          && verification.status !== 'unknown'
          && (outcome.status === 'succeeded' || verification.status !== 'pass'), 'settlement_mismatch');
        success = outcome.status === 'succeeded' && verification.status === 'pass'
          && (verification.goalSatisfied === true || verification.progress === 'advanced');
      } else check(attempt.status !== 'settled', 'unknown_attempt_settled');
    } else check(event.attempt_id === null, 'unexpected_attempt');
    const expected = {
      schemaVersion: 1,
      status: status !== 'settled' ? status : success ? 'verified_success'
        : outcome.status === 'failed' || verification.status === 'fail' ? 'verified_failure' : 'no_progress',
      attestation: 'producer', reviewStatus: 'unreviewed', governanceEligible: false,
      taskId: event.task_id, repairId: repair.repair_id, analysisId: repair.analysis_id,
      attemptId: attempt?.attempt_id ?? null, settlementStatus: status,
      attemptStatus: attempt?.status ?? 'unavailable', executionStatus: outcome?.status ?? 'unavailable',
      verificationStatus: verification?.status ?? 'unavailable',
      verifier: verification === null ? null : { id: verification.verifierId, version: verification.verifierVersion },
      progress: verification?.progress ?? 'unknown', goalSatisfied: verification?.goalSatisfied ?? null,
      evidenceRefs: verification?.evidenceRefs ?? [],
      provenance: {
        source: candidate === null ? null : { recipeId: candidate.source.recipeId, version: candidate.source.version },
        recipe: { id: task.recipeId, version: task.recipeVersion },
        tool: candidate === null ? null : { name: candidate.toolName, version: null },
        toolVersionStatus: 'unavailable', origin: declarations.origin ?? 'unknown',
        ...(Object.hasOwn(declarations, 'origin') ? { originStatus: 'declared' } : {}),
        principleRefs: declarations.principleRefs ?? null,
        principleRefsStatus: Object.hasOwn(declarations, 'principleRefs') ? 'declared' : 'unavailable',
      },
    };
    check(isDeepStrictEqual(evidence, expected), 'evidence_mismatch');
    const repairOutcome = parse(repair.outcome_json);
    check(object(repairOutcome), 'repair_outcome_mismatch');
    const hasSuccess = !['unknown', 'observed'].includes(status);
    check(hasSuccess ? repairOutcome.succeeded === success : !Object.hasOwn(repairOutcome, 'succeeded'), 'repair_success_mismatch');
    check(Object.keys(repairOutcome).every((key) => ['succeeded', 'reason'].includes(key))
      && (!Object.hasOwn(repairOutcome, 'reason') || (typeof repairOutcome.reason === 'string' && repairOutcome.reason.trim())), 'repair_outcome_mismatch');
    check(isDeepStrictEqual(payload, { repairId: repair.repair_id, status, ...repairOutcome, evidence: expected }), 'payload_mismatch');
    return result('match', 'persisted_identity_consistent', { producerId, eventId, kind: event.kind,
      payload: { ...payload, taskId: event.task_id, ...(event.attempt_id === null ? {} : { attemptId: event.attempt_id }) } });
  } catch (error) {
    if (error.evidenceStatus) return result(error.evidenceStatus, error.message);
    if (/no such (table|column)/i.test(error.message)) return result('unsupported', 'database_schema');
    if (error instanceof SyntaxError) return result('error', 'invalid_json');
    if (error.code?.startsWith('invalid_')) return result('mismatch', 'invalid_persisted_contract');
    return result('error', 'database_read_failed');
  } finally {
    if (db) {
      try { if (db.isTransaction) db.exec('ROLLBACK'); } finally { db.close(); }
    }
  }
}
