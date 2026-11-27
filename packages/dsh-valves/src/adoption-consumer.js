/** Read-only classification of unverified adoption nominations. */
const KEY = (row) => typeof row?.candidate_id === 'string' && row.candidate_id.trim() ? row.candidate_id : null;
const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const correlation = (row) => !Object.hasOwn(row, 'correlationId') ? 'missing'
  : typeof row.correlationId === 'string' && CORRELATION_ID.test(row.correlationId) ? 'valid' : 'invalid';

export function adoptionCandidates(entries, options = {}) {
  if (!Array.isArray(entries)) return { items: [], keys: [], truncated: false, read_completeness: 'unknown', error: 'ledger_unavailable',
    correlation_count_scope: 'provided_entries', ambiguous_correlation_rows: null, ambiguous_correlation_ids: null,
    unambiguous_page_keys: null, unambiguous_count_scope: 'current_page_observed' };
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 100) : 50;
  const consumed = new Set();
  const counts = new Map();
  const correlations = new Map();
  for (const row of entries) {
    if (row?.gate === 'adoption_consumed' && Array.isArray(row.consumed_keys)) {
      for (const key of row.consumed_keys) if (typeof key === 'string' && key.trim()) consumed.add(key);
    }
    if (row?.gate === 'adoption_nomination') {
      const key = KEY(row);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
      if (correlation(row) === 'valid') correlations.set(row.correlationId, (correlations.get(row.correlationId) ?? 0) + 1);
    }
  }
  const pending = entries.filter((row) => row?.gate === 'adoption_nomination').map((row, index) => {
    const key = KEY(row);
    const adoption = row.adoption && typeof row.adoption === 'object' && !Array.isArray(row.adoption) ? row.adoption : {};
    const correlationType = correlation(row);
    const duplicate = correlationType === 'valid' && correlations.get(row.correlationId) > 1;
    return {
      key, index,
      trace_ref: key,
      source: adoption.provenance === 'caller/user-action' ? 'caller/user-action' : 'unknown',
      note: typeof adoption.note === 'string' ? adoption.note : '',
      kind: correlationType !== 'invalid' && (adoption.kind === 'correction' || adoption.kind === 'positive') ? adoption.kind : 'unknown',
      ...(correlationType === 'valid' ? { correlationId: row.correlationId } : {}),
      correlation_status: duplicate ? 'ambiguous' : correlationType === 'valid' ? 'unverified' : correlationType,
      correlation_observed_count: correlationType === 'valid' ? correlations.get(row.correlationId) : null,
      identity: !key || counts.get(key) > 1 || duplicate || correlationType === 'invalid' ? 'unknown' : 'unverified',
      status: key && consumed.has(key) ? 'historical_consumed_unverified' : 'pending_unverified',
    };
  });
  pending.sort((a, b) => (a.key ?? '').localeCompare(b.key ?? '') || a.index - b.index);
  const page = pending.slice(0, limit);
  return {
    items: page.map(({ key, index, ...item }) => item),
    keys: page.map((item) => item.key).filter(Boolean),
    truncated: pending.length > page.length,
    correlation_count_scope: 'provided_entries',
    ambiguous_correlation_rows: pending.filter((item) => item.correlation_status === 'ambiguous').length,
    ambiguous_correlation_ids: [...correlations.values()].filter((count) => count > 1).length,
    unambiguous_page_keys: new Set(page.filter((item) => item.identity === 'unverified').map((item) => item.key)).size,
    unambiguous_count_scope: 'current_page_observed',
    read_completeness: 'unknown',
  };
}

/** Preserve the historical helper API; the governance path does not call it. */
export function adoptionConsumedRow(keys) {
  return { gate: 'adoption_consumed', direction: 'governance', outcome: 'admitted',
    action: 'adoption_consumed', reason: 'adoption_rows_injected_into_governance',
    origin: 'adoption', consumed_keys: keys.filter((k) => typeof k === 'string' && k) };
}
