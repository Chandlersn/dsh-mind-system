import { DecisionClient } from '../src/decision-client.js';

// Read only the explicitly assigned Jev environment namespace. Never discover keys elsewhere.
const endpoint = process.env.DSH_JEV_ENDPOINT;
const model = process.env.DSH_JEV_MODEL;
const token = process.env.DSH_JEV_API_KEY;
const required = { DSH_JEV_ENDPOINT: endpoint, DSH_JEV_MODEL: model, DSH_JEV_API_KEY: token };
const missing = Object.entries(required).filter(([, value]) => !value?.trim()).map(([name]) => name);

if (missing.length) {
  console.log(JSON.stringify({
    status: 'external_dependency_not_verified',
    reason: 'Explicit Jev endpoint, model and matching Jev credential environment are required.',
    missingEnvironment: missing,
    liveRequests: 0,
    fixtureTestsProveApi: false,
  }, null, 2));
} else {
  const samples = Number(process.env.DSH_JEV_PROBE_SAMPLES ?? 3);
  const timeoutMs = Number(process.env.DSH_JEV_TIMEOUT_MS ?? 10000);
  const latencies = [];
  let attempted = 0;
  try {
    if (!Number.isInteger(samples) || samples < 1 || samples > 100) throw new Error('Invalid sample count');
    const client = new DecisionClient({ provider: 'jev', endpoint, model, auth: { type: 'bearer', token }, timeoutMs });
    const candidates = [
      { candidateId: 'read_input', toolName: 'read_file', arguments: { path: 'input.json' }, effect: 'read', source: { recipeId: 'jev-protocol-probe', version: '1' } },
      { candidateId: 'read_unrelated', toolName: 'read_file', arguments: { path: 'unrelated.json' }, effect: 'read', source: { recipeId: 'jev-protocol-probe', version: '1' } },
    ];
    for (let index = 0; index < samples; index++) {
      attempted++;
      const result = await client.query({
        state: { goal: 'Read input.json before validating its JSON shape.', admission: 'Both candidates are read-only fixture descriptions; no tool will execute.' },
        candidates,
      });
      latencies.push(result.elapsedMs);
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    const percentile = (fraction) => sorted[Math.ceil(fraction * sorted.length) - 1];
    console.log(JSON.stringify({
      status: 'live_batch_protocol_verified', protocolVersion: 'systemone-noul-v1',
      attemptedRequests: attempted, successfulRequests: latencies.length,
      latencyMs: { samples: latencies, p50: percentile(0.5), p95: percentile(0.95) },
      confidence: null, confidenceSource: 'unavailable',
      scope: 'Only successful batch scoring and observed latency; provider error behavior and production selection quality remain unverified.',
    }, null, 2));
  } catch (error) {
    // Do not print provider text, URLs, model strings, error causes or credentials.
    console.log(JSON.stringify({
      status: 'live_probe_failed', code: error?.code ?? 'probe_config_error',
      attemptedRequests: attempted, successfulRequests: latencies.length,
      latencyMs: { samples: latencies }, fixtureTestsProveApi: false,
    }, null, 2));
    process.exitCode = 1;
  }
}
