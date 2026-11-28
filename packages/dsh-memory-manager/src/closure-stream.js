/**
 * Bounded, in-memory task evidence. All records are caller-declared observations,
 * not authenticated human review, durable storage verification or goal proof.
 * Legacy live flow is diagnostic only: query-time labels cannot bind its events.
 */
import { classifyClosure } from './closure-evidence.js';

const RECALL_EDGES = ['e10', 'e12'];
const TOOL_EDGES = ['e2', 'e3', 'e4', 'e6', 'e7', 'e9', 'e11', 'e14', 'e15'];
const KINDS = ['recall', 'action', 'result', 'review'];
const ID_RE = /^[A-Za-z0-9_.:-]{1,256}$/;
const validId = value => typeof value === 'string' && ID_RE.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => JSON.parse(JSON.stringify(value));

/** No listeners or disk writes are installed by this module. */
export function createClosureStream({ flow, now = Date.now, maxTasks = 64, maxEventsPerTask = 64 } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  for (const value of [maxTasks, maxEventsPerTask]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1024) {
      throw new RangeError('retention limits must be integers from 1 to 1024');
    }
  }
  const tasks = new Map();
  const owners = new Map();
  let evictedTasks = 0;

  const observe = () => {
    let snap = null;
    try { if (typeof flow?.snapshot === 'function') snap = flow.snapshot(); } catch { snap = null; }
    const edges = object(snap?.edges) ? snap.edges : {};
    const phase = id => object(edges[id]) ? edges[id].phase : null;
    const toolPhase = id => id === 'e15' && edges[id]?.source === 'automatic' ? null : phase(id);
    return {
      recall: RECALL_EDGES.some(id => phase(id) === 'finished'),
      action: TOOL_EDGES.some(id => toolPhase(id) === 'active'),
      result: TOOL_EDGES.some(id => toolPhase(id) === 'finished'),
      observedAt: now(),
      source: snap ? 'live_flow' : 'unavailable',
    };
  };

  const getTask = taskId => {
    if (!tasks.has(taskId)) {
      if (tasks.size >= maxTasks) {
        const oldest = tasks.keys().next().value;
        for (const id of tasks.get(oldest).events.keys()) owners.delete(id);
        tasks.delete(oldest);
        evictedTasks++;
      }
      tasks.set(taskId, { events: new Map(), conflicted: false, truncated: false });
    }
    return tasks.get(taskId);
  };

  /**
   * Bind identities at ingestion. linkedTo names the retained previous event,
   * including the result reviewed by a question-answer observation. Evidence
   * references are bounded opaque IDs, never paths, payloads or message bodies.
   */
  const record = input => {
    if (!object(input) || !validId(input.taskId)) return { accepted: false, reason: 'invalid_task' };
    const task = getTask(input.taskId);
    const reject = reason => {
      task.conflicted = true;
      return { accepted: false, reason };
    };
    const { taskId, eventId, kind, source, evidence } = input;
    if (!validId(eventId) || !KINDS.includes(kind) || !object(source)
      || !['self', 'external'].includes(source.type) || !validId(source.actor)) {
      return reject('malformed_event');
    }
    const linkedTo = input.linkedTo ?? null;
    if ((kind === 'recall' && linkedTo !== null)
      || (kind !== 'recall' && !validId(linkedTo))) return reject('invalid_link');
    const normalized = { taskId, eventId, kind, linkedTo, source: { type: source.type, actor: source.actor } };
    if (kind === 'result' || kind === 'review') {
      const expected = kind === 'result' ? 'persisted_artifact' : 'question_answer';
      const status = kind === 'result' ? 'observed' : 'answered';
      if (!object(evidence) || evidence.kind !== expected || evidence.status !== status || !validId(evidence.ref)) {
        return reject('unsupported_evidence');
      }
      normalized.evidence = { kind: evidence.kind, status: evidence.status, ref: evidence.ref };
    }
    const owner = owners.get(eventId);
    if (owner && owner !== taskId) {
      tasks.get(owner).conflicted = true;
      return reject('event_identity_conflict');
    }
    const previous = task.events.get(eventId);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(normalized)) return reject('event_conflict');
      return { accepted: true, duplicate: true };
    }
    if (kind !== 'recall') {
      const parent = task.events.get(linkedTo);
      if (!parent || parent.kind !== KINDS[KINDS.indexOf(kind) - 1]) return reject('unbound_predecessor');
    }
    if (task.events.size >= maxEventsPerTask) {
      // Keep the bounded prefix and a sticky gap instead of forgetting a failure.
      task.truncated = true;
      return { accepted: false, reason: 'event_limit' };
    }
    task.events.set(eventId, normalized);
    owners.set(eventId, taskId);
    return { accepted: true, duplicate: false };
  };

  /** The report selects stored events only; legacy review arguments are ignored. */
  const report = ({ taskId } = {}) => {
    const task = validId(taskId) ? tasks.get(taskId) : undefined;
    const events = task ? [...task.events.values()] : [];
    const truncated = evictedTasks > 0 || !!task?.truncated;
    const incomplete = truncated || !!task?.conflicted;
    const selected = {};
    // Follow one explicit lineage, never independently select unrelated hops.
    let head = null;
    for (const event of events) {
      if (!head || KINDS.indexOf(event.kind) >= KINDS.indexOf(head.kind)) head = event;
    }
    while (head) {
      selected[head.kind] = head;
      head = head.linkedTo ? task.events.get(head.linkedTo) : null;
    }
    const chain = {};
    const eventRefs = {};
    for (const kind of KINDS) {
      const event = selected[kind];
      eventRefs[kind] = event?.eventId ?? null;
      chain[kind] = {
        status: incomplete || !task ? 'unknown' : event ? 'present' : 'missing',
        identity: event?.taskId ?? null,
        linkedTo: event?.linkedTo ? taskId : null,
        source: event ? { ...event.source } : undefined,
      };
    }
    const classified = classifyClosure(chain);
    return {
      ...classified,
      // Declared actor separation is not authenticated independent review.
      declaredIndependentReview: classified.independentReview,
      independentReview: false,
      reviewOrigin: 'unverified',
      observation: observe(),
      correlation: task ? 'event_bound' : validId(taskId) ? 'unbound' : 'required',
      reviewSupplied: !!selected.review,
      eventRefs,
      provenance: 'caller_declared_unverified',
      humanIdentity: 'unknown',
      principleValidity: 'unknown',
      retention: { maxTasks, maxEventsPerTask, retainedTasks: tasks.size, retainedEvents: events.length, evictedTasks },
      truncated,
      incomplete: incomplete || KINDS.some(kind => !selected[kind]),
      ...(task?.conflicted ? { degraded: 'conflicting_or_invalid_event' } : {}),
    };
  };

  /** Export copies for a host adapter; persistence and replay trust are external. */
  const snapshot = () => ({
    version: 1,
    maxTasks,
    maxEventsPerTask,
    evictedTasks,
    truncated: evictedTasks > 0 || [...tasks.values()].some(task => task.truncated),
    tasks: [...tasks].map(([taskId, task]) => ({
      taskId,
      conflicted: task.conflicted,
      truncated: task.truncated,
      events: [...task.events.values()].map(copy),
    })),
  });

  return { observe, record, report, snapshot };
}
