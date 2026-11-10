import { createHash } from 'node:crypto';
import { redactSecrets } from './secrets.js';

// IDs are opaque UTF-16 strings. Encoding their code units preserves distinct
// IDs even when they contain unpaired surrogates (UTF-8 would replace them).
const DOMAIN = Buffer.from('dsh-memory-daily-capture-event\0v1\0', 'ascii');
const MARKER = /^<!-- memory-capture:v1:[0-9a-f]{64} -->$/;
const DEFAULT_MAX_CHARS = 160;

/** Return a stable marker for an opaque nonblank message ID, or null. */
export function makeCaptureMarker(id) {
	try {
		if (typeof id !== 'string' || !id.trim()) return null;
		const encoded = Buffer.from(id, 'utf16le');
		const length = Buffer.alloc(8);
		length.writeBigUInt64BE(BigInt(encoded.length));
		const digest = createHash('sha256').update(DOMAIN).update(length).update(encoded).digest('hex');
		return `<!-- memory-capture:v1:${digest} -->`;
	} catch {
		return null;
	}
}

/** Match a complete marker line only; textual similarity is not event identity. */
export function hasCaptureMarker(dailyText, marker) {
	if (typeof dailyText !== 'string' || typeof marker !== 'string' || !MARKER.test(marker)) return false;
	return dailyText.split(/\r?\n/).some((line) => line === marker);
}

// A maximum counts Unicode code points, never splitting a surrogate pair.
function truncate(text, maxChars) {
	let end = 0;
	let count = 0;
	for (const ch of text) {
		if (count === maxChars) return `${text.slice(0, end)}…`;
		end += ch.length;
		count++;
	}
	return text;
}

/**
 * Extract per-message candidate events without mutation or I/O.
 * source.kind and ID are declarations, not authenticated user identity.
 * Counts are per input message except invalidBlock, which counts blocks.
 */
export function selectCaptureEvents(messages, options = {}) {
	const skipped = { invalidMessage: 0, nonUser: 0, nonUserSource: 0, missingId: 0, noText: 0, nonTextBlock: 0, invalidBlock: 0, duplicate: 0, conflict: 0 };
	const conflicts = [];
	const byId = new Map();
	const unreadableIds = new Set();
	let input;
	let maxChars = DEFAULT_MAX_CHARS;
	try {
		input = Array.isArray(messages) ? messages : [];
		if (!Array.isArray(messages)) skipped.invalidMessage++;
	} catch {
		return { events: [], skipped: { ...skipped, invalidMessage: skipped.invalidMessage + 1 }, conflicts };
	}
	try {
		if (Number.isSafeInteger(options?.maxChars) && options.maxChars >= 0) maxChars = options.maxChars;
	} catch { skipped.invalidMessage++; }
	try {
	for (let i = 0; i < input.length; i++) {
		let candidateId;
		try {
			const message = input[i];
			if (!message || typeof message !== 'object' || Array.isArray(message)) { skipped.invalidMessage++; continue; }
			if (message.role !== 'user') { skipped.nonUser++; continue; }
			if (!message.source || typeof message.source !== 'object' || message.source.kind !== 'user') { skipped.nonUserSource++; continue; }
			const id = message.id;
			if (typeof id !== 'string' || !id.trim()) { skipped.missingId++; continue; }
			candidateId = id;
			const marker = makeCaptureMarker(id);
			if (!marker) { skipped.invalidMessage++; continue; }
			const parts = [];
			let invalidContent = false;
			if (Array.isArray(message.content)) {
				for (const block of message.content) {
					try {
						if (!block || typeof block !== 'object' || typeof block.type !== 'string') { skipped.invalidBlock++; invalidContent = true; continue; }
						if (block.type !== 'text') { skipped.nonTextBlock++; continue; }
						if (typeof block.text !== 'string') { skipped.invalidBlock++; invalidContent = true; continue; }
						parts.push(block.text);
					} catch { skipped.invalidBlock++; invalidContent = true; }
				}
			} else { invalidContent = true; skipped.invalidMessage++; }
			if (invalidContent) {
				if (!unreadableIds.has(id)) { unreadableIds.add(id); conflicts.push({ id, reason: 'invalid-content' }); }
				continue;
			}
			// Concatenate before redaction so a secret split between text blocks
			// cannot escape detection merely because of a synthetic separator.
			const raw = parts.join('');
			const usable = raw.trim().length > 0;
			if (!usable) skipped.noText++;
			const previous = byId.get(id);
			if (!previous) {
				byId.set(id, { id, marker, raw, usable, conflict: false });
			} else if (previous.raw !== raw || previous.usable !== usable) {
				if (!previous.conflict) { previous.conflict = true; skipped.conflict++; conflicts.push({ id, reason: 'same-id-different-content' }); }
			} else {
				skipped.duplicate++;
			}
		} catch {
			skipped.invalidMessage++;
			if (candidateId && !unreadableIds.has(candidateId)) {
				unreadableIds.add(candidateId);
				conflicts.push({ id: candidateId, reason: 'unreadable-content' });
			}
		}
	}
	} catch {
		// A hostile array proxy can fail while reading length or iteration state.
		skipped.invalidMessage++;
	}
	const events = [];
	for (const candidate of byId.values()) {
		if (candidate.conflict || unreadableIds.has(candidate.id) || !candidate.usable) continue;
		try {
			const safe = redactSecrets(candidate.raw);
			events.push({ id: candidate.id, marker: candidate.marker, text: truncate(safe.text, maxChars), redactions: [...safe.hits] });
		} catch { skipped.invalidMessage++; }
	}
	return { events, skipped, conflicts };
}
