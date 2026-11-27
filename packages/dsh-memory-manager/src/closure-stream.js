/**
 * Automatic three-hop observation for the growth-loop evidence report.
 *
 * It reuses the passive live-flow snapshot (already fed by tools/execute,
 * tools/result and pre-step recall listeners). It observes only phases and
 * bounded edge identities - never tool arguments, results or message bodies -
 * and installs no new host listeners.
 *
 * The review hop is deliberately NOT collected here: it can only come from a
 * person in the loop. Without it the report stays incomplete, so the system
 * never manufactures its own independent review. Correlation to a task is also
 * caller-supplied; without it hops remain unknown rather than being stitched
 * together by timing.
 */
import { classifyClosure } from './closure-evidence.js';

const RECALL_EDGES = ['e10', 'e12'];
const TOOL_EDGES = ['e2', 'e3', 'e4', 'e6', 'e7', 'e9', 'e11', 'e14', 'e15'];
const ID_RE = /^[A-Za-z0-9_.:-]{1,256}$/;
const validId = value => typeof value === 'string' && ID_RE.test(value);

/**
 * @param {{ flow?: { snapshot?: Function }, now?: Function }} options
 */
export function createClosureStream({ flow, now = Date.now } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  /** Read-only, bounded observation of the current activity window. */
  const observe = () => {
    let snap = null;
    try { if (typeof flow?.snapshot === 'function') snap = flow.snapshot(); } catch { snap = null; }
    const edges = snap && typeof snap.edges === 'object' && snap.edges ? snap.edges : {};
    const phase = id => (edges[id] && typeof edges[id] === 'object' ? edges[id].phase : null);
    return {
      recall: RECALL_EDGES.some(id => phase(id) === 'finished'),
      action: TOOL_EDGES.some(id => phase(id) === 'active'),
      result: TOOL_EDGES.some(id => phase(id) === 'finished'),
      observedAt: now(),
      source: snap ? 'live_flow' : 'unavailable',
    };
  };

  /**
   * Automatic evidence report. `taskId` is a caller-supplied correlation key;
   * `review` is a caller-supplied human-in-the-loop signal shaped as
   * { actor, sourceType } or absent. Neither is inferred by this module.
   */
  const report = ({ taskId, review } = {}) => {
    const o = observe();
    const identity = validId(taskId) ? taskId : null;
    const hop = (observed, source) => ({
      status: identity === null ? 'unknown' : observed ? 'present' : 'missing',
      identity,
      source,
      linkedTo: identity,
    });
    const r = review && typeof review === 'object' ? review : null;
    const hasReview = r !== null && validId(r.actor) && r.sourceType === 'external';
    const chain = {
      recall: hop(o.recall, { type: 'external', actor: 'prestep' }),
      action: hop(o.action, { type: 'self', actor: 'agent' }),
      result: hop(o.result, { type: 'self', actor: 'agent' }),
      review: hasReview
        ? hop(true, { type: r.sourceType, actor: r.actor })
        : hop(false, { type: 'external' }),
    };
    return {
      ...classifyClosure(chain),
      observation: {
        recall: o.recall,
        action: o.action,
        result: o.result,
        observedAt: o.observedAt,
        source: o.source,
      },
      correlation: identity ? 'caller_supplied' : 'required',
      reviewSupplied: hasReview,
    };
  };

  return { observe, report };
}
