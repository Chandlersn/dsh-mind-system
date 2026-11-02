/**
 * Locating the Host installation.
 *
 * A profile-installed bundle is a pnpm link whose realpath is this source
 * directory, so bare-import resolution from inside it never sees the Host's
 * node_modules. Requiring the exact Host file works: these are ESM modules
 * (Node >= 22.12 `require(esm)`), their own dependencies resolve from the
 * install's flat node_modules, and require(esm) returns the already-cached
 * namespace the Host loaded — one shared instance.
 *
 * The install root is discovered instead of hardcoded so the bundle stays
 * portable.
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

export const HOST_MARKER = path.join('node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');

export function looksLikeDshRoot(dir) {
	return Boolean(dir) && existsSync(path.join(dir, HOST_MARKER));
}

export function walkUpForDshRoot(seed) {
	if (!seed) return undefined;
	let dir = path.resolve(seed);
	if (!existsSync(dir)) dir = path.dirname(dir);
	for (;;) {
		if (looksLikeDshRoot(dir)) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function resolveFromOwnTree() {
	try {
		const resolved = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools/lib/index.js');
		return walkUpForDshRoot(resolved);
	} catch {
		return undefined;
	}
}

/**
 * Candidates, in order:
 *   1. plugin config `dshRoot`
 *   2. env `DSH_INSTALL_DIR` / `DSH_ROOT`
 *   3. walking up from the running CLI entry (`process.argv[1]`)
 *   4. walking up from `process.cwd()`
 *   5. walking up from `DSH_PROFILE_DIR`
 *   6. resolving the Host package from this file's own tree (regular installs)
 * A candidate counts only when it really contains the Host package.
 */
export function resolveDshRoot(configured) {
	const candidates = [
		typeof configured === 'string' && configured.trim() ? configured.trim() : undefined,
		process.env.DSH_INSTALL_DIR,
		process.env.DSH_ROOT,
		walkUpForDshRoot(process.argv[1]),
		walkUpForDshRoot(process.cwd()),
		walkUpForDshRoot(process.env.DSH_PROFILE_DIR),
		resolveFromOwnTree(),
	];
	for (const c of candidates) if (looksLikeDshRoot(c)) return path.resolve(c);
	throw new Error(
		'cannot locate the DSH installation (no node_modules/@deepseek-ai/dsh-tools found): ' +
			'set DSH_INSTALL_DIR to the harness install directory, or pass `dshRoot` in the plugin config',
	);
}

let hostRootOverride;
let hostModules;

/**
 * Host helpers, bound lazily so resolution happens at apply() time (when the
 * plugin config is known) and never at module-import time (so tests can import
 * this package without a host installation on the machine).
 */
export function setHostRoot(value) {
	hostRootOverride = value;
}

export function loadHost() {
	if (!hostModules) {
		const root = resolveDshRoot(hostRootOverride);
		const req = (pkg, sub) => {
			const file = path.join(root, 'node_modules', pkg, sub);
			try {
				return createRequire(file)(file);
			} catch (err) {
				throw new Error(`cannot load ${pkg} from the DSH installation (${root}): ${err?.message ?? err}`);
			}
		};
		hostModules = {
			root,
			defineTool: req('@deepseek-ai/dsh-tools', 'lib/index.js').defineTool,
			createUserMessage: req('@deepseek-ai/dsh-llm', 'lib/index.js').createUserMessage,
		};
	}
	return hostModules;
}

/** Bound at apply() time — see loadHost. */
export function defineTool(...args) {
	return loadHost().defineTool(...args);
}

export function createUserMessage(...args) {
	return loadHost().createUserMessage(...args);
}
