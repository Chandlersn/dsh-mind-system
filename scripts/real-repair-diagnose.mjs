// One diagnostic call through a real headless model into the native strict Analyzer.
// The exception package is read from disk as quoted, untrusted input; nothing is invented here.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Analyzer } from '../packages/dsh-execution-runtime/src/analyzer.js';
import { createHeadlessAnalysisTransport } from './real-repair-transport.mjs';

const packetPath = process.argv[2] ?? 'docs/first-repair-csv-observed/packet.json';
const realPacket = JSON.parse(readFileSync(resolve(packetPath), 'utf8'));
assert.equal(realPacket.schemaVersion ?? realPacket.input?.schemaVersion, 1, 'packet must be schemaVersion 1');
const instructions = realPacket.instructions;
const input = realPacket.input ?? realPacket;
const outDir = resolve('docs/real-repair-evidence');
// Allow a shorter retry budget via env so a degraded provider is detected quickly, not after 118s.
const timeoutMs = Number(process.env.DSH_REPAIR_TIMEOUT_MS ?? 118_000);
const transport = createHeadlessAnalysisTransport({ evidenceDir: outDir, timeoutMs });
const analyzer = new Analyzer({ invoke: transport.invoke, timeoutMs: Math.max(timeoutMs + 2000, 120_000), maxResponseBytes: 16_384 });

console.log(JSON.stringify({ phase: 'diagnostic', packetPath, analysisIdInput: input.analysisId ?? null }));
const result = await analyzer.analyze(input, { signal: new AbortController().signal });
const summary = {
  phase: 'diagnostic-result',
  status: result.status,
  error: result.error ?? null,
  repair: result.repair ?? null,
  evidencePath: transport.lastEvidence?.evidencePath ?? null,
  sessionHash: transport.lastEvidence?.response?.sessionHash ?? null,
  tokenTotals: transport.lastEvidence?.response?.tokenTotals ?? null,
  rawFinal: transport.lastEvidence?.response?.finalText ?? null,
  proseDetected: transport.lastEvidence?.response?.proseDetected ?? null,
};
// A retry overwrites the previous result; each attempt still has its own immutable evidence file.
writeFileSync(resolve(outDir, 'diagnostic-result.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (result.status !== 'proposed') {
  console.error(`No valid RepairAction from the real model (${result.status}). Stopping; no repair fabricated.`);
  process.exitCode = 2;
}
