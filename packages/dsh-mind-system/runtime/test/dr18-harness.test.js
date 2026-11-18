import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCase, runBenchmark, summarize } from '../scripts/verify-dr18-arms.mjs';

// The known expected bytes predate any transformation by the measured arms.
test('the DR-18 corpus carries an independent expected artifact', () => {
  const fixture = makeCase(3, 42);
  assert.deepEqual(JSON.parse(fixture.expected), [
    { id: 'id-00000', name: 'name-0' },
    { id: 'id-00001', name: 'name-1' },
    { id: 'id-00002', name: 'name-2' },
  ]);
  assert.notEqual(fixture.source, fixture.expected);
});

test('DR-18 summaries include failed trials and take percentiles from raw durations', () => {
  const samples = [
    { ms: 1, accepted: true, hostDispatches: 2, writerDispatches: 1, budgetUsage: { decisionRequests: 0, analysisCalls: 0 } },
    { ms: 9, accepted: false, hostDispatches: 1, writerDispatches: 0, budgetUsage: { decisionRequests: 1, analysisCalls: 1 } },
  ];
  const summary = summarize(samples);
  assert.equal(summary.n, 2);
  assert.equal(summary.pass, 1);
  assert.equal(summary.successRate, 0.5);
  assert.equal(summary.p50Ms, 1);
  assert.equal(summary.p95Ms, 9);
  assert.equal(summary.hostDispatches, 3);
  assert.equal(summary.writerDispatches, 1);
  assert.equal(summary.decisionRequests, 1);
  assert.equal(summary.analysisCalls, 1);
});

test('the DR-18 harness measures installed native dispatch without inventing a model arm', async () => {
  const report = await runBenchmark({ sizes: [4], repetitions: 2 });
  assert.equal(report.harnessPassed, true, JSON.stringify(report.negativeControls));
  assert.equal(report.dr18Passed, false);
  assert.equal(report.gainClaimAllowed, false);
  assert.equal(report.requiredArms.existing_model_loop.status, 'not_measured');
  assert.equal(report.requiredArms.rule_jev_analysis.liveRequests, 0);
  assert.equal(report.corpus.trialsPerArm, 5);
  assert.equal(report.corpus.distinctInputs, 5);
  assert.match(report.corpus.sha256, /^[a-f0-9]{64}$/);
  assert.ok(report.samples.some(sample => sample.scenario === 'already_normalized'));
  for (const sample of report.samples) {
    assert.equal(sample.accepted, true, JSON.stringify(sample));
    assert.equal(sample.sourcePreserved, true);
    assert.equal(sample.modelCalls, 0, 'Local controls never invoke a model.');
    assert.equal(sample.modelTokens, null, 'No model token measurement exists.');
    if (sample.arm === 'host_runtime') {
      assert.equal(sample.writerDispatches, 1);
      assert.equal(sample.hostDispatches, 2, 'Outer runtime call and nested writer are counted separately.');
      assert.equal(sample.budgetUsage.toolCalls, 1);
      assert.ok(sample.budgetUsage.ioOperations > 0);
    } else assert.equal(sample.hostDispatches, 0);
  }
  assert.equal(report.negativeControls.length, 2);
  assert.ok(report.negativeControls.every(control => control.passed && control.status !== 'completed'));
  assert.equal(report.negativeControls.find(control => control.taskId === 'dr18-corrupt').writerDispatches, 1);
  assert.equal(report.negativeControls.find(control => control.taskId === 'dr18-invalid').writerDispatches, 0);
});
