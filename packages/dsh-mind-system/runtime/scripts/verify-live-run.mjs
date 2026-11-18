import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Run one real task through the runtime in a live Cordis host, and report what actually happened.
 *
 * ## Why this exists
 *
 * The unit suites drive the plugin through a stand-in tools service. That is enough for most checks, but it
 * silently diverged on one contract: the runtime marks "dispatch observed" from the host's SECOND pipeline
 * event (`tools/execute`), while a stand-in that only emits `tools/pre-execute` makes every honest run
 * look unconfirmed. The failure mode is a false negative — the artifact is written, the verifier passes,
 * and the run still reports `reconciling`. Reading the code did not reveal it; running the real chain did.
 *
 * So this script models both events in the order the host emits them, which is the cheapest way to keep
 * that contract honest without booting a full DSH profile.
 *
 * Usage: node packages/dsh-execution-runtime/scripts/verify-live-run.mjs
 * Exits non-zero when the run does not complete, so it can gate a release.
 */
const HOST_ROOTS = ['D:/dsh', process.env.DSH_INSTALL_DIR].filter(Boolean);

async function loadCordis() {
  for (const root of HOST_ROOTS) {
    try {
      const require = createRequire(pathToFileURL(join(root, 'package.json')));
      return await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
    } catch { /* try the next root */ }
  }
  return null;
}

const cordis = await loadCordis();
if (!cordis) {
  console.log(JSON.stringify({ skipped: true, reason: 'cordis_not_available' }));
  process.exit(0);
}

const entry = pathToFileURL(join(import.meta.dirname, '..', 'src', 'host-plugin.js')).href;
const pluginModule = await import(entry);
const plugin = pluginModule.default ?? pluginModule.plugin ?? pluginModule;

const registered = new Map();
const app = new cordis.Context();

/**
 * Dispatch that mirrors the host: pre-execute, then execute around the tool body.
 * Emitting only the first event is what produced the false negative this script guards against.
 */
const toolsService = {
  register(tool) {
    if (registered.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    registered.set(tool.name, tool);
    return () => registered.delete(tool.name);
  },
  get(name) { return registered.get(name) ?? null; },
  list() { return [...registered.keys()]; },
  async execute(input) {
    const tool = registered.get(input?.name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `unknown tool: ${input?.name}` }] };
    await app.waterfall('tools/pre-execute', input, () => Promise.resolve({ kind: 'allow' }));
    let outcome;
    await app.waterfall('tools/execute', input, async () => {
      try {
        const value = await tool.execute(input.arguments, input);
        outcome = { isError: false, value, content: [{ type: 'text', text: 'ok' }] };
      } catch (error) {
        outcome = { isError: true, content: [{ type: 'text', text: error?.message ?? String(error) }] };
      }
      return outcome;
    });
    return outcome;
  },
};

app.provide?.('tools');
app.set('tools', toolsService);

const stateDir = mkdtempSync(join(tmpdir(), 'live-run-state-'));
const work = mkdtempSync(join(tmpdir(), 'live-run-work-'));
const fiber = app.plugin(plugin, { enabled: true, stateDir, workspaceRoot: work, scopeRef: 'live-run' });
await fiber.await?.();

const report = { mounted: [...registered.keys()].sort() };
try {
  writeFileSync(join(work, 'input.txt'), 'cherry\napple\nbanana\n');
  const agent = { id: 'live-caller', name: 'live-caller' };
  const run = await registered.get('runtime_execute').execute({
    goal: 'Write the input lines in alphabetical order.',
    recipe: { recipeId: 'live-sort', tool: 'runtime_write_text', effect: 'reversible_write',
      verifier: { primitive: 'sorted_lines', parameters: { expectAscending: true } },
      arguments: { path: '{{workspaceRoot}}/{{outputFile}}', content: 'apple\nbanana\ncherry\n',
        createOnly: true } },
    inputs: { inputFile: 'input.txt', outputFile: 'sorted.txt' },
  }, { agent });
  report.status = run.status;
  report.reason = run.reason;
  report.artifact = readFileSync(join(work, 'sorted.txt'), 'utf8');
  report.library = run.library;

  // The library is part of the same claim: a run that completes must be findable afterwards.
  const found = await registered.get('runtime_recipes').execute({ goal: 'alphabetical order' }, { agent });
  report.recipes = { count: found.count, first: found.entries[0]?.recipeKey ?? null,
    verifiedRuns: found.entries[0]?.verifiedRuns ?? 0 };

  // A run whose artifact misses its own declared primitive must not report success.
  const bad = await registered.get('runtime_execute').execute({
    goal: 'Claim an ordering the artifact does not have.',
    recipe: { recipeId: 'live-wrong', tool: 'runtime_write_text', effect: 'reversible_write',
      verifier: { primitive: 'line_set', parameters: { expectedLines: ['zzz'] } },
      arguments: { path: '{{workspaceRoot}}/wrong.txt', content: 'apple\n', createOnly: true } },
    inputs: { inputFile: 'input.txt', outputFile: 'wrong.txt' },
  }, { agent });
  report.negativeControl = { status: bad.status, succeeded: bad.library?.succeeded };
} finally {
  await fiber?.dispose?.();
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

const ok = report.status === 'completed'
  && report.artifact === 'apple\nbanana\ncherry\n'
  && report.recipes.verifiedRuns >= 1
  && report.negativeControl.status !== 'completed'
  && report.negativeControl.succeeded === false;

console.log(JSON.stringify({ ...report, ok }, null, 2));
if (!ok) process.exitCode = 1;
