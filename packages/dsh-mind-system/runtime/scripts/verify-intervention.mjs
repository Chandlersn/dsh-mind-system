import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Prove the runtime actually speaks through a live host, rather than merely having a policy object.
 *
 * The unit tests drive `createInterventionPolicy` directly, which shows the decision logic works. They cannot
 * show that the plugin is subscribed to `tools/post-execute`, that it reads a real host result, or that the
 * hint reaches `additionalContexts` — a component that is correct but unsubscribed looks identical to one
 * that works, from the unit tests' point of view.
 *
 * Exits non-zero when the runtime does not intervene, so it can gate a release.
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

const app = new cordis.Context();
let lastPostExecute = null;
const registered = new Map();
const tools = {
  register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); },
  get(name) { return registered.get(name) ?? null; },
  list() { return [...registered.keys()]; },
  async execute(input) {
    const tool = registered.get(input?.name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: 'unknown' }] };
    await app.waterfall('tools/pre-execute', input, () => Promise.resolve({ kind: 'allow' }));
    let result;
    await app.waterfall('tools/execute', input, async () => {
      try {
        result = { isError: false, value: await tool.execute(input.arguments, input),
          content: [{ type: 'text', text: 'ok' }] };
      } catch (error) {
        result = { isError: true, error: { message: error?.message ?? String(error), code: error?.code },
          content: [{ type: 'text', text: error?.message ?? String(error) }] };
      }
      return result;
    });
    // The host emits a THIRD event after the body settles. Intervention lives there: a component that only
    // sees pre-execute and execute can never observe an outcome, which is exactly what happened first here.
    // Cordis appends `next` to the arguments, so the payload comes first and the fallback last.
    const decision = await app.waterfall('tools/post-execute', input, result,
      () => Promise.resolve({ additionalContexts: [] }));
    lastPostExecute = decision;
    return result;
  },
};
app.provide?.('tools');
app.set('tools', tools);

const stateDir = mkdtempSync(join(tmpdir(), 'intervene-state-'));
const fiber = app.plugin(plugin, { enabled: true, stateDir, workspaceRoot: stateDir, scopeRef: 'live' });
await fiber.await?.();

const report = { mounted: [...registered.keys()].sort() };
try {
  const agent = { id: 'intervene-caller', name: 'intervene-caller' };
  // A tool that fails with a reason the runtime can help with. The same tool runs twice: a single failure is
  // deliberately not enough to trigger a hint.
  const failing = {
    name: 'failing-tool',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [] },
    async execute() {
      const error = new Error('verification failed: output does not match the declared digest');
      error.code = 'verification_failed';
      throw error;
    },
  };
  tools.register(failing);

  await tools.execute({ name: 'failing-tool', arguments: {}, agent });
  await tools.execute({ name: 'failing-tool', arguments: {}, agent });

  const decision = lastPostExecute;
  report.contexts = (decision?.additionalContexts ?? []).length;
  report.hintPresent = JSON.stringify(decision?.additionalContexts ?? []).includes('runtime_execute');
  report.hintText = (decision?.additionalContexts ?? [])
    .flatMap((item) => item?.content ?? []).map((part) => part?.text ?? '').join(' ').slice(0, 120);
} finally {
  await fiber?.dispose?.();
  rmSync(stateDir, { recursive: true, force: true });
}

async function safeProbe(mod, ctx) {
  try {
    const probe = typeof mod.healthProbe === 'function' ? await mod.healthProbe(ctx) : null;
    return probe?.intervention ?? null;
  } catch { return null; }
}

const ok = report.hintPresent === true;
console.log(JSON.stringify({ ...report, ok }, null, 2));
if (!ok) process.exitCode = 1;
