import test from 'node:test';
import assert from 'node:assert/strict';

// Exercise the real client module and MemoryPanel callback with a small,
// stateful React hook shim. No browser, server, or real memory data is used.
function reactHarness() {
	let cursor = 0;
	let dirty = false;
	const hooks = [];
	const effects = [];
	return {
		React: {
			createElement(type, props, ...children) {
				return { type, props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children } };
			},
			useState(initial) {
				const i = cursor++;
				if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
				return [hooks[i], (value) => {
					const next = typeof value === 'function' ? value(hooks[i]) : value;
					if (!Object.is(next, hooks[i])) { hooks[i] = next; dirty = true; }
				}];
			},
			useRef(initial) {
				const i = cursor++;
				if (!(i in hooks)) hooks[i] = { current: initial };
				return hooks[i];
			},
			useEffect(fn, deps) {
				const i = cursor++;
				// Execute the production useApi effects; skip unrelated debounce and
				// focus effects so tests have no real timers or DOM dependencies.
				if (!(deps?.length === 1 && typeof deps[0] === 'string' && deps[0].startsWith('/api/memory-org/'))) return;
				const previous = hooks[i];
				if (!previous || previous.url !== deps[0]) {
					if (previous?.cleanup) previous.cleanup();
					hooks[i] = { url: deps[0], cleanup: undefined };
					effects.push(() => { hooks[i].cleanup = fn(); });
				}
			},
		},
		async flush(Component, props) {
			let tree;
			for (let round = 0; round < 20; round++) {
				cursor = 0; dirty = false;
				tree = Component(props);
				while (effects.length) effects.shift()();
				// fetch and response.json both settle on microtasks.
				for (let i = 0; i < 8; i++) await Promise.resolve();
				if (!dirty && effects.length === 0) return tree;
			}
			throw new Error('fake React did not settle');
		},
	};
}

function nodes(value) {
	if (Array.isArray(value)) return value.flatMap(nodes);
	if (!value || typeof value !== 'object') return [];
	return [value, ...nodes(value.props?.children)];
}
function zone(tree) {
	const element = nodes(tree).find((node) => typeof node.type === 'function' && node.type.name === 'ZoneList');
	assert.ok(element, 'real MemoryPanel must render its ZoneList');
	return { props: element.props, tree: element.type(element.props) };
}
function byMark(tree, mark) {
	const found = nodes(tree).find((node) => node.props?.['data-dmo'] === mark);
	assert.ok(found, `missing ${mark} button`);
	return found;
}

for (const action of ['confirm', 'reject', 'delete', 'delete-dao']) {
	for (const failure of ['http', 'network', 'success']) {
		test(`${action}: ${failure} ${failure === 'success' ? 'positive control refreshes lists' : 'failure refreshes lists and retains unknown-result warning'}`, async (t) => {
			const oldWindow = globalThis.window;
			const oldFetch = globalThis.fetch;
			const harness = reactHarness();
			let client;
			globalThis.window = {
				__ModuleLoader__: { load(value) { client = value; } },
				confirm: () => true,
				prompt: () => '测试理由',
			};
			t.after(() => { globalThis.window = oldWindow; globalThis.fetch = oldFetch; });
			await import(new URL(`../client.js?reconcile=${action}-${failure}`, import.meta.url));
			assert.ok(client?.factory, 'real client module must register');
			const instance = client.factory((name) => name === 'react' ? harness.React : undefined);
			let Panel;
			instance.apply({ slots: { inject: (_slot, fn) => fn(), register: (opts, component) => { if (opts.name === 'main') Panel = component; } } });
			assert.ok(Panel);

			let candidates = [{ name: '候选甲', proposition: '候选命题', source_count: 5 }];
			let daos = [{ name: '正式甲.md', mtime: '2026-11-10T00:00:00Z', bytes: 10 }];
			const requests = [];
			globalThis.fetch = async (input, options = {}) => {
				const url = String(input);
				const method = options.method ?? 'GET';
				requests.push({ url, method, body: options.body });
				if (method === 'POST') {
					const expected = action === 'delete-dao' ? '/dao-action' : '/axiom-action';
					assert.ok(url.endsWith(expected));
					const body = JSON.parse(options.body);
					assert.equal(body.action, action === 'delete-dao' ? 'delete' : action);
					// Simulate the most dangerous ambiguity: server committed but its
					// response was an error or lost. The refresh must show actual state.
					if (action === 'delete-dao') daos = [];
					else {
						candidates = [];
						if (action === 'confirm') daos = [...daos, { name: '候选甲.md', mtime: '2026-11-10T00:00:00Z', bytes: 10 }];
					}
					if (failure === 'network') throw new Error('连接中断');
					if (failure === 'success') return { ok: true, status: 200, json: async () => ({ message: '完成' }) };
					return { ok: false, status: 500, json: async () => ({ error: '服务错误' }) };
				}
				const u = new URL(url, 'http://fixture.invalid');
				let data;
				if (u.pathname.endsWith('/overview')) data = [{ root: 'isolated', initialized: true, counts: {}, results: [] }];
				else if (u.pathname.endsWith('/axiom-candidates')) data = { candidates: structuredClone(candidates) };
				else if (u.pathname.endsWith('/list')) data = { files: u.searchParams.get('zone') === 'dao' ? structuredClone(daos) : [] };
				else if (u.pathname.endsWith('/file')) data = { text: '' };
				else data = {};
				return { ok: true, status: 200, json: async () => data };
			};

			const props = { initialView: { kind: 'zone', zone: 'dao' } };
			let tree = await harness.flush(Panel, props);
			if (action !== 'delete-dao') {
				byMark(zone(tree).tree, 'dao-cand-tab').props.onClick();
				tree = await harness.flush(Panel, props);
			}
			const mark = action === 'delete-dao' ? 'dao-del' : `dao-${action}`;
			const click = byMark(zone(tree).tree, mark);
			click.props.onClick();
			for (let i = 0; i < 8; i++) await Promise.resolve();
			tree = await harness.flush(Panel, props);
			const postIndex = requests.findIndex((r) => r.method === 'POST');
			assert.ok(postIndex >= 0, 'action must actually send POST');
			const afterPost = requests.slice(postIndex + 1).filter((r) => r.method === 'GET');
			assert.ok(afterPost.some((r) => r.url.includes('/axiom-candidates?')), '候选列表 must refetch after an uncertain write');
			assert.ok(afterPost.some((r) => r.url.includes('/list?zone=dao')), '正式道列表 must refetch after an uncertain write');
			const displayed = zone(tree).props;
			if (failure !== 'success') {
				assert.match(displayed.actMsg, /未知/, 'warning must tell the user the outcome is unknown after the list refresh');
				assert.match(displayed.actMsg, /核对|确认/, 'warning must advise the user to check current state');
			} else assert.match(displayed.actMsg, /完成/, 'success message survives the refresh');
			if (action === 'delete-dao') assert.equal(displayed.rows.length, 0, 'actual committed deletion is shown');
			else {
				assert.equal(displayed.candidates.length, 0, 'actual candidate state is shown');
				if (action === 'confirm') assert.ok(displayed.rows.some((r) => r.name === '候选甲.md'), 'actual promotion is shown');
			}
		});
	}
}
