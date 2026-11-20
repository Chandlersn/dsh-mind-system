import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Bump when the MEANING of a status changes, not merely when code is refactored.
//
// WHY A VERSION EXISTS
// The weekly patrol used to re-run coverage only when a stored report had no
// `cycle_coverage` field at all. That answered "was this section ever written"
// and not "which computation produced it". Consequence measured on 2026-11-20:
// the BOM and delivery fixes landed, the running host loaded them, and the panel
// still showed the data flow as not connected -- because the last report (11-19)
// DID carry the field, holding values computed by the old code, so nothing
// recomputed them. The display would have stayed wrong until the next due patrol
// on 11-26.
//
// A version makes staleness observable: a report whose coverage version differs
// from the current one is recomputed rather than trusted.
export const COVERAGE_VERSION = 2;

// These sources establish observations, not completeness or success of a cycle.
//
// A leading BOM is stripped before parsing. Two of these ledgers were created by
// a PowerShell `Set-Content` once (2026-11-18 recorded that accident) and have
// been append-only since, so the BOM sits on line 1 forever. Node's `readFile`
// keeps it, `JSON.parse` rejects it, and treating that as "the whole file is
// invalid" threw away 255 readable rows of evidence because of one byte.
//
// Unparseable lines are counted, not fatal: `invalid` now means "at least one row
// could not be read", reported alongside what WAS observed. Dropping a corrupt row
// loses one fact; failing the file loses the reader's confidence in every fact.
async function ledger(file, match) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (err) {
    return err?.code === 'ENOENT' ? { status: 'unknown', reason: 'source_absent' }
      : { status: 'error', reason: err?.code ?? 'read_failed' };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let observed = false;
  let invalid = 0;
  let rows = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      invalid++;
      continue;
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) { invalid++; continue; }
    rows++;
    if (match(row)) observed = true;
  }
  if (invalid) {
    return {
      status: rows === 0 ? 'unknown' : 'incomplete',
      observed,
      invalid,
      rows,
      reason: rows === 0 ? 'no_readable_records' : 'invalid_records',
    };
  }
  return observed ? { status: 'observed' } : { status: 'unknown', reason: 'no_matching_evidence' };
}

async function recallEvidence(root) {
  const files = [join(root, '.usage.jsonl')];
  let listingError;
  for (const dir of ['.usage', join('.usage', 'archive')]) {
    try {
      for (const name of await readdir(join(root, dir))) {
        if (/^\d{4}-\d{2}\.jsonl$/.test(name)) files.push(join(root, dir, name));
      }
    } catch (err) { if (err?.code !== 'ENOENT') listingError = err?.code ?? 'read_failed'; }
  }
  const results = await Promise.all(files.map((file) => ledger(file, (row) => row.kind === 'recall' && typeof row.href === 'string')));
  const observed = results.some((r) => r.status === 'observed' || r.observed === true);
  const error = results.find((r) => r.status === 'error');
  if (listingError || error) return { status: 'error', observed, reason: listingError ?? error.reason };
  if (results.some((r) => r.status === 'incomplete')) return { status: 'incomplete', observed, reason: 'invalid_records' };
  return observed ? { status: 'observed' } : { status: 'unknown', reason: 'no_recall_evidence' };
}

async function indexEvidence(root) {
  try {
    const text = await readFile(join(root, 'MEMORY.md'), 'utf8');
    return text.trim() ? { status: 'observed', scope: 'index_file_only' } : { status: 'unknown', reason: 'empty_index' };
  } catch (err) {
    return err?.code === 'ENOENT' ? { status: 'unknown', reason: 'source_absent' }
      : { status: 'error', reason: err?.code ?? 'read_failed' };
  }
}

// Keep runtime observations bounded and preserve uncertainty in incomplete snapshots.
async function runtimeEvidence(getRuntimeStatus) {
  let service, snapshot;
  try {
    service = getRuntimeStatus?.();
    if (service == null) return { state: 'missing' };
    if (typeof service.snapshot !== 'function') return { state: 'partial', reason: 'snapshot_method_missing' };
    snapshot = await service.snapshot({ limit: 100 });
  } catch (err) {
    return { state: 'error', reason: 'snapshot_threw', error: String(err?.message ?? err) };
  }
  if (!snapshot || typeof snapshot !== 'object') return { state: 'partial', reason: 'invalid_snapshot' };
  if (['disabled', 'unavailable', 'error'].includes(snapshot.state)) {
    return { state: snapshot.state, ...(typeof snapshot.error === 'string' ? { error: snapshot.error } : {}) };
  }
  if (snapshot.state !== 'ready') return { state: 'partial', reason: 'invalid_state' };
  let partial = !Number.isSafeInteger(snapshot.limit) || snapshot.limit < 1 || snapshot.limit > 100 ||
    typeof snapshot.truncated !== 'boolean' || !Array.isArray(snapshot.runs) ||
    !snapshot.registeredTasks || !Array.isArray(snapshot.registeredTasks.taskIds) ||
    typeof snapshot.registeredTasks.truncated !== 'boolean';
  const rawRuns = Array.isArray(snapshot.runs) ? snapshot.runs : [];
  const rawTasks = Array.isArray(snapshot.registeredTasks?.taskIds) ? snapshot.registeredTasks.taskIds : [];
  if (rawRuns.length > 100 || rawTasks.length > 100) partial = true;
  const runs = [];
  for (const run of rawRuns.slice(0, 100)) {
    const first = run?.unresolved?.first;
    if (!run || typeof run.taskId !== 'string' || typeof run.status !== 'string' ||
      !(run.reason === null || typeof run.reason === 'string') || !Number.isSafeInteger(run.createdAt) ||
      !Number.isSafeInteger(run.updatedAt) || typeof run.registered !== 'boolean' ||
      !Number.isSafeInteger(run.unresolved?.count) || run.unresolved.count < 0 ||
      !(first === null || (first && typeof first.attemptId === 'string' && typeof first.status === 'string'))) {
      partial = true;
      continue;
    }
    runs.push({ taskId: run.taskId, status: run.status, reason: run.reason, createdAt: run.createdAt,
      updatedAt: run.updatedAt, unresolved: { count: run.unresolved.count,
        first: first === null ? null : { attemptId: first.attemptId, status: first.status } }, registered: run.registered });
  }
  const taskIds = rawTasks.slice(0, 100).filter((id) => typeof id === 'string');
  if (taskIds.length !== Math.min(rawTasks.length, 100)) partial = true;
  if (snapshot.truncated === true || snapshot.registeredTasks?.truncated === true) partial = true;
  return { state: partial ? 'partial' : 'ready', sourceState: 'ready',
    limit: Number.isSafeInteger(snapshot.limit) && snapshot.limit >= 1 && snapshot.limit <= 100 ? snapshot.limit : null,
    truncated: typeof snapshot.truncated === 'boolean' ? snapshot.truncated || rawRuns.length > 100 : null,
    runs, registeredTasks: { taskIds, truncated: typeof snapshot.registeredTasks?.truncated === 'boolean'
      ? snapshot.registeredTasks.truncated || rawTasks.length > 100 : null },
    unresolvedCandidates: runs.filter((run) => run.unresolved.count > 0).map((run) => ({
      taskId: run.taskId, status: run.status, unresolved: run.unresolved,
    })) };
}

/**
 * Delivery evidence: did a weekly report actually reach the inbox?
 *
 * This used to be a hardcoded `{ status: 'unknown', reason: 'no_delivery_source_connected' }`.
 * That claim went stale: the memory package has been writing durable receipts under
 * `<storageDir>/patrol-delivery-receipts/` since VI-5, and a real receipt was on disk
 * (2026-11-19) while the panel still reported "no delivery source connected". A fixed
 * `unknown` is not honesty — when the evidence exists, saying "unknown" misreports it
 * as absent, which is the same error as claiming a clean boundary nobody checked.
 *
 * Reading a directory the peer owns is not an import edge (N2 holds: node built-ins
 * only), and it matches how this module already reads `memoryRoot` files.
 *
 * A receipt proves delivery was recorded. It does NOT prove the message was read,
 * acknowledged, or acted on — so the reason string says which of those it is not.
 */
async function deliveryEvidence(storageDir) {
  const dir = join(storageDir, 'patrol-delivery-receipts');
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    return err?.code === 'ENOENT'
      ? { status: 'unknown', reason: 'no_delivery_receipts_written' }
      : { status: 'error', reason: err?.code ?? 'read_failed' };
  }
  // Sorted so the pass is reproducible: readdir gives no order guarantee, and an
  // unordered walk makes "which receipt a test sees first" depend on the
  // filesystem. The reported latest is chosen by timestamp, but determinism here
  // is what makes that choice testable at all.
  const json = names.filter((n) => n.endsWith('.json')).sort();
  if (json.length === 0) return { status: 'unknown', reason: 'no_delivery_receipts_written' };
  let parsed = 0;
  let invalid = 0;
  let latest = null;
  for (const name of json) {
    let body;
    try {
      body = await readFile(join(dir, name), 'utf8');
    } catch {
      invalid++;
      continue;
    }
    let row;
    try {
      row = JSON.parse(body.charCodeAt(0) === 0xfeff ? body.slice(1) : body);
    } catch {
      invalid++;
      continue;
    }
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.reportId !== 'string') { invalid++; continue; }
    parsed++;
    const at = Date.parse(row.deliveredAt);
    if (Number.isFinite(at) && (latest === null || at > latest.at)) latest = { at, reportId: row.reportId };
  }
  if (parsed === 0) return { status: 'incomplete', observed: false, invalid, reason: 'no_readable_receipts' };
  return {
    status: 'observed',
    receipts: parsed,
    invalid,
    ...(latest ? { latest_delivered_at: new Date(latest.at).toISOString() } : {}),
    note: 'A receipt records that delivery was written; it does not record that it was read, acknowledged, or acted on.',
  };
}

export async function collectCycleCoverage({ storageDir, memoryRoot, getRuntimeStatus }) {
  const [distillation, index, recall, governance, runtime, delivery] = await Promise.all([
    ledger(join(memoryRoot, '.write-ledger.jsonl'), (r) => r.tool === 'memory-manager' && typeof r.key === 'string' && r.key.startsWith('functions/') && typeof r.hash === 'string'),
    indexEvidence(memoryRoot),
    recallEvidence(memoryRoot),
    ledger(join(storageDir, 'mind-valves.jsonl'), (r) => typeof r.gate === 'string' && r.gate !== 'patrol' && typeof r.outcome === 'string'),
    runtimeEvidence(getRuntimeStatus),
    deliveryEvidence(storageDir),
  ]);
  return {
    version: COVERAGE_VERSION,
    micro_execution: {
      schedule_delivery: delivery,
      outcome: { status: 'unknown', reason: 'runtime_snapshot_does_not_establish_outcome' },
      runtime_snapshot: runtime,
    },
    memory: { distillation: { status: distillation.status === 'observed' ? 'unknown' : distillation.status, reason: distillation.status === 'observed' ? 'generic_tracked_write_does_not_identify_distillation' : distillation.reason, tracked_function_write_observed: distillation.status === 'observed' || distillation.observed === true }, index, recall },
    governance: { decisions: governance },
    cross_step_correlation: { status: 'unknown', reason: 'no_shared_cycle_identity_established', note: 'Individual observations do not establish that the same work passed through these steps.' },
  };
}
