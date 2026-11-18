# Real-model analyzer bridge for the native autoRepair loop

Date: 2026-11-18. Status: bridge implemented; real diagnostic calls did **not** yield a valid RepairAction. Further identical retries were deliberately stopped after repeated failures.

## Files

- `scripts/real-repair-transport.mjs` — exports `createHeadlessAnalysisTransport(options)`, returning `{ invoke, lastEvidence, evidence, evidenceDir, timeoutMs }`.
- `scripts/real-repair-diagnose.mjs` — one-shot diagnostic entry point; passes a real captured exception package to the real native `Analyzer` through the real headless CLI.

No other repo files were changed. No commit was made.

## Interface

`invoke({ instructions, input, signal })` is the exact shape consumed by `packages/dsh-execution-runtime/src/analyzer.js`:

1. Builds one fresh task: `node D:/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js headless --json <task>`.
2. Puts `instructions` and `JSON.stringify(input)` inside `ANALYSIS_INSTRUCTIONS_*` / `UNTRUSTED_DATA_*` markers; the task explicitly says the data is untrusted and forbids tool use and file writes.
3. Asks for exactly one raw JSON RepairAction as the final answer, with no prose or markdown.
4. Reads newline-delimited events. Captures `session`, `status` (including `step_end` `usage`), `text`, `tool_call`, `tool_result`, `error` and the terminal `final.text`.
5. Returns the final text to `Analyzer`. If the final text contains one clean JSON object, the isolated object is returned; otherwise the untouched text is returned so strict validation fails honestly. The transport never constructs a RepairAction.
6. Writes one bounded evidence JSON per call under `docs/real-repair-evidence/<requestId>.json` with duration, CLI path, child pid, request instructions/input/task, status events, `stepEndUsages`, aggregated `tokenTotals` (input/output/total/reasoning), SHA-256 session hash (not the session id), final text, extracted JSON and prose flag. Credentials are not read or written.
7. Honors `signal` and timeout by killing the child; abort/timeout/overflow/exit failures are thrown so `Analyzer` records `analysis_failed` / `analysis_cancelled`, not a fabricated proposal.

Defaults: `timeoutMs = 118_000` (below the Analyzer's 120,000 hard limit), `maxStdoutBytes = 262_144`.

## Wire-up

Use the transport with the native analyzer directly:

```js
import { Analyzer } from './packages/dsh-execution-runtime/src/analyzer.js';
import { createHeadlessAnalysisTransport } from './scripts/real-repair-transport.mjs';
const transport = createHeadlessAnalysisTransport();
const analyzer = new Analyzer({ invoke: transport.invoke, timeoutMs: 120_000, maxResponseBytes: 16_384 });
```

`host-plugin.js`'s `makeAnalyzer()` is HTTP-key based by design. To use this transport inside the native autoRepair path without an HTTP relay, mount `createExecutionRuntimePlugin({ analyzer, ... })` directly (the seam used by `scripts/first-repair-resume.mjs` and the runtime tests). Do not change the product's HTTP/key default: analysis must remain an explicit host decision.

## First real call: result

Command: `node scripts/real-repair-diagnose.mjs` (one diagnostic call, no repair loop entered).

Input: the real captured exception package `docs/first-repair-csv-observed/packet.json` (`taskId=empty-csv-eebd1363-…`, `trigger=verification_failed`, cause `output_invalid_csv`).

Result: `analysis_failed / analysis_transport_error`. The headless child was still in `step_start` after 100,000 ms; the transport killed it. No `step_end`, no token usage, no final text, no RepairAction. Evidence: `docs/real-repair-evidence/mwm0gbuc-1-uvsjje.json`; session hash `17fa2b222253483b75664cc0aa79698567793d8fbed707d19aa24c689788a6c1`; child killed `true`.

Machine-readable result: `docs/real-repair-evidence/diagnostic-result.json`.

The timeout used in that first call was 100,000 ms; the transport default has since been raised to 118,000 ms.

## Subsequent calls and the decision to stop retrying

Two more attempts were made to separate a prompt/timeout problem from a provider problem:

| Attempt | Budget | Observed | Result |
| :--- | :--- | :--- | :--- |
| Minimal control probe (`Reply with exactly {"ok":true}`) | 10 min | stuck at `step_start`, no `step_end`/token/final | killed; provider-side stall |
| Real diagnostic retry | 45 s (`DSH_REPAIR_TIMEOUT_MS`) | stuck at `step_start`, no `step_end`/token/final | `analysis_failed / analysis_transport_error`; evidence `mwm0pyij-1-d4l0h7.json`, session hash `605f1526…522b` |

The minimal control probe rules out our task text and the Analyzer schema as the cause: the same stall occurs for a one-line request with no tools. Three same-mode failures with unchanged inputs establish a unidirectional external dependency stall — repeating the same call cannot produce a different result. **Retries were stopped**, not because the bridge is wrong, but because the upstream model service did not return. No RepairAction was fabricated and the repair loop was never entered from a failed diagnosis.

A process-cleanup sub-loop also failed repeatedly and was traced to a self-inflicted cause: a cleanup command matched process command lines containing `subprocess-local.*runner`, which also matched the very runner executing the probe, so the probe killed itself (`subprocess-local job runner exited … 4294967295`, PIDs changing each attempt). The fix was to stop matching command lines and kill the exact lingering PID instead. This is recorded here so the same self-matching probe is not reused.

## What is and is not proven

Proven: the bridge really spawns the installed headless CLI, treats the packet as untrusted data, streams real run events, kills the child on timeout, persists bounded evidence with a session hash, and hands only model output to the native strict Analyzer.

Not proven: that this real model can produce a schema-valid RepairAction for this packet. The first call timed out before answer. No repair was fabricated and no file under `docs/first-repair-csv-observed/workspace` was modified by this work.

## Next step for the lead

Do not re-run the same headless transport against the currently stalled provider; identical input has repeatedly produced the same stall. Re-check provider health with the minimal control probe first. Only when that probe completes with a `final` and positive output tokens should the real diagnostic be retried, then — and only on `status === 'proposed'` — should the native repair loop be entered with `scheduler.repair` and the original verifier unchanged. Product-side wiring is independently covered by the stub-model tests in `native-repair-entry.test.js` and does not depend on provider recovery.
