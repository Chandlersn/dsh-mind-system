import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { readRepairEventByIdentity as read, REPAIR_EVENT_REVIEW_LIMITS as limits } from '../src/repair-event-review.js';
import { createRepairEventReceiver } from '../src/repair-event-receiver.js';

function fixture(t) {
 const dir = fs.mkdtempSync(join(tmpdir(), 'repair-identity-'));
 t.after(() => { assert.equal(dirname(dir), resolve(tmpdir())); assert.match(dir, /repair-identity-/); fs.rmSync(dir, { recursive:true, force:true }); });
 const filePath = join(dir, 'inbox.sqlite');
 return { dir, filePath, query: { filePath, producerId: 'producer', eventId: 'event' } };
}

test('exact composite identity distinguishes producers and case without changing live WAL', t => {
 const {dir, filePath, query} = fixture(t);
 const receiver = createRepairEventReceiver({filePath});
 try {
  for (const producerId of ['producer','other','Producer']) receiver.receive({producerId,eventId:'event',kind:'repair_finished',payload:{producerId,status:'settled'}});
  const files = fs.readdirSync(dir).filter(name => !name.endsWith('-shm'));
  const before = files.map(name => fs.readFileSync(join(dir,name)));
  const result = read(query);
  assert.equal(result.status,'available');
  assert.equal(result.provenance,'raw_producer_claims');
  assert.equal(result.item.payload.value.producerId,'producer');
  assert.equal(read({...query,producerId:'Producer'}).item.payload.value.producerId,'Producer');
  assert.deepEqual(read({...query,eventId:'Event'}),{status:'missing',code:'event_missing'});
  assert.deepEqual(read({...query,producerId:'absent'}),{status:'missing',code:'event_missing'});
  assert.equal(receiver.count(),3);
  assert.deepEqual(files.map(name => fs.readFileSync(join(dir,name))),before);
 } finally {receiver.close();}
});

test('missing and corrupt databases remain explicit and are never created', t => {
 const {filePath,dir,query} = fixture(t);
 assert.deepEqual(read(query),{status:'unavailable',code:'database_missing'});
 assert.deepEqual(fs.readdirSync(dir),[]);
 fs.writeFileSync(filePath,'invalid sqlite');
 assert.deepEqual(read(query),{status:'error',code:'database_read_error'});
 assert.equal(fs.readFileSync(filePath,'utf8'),'invalid sqlite');
});

test('oversized and malformed payloads cannot become available evidence', t => {
 const {filePath,query} = fixture(t);
 const receiver = createRepairEventReceiver({filePath});
 receiver.receive({producerId:'producer',eventId:'event',kind:'repair_finished',payload:{status:'settled'}});
 receiver.close();
 const db = new DatabaseSync(filePath);
 try {
  const update = db.prepare('UPDATE repair_event_inbox SET payload_json=? WHERE producer_id=? AND event_id=?');
  update.run('x'.repeat(limits.maxPayloadBytes+1),'producer','event');
  assert.equal(read(query).status,'unresolved');
  assert.equal(read(query).item.payload.status,'oversize');
  update.run('{broken','producer','event');
  assert.equal(read(query).code,'record_invalid');
  assert.equal(read(query).item.payload.status,'invalid_json');
 } finally {db.close();}
});

test('ambiguous identities and expanded response bytes are explicit', t => {
 const {filePath,query} = fixture(t);
 const db = new DatabaseSync(filePath);
 try {
  db.exec('CREATE TABLE repair_event_inbox (producer_id TEXT,event_id TEXT,kind TEXT,payload_json TEXT,received_at TEXT)');
  const insert = db.prepare('INSERT INTO repair_event_inbox VALUES (?,?,?,?,?)');
  insert.run('producer','event','repair_finished','{}','now');
  insert.run('producer','event','repair_finished','{}','now');
  assert.deepEqual(read(query),{status:'error',code:'identity_ambiguous'});
  db.exec('DELETE FROM repair_event_inbox');
  insert.run('producer','event','repair_finished','\u0001'.repeat(limits.maxPayloadBytes),'now');
  assert.deepEqual(read(query),{status:'unresolved',code:'serialized_row_limit'});
 } finally {db.close();}
});

test('invalid query identifiers fail before filesystem access',t=>{
 const {query,dir}=fixture(t);
 for(const key of ['producerId','eventId']) for(const value of ['',null,'\0','x'.repeat(1025)]) {
  assert.throws(()=>read({...query,[key]:value}),{code:'invalid_review_options'});
 }
 assert.deepEqual(fs.readdirSync(dir),[]);
});
