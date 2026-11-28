const MINUTE = 60_000;
const REVIEW_INTERVAL = 24 * 60 * MINUTE;

/** Select a due item without updating its observation or disposition history. */
export function selectInboxWork(items, now = Date.now()) {
  if (!Array.isArray(items) || !Number.isFinite(now)) return null;
  const due = [];
  for (const item of items) {
    if (!item || typeof item.fingerprint !== 'string' || !item.fingerprint) continue;
    if (item.status !== 'open' && item.status !== 'acknowledged') continue;
    // Older records have no disposition clock. Repeated findings can change
    // lastSeenAt, so use first receipt as an estimate for legacy reviews.
    const receivedAt = Date.parse(item.receivedAt);
    let dueAt = receivedAt;
    if (item.status === 'acknowledged') {
      const handledAt = Date.parse(item.lastHandledAt ?? item.receivedAt);
      dueAt = handledAt + REVIEW_INTERVAL;
    }
    if (dueAt <= now) due.push({ item, dueAt });
  }
  if (!due.length) return null;
  due.sort((a, b) => a.dueAt - b.dueAt || a.item.fingerprint.localeCompare(b.item.fingerprint, 'en'));
  // A maintenance job may always run at the same UTC time. Advance the
  // rotation daily even when the number of items divides 1,440 minutes.
  const day = Math.floor(now / REVIEW_INTERVAL);
  const utc = new Date(now);
  const slot = (day + utc.getUTCHours() + utc.getUTCMinutes()) % due.length;
  return due[(slot + due.length) % due.length].item;
}
