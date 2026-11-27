import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Resolve the installed host, never the worktree's optional dependencies.
const hostRoot = path.resolve(process.env.DSH_SEAM_HOST_ROOT ?? 'D:/dsh');
const hostRequire = createRequire(pathToFileURL(path.join(hostRoot, 'package.json')));
export const installed = {};
for (const name of ['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-scope',
  'dsh-tool-executor-native', 'dsh-tool-executor-ptc']) {
  const id = `@deepseek-ai/${name}`;
  const entry = hostRequire.resolve(id);
  installed[name] = { entry, ...JSON.parse(readFileSync(hostRequire.resolve(`${id}/package.json`), 'utf8')) };
}
const load = (name) => import(pathToFileURL(installed[name].entry).href);
const [{ Context }, { SystemPrompt }, { ToolRuntime }, { createScope }, nativeExecutor, ptcExecutor] = await Promise.all([
  load('cordis'), load('dsh-system-prompt'), load('dsh-tools'), load('dsh-scope'),
  load('dsh-tool-executor-native'), load('dsh-tool-executor-ptc'),
]);
export { Context, ToolRuntime };

/** Mount the installed Node PTC provider and its real support services locally. */
export async function installNodePtc(host) {
  const definitions = [
    ['dsh-session-projection', {}],
    ['dsh-fs-local', { cwd: host.root }],
    ['dsh-subprocess-local', {}],
    ['dsh-sandbox-local', {}],
    ['dsh-sandbox-policy', { mode: 'danger-full-access', workspaceRoot: host.root }],
    ['dsh-ptc-runtime-node', { timeoutMs: 5000, maxTimeoutMs: 5000, graceMs: 200 }],
  ];
  for (const [name, config] of definitions) {
    const id = `@deepseek-ai/${name}`;
    const entry = hostRequire.resolve(id);
    installed[name] = { entry, ...JSON.parse(readFileSync(hostRequire.resolve(`${id}/package.json`), 'utf8')) };
    const { default: plugin } = await import(pathToFileURL(entry).href);
    await host.ctx.plugin(plugin, config).await();
  }
  assert.equal(host.ctx.get('ptcRuntime').language, 'typescript');
  // Mount the PTC executor now that ptcRuntime is available (native was mounted in createHost).
  await host.ctx.plugin({ name: 'fixture-ptc-executor', inject: ptcExecutor.inject, apply: ptcExecutor.apply },
    { maxSubCallsPerMinute: 1024, maxParallelSubCalls: 10 }).await();
}

/** Bound observation waits without abandoning the execution under observation. */
export async function waitFor(promise, label, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** Install real host services with fixture tools and process-local temporary state. */
export async function createHost(t, { mode = 'native' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-runtime-seam-'));
  const verifiedRoot = realpathSync(root);
  assert.equal(path.dirname(verifiedRoot), realpathSync(tmpdir()));
  assert.ok(path.basename(verifiedRoot).startsWith('dsh-runtime-seam-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const storage = path.join(root, 'storage');
  mkdirSync(storage);
  const ledgerPath = path.join(root, 'effects.jsonl');
  const ctx = new Context();
  const scopes = [];
  const active = new Set();
  const controllers = new Set();
  const ledger = (kind, details = {}) => appendFileSync(ledgerPath, `${JSON.stringify({ kind, ...details })}\n`, 'utf8');
  const rows = () => existsSync(ledgerPath)
    ? readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  t.after(async () => {
    try {
      for (const controller of controllers) controller.abort('test cleanup');
      await Promise.allSettled([...active]);
      for (const scope of scopes.reverse()) await scope.dispose();
      await ctx.fiber.dispose();
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      // Only delete the exact mkdtemp target after checking it again.
      assert.equal(realpathSync(root), verifiedRoot);
      assert.equal(path.dirname(verifiedRoot), realpathSync(tmpdir()));
      assert.ok(path.basename(verifiedRoot).startsWith('dsh-runtime-seam-'));
      await rm(verifiedRoot, { recursive: true, force: true });
    }
  });
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false }).await();
  // New dsh-tools removed the `mode` config; the executor is a separate plugin.
  // Native can mount immediately; PTC needs ptcRuntime, installed later by installNodePtc().
  await ctx.plugin(ToolRuntime, {}).await();
  if (mode === 'native') {
    await ctx.plugin({ name: 'fixture-native-executor', inject: nativeExecutor.inject, apply: nativeExecutor.apply }, {}).await();
  } else if (mode !== 'ptc') throw new Error(`Unsupported fixture tool mode: ${mode}`);
  const tools = ctx.get('tools');
  assert.ok(Context.is(ctx));
  assert.ok(tools instanceof ToolRuntime);
  assert.equal(ctx.get('approval'), undefined);
  let serial = 0;
  return {
    ctx, tools, root, storage, ledger, rows,
    count: (kind) => rows().filter((row) => row.kind === kind).length,
    controller() {
      const controller = new AbortController();
      controllers.add(controller);
      return controller;
    },
    async agent(id) {
      // The runtime only needs an identity and scope; this is not an AgentFactory lifecycle test.
      const agent = { id };
      const scope = createScope(ctx, agent);
      scopes.push(scope);
      await scope.ctx.fiber.await();
      agent.ctx = scope.ctx;
      return agent;
    },
    register(name, body, owner = ctx) {
      return owner.get('tools').register({
        name,
        description: 'Write fixture evidence only inside the temporary seam directory.',
        parameters: { type: 'object', properties: {} },
        output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, exec) {
          ledger(`body:${name}`, { callId: exec.callId });
          return body ? body(args, exec) : { fixture: name };
        },
      });
    },
    execute(name, options = {}) {
      // New dsh-tools dispatches a batch: { calls: [{ id, name, arguments: JSON }], signal, agent }.
      // The batch block drops rootCallId/parent, so replay them through an owned pre-execute hook to
      // preserve the legacy single-call exec shape the fixtures assert on.
      const callId = options.callId ?? `seam-${++serial}`;
      const input = {
        calls: [{ id: callId, name, arguments: JSON.stringify(options.arguments ?? {}) }],
        signal: options.signal ?? this.controller().signal,
        ...(options.agent === undefined ? {} : { agent: options.agent }),
        ...(options.toolSet === undefined ? {} : { toolSet: options.toolSet }),
      };
      let removeTrace;
      if (options.rootCallId !== undefined || options.parent !== undefined) {
        removeTrace = ctx.on('tools/pre-execute', (exec, next) => {
          if (exec.callId === callId) {
            if (options.rootCallId !== undefined && exec.rootCallId !== options.rootCallId) exec.rootCallId = options.rootCallId;
            if (options.parent !== undefined && exec.parent !== options.parent) exec.parent = options.parent;
          }
          return next();
        }, { prepend: true, global: true });
      }
      const work = tools.execute(input).then((batch) => {
        const settled = batch.results.find((row) => row.callId === callId);
        return settled?.result ?? { isError: true, content: [{ type: 'text', text: `No result for tool call ${callId}` }] };
      }).finally(() => { if (removeTrace) removeTrace(); });
      active.add(work);
      work.finally(() => active.delete(work)).catch(() => {});
      return work;
    },
  };
}
