/**
 * Host skill bridge (5.17.0).
 *
 * Registers a `ctx.skills` provider over the plugin's OWN memory-root `skills/`
 * folder: an ACTIVE crystallized skill that carries a kebab-case `hostName`
 * joins the host catalog and becomes callable through the host `skill` tool —
 * the merge point between the memory lifecycle (candidate→active→retired) and
 * the host's provider registry (@deepseek-ai/dsh-skill).
 *
 * Everything here is OPTIONAL by design: a host without the skill service, a
 * root without skills, or files without hostName all mean "no contribution",
 * never a crash — the plugin's own pre-step recall keeps serving every skill
 * regardless. The provider only admits skills the plugin itself marked safe
 * to publish (active + valid hostName), which is the memory layer's version of
 * the host's invocation policy.
 */
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';

/** Host grammar mirror: dsh-skill SKILL_NAME (drift-guarded in harness-test). */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isSkillName = (name) => typeof name === 'string' && SKILL_NAME_RE.test(name);

/**
 * Provider-local rank for memory-root skills. Lower ranks WIN duplicate names
 * inside one layer (registry contract), so this sits ABOVE the host's
 * BUNDLED_SKILL_RANK (600): a hand-curated skill with the same name always
 * wins over a memory export — the bridge never overrides the user.
 */
const MEMORY_SKILL_RANK = 700;
// Exported: the panel uses it to tell OUR published rows (fold them into the
// memory group) apart from foreign providers (bundled/project/user skills).
export const PROVIDER_NAME = 'dsh-memory-manager';

/** Minimal frontmatter split: `---` block at the very top, then the body. */
export function parseSkillText(text) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text ?? ''));
	if (!m) return { fields: {}, body: String(text ?? '') };
	const fields = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
		if (!kv) continue;
		let v = kv[2].trim();
		if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
		fields[kv[1]] = v;
	}
	return { fields, body: text.slice(m[0].length).trim() };
}

/**
 * The publish gate: this plugin OWNS the bundle (agent_created) and it is live
 * (status active). The bundle directory name is the host name, validated by the
 * host provider itself, so no separate name check is needed here.
 */
function publishable(fields) {
	return /^(?:true|1)$/i.test(String(fields.agent_created ?? '')) && fields.status === 'active';
}

/**
 * Single source of truth for "is this skill currently published to the host?".
 * The bridge (list/get) AND the plugin's own `memory_skill(list)` read-back both
 * call it, so the publish state the tool REPORTS can never drift from what the
 * provider actually advertises — the day's recurring theme, one predicate.
 */
export const isPublishable = (fields) => publishable(fields);

/**
 * Routing (skill_scope.py --route, lifted into the plugin): does this skill
 * apply to a project? global → everywhere; project → only its scope_project;
 * an owned skill with no/unknown scope is NOT "确定适用". This is what finally
 * makes `scope` a field some code READS rather than just writes + audits.
 */
export function skillAppliesToProject(fields, projectKey) {
	if (!projectKey) return true; // no filter requested
	const scope = String(fields.scope ?? '').toLowerCase();
	if (scope === 'global') return true;
	if (scope === 'project') return Boolean(fields.scope_project ?? fields.scopeProject) && (fields.scope_project ?? fields.scopeProject) === projectKey;
	return false; // missing/unknown scope: never counted as definitely applicable
}

/**
 * Register the bridge on the host context. Returns `{ invalidate, dispose }`,
 * or `undefined` when the host exposes no skill registry (the plugin keeps
 * running on its own recall — this seam must never be load-bearing).
 */
export function registerMemorySkillBridge(ctx, { skillsDir }) {
	let registry;
	try {
		registry = typeof ctx.get === 'function' ? ctx.get('skills') : undefined;
		if (!registry) registry = ctx.skills;
	} catch {
		registry = undefined;
	}
	if (!registry || typeof registry.registerProvider !== 'function') return undefined;

	const dir = skillsDir;
	// 5.24.0: skills ARE host bundles (<root>/<kebab-name>/SKILL.md). The bridge
	// no longer publishes a memory-root copy — it reads the same store the host
	// filesystem provider reads, and only decides which of those bundles are
	// OURS-and-live (agent_created + status active). The bundle dir name is the
	// host name; there is no separate hostName field.
	const readPublishable = async () => {
		let entries = [];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return [];
		}
		const out = [];
		for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
			const file = path.join(dir, e.name, 'SKILL.md');
			let text;
			try {
				text = await readFile(file, 'utf8');
			} catch {
				continue;
			}
			const { fields, body } = parseSkillText(text);
			if (!publishable(fields) || !fields.description) continue;
			out.push({ file, dirName: e.name, fields, body });
		}
		return out;
	};

	const provider = {
		name: PROVIDER_NAME,
		async list(options) {
			options?.signal?.throwIfAborted?.();
			const found = await readPublishable();
			return found.map(({ file, dirName, fields, body }) => ({
				name: dirName,
				description: fields.description,
				path: file,
				invocation: { modelInvocable: true, userInvocable: true },
				source: 'custom',
				provider: PROVIDER_NAME,
				rank: MEMORY_SKILL_RANK,
				locator: file,
				_body: body,
				_summary: fields.description,
			}));
		},
		async get(candidate, options) {
			options?.signal?.throwIfAborted?.();
			// Reload from disk: the catalog caches nothing about bodies (host rule:
			// "definitions are never cached"), and a retire between list and get
			// must not still be loadable.
			const text = await readFile(String(candidate.locator), 'utf8').catch(() => undefined);
			if (text === undefined) return undefined;
			const { fields, body } = parseSkillText(text);
			if (!publishable(fields)) return undefined;
			const dirName = path.basename(path.dirname(String(candidate.locator)));
			return {
				name: dirName,
				description: fields.description,
				path: String(candidate.locator),
				content: body,
				invocation: { modelInvocable: true, userInvocable: true },
				source: 'custom',
				provider: PROVIDER_NAME,
				// The skill's OWN directory: relative paths it mentions (scripts/…)
				// resolve against the bundle, which is what the reader expects.
				resourceBase: { kind: 'directory', path: path.dirname(String(candidate.locator)) },
			};
		},
	};

	let control;
	const dispose = registry.registerProvider((c) => {
		control = c;
		return provider;
	});
	return {
		// The registry itself, borrowed for READS (the panel's skill library
		// lists the WHOLE host catalog, not just our rows). Same instance the
		// host `skill` tool resolves against — one catalog, one truth.
		registry,
		invalidate: () => {
			try {
				control?.invalidate?.();
			} catch {
				/* registration already gone — nothing to refresh */
			}
		},
		dispose,
	};
}
