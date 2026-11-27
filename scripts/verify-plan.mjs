import { readFileSync } from 'node:fs';

const plan = readFileSync(new URL('../UPGRADE-PLAN.md', import.meta.url), 'utf8');
const errors = [];
if (!/^# .+$/m.test(plan) || !/^## .+\r?\n\s*\n\S/m.test(plan)) {
  errors.push('Expected a plan title and an iteration with an action.');
}
if (/^\s*\||[✅🔶⬜]|^\s*[-*] \[[xX ]\]/m.test(plan)) {
  errors.push('Remove progress tables and status markers from the iteration plan.');
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('plan-check: ALL PASS');
}
