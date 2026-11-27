import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { normalizeWriteContext } from '../src/write-context.js';
const base = () => ({schema_version:1,source:'dsh-memory-manager',event:'write_admission',mode:'observational',
 tool:'memory_write',tool_action:'write',target:{kind:'function',key:'functions/example.md'},
 origin_basis:'bridge_default',execution_result:'not_observed',adoption:'not_observed'});
test('admission context copies bounded identity without observing execution or adoption', () => {
 const input=base(), output=normalizeWriteContext(input);
 assert.deepEqual(output,input);
 input.target.key='functions/changed.md';
 assert.equal(output.target.key,'functions/example.md');
 assert.deepEqual(normalizeWriteContext({...base(),target:null}).target,null);
 assert.equal(normalizeWriteContext(undefined),undefined);
});
test('v2 accepts only canonical generated UUID identity while v1 stays uncorrelated', () => {
 const input = {...base(),schema_version:2,request_id:randomUUID()};
 assert.deepEqual(normalizeWriteContext(input),input);
 for (const over of [{schema_version:1},{schema_version:3},{request_id:''},{request_id:'caller-selected'},
 {request_id:'12345678-ABCD-4ABC-8ABC-123456789ABC'},{request_id:input.request_id+'x'},{extra:true}]) {
  assert.equal(normalizeWriteContext({...input,...over}),undefined);
 }
 const {request_id,...missing} = input;
 assert.equal(normalizeWriteContext(missing),undefined);
 assert.equal(Object.hasOwn(normalizeWriteContext(base()),'request_id'),false);
});
test('context refuses fabricated completion, provenance and raw extra fields', () => {
 for (const over of [{execution_result:'success'},{adoption:'observed'},{origin_basis:'authenticated'},
 {raw_content:'secret'},{source:'other'},{tool:'constructor'},{tool_action:'toString'}]) {
  assert.equal(normalizeWriteContext({...base(),...over}),undefined);
 }
});
test('object keys cannot escape namespaces or merge candidate and active objects', () => {
 for (const target of [{kind:'function',key:'functions/../other.md'}, {kind:'function',key:'functions/a\\b.md'},
 {kind:'insight',key:'functions/example.md'},{kind:'function',key:'functions/a\u0000.md'},
 {kind:'function',key:`functions/${'a'.repeat(1024)}.md`}]) assert.equal(normalizeWriteContext({...base(),target}),undefined);
 const dao={...base(),tool:'memory_dao',tool_action:'candidate',target:{kind:'dao_candidate',key:'dao/_candidates/example.md'}};
 assert.deepEqual(normalizeWriteContext(dao),dao);
 assert.equal(normalizeWriteContext({...dao,tool_action:'active'}),undefined);
 for (const zone of ['functions','insights']) {
  const index={...base(),tool:'memory_index',tool_action:'upsert',target:{kind:'index_entry',key:`${zone}/example.md`}};
  assert.deepEqual(normalizeWriteContext(index),index);
 }
});
