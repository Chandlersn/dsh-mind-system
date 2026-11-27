/**
 * Fail-closed classifier for the "first visible growth loop" acceptance check.
 *
 * It does NOT assert that a loop happened. It reports, per hop, the identity and
 * the origin of the evidence, and refuses to call a review independent when it
 * is self-produced. Four namespaces (runtime taskId, memory objectKey,
 * operation request_id, usage correlationId) have no safe converter, so a hop
 * is linked only by an explicit, caller-supplied link that must equal the
 * previous hop's identity. No fuzzy time-based or value-based stitching.
 *
 * Everything is caller-declared and unverified: the output is an evidence
 * report, never proof of human adoption, task success or principle attribution.
 */

const HOP_NAMES = ['recall', 'action', 'result', 'review'];
const IDENTIFIER_RE = /^[A-Za-z0-9_.:-]{1,256}$/;

function normalizeHop(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = value.status;
  if (!['present', 'missing', 'unknown'].includes(status)) return null;
  const identity = value.identity === undefined || value.identity === null ? null : value.identity;
  if (identity !== null && (typeof identity !== 'string' || !IDENTIFIER_RE.test(identity))) return null;
  const source = value.source;
  if (source !== undefined && source !== null && (typeof source !== 'object' || Array.isArray(source))) return null;
  const sourceType = source ? source.type : null;
  if (sourceType !== null && !['self', 'external'].includes(sourceType)) return null;
  // A present-but-malformed actor is corruption, not absence: degrade instead of
  // silently dropping it, otherwise a self-review can bypass the actor check.
  if (source && Object.hasOwn(source, 'actor')
    && (typeof source.actor !== 'string' || !IDENTIFIER_RE.test(source.actor))) return null;
  const actor = source && typeof source.actor === 'string' && IDENTIFIER_RE.test(source.actor)
    ? source.actor : null;
  const linkedTo = value.linkedTo === undefined || value.linkedTo === null ? null : value.linkedTo;
  if (linkedTo !== null && (typeof linkedTo !== 'string' || !IDENTIFIER_RE.test(linkedTo))) return null;
  return { status, identity, sourceType, actor, linkedTo };
}

/**
 * Pure, side-effect-free classification. Input is untrusted; malformed values
 * degrade the whole chain to unknown, never to "missing" (absence != no loop).
 */
export function classifyClosure(input) {
  const hops = {};
  let malformed = false;
  for (const name of HOP_NAMES) {
    const normalized = normalizeHop(input && typeof input === 'object' ? input[name] : undefined);
    if (normalized === null && (input && typeof input === 'object' && input[name] !== undefined)) malformed = true;
    hops[name] = normalized ?? { status: 'unknown', identity: null, sourceType: null, actor: null, linkedTo: null };
  }

  const missingOrUnknown = HOP_NAMES.some(name => hops[name].status !== 'present');
  const missingIdentity = HOP_NAMES.some(name => !hops[name].identity);
  const missingActor = HOP_NAMES.some(name => !hops[name].actor);
  const linkBroken = HOP_NAMES.slice(1).some((name, i) => {
    const prev = hops[HOP_NAMES[i]];
    return hops[name].linkedTo === null || hops[name].linkedTo !== prev.identity;
  });
  // Adjacent links alone are not enough: identities may drift A->B->C->D while
  // every link is locally valid. Require every hop to share the head identity.
  const sameIdentity = HOP_NAMES.every(name => hops[name].identity === hops.recall.identity);

  // A review produced by any hop's own actor is not independent. Self-produced
  // signals are exposure only and can never close the loop. A claimed external
  // review whose actor equals a hop identity is also not a distinct party.
  const review = hops.review;
  // Compare against the OTHER hops only; including review itself would make
  // every external review look self-produced.
  const hopActors = HOP_NAMES.slice(0, 3).map(name => hops[name].actor);
  const identities = HOP_NAMES.map(name => hops[name].identity);
  // An actor equal to a hop identity conflates the two namespaces; treat it as
  // ambiguous and never let it support an independent-review claim.
  const actorIdentityAmbiguous = HOP_NAMES.some(name => hops[name].actor !== null
    && hops[name].actor === hops[name].identity);
  const selfReview = review.sourceType === 'self'
    || actorIdentityAmbiguous
    || (review.actor !== null && (hopActors.includes(review.actor) || identities.includes(review.actor)));
  // An independent review only counts as THIS loop's review if the whole chain
  // is present, linked and well-formed. A valid-looking external review attached
  // to a broken or incomplete chain cannot certify a loop that does not exist.
  const chainIntact = !malformed && !missingOrUnknown && !missingIdentity
    && !missingActor && !linkBroken && sameIdentity;
  // caller-declared and unverified: downstream must not treat this boolean as
  // authenticated human review or governance evidence.
  const independentReview = chainIntact
    && review.status === 'present'
    && review.sourceType === 'external'
    && !selfReview;

  let chain = 'unknown';
  if (!malformed && !missingOrUnknown && !missingIdentity) {
    chain = (linkBroken || !sameIdentity) ? 'not_correlated' : 'correlated';
  }

  return {
    status: 'ok',
    hops,
    chain,
    independentReview,
    selfReviewCannotClose: selfReview,
    // A correlated chain with an external review is still only an evidence
    // report. Claiming the loop is a human decision, never this classifier's.
    closureClaim: 'not_asserted',
    humanAdoption: 'not_evaluated',
    goalProof: 'not_evaluated',
    principleAttribution: 'not_evaluated',
    governanceEligible: false,
    ...(malformed ? { degraded: 'malformed_input' } : {}),
  };
}
