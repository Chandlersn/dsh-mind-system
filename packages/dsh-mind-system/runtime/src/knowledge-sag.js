import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Resolve the SAG API key from the environment or the desktop application's configuration. */
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

/**
 * SAG's global search and directory indexing do not establish a knowledge domain or version.
 * Refuse reference operations until an adapter can establish both before reading or writing.
 */
export function createSagAdapter({ apiKey = null } = {}) {
  const unsupported = () => {
    const error = new Error('SAG cannot establish the requested knowledge domain and version.');
    error.code = 'knowledge_identity_unsupported';
    throw error;
  };
  return Object.freeze({
    async read() {
      if (!apiKey) {
        const error = new Error('SAG API key is not configured.');
        error.code = 'no_key';
        throw error;
      }
      return unsupported();
    },
    async write({ content } = {}) {
      if (typeof content?.path !== 'string' || !content.path) {
        const error = new Error('A SAG write needs content.path to index.');
        error.code = 'invalid_knowledge_write';
        throw error;
      }
      return unsupported();
    },
  });
}
