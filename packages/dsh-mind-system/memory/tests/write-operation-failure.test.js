import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { withOperationContext, currentOperationId } from '../src/operation-context.js';
import { writeText } from '../src/util.js';
import { LEDGER_REL } from '../src/write-ledger.js';
async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'write-operation-failure-'));
 t.after(async () => {
  assert.equal(dirname(root),resolve(tmpdir()));
  assert.match(basename(root),/^write-operation-failure-/);
  await rm(root,{recursive:true,force:true});
 });
 await writeFile(join(root,LEDGER_REL),'');
 return root;
}
for (const phase of ['before','after']) test(`ledger ${phase}-append failure preserves physical facts without claiming operation success`, async t => {
 const root=await fixture(t), ledger=join(root,LEDGER_REL), file=join(root,'dao','_candidates','candidate.md');
 const text='Candidate bytes independently observed on disk';
 const original=fs.promises.appendFile;
 let attempted=0, requestId;
 fs.promises.appendFile=async (target,...args) => {
  if (target !== ledger) return original(target,...args);
  attempted++;
  assert.equal(await readFile(file,'utf8'),text);
  if (phase === 'after') await original(target,...args);
  throw Object.assign(new Error('injected append acknowledgement failure'),{code:'EIO'});
 };
 syncBuiltinESMExports();
 try {
  await assert.rejects(withOperationContext(async () => {
   requestId=currentOperationId();
   await writeText(file,text,{memoryRoot:root});
  }), error => error.code === 'MEMORY_LEDGER_APPEND_FAILED' && error.fileWritten === true && error.ledgerRecorded === null);
 } finally {fs.promises.appendFile=original;syncBuiltinESMExports();}
 assert.equal(attempted,1);
 assert.equal(currentOperationId(),undefined);
 const bytes=await readFile(file);
 assert.equal(bytes.toString(),text);
 const rows=(await readFile(ledger,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
 assert.equal(rows.length,phase === 'after' ? 1 : 0);
 if (rows.length) {
  assert.equal(rows[0].request_id,requestId);
  assert.equal(rows[0].key,'dao/_candidates/candidate.md');
  assert.equal(rows[0].hash,createHash('sha256').update(bytes).digest('hex').slice(0,16));
 }
});
test('lost rename acknowledgement leaves changed bytes without inventing a correlated ledger row', async t => {
 const root=await fixture(t), file=join(root,'functions','committed.md');
 const original=fs.promises.rename;
 let attempted=0;
 fs.promises.rename=async (source,target) => {
  await original(source,target);
  if (target === file) {attempted++;throw Object.assign(new Error('injected rename acknowledgement loss'),{code:'EIO'});}
 };
 syncBuiltinESMExports();
 try {
  await assert.rejects(withOperationContext(() => writeText(file,'Changed despite acknowledgement loss',{memoryRoot:root})),
   error => error.fileWritten === null);
 } finally {fs.promises.rename=original;syncBuiltinESMExports();}
 assert.equal(attempted,1);
 assert.equal(await readFile(file,'utf8'),'Changed despite acknowledgement loss');
 assert.equal(await readFile(join(root,LEDGER_REL),'utf8'),'');
 assert.equal(currentOperationId(),undefined);
});
