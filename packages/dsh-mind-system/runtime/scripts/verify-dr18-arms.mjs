import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareJsonTask, buildJsonCandidate, verifyJsonOutput } from '../recipes/json-normalize.js';
import * as hostEntry from '../src/host-plugin.js';

/** Synthetic engineering controls, not a model benchmark or production task distribution. */
export function makeCase(size, seed) {
  const expected = Array.from({ length: size }, (_, index) => ({
    id: `id-${String(index).padStart(5, '0')}`, name: `name-${index}`,
  }));
  // Expected bytes are built before padding and shuffling, independently of either transformation.
  const rows = expected.map(row => ({ id: row.id, name: `  ${row.name}  ` }));
  let state = seed >>> 0;
  for (let index = rows.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = state % (index + 1);
    [rows[index], rows[other]] = [rows[other], rows[index]];
  }
  return { source: `${JSON.stringify(rows, null, 2)}\n`, expected: `${JSON.stringify(expected, null, 2)}\n` };
}

export function summarize(samples) {
  const times = samples.map(sample => sample.ms).sort((left, right) => left - right);
  const percentile = fraction => times.length ? times[Math.ceil(fraction * times.length) - 1] : null;
  return {
    n: samples.length, pass: samples.filter(sample => sample.accepted).length,
    successRate: samples.length ? samples.filter(sample => sample.accepted).length / samples.length : null,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95),
    hostDispatches: samples.reduce((total, sample) => total + sample.hostDispatches, 0),
    writerDispatches: samples.reduce((total, sample) => total + sample.writerDispatches, 0),
    decisionRequests: samples.reduce((total, sample) => total + (sample.budgetUsage?.decisionRequests ?? 0), 0),
    analysisCalls: samples.reduce((total, sample) => total + (sample.budgetUsage?.analysisCalls ?? 0), 0),
  };
}

function plainTransform(input, output) {
  const rows = JSON.parse(readFileSync(input, 'utf8'));
  const normalized = rows.map(({ id, name }) => ({ id, name: name.trim() }));
  normalized.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  writeFileSync(output, `${JSON.stringify(normalized, null, 2)}\n`, { flag: 'wx' });
}

function templateTask(workspaceRoot, taskId, inputFile, outputFile) {
  return { taskId, recipeId: 'json-normalize', recipeVersion: '1',
    goal: 'Sort unique records by id, trim names and preserve the input.',
    scopeRef: 'dr18-benchmark', workspaceRoot, inputs: { inputFile, outputFile },
    deadlineAt: Date.now() + 300_000, allowedTools: ['runtime_write_json'] };
}

/** Use installed ToolRuntime and native writers. Never pre-register a substitute writer. */
export async function runBenchmark({ sizes = [50, 200, 800], repetitions = 7 } = {}) {
  if (!Array.isArray(sizes) || sizes.length < 1 || sizes.length > 5
    || new Set(sizes).size !== sizes.length || sizes.some(size => !Number.isInteger(size) || size < 1 || size > 10_000)
    || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 30) {
    throw new Error('Expected 1-5 distinct sizes in 1-10000 and repetitions in 1-30.');
  }
  const setupStart = performance.now();
  const cleanup = [];
  const { createHost, installed } = await import('../test/helpers/host.js');
  const host = await createHost({ after(callback) { cleanup.push(callback); } });
  let fiber;
  try {
    const cases = sizes.flatMap(size => Array.from({ length: repetitions }, (_, repetition) => {
      const id = `${size}-${repetition}`;
      const fixture = makeCase(size, size * 101 + repetition);
      const inputFile = `input-${id}.json`;
      const scenario = repetition === 0 ? 'already_normalized' : 'shuffled_padded';
      if (scenario === 'already_normalized') fixture.source = fixture.expected;
      writeFileSync(join(host.storage, inputFile), fixture.source, { flag: 'wx' });
      return { id, size, repetition, inputFile, scenario, ...fixture };
    }));
    const edgeCases = [
      { id: 'empty', sourceRows: [], expectedRows: [] },
      { id: 'case-order', sourceRows: [{ id: 'z', name: ' z ' }, { id: 'a', name: ' a ' }, { id: 'A', name: ' A ' }],
        expectedRows: [{ id: 'A', name: 'A' }, { id: 'a', name: 'a' }, { id: 'z', name: 'z' }] },
      { id: 'unicode', sourceRows: [{ id: 'b', name: ' café ' }, { id: 'a', name: '\t東京\n' }],
        expectedRows: [{ id: 'a', name: '東京' }, { id: 'b', name: 'café' }] },
    ];
    for (const edge of edgeCases) {
      const inputFile = `input-${edge.id}.json`;
      const source = `${JSON.stringify(edge.sourceRows, null, 2)}\n`;
      const expected = `${JSON.stringify(edge.expectedRows, null, 2)}\n`;
      writeFileSync(join(host.storage, inputFile), source, { flag: 'wx' });
      cases.push({ id: edge.id, size: edge.sourceRows.length, repetition: 0, inputFile,
        scenario: edge.id, source, expected });
    }
    const warmup = makeCase(4, 19);
    writeFileSync(join(host.storage, 'warmup.json'), warmup.source, { flag: 'wx' });
    writeFileSync(join(host.storage, 'invalid.json'), '[{"id":"same","name":"a"},{"id":"same","name":"b"}]\n', { flag: 'wx' });
    const tasks = [
      ...cases.map(item => templateTask(host.storage, `dr18-${item.id}`, item.inputFile, `host-${item.id}.json`)),
      templateTask(host.storage, 'dr18-warmup', 'warmup.json', 'warmup-out.json'),
      templateTask(host.storage, 'dr18-corrupt', 'warmup.json', 'corrupt-out.json'),
      templateTask(host.storage, 'dr18-invalid', 'invalid.json', 'invalid-out.json'),
    ];
    const observed = [];
    const corruptTarget = join(host.storage, 'corrupt-out.json');
    const disposeObservation = host.ctx.on('tools/execute', async (execution, next) => {
      observed.push(execution.name);
      const outcome = await next();
      // Fault injection is confined to the negative control, outside the timed sample set.
      if (execution.name === 'runtime_write_json' && execution.arguments.path === corruptTarget) {
        writeFileSync(corruptTarget, '[{"id":"wrong","name":"corrupt"}]\n');
      }
      return outcome;
    });
    cleanup.push(disposeObservation);
    fiber = host.ctx.plugin(hostEntry.plugin, { enabled: true, stateDir: join(host.root, 'runtime-state'),
      workspaceRoot: host.storage, scopeRef: 'dr18-benchmark', intervention: { enabled: false }, tasks });
    await fiber.await();
    const probe = hostEntry.healthProbe.probe();
    if (probe.facts.state !== 'ready') throw new Error('The native runtime did not mount successfully.');
    const agent = await host.agent('dr18-caller');
    const invoke = taskRef => host.execute('runtime_run', { agent, arguments: { taskRef } });
    const setupMs = performance.now() - setupStart;
    const warmupStart = performance.now();
    const warmupResult = await invoke('dr18-warmup');
    if (warmupResult.isError || warmupResult.value.status !== 'completed'
      || readFileSync(join(host.storage, 'warmup-out.json'), 'utf8') !== warmup.expected) {
      throw new Error('The native warmup failed independent acceptance.');
    }
    const warmupMs = performance.now() - warmupStart;
    const samples = [];
    const arms = ['local_function', 'recipe_direct', 'host_runtime'];
    for (const [caseIndex, item] of cases.entries()) {
      // Rotate order so one arm does not always receive the first filesystem read.
      const order = arms.slice(caseIndex % arms.length).concat(arms.slice(0, caseIndex % arms.length));
      for (const arm of order) {
        const outputFile = `${arm === 'host_runtime' ? 'host' : arm}-${item.id}.json`;
        const output = join(host.storage, outputFile);
        const mark = observed.length;
        const started = performance.now();
        let status = 'completed';
        let verification = null;
        let budgetUsage = null;
        let reason = null;
        if (arm === 'local_function') plainTransform(join(host.storage, item.inputFile), output);
        else if (arm === 'recipe_direct') {
          const task = prepareJsonTask({ taskId: `direct-${item.id}`, workspaceRoot: host.storage,
            inputFile: item.inputFile, outputFile, scopeRef: 'dr18-benchmark', deadlineAt: Date.now() + 60_000 });
          const candidate = buildJsonCandidate(task);
          writeFileSync(candidate.arguments.path, candidate.arguments.content, { flag: 'wx' });
          verification = verifyJsonOutput(task);
          if (!verification.goalSatisfied) status = 'verification_failed';
        } else {
          const result = await invoke(`dr18-${item.id}`);
          if (result.isError) throw new Error('Native runtime invocation failed before reporting a run.');
          ({ status, reason, budgetUsage } = result.value);
        }
        // Exclude this independent acceptance read from execution timing in every arm.
        const ms = performance.now() - started;
        const calls = observed.slice(mark);
        const hostDispatches = calls.length;
        const writerDispatches = calls.filter(name => name === 'runtime_write_json').length;
        const bytesMatch = existsSync(output) && readFileSync(output, 'utf8') === item.expected;
        const sourcePreserved = readFileSync(join(host.storage, item.inputFile), 'utf8') === item.source;
        const accountingMatches = arm !== 'host_runtime' || (writerDispatches === 1 && writerDispatches === budgetUsage?.toolCalls);
        samples.push({ arm, caseId: item.id, scenario: item.scenario, size: item.size, repetition: item.repetition, ms, status, reason,
          accepted: status === 'completed' && bytesMatch && sourcePreserved && accountingMatches,
          bytesMatch, sourcePreserved, accountingMatches, hostDispatches, writerDispatches,
          budgetUsage, modelCalls: 0, modelCallBasis: 'No model transport is installed in these local engineering controls.',
          modelTokens: null });
      }
    }
    const negativeControls = [];
    for (const [taskId, outputFile, expectedWrites] of [
      ['dr18-corrupt', 'corrupt-out.json', 1], ['dr18-invalid', 'invalid-out.json', 0],
    ]) {
      const mark = observed.length;
      const result = await invoke(taskId);
      if (result.isError) throw new Error('Negative control did not reach the runtime.');
      const writerDispatches = observed.slice(mark).filter(name => name === 'runtime_write_json').length;
      const output = join(host.storage, outputFile);
      const outputRejected = taskId === 'dr18-corrupt'
        ? existsSync(output) && readFileSync(output, 'utf8') !== warmup.expected : !existsSync(output);
      negativeControls.push({ taskId, status: result.value.status, reason: result.value.reason,
        writerDispatches, passed: result.value.status !== 'completed' && outputRejected && writerDispatches === expectedWrites });
    }
    const summaries = Object.fromEntries(arms.map(arm => [arm, {
      overall: summarize(samples.filter(sample => sample.arm === arm)),
      bySize: Object.fromEntries(sizes.map(size => [size, summarize(samples.filter(sample => sample.arm === arm && sample.size === size))])),
    }]));
    const configuredJev = ['DSH_JEV_ENDPOINT', 'DSH_JEV_MODEL', 'DSH_JEV_API_KEY'].every(name => process.env[name]?.trim());
    return {
      schemaVersion: 2, generatedAt: new Date().toISOString(), corpus: { version: 'dr18-local-v2', kind: 'synthetic', sizes, repetitions,
        trialsPerArm: cases.length, edgeCases: edgeCases.map(item => item.id),
        distinctInputs: new Set(cases.map(item => createHash('sha256').update(item.source).digest('hex'))).size,
        sha256: createHash('sha256').update(JSON.stringify(cases.map(({ id, source, expected }) => ({ id, source, expected })))).digest('hex'),
        independentOracle: 'Expected rows are generated before input padding and shuffling; no arm computes its own expected output.' },
      environment: { node: process.version, toolsVersion: installed['dsh-tools'].version, cordisVersion: installed.cordis.version },
      scope: { host: 'Isolated installed Cordis + ToolRuntime, native runtime plugin and native write tools.',
        timing: 'Warm process; runtime setup and one warmup excluded; input creation and external acceptance excluded from all arms.',
        setupMs, warmupMs, productionTaskDistribution: false,
        counting: 'hostDispatches counts actual tools/execute events including runtime_run; writerDispatches counts only native writes; budgetUsage is the persisted run budget.',
        missingModelCosts: 'Model token counts and model-loop latency are unknown. Local controls perform no model requests.' },
      requiredArms: {
        existing_model_loop: { status: 'not_measured', reason: 'No real model loop was invoked. local_function is not a substitute.' },
        rule_only: { status: 'measured_on_synthetic_corpus', arm: 'host_runtime' },
        rule_jev_analysis: { status: configuredJev ? 'configured_not_measured' : 'unavailable',
          reason: configuredJev ? 'Dedicated configuration exists; this local harness does not invoke that transport.' : 'Dedicated Jev endpoint, model and matching credential are missing.', liveRequests: 0 },
      },
      summaries, samples, negativeControls,
      harnessPassed: samples.every(sample => sample.accepted) && negativeControls.every(control => control.passed),
      dr18Passed: false, gainClaimAllowed: false,
    };
  } finally {
    try { await fiber?.dispose(); } finally {
      for (const dispose of cleanup.reverse()) await dispose?.();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: verify-dr18-arms.mjs [--output new-report.json]');
    const target = args.length ? resolve(args[1]) : null;
    if (target && existsSync(target)) throw new Error('The report already exists; choose a new output path.');
    const report = await runBenchmark();
    if (target) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    }
    console.log('DR-18 engineering controls; the real model loop and Jev arm remain unmeasured.');
    for (const [arm, summary] of Object.entries(report.summaries)) {
      console.log(`${arm}: n=${summary.overall.n} pass=${summary.overall.pass} p50=${summary.overall.p50Ms.toFixed(2)}ms p95=${summary.overall.p95Ms.toFixed(2)}ms writerDispatches=${summary.overall.writerDispatches}`);
    }
    console.log(`negativeControls=${report.negativeControls.filter(control => control.passed).length}/${report.negativeControls.length}; harnessPassed=${report.harnessPassed}; dr18Passed=false`);
    console.log(`__RESULT__${JSON.stringify(report)}`);
    if (!report.harnessPassed) process.exitCode = 1;
  } catch (error) {
    console.error(`DR-18 harness failed: ${error.code ?? error.message}`);
    process.exitCode = 1;
  }
}
