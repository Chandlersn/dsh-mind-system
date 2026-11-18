// Provider liveness probe with a strict, bounded pass criterion.
// Exit 0 = provider healthy (final text AND positive output tokens before deadline).
// Exit 2 = provider stalled (no final / no tokens within deadline) -> do NOT retry diagnosis.
// Exit 1 = harness/config error.
// This script is deliberately different from the diagnosis action: it is a one-line control,
// no Analyzer, no exception packet, no repair loop. It only answers "is the provider returning?".
import { spawn } from 'node:child_process';

const CLI = 'D:/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';
// Historical model baseline on this host: p50=23.6s, p95=33.8s, max=34.1s. A budget below
// that range can mistake a merely-slow provider for a stalled one, so the default clears the max.
const BUDGET_MS = Number(process.env.DSH_PROBE_BUDGET_MS ?? 60_000);
const TASK = 'Reply with exactly the JSON object {"ok":true} and nothing else.';

let finalText = null;
let outputTokens = 0;
let stepEnds = 0;
let sawSession = false;

const child = spawn(process.execPath, [CLI, '--profile', 'headless', '--json', TASK], {
  cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
});
let buf = '';
let settled = false;
const timer = setTimeout(() => finish('timeout'), BUDGET_MS);
function finish(kind) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try { child.kill(); } catch { /* already gone */ }
  const healthy = finalText !== null && outputTokens > 0;
  console.log(JSON.stringify({ kind, sawSession, stepEnds, outputTokens,
    finalText: finalText === null ? null : finalText.slice(0, 200), healthy }));
  if (healthy) process.exitCode = 0;
  else if (kind === 'timeout' || kind === 'close') process.exitCode = 2;
  else process.exitCode = 1;
}
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'session') sawSession = true;
    else if (event.type === 'status' && event.phase === 'step_end') {
      stepEnds++;
      outputTokens += Number(event.usage?.outputTokens ?? 0);
    } else if (event.type === 'final' && typeof event.text === 'string' && finalText === null) {
      finalText = event.text.trim();
    }
  }
});
child.on('error', () => finish('error'));
child.on('close', (code) => finish(code === 0 ? 'close' : 'exit_error'));
