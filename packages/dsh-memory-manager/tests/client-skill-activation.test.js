import test from 'node:test';
import assert from 'node:assert/strict';

// Verify the skill activate control is driven ONLY by the backend /skills
// data.activation fact. No browser, server, timers, or real memory data: the
// real client module renders through a no-effect React shim with __apiFixtures
// as the sole data source (same seam as client-runtime-snapshot.test.js).
const React = {
	createElement(type, props, ...children) { return { type, props: { ...(props ?? {}), children } }; },
	useState(init) { return [typeof init === 'function' ? init() : init, () => {}]; },
	useEffect() {},
	useRef(value) { return { current: value }; },
};
let definition;
const previousWindow = globalThis.window;
const previousFetch = globalThis.fetch;
globalThis.window = { __ModuleLoader__: { load(value) { definition = value; } } };
globalThis.fetch = () => { throw new Error('network is forbidden in this test'); };
await import('../client.js');
const instance = definition.factory((name) => name === 'react' ? React : undefined);
let Panel;
instance.apply({ slots: { inject(_slot, fn) { fn(); }, register(options, component) { if (options.name === 'main') Panel = component; } } });
test.after(() => { globalThis.window = previousWindow; globalThis.fetch = previousFetch; });

function expand(value) {
	if (Array.isArray(value)) return value.flatMap(expand);
	if (value == null || typeof value === 'boolean') return [];
	if (typeof value !== 'object') return [String(value)];
	if (typeof value.type === 'function') return expand(value.type(value.props));
	return [{ type: value.type, props: value.props }, ...expand(value.props?.children)];
}
function render(fixture) {
	return expand(React.createElement(Panel, {
		__apiFixtures: {
			// The overview must resolve a registered, initialized workspace or the
			// skills zone never mounts (the panel's early guard wins).
			'/api/memory-org/overview?v=0': { data: [{ root: 'fixture', initialized: true, failCount: 0, warnCount: 0, results: [] }], loading: false, error: null },
			'/api/memory-org/skills?v=0': { data: fixture, loading: false, error: null },
		},
		initialView: { kind: 'zone', zone: 'skills' },
	}));
}
function byMark(tree, mark) {
	return tree.filter((node) => node.props?.['data-dmo'] === mark);
}
function textOf(node) {
	return expand(node.props?.children).filter((item) => typeof item === 'string').join(' ');
}

const DETAIL = '宿主尚无绑定技能版本和任务的独立执行验收证据';
const baseSkills = () => ({
	memory: [
		{ name: '候选技能', status: 'candidate', description: '等待转正' },
		{ name: '在用技能', status: 'active', description: '正在使用' },
	],
	host: [],
});
function library(activation) {
	const fixture = baseSkills();
	if (activation !== undefined) fixture.activation = activation;
	const tree = render(fixture);
	return {
		toggles: byMark(tree, 'skill-toggle'),
		notes: byMark(tree, 'skill-activation-note'),
		noteText: byMark(tree, 'skill-activation-note').map(textOf).join(' '),
	};
}
// active toggles carry the ' on' class; candidate toggles do not.
const candidateToggle = (view) => view.toggles.find((n) => !String(n.props.className).includes(' on'));
const activeToggle = (view) => view.toggles.find((n) => String(n.props.className).includes(' on'));

test('available=false: activate disabled, backend detail shown verbatim, retire stays enabled', () => {
	const view = library({ available: false, reason: 'verified_skill_execution_unavailable', detail: DETAIL });
	const candidate = candidateToggle(view);
	const active = activeToggle(view);
	assert.ok(candidate && active, 'both lifecycle toggles render');
	assert.equal(candidate.props.disabled, true, 'candidate activate must be disabled when backend says unavailable');
	assert.equal(candidate.props.title, DETAIL, 'title must come from backend detail, not a client-hardcoded string');
	assert.match(view.noteText, new RegExp(DETAIL), 'backend detail must be visible on the row');
	assert.equal(active.props.disabled, false, 'retire of an active skill stays available');
	assert.equal(active.props.title, '停用（retire）');
});

test('available=true: candidate activate enabled, no disabled note', () => {
	const view = library({ available: true, reason: '', detail: '' });
	const candidate = candidateToggle(view);
	assert.equal(candidate.props.disabled, false, 'backend authorization must enable activate');
	assert.equal(candidate.props.title, '启用（activate）');
	assert.equal(view.notes.length, 0, 'no unavailable/unknown note when activation is available');
});

test('activation missing: activate disabled and explicitly reported as unknown', () => {
	const view = library(undefined);
	const candidate = candidateToggle(view);
	assert.equal(candidate.props.disabled, true, 'missing backend fact must never fabricate an available control');
	assert.match(candidate.props.title, /未知/, 'title must state availability is unknown');
	assert.match(view.noteText, /未知/, 'a visible note must state availability is unknown');
});

test('activation non-boolean: disabled as unknown, untrusted detail not shown', () => {
	const view = library({ available: 'yes', reason: '', detail: '客户端猜的' });
	const candidate = candidateToggle(view);
	assert.equal(candidate.props.disabled, true, 'non-boolean availability is not an authorization');
	assert.match(candidate.props.title, /未知/);
	assert.doesNotMatch(view.noteText, /客户端猜的/, 'detail must not be shown when availability is unknown');
});
