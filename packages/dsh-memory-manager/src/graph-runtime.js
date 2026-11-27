/**
 * Shared architecture-edge verdicts. EXTERNAL facts only (SQLite rows / ledgers).
 * Single source of truth for both npm run verify-graph and the live panel architecture page.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Resolve store paths from env/cwd so server and CLI share one implementation. */
export function resolveGraphPaths(env = process.env, cwd = 'D:/dsh') {
  const dshHome = env.DSH_HOME ?? join(homedir(), '.dsh');
  const runtimeCandidates = [env.DSH_HOST_ROOT, cwd, env.DSH_INSTALL_DIR].filter(v => typeof v === 'string' && v.length);
  const runtimeDb = runtimeCandidates.map(root => join(root, '.execution-runtime', 'runtime.sqlite')).find(p => existsSync(p))
    ?? join(cwd, '.execution-runtime', 'runtime.sqlite');
  return { dshHome, clisDb: join(dshHome,'storages','clis-events.sqlite'), valveDb: join(dshHome,'storages','clis-event-inbox.sqlite'), runtimeDb };
}

/**
 * Pure classifier over observed facts. Exported so the verdicts can be tested
 * without touching live stores: a mislabelled edge would make the running map
 * lie, so the classifier itself must be falsifiable.
 */
function latestReceiptAt(current, value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return current;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return current;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return current;
  return current === null || time > Date.parse(current) ? value : current;
}

export function classifyEdges(f) {
  const edges = [];
  // graphEdge anchors each check to the edge it verifies in README's mermaid graph.
  // A check without a graphEdge is a self-invented edge, not part of the design map.
  const add = (id, graphEdge, status, detail) => edges.push({ id, graphEdge, status, detail });
  add('clis.run -> outbox', 'C->V', f.events > 0 && f.pending > 0 ? 'running' : 'no_data',
    `events=${f.events}, pending=${f.pending}`);
  add('outbox -> valves inbox', 'C->V', f.receiptMatch > 0 ? 'observed' : 'no_data',
    `matching receipts=${f.receiptMatch}`);
  add('valves consumption -> clis feedback', 'V->C', f.feedbackMatch > 0 ? 'observed' : 'no_data',
    `matching classifications=${f.feedbackMatch}; unauthenticated; human adoption and principle attribution unknown; not governance eligible`);
  for (const edge of [edges[1], edges[2]]) {
    edge.evidenceScope = 'historical';
    edge.currentActivity = 'unknown';
  }
  edges[1].latestReceiptAt = f.receiptMatch == null ? null : (f.receiptLatestAt ?? null);
  edges[2].latestReceiptAt = f.feedbackMatch == null ? null : (f.feedbackReceiptLatestAt ?? null);
  add('valves -> memory (negative rules)', 'V->R', f.activeNegativeRules > 0 ? 'running' : 'no_data',
    `confirmed negative rules=${f.activeNegativeRules}`);
  add('valves -> decision ledger', 'V->L', f.ledgerRows > 0 ? 'running' : 'no_data',
    `ledger rows=${f.ledgerRows}`);
  add('valves -> weekly patrol', 'V->I', f.patrolReports > 0 ? 'running' : 'no_data',
    `patrol reports=${f.patrolReports}`);
  add('valves -> recall probe', 'V->K', f.recallProbeChecked ? 'running' : 'no_data',
    `patrol recall_boundary.probe.checked=${f.recallProbeChecked}`);
  add('memory -> issue inbox', 'R->I', f.inboxEntries > 0 ? 'running' : 'no_data',
    `inbox entries=${f.inboxEntries}`);
  add('execution -> runtime store', 'X->S', f.totalRuns > 0 && f.recipeLibrary > 0 ? 'running' : 'no_data',
    `runs=${f.totalRuns}, recipe_library=${f.recipeLibrary}`);
  add('execution -> host tool dispatch', 'X->T', f.dispatchEvents > 0 ? 'running' : 'no_data',
    `dispatch_started events=${f.dispatchEvents}`);
  add('execution -> verifier evidence', 'X->S', f.completedRuns > 0 && f.settledAttempts > 0 ? 'running' : 'no_data',
    `completed_runs=${f.completedRuns}, settled_attempts=${f.settledAttempts}`);
  // Entering analysis and producing a real proposal is a distinct milestone from
  // EXECUTING a repair. The host-LLM analyzer now produces proposed repairs for real
  // failed tasks; repair execution needs a native policy and is measured by the next edge.
  add('execution -> analysis (proposal)', 'X->S', f.proposedAnalyses > 0 ? 'running' :
    f.analyses > 0 ? 'partial' : 'design_only',
    `analyses=${f.analyses}, proposed=${f.proposedAnalyses}`);
  // A proposed repair that needs human review / evidence gathering is NOT a repair
  // that may be executed. Record why the edge has not fired rather than a bare zero.
  add('analysis proposal -> repair execution', 'X->S', f.repairs > 0 ? 'running' :
    f.proposedAnalyses > 0 ? 'blocked_by_review' : 'design_only',
    `repairs=${f.repairs}, proposed=${f.proposedAnalyses}, ` +
    `automatic=${f.autoEligibleProposals}, review_or_evidence=${f.reviewProposals}`);
  // The real cross-task source is the repairs table grouped by signature
  // (store.listPatternEvidence), NOT a pattern_evidence/patterns table. Count
  // distinct tasks among repairs so one task repairing itself cannot fake it.
  add('repair -> cross-task pattern', 'S->Q', f.repairs > 0 && f.independentRepairTasks >= 2 ? 'running' : 'design_only',
    `repairs=${f.repairs}, independent_repair_tasks=${f.independentRepairTasks}, repair_failures=${f.repairFailures}`);
  // Not decidable from these stores; a checked approval + valve rule version
  // lives in a different trust boundary and must not be guessed here.
  add('pattern -> valve write -> version effective', 'Q->V', 'unknown',
    'requires checked approval + valve rule version; not derivable from local stores');

  // agent-mind's OWN decision (M->A) has an independent external record: the dispatch
  // samples ledger written on each inbox claim. That is not the model's tool choice,
  // just the judging step, so it can be attributed from local facts.
  add('agent-mind -> situation judgment', 'M->A', f.dispatchSamples > 0 ? 'running' : 'no_data',
    `dispatch samples=${f.dispatchSamples}, matched=${f.dispatchMatched}`);

  // The remaining diagram edges are model decisions or optional bridges. A local
  // store can show that a tool was CALLED but cannot attribute the choice to the
  // agent, so claiming "running" here would be a self-produced verdict. Mark them
  // unknown explicitly: covered by the check, but not decidable from local facts.
  // A->C has an attributable external record: the interventions ledger stores an
  // agent id on each adopted intervention. That is the agent acting on CLIS, not a
  // guess from "the tool exists".
  add('agent -> CLIS (adopted intervention)', 'A->C', f.adoptedInterventions > 0 ? 'running' : 'no_data',
    `adopted interventions=${f.adoptedInterventions}`);

  // A->R has an attributable consumption record: the memory usage ledger's `read`
  // events are actual reads of memory files. `recall` events are deliberately EXCLUDED
  // because they are mostly self-produced exposure, not evidence of agent consumption.
  add('agent -> memory (read events)', 'A->R', f.memoryReadEvents > 0 ? 'running' : 'no_data',
    `memory read events=${f.memoryReadEvents} (recall excluded as self-produced)`);

  const unobservable = [
    ['agent -> meta-framework', 'A->F'],
    ['agent -> valves', 'A->V'],
    ['agent -> execution-runtime', 'A->X'],
    ['agent -> SAG recall', 'A->K'],
    ['CLIS -> meta optional classification', 'C->F'],
    ['memory -> valves optional bridge', 'R->V'],
  ];
  for (const [id, edge] of unobservable) {
    add(id, edge, 'unknown', `${edge}: model decision / optional bridge; tool-call rows cannot attribute the choice`);
  }
  // Aggregate counts cannot establish that records belong to the same operation,
  // signature, agent, or producer. Preserve those limits even when counts are positive.
  const uncorrelated = new Set(['clis.run -> outbox',
    'execution -> runtime store', 'execution -> verifier evidence',
    'analysis proposal -> repair execution', 'repair -> cross-task pattern',
    'agent -> CLIS (adopted intervention)', 'agent -> memory (read events)']);
  const required = {
    'clis.run -> outbox': ['events', 'pending'],
    'outbox -> valves inbox': ['receiptMatch'],
    'valves consumption -> clis feedback': ['feedbackMatch'],
    'valves -> memory (negative rules)': ['activeNegativeRules'],
    'valves -> decision ledger': ['ledgerRows'],
    'valves -> weekly patrol': ['patrolReports'],
    'valves -> recall probe': ['recallProbeChecked'],
    'memory -> issue inbox': ['inboxEntries'],
    'execution -> host tool dispatch': ['dispatchEvents'],
    'execution -> analysis (proposal)': ['analyses', 'proposedAnalyses'],
    'analysis proposal -> repair execution': ['repairs', 'proposedAnalyses', 'autoEligibleProposals', 'reviewProposals'],
    'agent-mind -> situation judgment': ['dispatchSamples', 'dispatchMatched'],
  };
  for (const edge of edges) {
    if (uncorrelated.has(edge.id)) {
      edge.status = 'unknown';
      edge.detail += '; aggregate records do not establish identity or correlation';
    } else if (required[edge.id]?.some(key => f[key] == null)) {
      edge.status = 'unknown';
      edge.detail += '; source unavailable or incomplete';
    }
  }
  // Presence of a rule, report, inbox item, probe or dispatch sample alone
  // does not establish the producer-to-consumer relationship drawn in the graph.
  // No remaining collector observation provides that linkage.
  for (const edge of edges) {
    edge.detail = edge.detail.replace(/\b(?:undefined|null)\b/g, 'unavailable');
    if (!['outbox -> valves inbox', 'valves consumption -> clis feedback'].includes(edge.id) && edge.status !== 'unknown') {
      edge.status = 'unknown';
      edge.detail += '; source does not establish this graph edge';
    }
  }
  edges[0].producerObservation = f.producerObservation ?? null;
  const observation = f.producerObservation;
  const local = observation?.status === 'complete' && Number.isSafeInteger(observation.matchedEvents) && observation.matchedEvents >= 0
    ? `matchedEvents=${observation.matchedEvents}`
    : observation?.status === 'incomplete' ? 'incomplete' : 'unknown';
  edges[0].detail += `; local producer history: ${local}; does not establish receipt or current activity`;
  return edges;
}

/** Match bounded producer receipts with consumer identities, read-only. */
export function collectFacts({ clisDb, valveDb, dshHome } = {}) {
  const facts = {
    events: null, pending: null, receiptMatch: null, feedbackMatch: null,
    receiptLatestAt: null, feedbackReceiptLatestAt: null,
    totalRuns: null, recipeLibrary: null, dispatchEvents: null,
    activeNegativeRules: null, ledgerRows: null, patrolReports: null,
    recallProbeChecked: null, inboxEntries: null, dispatchSamples: null,
    dispatchMatched: null, adoptedInterventions: null, memoryReadEvents: null,
    completedRuns: null, settledAttempts: null, analyses: null, proposedAnalyses: null,
    autoEligibleProposals: null, reviewProposals: null, repairs: null,
    repairFailures: null, independentRepairTasks: null,
  };
  const paths = resolveGraphPaths();
  const root = dshHome ?? paths.dshHome;
  const producerPath = clisDb ?? join(root, 'storages', 'clis-events.sqlite');
  const consumerPath = valveDb ?? join(root, 'storages', 'clis-event-inbox.sqlite');
  let producer, consumer;
  try {
    if (!existsSync(producerPath) || !existsSync(consumerPath)) throw new Error('missing store');
    producer = new DatabaseSync(producerPath, { readOnly: true });
    consumer = new DatabaseSync(consumerPath, { readOnly: true });
    const producerId = producer.prepare("SELECT value FROM clis_meta WHERE key='producer_id'").get()?.value;
    if (typeof producerId !== 'string' || !producerId) throw new Error('missing producer identity');
    const receipts = producer.prepare(`SELECT r.receipt_id, r.event_id,
      CASE WHEN length(CAST(r.evidence AS BLOB)) <= 65536 THEN r.evidence END AS evidence,
      r.evidence_hash, e.event_id AS bound_event
      FROM clis_receipts r LEFT JOIN clis_events e ON e.event_id = r.event_id
      ORDER BY r.rowid LIMIT 101`).all();
    if (receipts.length > 100) throw new Error('receipt scan truncated');
    const find = consumer.prepare(`SELECT r.receipt_id, r.status, i.event_id AS bound_event
      FROM clis_event_results r LEFT JOIN clis_event_inbox i
      ON i.producer_id=r.producer_id AND i.event_id=r.event_id
      WHERE r.producer_id=? AND r.event_id=?`);
    let matches = 0, latest = null;
    for (const row of receipts) {
      if (typeof row.evidence !== 'string' || row.bound_event !== row.event_id ||
          createHash('sha256').update(row.evidence).digest('hex') !== row.evidence_hash) throw new Error('invalid receipt');
      const evidence = JSON.parse(row.evidence);
      const received = find.get(producerId, row.event_id);
      if (evidence.producerId !== producerId || evidence.eventId !== row.event_id ||
          evidence.receiptId !== row.receipt_id || evidence.status !== 'received' ||
          !received || received.bound_event !== row.event_id || received.receipt_id !== row.receipt_id ||
          received.status !== 'received') throw new Error('identity mismatch');
      matches++;
      latest = latestReceiptAt(latest, evidence.receivedAt);
    }
    facts.receiptMatch = matches;
    facts.receiptLatestAt = latest;
  } catch { facts.receiptMatch = null; }
  finally { try { producer?.close(); } catch {} try { consumer?.close(); } catch {} }
  facts.producerObservation = collectProducerObservation(producerPath);
  const feedback = collectFeedbackMatches(producerPath, consumerPath);
  facts.feedbackMatch = feedback?.count ?? null;
  facts.feedbackReceiptLatestAt = feedback?.latestReceiptAt ?? null;
  return facts;
}

// This is a producer-local historical observation, not an edge verdict.
function collectProducerObservation(path) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const base = { source: 'local_producer_store', consumption: 'unknown', currentActivity: 'unknown', authenticated: false };
  let db;
  try {
    if (!existsSync(path)) return { ...base, status: 'unknown', reason: 'missing_store' };
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=50; BEGIN');
    const producerId = db.prepare("SELECT CASE WHEN length(CAST(value AS BLOB)) <= 36 THEN value END AS value FROM clis_meta WHERE key='producer_id'").get()?.value;
    if (!uuid.test(producerId ?? '')) throw Error('invalid_identity');
    const events = db.prepare(`SELECT seq,
      CASE WHEN length(CAST(event_id AS BLOB))<=36 THEN event_id END AS event_id,
      CASE WHEN length(CAST(kind AS BLOB))<=128 THEN kind END AS kind,
      CASE WHEN length(CAST(payload AS BLOB))<=65536 THEN payload END AS payload,
      CASE WHEN length(CAST(payload_hash AS BLOB))<=64 THEN payload_hash END AS payload_hash,
      CASE WHEN length(CAST(created_at AS BLOB))<=64 THEN created_at END AS created_at
      FROM clis_events ORDER BY seq LIMIT 101`).all();
    const outbox = db.prepare(`SELECT CASE WHEN length(CAST(event_id AS BLOB))<=36 THEN event_id END AS event_id,
      CASE WHEN length(CAST(status AS BLOB))<=16 THEN status END AS status FROM clis_outbox LIMIT 101`).all();
    if (events.length > 100 || outbox.length > 100) return { ...base, status: 'incomplete', reason: 'row_limit' };
    const pending = new Set();
    for (const row of outbox) {
      if (!uuid.test(row.event_id ?? '') || row.status !== 'pending' || pending.has(row.event_id)) throw Error('invalid_outbox');
      pending.add(row.event_id);
    }
    for (const row of events) {
      if (!Number.isSafeInteger(row.seq) || row.seq < 1 || !uuid.test(row.event_id ?? '') ||
          typeof row.kind !== 'string' || !/^[a-z][a-z0-9_.-]{0,127}$/.test(row.kind) ||
          typeof row.payload !== 'string' || typeof row.created_at !== 'string' ||
          !pending.delete(row.event_id) ||
          createHash('sha256').update(JSON.stringify([producerId, row.event_id, row.kind, row.payload, row.created_at, row.seq])).digest('hex') !== row.payload_hash) throw Error('invalid_event');
      JSON.parse(row.payload);
    }
    if (pending.size) throw Error('unmatched_outbox');
    return { ...base, status: 'complete', producerId, matchedEvents: events.length, observedAt: new Date().toISOString() };
  } catch {
    return { ...base, status: 'unknown', reason: 'source_invalid_or_unavailable' };
  } finally { try { db?.close(); } catch {} }
}

// A complete, bounded scan is required before reporting a count. Hashes detect
// inconsistent records; they do not authenticate either writer.
function collectFeedbackMatches(producerPath, consumerPath) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const allowed = new Set(['unsupported_kind', 'invalid_run_payload', 'baseline_unassociated_feedback', 'pending_failure_review', 'caller_declared_achieved', 'baseline', 'not_tried', 'not_provided']);
  const digest = text => createHash('sha256').update(text).digest('hex');
  const canonical = value => {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
  };
  let p, v;
  try {
    if (!existsSync(producerPath) || !existsSync(consumerPath)) return null;
    p = new DatabaseSync(producerPath, { readOnly: true });
    v = new DatabaseSync(consumerPath, { readOnly: true });
    p.exec('BEGIN'); v.exec('BEGIN');
    const producerId = p.prepare("SELECT value FROM clis_meta WHERE key='producer_id'").get()?.value;
    if (!uuid.test(producerId ?? '')) throw Error('invalid producer');
    const rows = p.prepare(`SELECT f.event_id, CASE WHEN length(CAST(f.evidence AS BLOB))<=65536 THEN f.evidence END AS evidence, f.evidence_hash,
      e.kind, CASE WHEN length(CAST(e.payload AS BLOB))<=65536 THEN e.payload END AS payload, e.payload_hash, e.created_at, e.seq
      FROM clis_feedback_v1 f LEFT JOIN clis_events e ON e.event_id=f.event_id ORDER BY f.rowid LIMIT 101`).all();
    if (rows.length > 100) throw Error('truncated');
    const receipt = p.prepare(`SELECT event_id, CASE WHEN length(CAST(evidence AS BLOB))<=65536 THEN evidence END AS evidence, evidence_hash FROM clis_receipts WHERE receipt_id=?`);
    const consumed = v.prepare(`SELECT r.receipt_id,r.status,i.kind,
      CASE WHEN length(CAST(i.payload AS BLOB))<=65536 THEN i.payload END AS payload,i.payload_hash,c.classification
      FROM clis_event_results r JOIN clis_event_inbox i ON i.producer_id=r.producer_id AND i.event_id=r.event_id
      JOIN clis_consumption_v1 c ON c.producer_id=r.producer_id AND c.event_id=r.event_id
      WHERE r.producer_id=? AND r.event_id=?`);
    let latest = null;
    for (const row of rows) {
      if (!uuid.test(row.event_id ?? '') || typeof row.evidence !== 'string' || digest(row.evidence) !== row.evidence_hash ||
          typeof row.payload !== 'string' || digest(JSON.stringify([producerId, row.event_id, row.kind, row.payload, row.created_at, row.seq])) !== row.payload_hash) throw Error('corrupt producer');
      const f = JSON.parse(row.evidence);
      if (!f || Object.keys(f).sort().join(',') !== 'classification,eventId,producerId,receiptId,schemaVersion' || f.schemaVersion !== 1 ||
          f.producerId !== producerId || f.eventId !== row.event_id || !uuid.test(f.receiptId ?? '') || !allowed.has(f.classification)) throw Error('invalid feedback');
      const r = receipt.get(f.receiptId), c = consumed.get(producerId, row.event_id);
      if (!r || r.event_id !== row.event_id || typeof r.evidence !== 'string' || digest(r.evidence) !== r.evidence_hash) throw Error('invalid receipt');
      const evidence = JSON.parse(r.evidence);
      if (evidence.producerId !== producerId || evidence.eventId !== row.event_id || evidence.receiptId !== f.receiptId ||
          evidence.status !== 'received' || evidence.authenticated !== false || evidence.governanceEligible !== false ||
          evidence.kind !== row.kind || canonical(evidence.payload) !== row.payload ||
          !c || c.receipt_id !== f.receiptId || c.status !== 'received' || c.kind !== row.kind || c.payload !== row.payload ||
          digest(JSON.stringify(c.kind) + ':' + c.payload) !== c.payload_hash || c.classification !== f.classification) throw Error('mismatch');
      latest = latestReceiptAt(latest, evidence.receivedAt);
    }
    return { count: rows.length, latestReceiptAt: latest };
  } catch { return null; }
  finally { try { p?.close(); } catch {} try { v?.close(); } catch {} }
}