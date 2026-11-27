import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyEdges } from '../packages/dsh-memory-manager/src/graph-runtime.js';

function graphEdgesFromReadme() {
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const block = md.split('```mermaid')[1].split('```')[0];
  return [...block.matchAll(/^\s*(\w+)\s*(?:-\.|==>|-->|\.->)[^\n]*?(\w+)\s*(?:\[|$)/gm)].map(m => `${m[1]}->${m[2]}`);
}
const get = (facts, id) => {
  const edge = classifyEdges(facts).find(item => item.id === id);
  assert.ok(edge, `unknown edge ${id}`);
  return edge.status;
};
test('checks cover every documented graph edge and no invented edges', () => {
  const graph = new Set(graphEdgesFromReadme());
  const edges = classifyEdges({});
  assert.deepEqual([...new Set(edges.map(e => e.graphEdge))].sort(), [...graph].sort());
});
test('missing sources cannot be classified as empty', () => {
  assert.equal(get({}, 'valves -> decision ledger'), 'unknown');
  assert.equal(get({ analyses: null, proposedAnalyses: null }, 'execution -> analysis (proposal)'), 'unknown');
});
test('uncorrelated counts never imply a running edge', () => {
  const facts = { events: 5, pending: 5, completedRuns: 1, settledAttempts: 1, repairs: 2,
    independentRepairTasks: 2, adoptedInterventions: 5, memoryReadEvents: 3 };
  for (const id of ['clis.run -> outbox', 'execution -> verifier evidence',
    'analysis proposal -> repair execution', 'repair -> cross-task pattern',
    'agent -> CLIS (adopted intervention)', 'agent -> memory (read events)']) {
    assert.equal(get(facts, id), 'unknown', id);
  }
});
test('standalone activity never proves a graph edge', () => {
  const facts = { activeNegativeRules: 1, ledgerRows: 2, patrolReports: 1,
    recallProbeChecked: true, inboxEntries: 3, dispatchSamples: 2, dispatchMatched: 1,
    analyses: 2, proposedAnalyses: 1, dispatchEvents: 1 };
  for (const edge of classifyEdges(facts)) assert.equal(edge.status, 'unknown', edge.id);
});
