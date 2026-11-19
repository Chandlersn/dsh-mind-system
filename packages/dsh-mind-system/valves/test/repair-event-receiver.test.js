/**
 * Tests for the passive `repair_finished` receiver.
 *
 * Every test uses a throwaway temp directory: nothing here may touch a real
 * <dshHome> storage directory. The assertions are deliberately about the two
 * things this component could get wrong in a way nobody notices:
 *
 * 1. claiming durability before the commit, and
 * 2. letting a replay rewrite an existing row (or letting a conflict pass as a
 *    duplicate), which would silently change the history a human later reads.
 *
 * The "passive" claim is checked by counting the files in the temp directory:
 * besides its own SQLite database (and WAL sidecars) the receiver must write
 * nothing at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createRepairEventReceiver,
	REPAIR_EVENT_KIND,
	REPAIR_FINISHED_STATUSES,
} from '../src/repair-event-receiver.js';

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-valves-repair-inbox-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A valid delivery; override any field. */
function delivery(overrides = {}) {
	return {
		producerId: 'dsh-execution-runtime',
		eventId: 'evt-1',
		kind: REPAIR_EVENT_KIND,
		payload: { status: 'settled', taskId: 'task-1', repairId: 'repair-1' },
		...overrides,
	};
}

function invalidCodeFor(receiver, event) {
	try {
		receiver.receive(event);
		return null;
	} catch (err) {
		return err.code;
	}
}

test('sparse arrays are stored as valid JSON and replay consistently', () => {
	const { dir, cleanup } = tempDir();
	const receiver = createRepairEventReceiver({ filePath: join(dir, 'repair-events.sqlite') });
	try {
		const event = delivery({ payload: { status: 'settled', values: Array(2) } });
		assert.equal(receiver.receive(event).accepted, true);
		assert.deepEqual(receiver.list()[0].payload.values, [null, null]);
		assert.equal(receiver.receive(event).duplicate, true);
	} finally { receiver.close(); cleanup(); }
});

test('first delivery is accepted, counted once, and nothing else is written', () => {
	const { dir, cleanup } = tempDir();
	const receiver = createRepairEventReceiver({ filePath: join(dir, 'repair-events.sqlite') });
	try {
		assert.equal(receiver.count(), 0);

		const result = receiver.receive(delivery());
		assert.deepEqual(result, { accepted: true, duplicate: false });
		assert.equal(receiver.count(), 1);

		const rows = receiver.list();
		assert.equal(rows.length, 1);
		assert.equal(rows[0].producerId, 'dsh-execution-runtime');
		assert.equal(rows[0].eventId, 'evt-1');
		assert.equal(rows[0].kind, REPAIR_EVENT_KIND);
		assert.deepEqual(rows[0].payload, {
			status: 'settled',
			taskId: 'task-1',
			repairId: 'repair-1',
		});
		assert.match(rows[0].receivedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

		// Passive by construction: only the database and its WAL sidecars exist.
		const written = readdirSync(dir);
		assert.ok(written.length > 0);
		assert.deepEqual(
			written.filter((name) => !name.startsWith('repair-events.sqlite')),
			[],
			'the receiver must not create rule, ledger or snapshot files',
		);
	} finally {
		receiver.close();
		cleanup();
	}
});

test('identical replay is a duplicate: no new row and no change to the stored row', () => {
	const { dir, cleanup } = tempDir();
	const receiver = createRepairEventReceiver({ filePath: join(dir, 'repair-events.sqlite') });
	try {
		assert.deepEqual(receiver.receive(delivery()), { accepted: true, duplicate: false });
		const before = receiver.list()[0];

		assert.deepEqual(receiver.receive(delivery()), {
			accepted: false,
			duplicate: true,
			code: 'duplicate',
		});
		assert.equal(receiver.count(), 1, 'a replay must not add a second row');
		assert.deepEqual(receiver.list()[0], before, 'a replay must not touch the stored row');

		// Equality is by canonical bytes, not by key insertion order.
		const reordered = delivery({
			payload: { repairId: 'repair-1', status: 'settled', taskId: 'task-1' },
		});
		assert.deepEqual(receiver.receive(reordered), {
			accepted: false,
			duplicate: true,
			code: 'duplicate',
		});
		assert.equal(receiver.count(), 1);
	} finally {
		receiver.close();
		cleanup();
	}
});

test('same key with different payload is refused and the stored bytes stay untouched', () => {
	const { dir, cleanup } = tempDir();
	const receiver = createRepairEventReceiver({ filePath: join(dir, 'repair-events.sqlite') });
	try {
		receiver.receive(delivery());
		const before = receiver.list()[0];

		assert.throws(
			() => receiver.receive(delivery({ payload: { status: 'blocked', repairId: 'repair-1' } })),
			{ code: 'identity_conflict', conflict: true, duplicate: false },
		);
		assert.equal(receiver.count(), 1);
		assert.deepEqual(receiver.list()[0], before, 'a conflict must not rewrite the stored row');

		// The original delivery is still the one stored, and it is still a duplicate:
		// the refusal did not leave a half-open transaction behind either.
		assert.deepEqual(receiver.list()[0].payload, {
			status: 'settled',
			taskId: 'task-1',
			repairId: 'repair-1',
		});
		assert.deepEqual(receiver.receive(delivery()), {
			accepted: false,
			duplicate: true,
			code: 'duplicate',
		});
	} finally {
		receiver.close();
		cleanup();
	}
});

test('a row of another kind under the same key is a conflict, not a reinterpretation', () => {
	const { dir, cleanup } = tempDir();
	const filePath = join(dir, 'repair-events.sqlite');
	// Simulate a row written by a different version/hand: same key, other kind.
	const foreign = new DatabaseSync(filePath);
	foreign.exec(`
		CREATE TABLE repair_event_inbox (
			producer_id TEXT NOT NULL,
			event_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			received_at TEXT NOT NULL,
			PRIMARY KEY (producer_id, event_id)
		);
	`);
	foreign
		.prepare('INSERT INTO repair_event_inbox (producer_id, event_id, kind, payload_json, received_at) VALUES (?, ?, ?, ?, ?)')
		.run('dsh-execution-runtime', 'evt-foreign', 'repair_noted', '{"status":"settled"}', '2026-01-01T00:00:00.000Z');
	foreign.close();

	const receiver = createRepairEventReceiver({ filePath });
	try {
		assert.throws(
			() => receiver.receive(delivery({ eventId: 'evt-foreign', payload: { status: 'settled' } })),
			{ code: 'identity_conflict' },
		);
		assert.equal(receiver.count(), 1);
		assert.equal(receiver.list()[0].kind, 'repair_noted', 'the foreign row must not be relabelled');
	} finally {
		receiver.close();
		cleanup();
	}
});

test('malformed status, kind, identity and payload are rejected as invalid_repair_event', () => {
	const { dir, cleanup } = tempDir();
	const receiver = createRepairEventReceiver({ filePath: join(dir, 'repair-events.sqlite') });
	try {
		assert.equal(REPAIR_FINISHED_STATUSES.includes('done'), false);

		const cases = [
			['unknown status', delivery({ payload: { status: 'done' } })],
			['missing status', delivery({ payload: { taskId: 'task-1' } })],
			['non-string status', delivery({ payload: { status: 42 } })],
			['wrong kind', delivery({ kind: 'repair_started' })],
			['missing kind', delivery({ kind: undefined })],
			['empty producerId', delivery({ producerId: '   ' })],
			['missing eventId', delivery({ eventId: '' })],
			['non-object payload', delivery({ payload: 'settled' })],
			['array payload', delivery({ payload: [] })],
			['non-string optional id', delivery({ payload: { status: 'settled', attemptId: 42 } })],
			['empty optional id', delivery({ payload: { status: 'settled', repairId: '  ' } })],
			['non-finite number in payload', delivery({ payload: { status: 'settled', score: Number.NaN } })],
			['cyclic payload', (() => {
				const payload = { status: 'observed' };
				payload.self = payload;
				return delivery({ payload });
			})()],
		];

		for (const [label, event] of cases) {
			assert.equal(invalidCodeFor(receiver, event), 'invalid_repair_event', `must reject ${label}`);
		}
		assert.equal(invalidCodeFor(receiver, null), 'invalid_repair_event');

		assert.equal(receiver.count(), 0, 'no malformed delivery may leave a row behind');
		assert.deepEqual(receiver.list(), []);
	} finally {
		receiver.close();
		cleanup();
	}
});

test('accepted deliveries survive close and reopen, and replay is still deduplicated', () => {
	const { dir, cleanup } = tempDir();
	const filePath = join(dir, 'repair-events.sqlite');

	const first = createRepairEventReceiver({ filePath });
	try {
		assert.deepEqual(first.receive(delivery()), { accepted: true, duplicate: false });
		assert.deepEqual(
			first.receive(delivery({
				eventId: 'evt-2',
				payload: {
					status: 'observed',
					taskId: 'task-1',
					attemptId: 'attempt-1',
					repairId: 'repair-2',
					evidenceRef: 'evidence-1',
				},
			})),
			{ accepted: true, duplicate: false },
		);
	} finally {
		first.close();
		first.close(); // closing twice is allowed
	}

	const reopened = createRepairEventReceiver({ filePath });
	try {
		assert.equal(reopened.count(), 2);
		assert.deepEqual(
			reopened.list().map((row) => row.eventId),
			['evt-1', 'evt-2'],
		);
		assert.deepEqual(reopened.list()[1].payload, {
			status: 'observed',
			taskId: 'task-1',
			attemptId: 'attempt-1',
			repairId: 'repair-2',
			evidenceRef: 'evidence-1',
		});
		assert.deepEqual(reopened.receive(delivery()), {
			accepted: false,
			duplicate: true,
			code: 'duplicate',
		});
		assert.equal(reopened.count(), 2, 'replay after reopen must not duplicate the row');
		assert.equal(reopened.closed, false);
	} finally {
		reopened.close();
		cleanup();
	}
});

test('the same eventId from distinct producers is stored separately', () => {
	const { dir, cleanup } = tempDir();
	const receiver = createRepairEventReceiver({ filePath: join(dir, 'repair-events.sqlite') });
	try {
		assert.deepEqual(receiver.receive(delivery({ producerId: 'producer-a' })), {
			accepted: true,
			duplicate: false,
		});
		assert.deepEqual(receiver.receive(delivery({ producerId: 'producer-b' })), {
			accepted: true,
			duplicate: false,
		});
		assert.equal(receiver.count(), 2);
		assert.deepEqual(
			receiver.list().map((row) => row.producerId),
			['producer-a', 'producer-b'],
		);
		// Each producer's own replay is a duplicate of its own row only.
		assert.equal(receiver.receive(delivery({ producerId: 'producer-b' })).code, 'duplicate');
		assert.equal(receiver.count(), 2);
	} finally {
		receiver.close();
		cleanup();
	}
});

test('a closed receiver refuses further work instead of reopening silently', () => {
	const { dir, cleanup } = tempDir();
	const receiver = createRepairEventReceiver({ filePath: join(dir, 'repair-events.sqlite') });
	try {
		receiver.close();
		assert.throws(() => receiver.receive(delivery()), { code: 'receiver_closed' });
		assert.throws(() => receiver.count(), { code: 'receiver_closed' });
		assert.throws(() => receiver.list(), { code: 'receiver_closed' });
	} finally {
		cleanup();
	}
});