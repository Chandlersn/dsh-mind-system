import { isDeepStrictEqual } from 'node:util';
import { readRepairEventByIdentity, REPAIR_EVENT_REVIEW_LIMITS } from './repair-event-review.js';

const verdict = (status, code, details = {}) => ({
 schemaVersion: 1, ...details, status, code, attestation: 'record_consistency',
 artifacts: 'not_evaluated', goalProof: 'not_evaluated', principleAttribution: 'not_evaluated', governanceEligible: false,
});

/** Host-owned bindings and reader are configuration, never fields supplied by an event. */
export function createRepairIdentityResolver({ inboxFilePath, sources, readRuntimeEvidence } = {}) {
 if (typeof inboxFilePath !== 'string' || !inboxFilePath.trim()
  || !sources || typeof sources !== 'object' || Array.isArray(sources)) throw new TypeError('Invalid resolver configuration');
 const bindings = new Map(Object.entries(sources).map(([id, source]) => {
  if (!id.trim()) throw new TypeError('Invalid producer binding');
  if (typeof source?.readEvidence === 'function') return [id, Object.freeze({ readEvidence: source.readEvidence })];
  if (typeof source?.runtimeFilePath !== 'string' || !source.runtimeFilePath.trim() || typeof readRuntimeEvidence !== 'function') throw new TypeError('Invalid producer binding');
  const runtimeFilePath = source.runtimeFilePath;
  return [id, Object.freeze({ readEvidence: ({producerId,eventId}) => readRuntimeEvidence({runtimeFilePath,producerId,eventId}) })];
 }));
 return Object.freeze({
  resolve({producerId, eventId} = {}) {
   const source = bindings.get(producerId);
   if (!source) return verdict('unsupported','producer_unbound');
   try {
    const receipt = readRepairEventByIdentity({filePath:inboxFilePath,producerId,eventId});
    if (receipt.status !== 'available') return verdict('incomplete',`receipt_${receipt.code}`);
    const item = receipt.item;
    if (item.kind !== 'repair_finished') return verdict('unsupported','receipt_kind');
    const stored = source.readEvidence({producerId,eventId});
    if (!stored || !['match','missing','mismatch','unsupported','error'].includes(stored.status)) return verdict('error','runtime_reader_contract');
    if (stored.status !== 'match') return verdict(stored.status, 'runtime_evidence_unresolved', {reason:stored.code ?? stored.reason ?? stored.status});
    if (stored.producerId !== producerId || stored.eventId !== eventId || stored.kind !== item.kind
     || !isDeepStrictEqual(stored.payload,item.payload.value)) return verdict('mismatch','receipt_payload_conflict');
    const result = verdict('match','receipt_matches_persisted_identity', {producerId,eventId,receivedAt:item.receivedAt,payload:stored.payload});
    if (Buffer.byteLength(JSON.stringify(result)) > REPAIR_EVENT_REVIEW_LIMITS.maxResponseBytes) return verdict('unsupported','response_limit');
    return result;
   } catch { return verdict('error','identity_read_failed'); }
  },
 });
}
