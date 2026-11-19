/**
 * Passive durable receiver for `repair_finished` events published by the
 * execution runtime's SQLite outbox.
 *
 * What this module deliberately is NOT
 * ------------------------------------
 * It never creates, modifies, confirms or rolls back valve rules. It has no
 * import of `store.js`, `guard.js` or `snapshot.js`, keeps no timer, opens no
 * socket, and returns no promise it cannot honour. Its only durable effect is
 * one row in `repair_event_inbox`. Whether a repair outcome should weaken an
 * axiom, sink a rule, or feed a nomination is a HUMAN decision made elsewhere;
 * this file only makes the fact durable so that later code can read it.
 *
 * Delivery semantics (no over-claiming)
 * -------------------------------------
 * The runtime outbox is at-least-once: a crash between INSERT and the
 * producer's acknowledgement replays the event. This receiver therefore
 * guarantees *effect-once inside this database*, identified by the
 * `(producer_id, event_id)` key — not exactly-once delivery and not
 * exactly-once processing. The first commit wins; an identical replay is
 * answered with `{ accepted: false, duplicate: true }` and a replay that
 * disagrees about the content of the same key is refused, leaving the stored
 * row byte-identical.
 *
 * Identity rule
 * -------------
 * `kind` is validated to be exactly `repair_finished`, so a caller cannot
 * legitimately present the same key with another kind. The kind arm of the
 * conflict check is kept anyway and is defensive only: it catches rows
 * written by another version or another hand into the same table, and refuses
 * to reinterpret them (see the `identity_conflict` test that seeds such a row).
 *
 * Payload bytes
 * -------------
 * Payloads are stored as canonical JSON (object keys sorted, no whitespace),
 * which makes "identical" a byte comparison rather than a guess. Members whose
 * value is `undefined` are treated as absent, exactly as JSON serialisation
 * would; values that JSON cannot represent losslessly (functions, symbols,
 * BigInt, non-finite numbers, class instances, cycles) are rejected instead of
 * being silently dropped, because a silently changed payload would turn the
 * next legitimate replay into a phantom identity conflict.
 *
 * @example
 *   const receiver = createRepairEventReceiver({ filePath });
 *   receiver.receive({
 *     producerId: 'dsh-execution-runtime',
 *     eventId: 'evt-abc',
 *     kind: 'repair_finished',
 *     payload: { status: 'settled', taskId: 'task-1', repairId: 'repair-9', succeeded: true },
 *   }); // { accepted: true, duplicate: false }
 */
import { DatabaseSync } from 'node:sqlite';

/** The only event kind this receiver stores. */
export const REPAIR_EVENT_KIND = 'repair_finished';

/** Finished-repair statuses that the runtime actually emits. */
export const REPAIR_FINISHED_STATUSES = Object.freeze([
	'settled',
	'blocked',
	'unknown',
	'observed',
	'restored',
]);

/** Optional payload identifiers; each must be a non-empty string when present. */
const OPTIONAL_ID_FIELDS = Object.freeze(['taskId', 'attemptId', 'repairId']);

const COLUMNS = 'producer_id, event_id, kind, payload_json, received_at';

/**
 * Build a typed error. Codes are the stable part of this API; messages are for
 * humans and may change.
 *
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 * @returns {Error}
 */
function codedError(code, message, extra) {
	const err = new Error(`${code}: ${message}`);
	err.code = code;
	if (extra) Object.assign(err, extra);
	return err;
}

/** Malformed event: always `.code === 'invalid_repair_event'`. */
function invalid(message, field) {
	return codedError('invalid_repair_event', message, field === undefined ? undefined : { field });
}

/** True for `{}` / `Object.create(null)` and false for arrays, Dates, class instances. */
function isPlainObject(value) {
	if (typeof value !== 'object' || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Deterministic JSON with sorted keys so equal payloads produce equal bytes.
 * Rejects anything JSON would have to drop or approximate.
 *
 * @param {unknown} value
 * @param {unknown[]} [stack] ancestors, for cycle detection
 * @param {string} [path] where we are, for the rejection message
 * @returns {string}
 */
function canonicalJson(value, stack = [], path = '$') {
	if (value === null) return 'null';
	switch (typeof value) {
		case 'string':
			return JSON.stringify(value);
		case 'boolean':
			return value ? 'true' : 'false';
		case 'number':
			if (!Number.isFinite(value)) throw invalid(`${path} must be a finite number`);
			return JSON.stringify(value);
		case 'undefined':
			// Reached only for array slots; object members are skipped below.
			throw invalid(`${path} cannot be undefined inside a stored payload`);
		case 'object':
			break;
		default:
			throw invalid(`${path} has a type that JSON cannot store (${typeof value})`);
	}
	if (stack.includes(value)) throw invalid(`${path} is a cycle`);
	if (Array.isArray(value)) {
		stack.push(value);
		const parts = Array.from(value, (item, index) => (item === undefined ? 'null' : canonicalJson(item, stack, `${path}[${index}]`)));
		stack.pop();
		return `[${parts.join(',')}]`;
	}
	if (!isPlainObject(value)) throw invalid(`${path} must be a plain object or array`);
	stack.push(value);
	const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
	const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], stack, `${path}.${key}`)}`);
	stack.pop();
	return `{${parts.join(',')}}`;
}

/**
 * Validate and normalise one delivery. Throws `invalid_repair_event` on
 * anything malformed so that a bad producer fails loudly at the boundary
 * instead of writing a half-understood row.
 *
 * @param {unknown} input
 * @returns {{producerId: string, eventId: string, kind: string, payload: object, payloadJson: string}}
 */
function normalizeEvent(input) {
	if (!isPlainObject(input)) throw invalid('event must be a plain object');
	const { producerId, eventId, kind, payload } = input;
	if (typeof producerId !== 'string' || producerId.trim() === '') {
		throw invalid('producerId must be a non-empty string', 'producerId');
	}
	if (typeof eventId !== 'string' || eventId.trim() === '') {
		throw invalid('eventId must be a non-empty string', 'eventId');
	}
	if (kind !== REPAIR_EVENT_KIND) {
		throw invalid(`kind must be "${REPAIR_EVENT_KIND}"`, 'kind');
	}
	if (!isPlainObject(payload)) throw invalid('payload must be a plain object', 'payload');
	if (!REPAIR_FINISHED_STATUSES.includes(payload.status)) {
		throw invalid(`payload.status must be one of ${REPAIR_FINISHED_STATUSES.join('|')}`, 'payload.status');
	}
	for (const field of OPTIONAL_ID_FIELDS) {
		const value = payload[field];
		// null is treated as absent on purpose: the runtime's attempt_id is
		// nullable, and a host adapter that passes it through as null has not
		// produced a malformed event.
		if (value === undefined || value === null) continue;
		if (typeof value !== 'string' || value.trim() === '') {
			throw invalid(`payload.${field} must be a non-empty string when present`, `payload.${field}`);
		}
	}
	return { producerId, eventId, kind, payload, payloadJson: canonicalJson(payload) };
}

/**
 * Create a receiver bound to one SQLite file.
 *
 * The parent directory must already exist: creating directories is a filesystem
 * side effect this module keeps out of its contract (the host owns storage
 * layout). `filePath` may be `':memory:'` for tests.
 *
 * @param {{filePath: string}} options
 */
export function createRepairEventReceiver({ filePath } = {}) {
	if (typeof filePath !== 'string' || filePath.trim() === '') {
		throw new TypeError('createRepairEventReceiver requires options.filePath as a non-empty string');
	}

	const db = new DatabaseSync(filePath);
	// WAL + FULL: a committed row survives a crash, and a second reader/host
	// process is not blocked by the receiver's writes. WAL is a no-op for
	// ':memory:' databases, which SQLite reports as journal_mode 'memory'.
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = FULL;
		PRAGMA busy_timeout = 1000;
		CREATE TABLE IF NOT EXISTS repair_event_inbox (
			producer_id TEXT NOT NULL,
			event_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			received_at TEXT NOT NULL,
			PRIMARY KEY (producer_id, event_id)
		);
	`);
	const selectExisting = db.prepare(`SELECT ${COLUMNS} FROM repair_event_inbox WHERE producer_id = ? AND event_id = ?`);
	const selectAll = db.prepare(`SELECT ${COLUMNS} FROM repair_event_inbox ORDER BY received_at ASC, rowid ASC`);
	const selectCount = db.prepare('SELECT COUNT(*) AS n FROM repair_event_inbox');
	const insertRow = db.prepare(`INSERT INTO repair_event_inbox (${COLUMNS}) VALUES (?, ?, ?, ?, ?)`);

	let closed = false;

	function assertOpen() {
		if (closed) throw codedError('receiver_closed', 'the repair event receiver has been closed');
	}

	/**
	 * Store one delivery. Synchronous on purpose: the commit is the completion
	 * point, so there is no window where a caller believes the event is durable
	 * while the write is still pending.
	 *
	 * @param {{producerId: string, eventId: string, kind: 'repair_finished', payload: object}} event
	 * @returns {{accepted: boolean, duplicate: boolean, code?: 'duplicate'}}
	 * @throws {Error & {code: 'invalid_repair_event'|'identity_conflict'|'receiver_closed'}}
	 */
	function receive(event) {
		assertOpen();
		const normalized = normalizeEvent(event);
		const receivedAt = new Date().toISOString();

		db.exec('BEGIN IMMEDIATE');
		let settled = false;
		try {
			const existing = selectExisting.get(normalized.producerId, normalized.eventId);
			if (existing) {
				if (existing.kind === normalized.kind && existing.payload_json === normalized.payloadJson) {
					db.exec('COMMIT');
					settled = true;
					return { accepted: false, duplicate: true, code: 'duplicate' };
				}
				// Refuse the replay without touching the stored row. Rolling back is
				// the honest statement: this delivery changed nothing.
				db.exec('ROLLBACK');
				settled = true;
				throw codedError(
					'identity_conflict',
					`${normalized.producerId}/${normalized.eventId} is already stored with different content`,
					{ duplicate: false, conflict: true },
				);
			}
			insertRow.run(normalized.producerId, normalized.eventId, normalized.kind, normalized.payloadJson, receivedAt);
			db.exec('COMMIT');
			settled = true;
			// Only now is the delivery durable; nothing above this line claims success.
			return { accepted: true, duplicate: false };
		} catch (err) {
			if (!settled) {
				try {
					db.exec('ROLLBACK');
				} catch {
					// A failed rollback must not mask the original error; SQLite will
					// discard the transaction when the connection is closed.
				}
			}
			throw err;
		}
	}

	/**
	 * Read stored rows oldest-first (insertion order breaks received_at ties).
	 * Used by tests and by host status output.
	 *
	 * @returns {{producerId: string, eventId: string, kind: string, payload: object, receivedAt: string}[]}
	 */
	function list() {
		assertOpen();
		return selectAll.all().map((row) => {
			let payload;
			try {
				payload = JSON.parse(row.payload_json);
			} catch {
				// Only a hand-edited or foreign-written row can reach this; report it
				// rather than hiding a corrupt inbox behind a shorter list.
				throw codedError('corrupt_repair_event_row', `${row.producer_id}/${row.event_id} holds unparseable payload_json`);
			}
			return {
				producerId: row.producer_id,
				eventId: row.event_id,
				kind: row.kind,
				payload,
				receivedAt: row.received_at,
			};
		});
	}

	/** @returns {number} number of stored deliveries (not accepts: duplicates are not rows). */
	function count() {
		assertOpen();
		return Number(selectCount.get().n);
	}

	/** Close the connection. Idempotent; any later call on this receiver throws. */
	function close() {
		if (closed) return;
		closed = true;
		db.close();
	}

	return {
		filePath,
		receive,
		list,
		count,
		close,
		get closed() {
			return closed;
		},
	};
}