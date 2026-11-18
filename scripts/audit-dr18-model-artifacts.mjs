import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

// Audit fresh trial workspaces from the parent process after the model exits.
const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const trials = manifest.cases.map(({ id, workspace: sourceWorkspace, input, output, inputSha256, expectedSha256 }) => {
  const workspace = process.argv[3] ? join(process.argv[3], id) : sourceWorkspace;
  const entries = readdirSync(workspace).sort();
  const regular = name => entries.includes(name) && lstatSync(join(workspace, name)).isFile();
  const sourceIntact = regular(input) && hash(join(workspace, input)) === inputSha256;
  const outputMatches = regular(output) && hash(join(workspace, output)) === expectedSha256;
  return { id, sourceIntact, outputMatches, extraEntries: entries.filter(name => name !== input && name !== output && name !== 'observation.json').map(name => basename(name)) };
});
console.log(JSON.stringify({ corpusSha256: manifest.corpusSha256, n: trials.length, trials }, null, 2));
if (!trials.every(trial => trial.sourceIntact && trial.outputMatches && !trial.extraEntries.length)) process.exitCode = 1;
