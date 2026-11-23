import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRepairEventReceiver } from '../src/repair-event-receiver.js';
import { createRepairIdentityResolver } from '../src/repair-identity-resolver.js';
const runtime = fs.existsSync(new URL('../../dsh-execution-runtime/src/store.js',import.meta.url))
 ? new URL('../../dsh-execution-runtime/src/',import.meta.url) : new URL('../../runtime/src/',import.meta.url);
const {RuntimeStore} = await import(new URL('store.js',runtime));
const {readRepairEvidence} = await import(new URL('repair-evidence-reader.js',runtime));

function fixture(t) {
 const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'identity-resolver-')));
 const runtimeFilePath = join(root,'runtime.sqlite');
 const inboxFilePath = join(root,'inbox.sqlite');
 const store = new RuntimeStore(runtimeFilePath,{now:()=>1000});
 const receiver = createRepairEventReceiver({filePath:inboxFilePath});
 t.after(()=>{receiver.close();store.close();assert.equal(dirname(root),fs.realpathSync(tmpdir()));assert.match(root,/identity-resolver-/);fs.rmSync(root,{recursive:true,force:true});});
 store.createRun({taskId:'task',recipeId:'fixture',recipeVersion:'v1',goal:'Not yet satisfied',scopeRef:'fixture',workspaceRoot:root,inputs:{},deadlineAt:5000,origin:'verification',principleRefs:[]});
 const options=()=>({expectedVersion:store.getRun('task').version});
 store.stopRun('task','waiting_analysis','exception',options());
 const {analysisId}=store.reserveAnalysis('task',options());
 const candidate={candidateId:'retry',toolName:'fixture',arguments:{},preconditionIds:['ready'],postconditionIds:['done'],progressKey:'cursor',effect:'read',source:{recipeId:'fixture',version:'v1'}};
 store.recordAnalysis('task',analysisId,{status:'proposed',repair:{kind:'retry_with',diagnosis:{location:'fixture',cause:'wrong_guess',evidenceRefs:[]},requiresHumanReview:false,candidate}},options());
 const {repairId}=store.startRepair('task',analysisId,{...options(),signature:'fixture'});
 const {attemptId}=store.reserveAttempt('task',candidate,options());
 store.markStarted('task',attemptId,options());
 store.recordOutcome('task',attemptId,{status:'succeeded'},{status:'pass',progress:'advanced',goalSatisfied:false,verifierId:'check',verifierVersion:'v1',evidenceRefs:['fixture:unreviewed']},options());
 store.finishRepair('task',repairId,{...options(),status:'settled',attemptId});
 const event=store.listPendingOutbox()[0];
 const producerId=store.getProducerId();
 receiver.receive({producerId,eventId:event.eventId,kind:'repair_finished',payload:event.payload});
 const sources={[producerId]:{runtimeFilePath}};
 const resolver=createRepairIdentityResolver({inboxFilePath,sources,readRuntimeEvidence:readRepairEvidence});
 return {root,runtimeFilePath,inboxFilePath,store,receiver,event,producerId,sources,resolver};
}

test('actual persisted repair matches canonical receipt after ACK without becoming goal proof',t=>{
 const f=fixture(t);
 f.store.acknowledgeOutbox(f.event.eventId,{expectedAttempts:0});
 const files=fs.readdirSync(f.root).filter(name=>!name.endsWith('-shm'));
 const before=files.map(name=>fs.readFileSync(join(f.root,name)));
 const result=f.resolver.resolve({producerId:f.producerId,eventId:f.event.eventId});
 assert.equal(result.status,'match',JSON.stringify(result));
 assert.equal(result.payload.evidence.status,'verified_success');
 assert.equal(result.payload.evidence.goalSatisfied,false);
 assert.equal(result.payload.evidence.provenance.origin,'verification');
 assert.equal(result.goalProof,'not_evaluated');
 assert.equal(result.principleAttribution,'not_evaluated');
 assert.equal(result.governanceEligible,false);
 assert.equal(result.artifacts,'not_evaluated');
 assert.deepEqual(f.store.listPendingOutbox(),[]);
 assert.equal(f.receiver.count(),1);
 assert.deepEqual(files.map(name=>fs.readFileSync(join(f.root,name))),before);
});

test('receipt tampering conflicts and event-supplied paths cannot change frozen bindings',t=>{
 const f=fixture(t);
 f.sources[f.producerId].runtimeFilePath=join(f.root,'forged.sqlite');
 assert.equal(f.resolver.resolve({producerId:f.producerId,eventId:f.event.eventId,runtimeFilePath:'forged'}).status,'match');
 assert.equal(f.resolver.resolve({producerId:'unknown',eventId:f.event.eventId}).code,'producer_unbound');
 assert.equal(f.resolver.resolve({producerId:f.producerId,eventId:'absent'}).status,'incomplete');
 const db=new DatabaseSync(f.inboxFilePath);
 try {db.prepare('UPDATE repair_event_inbox SET payload_json=?').run(JSON.stringify({...f.event.payload,taskId:'different-task'}));} finally {db.close();}
 const result=f.resolver.resolve({producerId:f.producerId,eventId:f.event.eventId});
 assert.equal(result.status,'mismatch');
 assert.equal(result.code,'receipt_payload_conflict');
 assert.equal(result.governanceEligible,false);
 assert.equal(fs.existsSync(join(f.root,'forged.sqlite')),false);
});
