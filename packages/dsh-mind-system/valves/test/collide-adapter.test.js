import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collideNoteToCandidate } from '../src/clis-bridge.js';

/**
 * The experimental-layer adapter counts only what the author actually wrote.
 *
 * Its number feeds a gate (criterionMinSkills), so both directions matter: an
 * invented observation inflates the gate and lets a note in, while a missed one
 * understates a note that deserved review. These tests pin the second direction —
 * shapes people really write that a digits-only pattern silently dropped.
 */

const note = (text) => ({ theme: 'A note', text, source: 'collide/note.md' });

test('Arabic ratio and percentage forms are counted', () => {
  const c = collideNoteToCandidate(note('实测 5/5 全活跃，命中率 91.7%。'));
  assert.equal(c.skill_coverage, 2);
});

test('Chinese numerals in a ratio are counted too', () => {
  // The real note writes "三比零" in one sentence and "5/5" in another. Matching
  // only ASCII digits dropped half of its evidence and understated the gate count.
  const c = collideNoteToCandidate(note('排在前面的是那份已删掉的——三比零。修完后 5/5 都指向活的。'));
  assert.equal(c.skill_coverage, 2, JSON.stringify(c.evidence));
  // Kept verbatim, so the ledger can be re-read against the note.
  assert.ok(c.evidence.some((e) => e.includes('5/5')));
  assert.ok(c.evidence.some((e) => e.includes('3:0')));
});

test('a clock time is still not a measurement', () => {
  // The original false-positive: "10:00" is a schedule, and counting it would
  // inflate coverage with something that measures nothing.
  const c = collideNoteToCandidate(note('周检时间 10:00，每 6 小时跑一次归档。'));
  assert.equal(c.skill_coverage, 0, JSON.stringify(c.evidence));
});

test('prose containing 比 without two numerals stays unmeasured', () => {
  // Narrow on purpose: "相比" and "比之前" are ordinary comparisons, not ratios.
  const c = collideNoteToCandidate(note('相比之前，这一版比上一版更容易看懂。'));
  assert.equal(c.skill_coverage, 0, JSON.stringify(c.evidence));
});

test('coverage stays zero when the author measured nothing', () => {
  // Refusing is the honest outcome; the adapter must not help by guessing.
  const c = collideNoteToCandidate(note('我觉得这个东西可能有问题，但说不上来在哪里。'));
  assert.equal(c.skill_coverage, 0);
  assert.deepEqual(c.evidence, ['collide:collide/note.md']);
});

test('the falsification hook is captured even with words before the colon', () => {
  const c = collideNoteToCandidate(note('留一条会失败的观测在这儿：以后又冒出 _deleted 就说明排除被冲掉了。'));
  assert.match(c.verifiable_by, /又冒出 _deleted/);
});
