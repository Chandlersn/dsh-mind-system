import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * A SAG-Wiki adapter for the runtime's knowledge channel.
 *
 * ## Why the two directions use different transports
 *
 * Reading is an HTTP call to the local SAG API; writing is a CLI invocation (`sag add`). That asymmetry is
 * not a shortcut — the API exposes search, and indexing a directory is a CLI operation. Pretending a single
 * transport covers both would mean either inventing an endpoint that does not exist or reporting writes as
 * successful when nothing was indexed.
 *
 * ## What this adapter refuses to do
 *
 * - It never reports success it did not observe. A missing key, an unreachable service or a non-zero CLI
 *   exit is returned as a failure with a reason code, never as an empty result that reads like "no content".
 * - It never claims `indexed: true` from a write that only stored bytes. `stored` and `indexed` stay separate
 *   facts, because "written" and "searchable" are different conditions and conflating them is how a knowledge
 *   channel silently stops working.
 */

const DEFAULT_ENDPOINT = 'http://127.0.0.1:24681';

/** Read the API key the way the SAG desktop app stores it, then fall back to the environment. */
export function resolveSagKey({ appData = process.env.APPDATA } = {}) {
  const fromEnv = process.env.SAG_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return { key: fromEnv.trim(), source: 'env' };
  if (typeof appData === 'string' && appData) {
    const file = join(appData, 'com.sag.desktop', 'api-key');
    if (existsSync(file)) {
      const key = readFileSync(file, 'utf8').trim();
      if (key) return { key, source: 'appdata' };
    }
  }
  return { key: null, source: null };
}

/** Run the SAG CLI. It is a .cmd shim on Windows, so a shell is required — spawning the file directly ENOENTs. */
function runSagCli(args, { sagCmd, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(sagCmd, args, { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, code: 'spawn_failed', detail: error?.message ?? String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 'spawn_failed', detail: error?.message ?? String(error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code === 0 ? null : `cli_exit_${code}`, stdout, stderr });
    });
  });
}

/**
 * Build an adapter the knowledge channel can drive.
 *
 * `read` uses the HTTP API. `write` indexes through the CLI and then asks the API whether the content is
 * actually findable — the only way to distinguish "stored" from "stored and searchable".
 */
export function createSagAdapter({ endpoint = DEFAULT_ENDPOINT, apiKey = null, sagCmd = 'sag',
  fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const base = endpoint.replace(/\/+$/, '');
  const headers = () => (apiKey ? { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }
    : { 'content-type': 'application/json' });

  return Object.freeze({
    async read({ id, signal } = {}) {
      if (!apiKey) {
        // No key is a configuration fact, not an empty knowledge base.
        const error = new Error('SAG API key is not configured.');
        error.code = 'no_key';
        throw error;
      }
      let response;
      try {
        response = await fetchImpl(`${base}/v1/search`, { method: 'POST', signal,
          headers: headers(),
          body: JSON.stringify({ query: id, mode: 'fast', paths: [], limit: 5 }) });
      } catch (cause) {
        const error = new Error(`SAG search failed: ${cause?.message ?? cause}`);
        error.code = signal?.aborted ? 'aborted' : 'network';
        throw error;
      }
      if (!response.ok) {
        const error = new Error(`SAG search returned ${response.status}.`);
        error.code = response.status === 401 ? 'unauthorized' : `http_${response.status}`;
        throw error;
      }
      const payload = await response.json();
      const results = Array.isArray(payload?.results) ? payload.results : [];
      // Every result carries its source path so a caller can tell where the content came from.
      return { content: results.map((item) => ({ path: item.path, text: item.text ?? null })),
        verified: false };
    },

    async write({ id, version, content, signal } = {}) {
      // The CLI indexes a directory, so the content is first written where SAG can pick it up. A caller that
      // cannot supply a path gets an honest refusal rather than a silent no-op.
      const target = content?.path;
      if (typeof target !== 'string' || !target) {
        const error = new Error('A SAG write needs content.path to index.');
        error.code = 'invalid_knowledge_write';
        throw error;
      }
      const indexed = await runSagCli(['add', target, '--json'], { sagCmd, timeoutMs });
      if (!indexed.ok) {
        // A failed index is a failed write from this caller's point of view; reporting `stored: true` would
        // claim progress that did not happen.
        return { stored: false, indexed: false, indexError: indexed.code ?? 'index_failed' };
      }
      // Ask the API whether it can now find the reference. Only a positive answer makes `indexed` true.
      const found = await this.read({ id, version, signal }).catch(() => null);
      const searchable = Array.isArray(found?.content)
        && found.content.some((item) => typeof item.path === 'string' && item.path.includes(id));
      return { stored: true, indexed: searchable,
        ...(searchable ? {} : { indexError: 'stored_but_not_searchable' }) };
    },
  });
}
