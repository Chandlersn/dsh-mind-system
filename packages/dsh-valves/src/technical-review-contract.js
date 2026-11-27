export const TECHNICAL_REVIEW_ALGORITHM_VERSION = 'technical-review-v1';
const identityCodes = new Set(['receipt_matches_persisted_identity']);
const artifactReasons = new Set(['all_artifacts_match', 'artifacts_not_verified', 'invalid_workspace_root',
  'invalid_evidence_refs', 'empty_evidence_refs', 'reference_count_limit', 'link_not_allowed',
  'ancestor_not_directory', 'workspace_not_directory', 'file_missing', 'access_denied',
  'filesystem_error', 'output_byte_limit']);
const artifactStatuses = new Set(['match', 'mismatch', 'unknown', 'error']);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const keys = ['producerId', 'eventId', 'payloadSha256', 'algorithmVersion', 'identityStatus',
  'identityReason', 'artifactStatus', 'artifactReason', 'goalProof', 'principleAttribution',
  'governanceEligible', 'createdAt'];

export const validId = (value) => typeof value === 'string' && idPattern.test(value);
export const validIdentityReason = (value) => identityCodes.has(value);
export const validArtifact = (status, reason) => artifactStatuses.has(status) && artifactReasons.has(reason)
  && (status === 'match') === (reason === 'all_artifacts_match');
export const noPromotion = (value) => value && value.goalProof === 'not_evaluated'
  && value.principleAttribution === 'not_evaluated' && value.governanceEligible === false;

export function validSnapshot(value, producerId, eventId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))
    || !validId(value.producerId) || !validId(value.eventId)
    || (producerId !== undefined && value.producerId !== producerId)
    || (eventId !== undefined && value.eventId !== eventId)
    || typeof value.payloadSha256 !== 'string' || !digestPattern.test(value.payloadSha256)
    || value.algorithmVersion !== TECHNICAL_REVIEW_ALGORITHM_VERSION || value.identityStatus !== 'match'
    || !validIdentityReason(value.identityReason) || !validArtifact(value.artifactStatus, value.artifactReason)
    || !noPromotion(value) || typeof value.createdAt !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt)) return false;
  const time = Date.parse(value.createdAt);
  return Number.isFinite(time) && new Date(time).toISOString() === value.createdAt;
}
