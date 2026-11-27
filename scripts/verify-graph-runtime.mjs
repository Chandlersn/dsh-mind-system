/**
 * CLI wrapper for the shared architecture-edge verdicts.
 *
 * The verdict logic lives in packages/dsh-memory-manager/src/graph-runtime.js so
 * the CLI and the live panel architecture page use ONE implementation. This file
 * only formats output. Usage: node scripts/verify-graph-runtime.mjs [--json]
 */
import { classifyEdges, collectFacts } from '../packages/dsh-memory-manager/src/graph-runtime.js';
export { classifyEdges, collectFacts };
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href
  : false;
if (invokedDirectly) {
  const edges = classifyEdges(collectFacts());
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(edges, null, 2));
  } else {
    console.log('Graph | Check                   | status      | external evidence');
    console.log('------|-------------------------|-------------|------------------');
    for (const e of edges) {
      console.log(`${e.graphEdge.padEnd(5)} | ${e.id.padEnd(24)} | ${e.status.padEnd(11)} | ${e.detail}`);
    }
    const graphSet = new Set(edges.map(e => e.graphEdge));
    const runningGraphs = new Set(edges.filter(e => e.status === 'running').map(e => e.graphEdge));
    const historicalGraphs = new Set(edges.filter(e => e.status === 'observed' && e.evidenceScope === 'historical').map(e => e.graphEdge));
    console.log(`\n${runningGraphs.size}/${graphSet.size} graph edges have a running check; ` +
      `${historicalGraphs.size}/${graphSet.size} have observed historical correlation. ` +
      `Historical correlation does not establish current activity.`);
  }
}
