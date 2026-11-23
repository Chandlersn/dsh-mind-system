import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const REPAIR_EVENT_REVIEW_LIMITS = Object.freeze({
	maxRows: 100,
	maxResponseBytes: 64 * 1024,
	maxPayloadBytes: 16 * 1024,
	maxIdentifierBytes: 1024,
	maxMetadataBytes: 128,
	maxCursorBytes: 256,
});
const MIN_ROWID = -(1n << 63n);
const MAX_ROWID = (1n << 63n) - 1n;
const fields = [
	['producer_id', 'producerId', REPAIR_EVENT_REVIEW_LIMITS.maxIdentifierBytes],
	['event_id', 'eventId', REPAIR_EVENT_REVIEW_LIMITS.maxIdentifierBytes],
	['kind', 'kind', REPAIR_EVENT_REVIEW_LIMITS.maxMetadataBytes],
	['received_at', 'receivedAt', REPAIR_EVENT_REVIEW_LIMITS.maxMetadataBytes],
	['payload_json', 'payload', REPAIR_EVENT_REVIEW_LIMITS.maxPayloadBytes],
];
// CASE prevents oversized text from crossing the SQLite/JavaScript boundary.
const projection = fields.map(([column, , cap]) => `
	length(CAST(${column} AS BLOB)) AS ${column}_bytes,
	typeof(${column}) AS ${column}_type,
	CASE WHEN length(CAST(${column} AS BLOB)) <= ${cap}
		AND typeof(${column}) = 'text' THEN CAST(${column} AS BLOB) ELSE NULL END AS ${column}
`).join(',');

function validateFilePath(filePath) {
	if (typeof filePath !== 'string' || filePath.trim() === '' || filePath.includes('\0') || filePath === ':memory:' || /^file:/i.test(filePath)) {
		throw invalid('filePath must name an existing filesystem database');
	}
}

function invalid(message) {
	const error = new TypeError(message);
	error.code = 'invalid_review_options';
	return error;
}

/** Exact-key access to one raw receipt; the path must come from trusted host configuration. */
export function readRepairEventByIdentity({ filePath, producerId, eventId } = {}) {
	validateFilePath(filePath);
	for (const value of [producerId, eventId]) {
		if (typeof value !== 'string' || !value.trim() || value.includes('\0')
			|| Buffer.byteLength(value) > REPAIR_EVENT_REVIEW_LIMITS.maxIdentifierBytes) {
			throw invalid('producerId and eventId must be bounded nonblank identifiers');
		}
	}
	let db;
	try {
		try { statSync(filePath); }
		catch (error) {
			if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { status: 'unavailable', code: 'database_missing' };
			throw error;
		}
		db = new DatabaseSync(filePath, { readOnly: true });
		db.exec('BEGIN');
		const statement = db.prepare(`SELECT rowid AS review_rowid, ${projection}
			FROM repair_event_inbox WHERE producer_id = ? COLLATE BINARY AND event_id = ? COLLATE BINARY LIMIT 2`);
		statement.setReadBigInts(true);
		const rows = statement.all(producerId, eventId);
		if (!rows.length) return { status: 'missing', code: 'event_missing' };
		if (rows.length !== 1) return { status: 'error', code: 'identity_ambiguous' };
		const item = mapRow(rows[0]);
		const result = { status: 'available', provenance: 'raw_producer_claims', item };
		if (Buffer.byteLength(JSON.stringify(result)) > REPAIR_EVENT_REVIEW_LIMITS.maxResponseBytes) {
			return { status: 'unresolved', code: 'serialized_row_limit' };
		}
		if (fields.some(([, name]) => name === 'payload' ? item.payload.status !== 'raw' : typeof item[name] !== 'string')) {
			return { ...result, status: 'unresolved', code: 'record_invalid' };
		}
		return result;
	} catch (error) {
		if (error.errcode === 14) return { status: 'unavailable', code: 'database_unavailable' };
		return { status: 'error', code: 'database_read_error' };
	} finally { db?.close(); }
}

function rowid(value) {
	if (typeof value !== 'string' || !/^(0|[1-9]\d{0,18}|-[1-9]\d{0,18})$/.test(value)) throw invalid('Invalid cursor rowid');
	const parsed = BigInt(value);
	if (parsed < MIN_ROWID || parsed > MAX_ROWID) throw invalid('Cursor rowid is outside signed 64-bit range');
	return parsed;
}

function encodeCursor(source, after, highWater) {
	return Buffer.from(JSON.stringify({ v: 1, source, after: String(after), highWater: String(highWater) })).toString('base64url');
}

function decodeCursor(cursor, source) {
	if (typeof cursor !== 'string' || cursor.length > REPAIR_EVENT_REVIEW_LIMITS.maxCursorBytes || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
		throw invalid('Invalid review cursor');
	}
	let data;
	try { data = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
	catch { throw invalid('Invalid review cursor'); }
	if (!data || data.v !== 1 || data.source !== source) throw invalid('Cursor version or database path does not match');
	const after = rowid(data.after);
	const highWater = rowid(data.highWater);
	if (after > highWater || encodeCursor(source, after, highWater) !== cursor) throw invalid('Noncanonical review cursor');
	return { after, highWater };
}

function mapRow(row) {
	const item = { rowid: String(row.review_rowid), status: 'raw' };
	for (const [column, name] of fields) {
		const bytes = row[`${column}_bytes`];
		if (row[`${column}_type`] !== 'text') {
			item[name] = { status: 'invalid_storage_type', storageType: row[`${column}_type`] };
		} else if (row[column] === null) {
			item[name] = { status: 'oversize', bytes: String(bytes) };
		} else {
			// Reading bounded blobs preserves embedded NULs on Node versions whose
			// SQLite TEXT conversion stops at the first NUL byte.
			const text = Buffer.from(row[column]).toString('utf8');
			if (name === 'payload') {
				try { item.payload = { status: 'raw', value: JSON.parse(text) }; }
				catch { item.payload = { status: 'invalid_json', raw: text }; }
			} else {
				item[name] = text;
			}
		}
	}
	return item;
}

/**
 * Read raw producer claims; no claim is verified or promoted into governance.
 * Limits are byte limits (UTF-8), including the complete serialized response.
 * A cursor fixes the insertion-rowid high-water mark across reopened connections.
 * This assumes the receiver's append-only table: deletion, replacement, explicit
 * rowid insertion, or VACUUM between pages is not a historical snapshot.
 * Invalid options throw invalid_review_options; storage failures return explicit
 * unavailable/error results. No SQLite error text or caller path is reflected.
 */
export function readRepairEventPage({ filePath, limit = 20, cursor } = {}) {
	validateFilePath(filePath);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > REPAIR_EVENT_REVIEW_LIMITS.maxRows) {
		throw invalid('limit must be an integer from 1 through 100');
	}
	const source = createHash('sha256').update(resolve(filePath)).digest('hex').slice(0, 32);
	const position = cursor === undefined ? null : decodeCursor(cursor, source);
	let db;
	try {
		try { statSync(filePath); }
		catch (error) {
			if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { status: 'unavailable', code: 'database_missing' };
			throw error;
		}
		// The native read-only open is essential: a preflight existence check alone
		// would create a database if it disappeared immediately before opening.
		db = new DatabaseSync(filePath, { readOnly: true });
		db.exec('BEGIN');
		const prepare = (sql) => {
			const statement = db.prepare(sql);
			statement.setReadBigInts(true);
			return statement;
		};
		const highWater = position?.highWater ?? prepare('SELECT max(rowid) AS high_water FROM repair_event_inbox').get().high_water;
		const result = {
			status: 'available', provenance: 'raw_producer_claims', items: [],
			nextCursor: null, snapshotHighWater: highWater === null ? null : String(highWater),
		};
		// Prepare even for an empty snapshot to detect missing/incompatible schema.
		const statement = prepare(`SELECT rowid AS review_rowid, ${projection}
			FROM repair_event_inbox WHERE rowid <= ? ${position ? 'AND rowid > ?' : ''}
			ORDER BY rowid ASC LIMIT ?`);
		if (highWater === null) return result;
		const parameters = position ? [highWater, position.after, limit + 1] : [highWater, limit + 1];
		let last = null;
		for (const row of statement.iterate(...parameters)) {
			if (result.items.length === limit) {
				result.nextCursor = encodeCursor(source, last, highWater);
				break;
			}
			let item = mapRow(row);
			const next = encodeCursor(source, row.review_rowid, highWater);
			const sizeWith = () => Buffer.byteLength(JSON.stringify({ ...result, items: [...result.items, item], nextCursor: next }));
			if (sizeWith() > REPAIR_EVENT_REVIEW_LIMITS.maxResponseBytes) {
				if (result.items.length > 0) {
					result.nextCursor = encodeCursor(source, last, highWater);
					break;
				}
				// JSON escaping can expand otherwise bounded input beyond a page.
				item = { rowid: String(row.review_rowid), status: 'oversize', reason: 'serialized_row_limit' };
			}
			result.items.push(item);
			last = row.review_rowid;
		}
		return result;
	} catch (error) {
		if (error.errcode === 14) return { status: 'unavailable', code: 'database_unavailable' };
		return { status: 'error', code: 'database_read_error' };
	} finally {
		// Closing rolls back the read transaction and releases its snapshot.
		db?.close();
	}
}
