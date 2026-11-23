import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepairEventPage, REPAIR_EVENT_REVIEW_LIMITS as limits } from '../src/repair-event-review.js';
import { createRepairEventReceiver } from '../src/repair-event-receiver.js';

function fixture(t, create = true) {
	const dir = fs.mkdtempSync(join(tmpdir(), 'repair-event-review-'));
	const filePath = join(dir, 'inbox.sqlite');
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	if (create) {
		const db = new DatabaseSync(filePath);
		db.exec(`CREATE TABLE repair_event_inbox (
			producer_id TEXT NOT NULL, event_id TEXT NOT NULL, kind TEXT NOT NULL,
			payload_json TEXT NOT NULL, received_at TEXT NOT NULL,
			PRIMARY KEY (producer_id, event_id))`);
		db.close();
	}
	return { dir, filePath };
}

function insert(filePath, id, { timestamp = '2026-01-01', payload = '{"status":"settled"}', producer = 'producer', kind = 'repair_finished', rowid } = {}) {
	const db = new DatabaseSync(filePath);
	try {
		db.prepare('INSERT INTO repair_event_inbox (rowid, producer_id, event_id, kind, payload_json, received_at) VALUES (?, ?, ?, ?, ?, ?)')
			.run(rowid ?? null, producer, id, kind, payload, timestamp);
	} finally { db.close(); }
}

function assertBounded(page) {
	assert.ok(Buffer.byteLength(JSON.stringify(page)) <= limits.maxResponseBytes);
	assert.ok(page.items.length <= limits.maxRows);
}

function drain(filePath, limit = 20) {
	const rows = [];
	let cursor;
	do {
		const page = readRepairEventPage({ filePath, limit, ...(cursor ? { cursor } : {}) });
		assert.equal(page.status, 'available');
		assertBounded(page);
		rows.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor);
	return rows;
}

test('missing database and missing parent are unavailable without creating files', (t) => {
	const { filePath, dir } = fixture(t, false);
	assert.deepEqual(readRepairEventPage({ filePath }), { status: 'unavailable', code: 'database_missing' });
	assert.deepEqual(readRepairEventPage({ filePath: join(dir, 'missing', 'inbox.sqlite') }), { status: 'unavailable', code: 'database_missing' });
	assert.deepEqual(fs.readdirSync(dir), []);
});

test('existing empty table is available and does not change bytes or create sidecars', (t) => {
	const { filePath, dir } = fixture(t);
	const before = fs.readFileSync(filePath);
	assert.deepEqual(readRepairEventPage({ filePath }), {
		status: 'available', provenance: 'raw_producer_claims', items: [], nextCursor: null, snapshotHighWater: null,
	});
	assert.deepEqual(fs.readFileSync(filePath), before);
	assert.deepEqual(fs.readdirSync(dir), ['inbox.sqlite']);
});

test('rowid pages survive reopen, timestamp ties/backtracking and concurrent later inserts', (t) => {
	const { filePath } = fixture(t);
	insert(filePath, 'one', { timestamp: '2030-01-01' });
	insert(filePath, 'two', { timestamp: '2030-01-01' });
	insert(filePath, 'three', { timestamp: '1999-01-01' });
	const first = readRepairEventPage({ filePath, limit: 1 });
	assert.equal(first.items[0].eventId, 'one');
	assert.equal(first.snapshotHighWater, '3');
	insert(filePath, 'four', { timestamp: '1900-01-01' });
	const second = readRepairEventPage({ filePath, limit: 1, cursor: first.nextCursor });
	const third = readRepairEventPage({ filePath, limit: 1, cursor: second.nextCursor });
	assert.equal(second.items[0].eventId, 'two');
	assert.equal(third.items[0].eventId, 'three');
	assert.equal(third.nextCursor, null);
	assert.equal(third.snapshotHighWater, '3');
	assert.deepEqual(readRepairEventPage({ filePath, limit: 1, cursor: first.nextCursor }), second);
	assert.deepEqual(drain(filePath).map((item) => item.eventId), ['one', 'two', 'three', 'four']);
});

test('signed 64-bit rowids retain precision, including negative insertion ids', (t) => {
	const { filePath } = fixture(t);
	const ids = [-(1n << 63n), 0n, 9007199254740993n, (1n << 63n) - 1n];
	ids.forEach((id) => insert(filePath, String(id), { rowid: id }));
	assert.deepEqual(drain(filePath, 1).map((item) => item.rowid), ids.map(String));
});

test('limit and cursor validation rejects malformed, noncanonical and cross-path inputs', (t) => {
	const { filePath } = fixture(t);
	for (const limit of [0, -1, 101, 1.1, NaN, Infinity, '2', null]) {
		assert.throws(() => readRepairEventPage({ filePath, limit }), { code: 'invalid_review_options' });
	}
	for (const cursor of ['', null, 4, '!', 'a'.repeat(257), Buffer.from('{}').toString('base64url')]) {
		assert.throws(() => readRepairEventPage({ filePath, cursor }), { code: 'invalid_review_options' });
	}
	for (const path of ['', ':memory:', 'file:inbox.sqlite', 'bad\0path']) {
		assert.throws(() => readRepairEventPage({ filePath: path }), { code: 'invalid_review_options' });
	}
	insert(filePath, 'a'); insert(filePath, 'b');
	const cursor = readRepairEventPage({ filePath, limit: 1 }).nextCursor;
	const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
	const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
	for (const changed of [
		{ ...decoded, v: 2 }, { ...decoded, after: '01' }, { ...decoded, after: '-0' },
		{ ...decoded, after: '3' }, { ...decoded, highWater: '9223372036854775808' },
		{ ...decoded, highWater: '-9223372036854775809' }, { ...decoded, extra: true },
		{ ...decoded, after: 1 },
	]) assert.throws(() => readRepairEventPage({ filePath, cursor: encode(changed) }), { code: 'invalid_review_options' });
	assert.throws(() => readRepairEventPage({ filePath, cursor: cursor + '=' }), { code: 'invalid_review_options' });
	assert.throws(() => readRepairEventPage({ filePath: join(filePath, 'other'), cursor }), { code: 'invalid_review_options' });
});

test('oversized payload, identifiers and metadata remain visible and permit continuation', (t) => {
	const { filePath } = fixture(t);
	const huge = '界'.repeat(400_000);
	insert(filePath, huge, { producer: huge, payload: JSON.stringify({ text: huge }), kind: huge, timestamp: huge });
	insert(filePath, 'next');
	const page = readRepairEventPage({ filePath, limit: 1 });
	const item = page.items[0];
	assert.equal(item.rowid, '1');
	for (const key of ['payload', 'producerId', 'eventId', 'kind', 'receivedAt']) {
		assert.equal(item[key].status, 'oversize');
		assert.ok(BigInt(item[key].bytes) >= 1_200_000n);
	}
	assertBounded(page);
	assert.equal(readRepairEventPage({ filePath, cursor: page.nextCursor }).items[0].eventId, 'next');
});

test('invalid JSON is exposed as raw text; oversized serialization has a row marker', (t) => {
	const { filePath } = fixture(t);
	insert(filePath, 'invalid', { payload: '{bad json' });
	insert(filePath, 'escape-expanded', { payload: '\0'.repeat(16_000) });
	insert(filePath, 'next');
	const rows = drain(filePath, 1);
	assert.deepEqual(rows[0].payload, { status: 'invalid_json', raw: '{bad json' });
	assert.deepEqual(rows[1], { rowid: '2', status: 'oversize', reason: 'serialized_row_limit' });
	assert.equal(rows[2].eventId, 'next');
});

test('response byte cap shortens pages without skipping rows; default and max row limits apply', (t) => {
	const { filePath } = fixture(t);
	for (let i = 0; i < 105; i++) insert(filePath, String(i));
	assert.equal(readRepairEventPage({ filePath }).items.length, 20);
	assert.equal(readRepairEventPage({ filePath, limit: 100 }).items.length, 100);
	for (let i = 105; i < 115; i++) insert(filePath, String(i), { payload: JSON.stringify({ text: 'x'.repeat(15_000) }) });
	const rows = drain(filePath, 100);
	assert.equal(rows.length, 115);
	assert.equal(new Set(rows.map((row) => row.rowid)).size, 115);
});

test('corrupt databases, absent schema and incompatible schema report errors without repair', (t) => {
	const { filePath } = fixture(t, false);
	fs.writeFileSync(filePath, 'not a sqlite database');
	const corruptBytes = fs.readFileSync(filePath);
	assert.deepEqual(readRepairEventPage({ filePath }), { status: 'error', code: 'database_read_error' });
	assert.deepEqual(fs.readFileSync(filePath), corruptBytes);
	fs.unlinkSync(filePath);
	const db = new DatabaseSync(filePath);
	db.exec('CREATE TABLE other (value TEXT)');
	db.close();
	const bytes = fs.readFileSync(filePath);
	assert.deepEqual(readRepairEventPage({ filePath }), { status: 'error', code: 'database_read_error' });
	assert.deepEqual(fs.readFileSync(filePath), bytes);
	const incompatible = new DatabaseSync(filePath);
	incompatible.exec('CREATE TABLE repair_event_inbox (wrong TEXT)');
	incompatible.close();
	assert.equal(readRepairEventPage({ filePath }).status, 'error');
});

test('reading all pages leaves row count, database bytes and directory entries unchanged', (t) => {
	const { filePath, dir } = fixture(t);
	insert(filePath, 'one'); insert(filePath, 'two');
	const before = fs.readFileSync(filePath);
	const names = fs.readdirSync(dir);
	assert.equal(drain(filePath, 1).length, 2);
	assert.deepEqual(fs.readFileSync(filePath), before);
	assert.deepEqual(fs.readdirSync(dir), names);
	const db = new DatabaseSync(filePath, { readOnly: true });
	try { assert.equal(db.prepare('SELECT count(*) AS n FROM repair_event_inbox').get().n, 2); }
	finally { db.close(); }
});

test('live receiver WAL events are readable without changing durable bytes or accepting claims', (t) => {
	const { filePath, dir } = fixture(t, false);
	const receiver = createRepairEventReceiver({ filePath });
	try {
		receiver.receive({ producerId: 'runtime', eventId: 'one', kind: 'repair_finished', payload: { status: 'settled', succeeded: true } });
		const before = fs.readFileSync(filePath);
		const wal = fs.readFileSync(filePath + '-wal');
		const names = fs.readdirSync(dir);
		const page = readRepairEventPage({ filePath });
		assert.equal(page.provenance, 'raw_producer_claims');
		assert.deepEqual(page.items[0].payload, { status: 'raw', value: { status: 'settled', succeeded: true } });
		assert.equal(receiver.count(), 1);
		assert.deepEqual(fs.readFileSync(filePath), before);
		assert.deepEqual(fs.readFileSync(filePath + '-wal'), wal);
		assert.deepEqual(fs.readdirSync(dir), names);
	} finally { receiver.close(); }
});

test('native read-only open cannot create a database removed after preflight stat', (t) => {
	const { filePath, dir } = fixture(t);
	const originalStat = fs.statSync;
	const mocked = mock.method(fs, 'statSync', (path, ...args) => {
		const result = originalStat(path, ...args);
		if (path === filePath) fs.unlinkSync(filePath);
		return result;
	});
	syncBuiltinESMExports();
	try {
		assert.deepEqual(readRepairEventPage({ filePath }), { status: 'unavailable', code: 'database_unavailable' });
		assert.deepEqual(fs.readdirSync(dir), []);
	} finally {
		mocked.mock.restore();
		syncBuiltinESMExports();
	}
});
