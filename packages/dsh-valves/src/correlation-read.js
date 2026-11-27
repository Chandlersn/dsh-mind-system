import { readGovernanceDecisions } from './store.js';
import { validateCorrelatedAdoption } from './correlated-adoption.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const summary = (status, scope = 'unknown', sourceState = 'unknown') => ({ status, scope, sourceState });

function validRow(row, id) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.note !== 'string') return false;
  const normalized = validateCorrelatedAdoption({ schemaVersion: 1, eventId: id, objectKey: row.objectKey, kind: row.kind, note: row.note });
  return !!normalized && normalized.objectKey === row.objectKey && normalized.kind === row.kind && normalized.note === row.note;
}

function copyDataObject(value, allowed) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key))) return null;
  const copy = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

function validatePeer(input, id) {
  try {
    const value = copyDataObject(input, ['status', 'scope', 'snapshot', 'sourceState', 'rows', 'duplicate', 'overflow', 'reason']);
    if (!value || !Array.isArray(value.rows) || Object.getPrototypeOf(value.rows) !== Array.prototype) return null;
    const arrayKeys = Reflect.ownKeys(value.rows);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value.rows, 'length');
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') || !Number.isInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > 2) return null;
    const length = lengthDescriptor.value;
    if (arrayKeys.length !== length + 1 || arrayKeys.some(key => typeof key !== 'string' || (key !== 'length' && !Array.from({ length }, (_, i) => String(i)).includes(key)))) return null;
    const rows = [];
    for (let i = 0; i < length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value.rows, String(i));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      const row = copyDataObject(descriptor.value, ['objectKey', 'kind', 'note', 'noteStatus']);
      if (!row || Reflect.ownKeys(row).length !== 4) return null;
      rows.push(Object.freeze(row));
    }
    value.rows = Object.freeze(rows);
    if (!['observed', 'not_observed', 'incomplete', 'error'].includes(value.status) || value.snapshot !== 'unknown' || typeof value.duplicate !== 'boolean' || typeof value.overflow !== 'boolean') return null;
    if (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 256)) return null;
    const complete = value.status === 'observed' || value.status === 'not_observed';
    if (value.scope !== (complete ? 'selected_sources_complete' : 'unknown')) return null;
    if (complete ? !['present', 'absent'].includes(value.sourceState) : value.sourceState !== undefined) return null;
    if (!complete && (value.rows.length || value.duplicate || value.overflow)) return null;
    if (value.status === 'not_observed' && (value.rows.length || value.duplicate || value.overflow)) return null;
    if (value.status === 'observed' && (!value.rows.length || value.sourceState !== 'present')) return null;
    if (value.duplicate !== (value.rows.length === 2) || (value.overflow && !value.duplicate)) return null;
    for (const row of value.rows) {
      if (!['available', 'missing_normalized_empty'].includes(row.noteStatus) || (row.noteStatus === 'missing_normalized_empty' && row.note !== '') || !validRow(row, id)) return null;
    }
    return Object.freeze(value);
  } catch { return null; }
}

// One slot per plugin scope also bounds accumulation when the peer service changes.
export function createCorrelationPeerGate({ timeoutMs = 1000, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let pending = false;
  let disposed = false;
  let endWait;
  return {
    dispose() { disposed = true; endWait?.(); },
    async read(getPeer, id) {
      if (disposed || pending) return null;
      let service, method;
      try {
        service = getPeer();
        method = service?.readUsageCorrelation;
        if (typeof method !== 'function') return null;
      } catch { return null; }
      pending = true;
      let timer;
      const waiting = new Promise(resolve => {
        endWait = () => resolve(null);
        timer = schedule(endWait, timeoutMs);
      });
      const actual = Promise.resolve().then(() => method.call(service, id)).then(
        value => validatePeer(value, id),
        () => null,
      ).then(value => { pending = false; return value; });
      try { return await Promise.race([actual, waiting]); }
      finally { cancel(timer); endWait = undefined; }
    },
  };
}

const defaultPeerGate = createCorrelationPeerGate();

export async function readCorrelation(storageDir, getPeer, id, peerGate = defaultPeerGate) {
  const result = { status: 'incomplete', receiver: summary('incomplete'), memory: summary('incomplete'), comparison: { objectKey: 'unknown', kind: 'unknown', note: 'unknown' }, snapshot: 'unknown', peerProvenance: 'unverified', goalProof: 'not_evaluated', principleAttribution: 'not_evaluated', governanceEligible: false };
  if (typeof id !== 'string' || !UUID.test(id)) return { ...result, reason: 'invalid_id' };
  let matches = [];
  try {
    const ledger = await readGovernanceDecisions(storageDir, { strictIdentity: true });
    if (ledger.complete && (ledger.status === 'missing' || ledger.terminated === true)) {
      matches = ledger.entries.filter(row => row.correlationId === id);
      if (matches.some(row => row.gate !== 'adoption_nomination' || row.origin !== 'adoption' || !validRow(row.adoption, id))) {
        result.receiver = summary('incomplete'); matches = [];
      } else {
        result.receiver = summary(matches.length > 1 ? 'duplicate' : matches.length ? 'observed' : 'not_observed', 'selected_sources_complete', ledger.status === 'missing' ? 'absent' : 'present');
      }
    }
  } catch { /* Fail closed without exposing errors. */ }
  let peer;
  try {
    peer = await peerGate.read(getPeer, id);
  } catch { /* Fail closed without exposing errors. */ }
  if (peer) {
    result.memory = summary(peer.duplicate || peer.overflow ? 'duplicate' : peer.status, peer.scope, peer.sourceState ?? 'unknown');
  }
  if (result.receiver.status === 'duplicate' || result.memory.status === 'duplicate') result.status = 'duplicate';
  else if (result.receiver.status === 'incomplete' || ['incomplete', 'error'].includes(result.memory.status)) result.status = 'incomplete';
  else if (result.receiver.status === 'not_observed' || result.memory.status === 'not_observed') result.status = 'not_observed';
  else if (peer && matches.length === 1 && peer.rows.length === 1) {
    const source = peer.rows[0], receiver = matches[0].adoption;
    result.status = 'compared';
    result.comparison.objectKey = source.objectKey === receiver.objectKey ? 'match' : 'mismatch';
    result.comparison.kind = source.kind === receiver.kind ? 'match' : 'mismatch';
    if (source.noteStatus === 'available') result.comparison.note = source.note === receiver.note ? 'match' : 'mismatch';
  }
  return result;
}
