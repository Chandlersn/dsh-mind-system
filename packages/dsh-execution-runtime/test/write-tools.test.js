/**
 * The write tools: the half of the recipe contract that was missing.
 *
 * Until these were registered, every generated task died at admission's `tool_not_visible`
 * gate -- the recipe named `runtime_write_json` and nothing answered to that name. That is
 * why the runtime had four failed runs and zero successful ones.
 *
 * These tests pin the properties that make the tool safe to hand a recipe, in the order they
 * matter: it refuses to escape the workspace, it refuses to overwrite, it fails closed, and
 * only then does it write correctly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

import { createWriteTools } from '../src/write-tools.js';

const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-write-'));
  return { root, tools: createWriteTools({ root }) };
};

const toolNamed = (tools, name) => {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} must exist`);
  return tool;
};

test('a write lands inside the workspace and reports the real byte count', async () => {
  const { root, tools } = fresh();
  try {
    const target = join(root, 'out.json');
    const result = await toolNamed(tools, 'runtime_write_json')
      .execute({ path: 'out.json', content: '{"a":1}' });
    assert.equal(result.created, true);
    assert.equal(readFileSync(target, 'utf8'), '{"a":1}');
    assert.equal(result.bytes, 7);
    // Reported size is read from disk, not from the string length.
    assert.equal(result.bytes, readFileSync(target).length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a path outside the workspace is refused, including one that climbs with ..', async () => {
  const { root, tools } = fresh();
  try {
    const tool = toolNamed(tools, 'runtime_write_json');
    // Climbing out with `..`
    await assert.rejects(
      () => tool.execute({ path: '../escaped.json', content: '{}' }),
      (e) => e.code === 'out_of_scope',
      'a .. climb must be refused',
    );
    // An absolute path outside the root
    const outside = join(tmpdir(), 'outside-target.json');
    await assert.rejects(
      () => tool.execute({ path: outside, content: '{}' }),
      (e) => e.code === 'out_of_scope',
      'an absolute path outside the root must be refused',
    );
    assert.equal(existsSync(join(root, '..', 'escaped.json')), false, 'nothing was written outside');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createOnly refuses to replace an existing file, and says so rather than succeeding', async () => {
  const { root, tools } = fresh();
  try {
    const tool = toolNamed(tools, 'runtime_write_json');
    writeFileSync(join(root, 'existing.json'), '{"original":true}', 'utf8');
    await assert.rejects(
      () => tool.execute({ path: 'existing.json', content: '{"replaced":true}' }),
      (e) => e.code === 'target_exists',
    );
    // The original bytes survive: a refused write is not a partial one.
    assert.equal(readFileSync(join(root, 'existing.json'), 'utf8'), '{"original":true}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createOnly:false cannot enable an unowned overwrite', async () => {
  const { root, tools } = fresh();
  try {
    const tool = toolNamed(tools, 'runtime_write_json');
    writeFileSync(join(root, 'existing.json'), '{"original":true}', 'utf8');
    await assert.rejects(
      () => tool.execute({ path: 'existing.json', content: '{"replaced":true}', createOnly: false }),
      (error) => error.code === 'overwrite_not_allowed',
    );
    assert.equal(readFileSync(join(root, 'existing.json'), 'utf8'), '{"original":true}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid JSON is refused before anything is written', async () => {
  const { root, tools } = fresh();
  try {
    await assert.rejects(
      () => toolNamed(tools, 'runtime_write_json').execute({ path: 'bad.json', content: 'not json' }),
      (e) => e.code === 'invalid_content',
    );
    assert.equal(existsSync(join(root, 'bad.json')), false, 'a refused write leaves no file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the text tool accepts non-JSON content', async () => {
  const { root, tools } = fresh();
  try {
    const result = await toolNamed(tools, 'runtime_write_text')
      .execute({ path: 'note.txt', content: 'plain text, not json' });
    assert.equal(result.created, true);
    assert.equal(readFileSync(join(root, 'note.txt'), 'utf8'), 'plain text, not json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a nested target creates its parent directory rather than failing', async () => {
  const { root, tools } = fresh();
  try {
    const result = await toolNamed(tools, 'runtime_write_json')
      .execute({ path: join('nested', 'deep', 'out.json'), content: '[]' });
    assert.equal(result.created, true);
    assert.equal(readFileSync(join(root, 'nested', 'deep', 'out.json'), 'utf8'), '[]');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a symlink pointing outside the workspace cannot be used to escape it', async (t) => {
  const { root, tools } = fresh();
  const outsideDir = mkdtempSync(join(tmpdir(), 'runtime-outside-'));
  try {
    // Creating a directory symlink on Windows needs either elevation or Developer Mode. When the
    // platform refuses, this specific check cannot be exercised here, so it is reported as
    // skipped: "we did not test it" and "it passed" are different facts and only one belongs in
    // a green run.
    try {
      symlinkSync(outsideDir, join(root, 'link-out'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`cannot create a directory symlink here: ${error.code}`);
      return;
    }
    await assert.rejects(
      () => toolNamed(tools, 'runtime_write_json').execute({ path: join('link-out', 'x.json'), content: '{}' }),
      (e) => e.code === 'out_of_scope',
      'the realpath of the parent is outside the root, so this must be refused',
    );
    assert.equal(existsSync(join(outsideDir, 'x.json')), false, 'nothing landed outside');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('tool names are safe for strict LLM APIs (no dots or exotic characters)', () => {
  const { root, tools } = fresh();
  try {
    // dsh allows exotic tool names internally, but Codex/Responses gates reject
    // everything outside [A-Za-z0-9_-] in tools[].name (HTTP 400 before any turn).
    for (const tool of tools) assert.match(tool.name, /^[a-zA-Z0-9_-]+$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a target published by a competing writer is never replaced', async () => {
  const { root, tools } = fresh();
  const originalLink = fs.linkSync;
  const target = join(root, 'race.txt');
  let observed = false;
  fs.linkSync = (temporary, destination) => {
    observed = true;
    writeFileSync(destination, 'concurrent bytes', { flag: 'wx' });
    return originalLink(temporary, destination);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => toolNamed(tools, 'runtime_write_text')
      .execute({ path: 'race.txt', content: 'replacement' }), (error) => error.code === 'target_exists');
    assert.equal(observed, true, 'The competing writer must run at publication.');
    assert.equal(readFileSync(target, 'utf8'), 'concurrent bytes');
    assert.deepEqual(fs.readdirSync(root), ['race.txt'], 'Only the owned temporary file is cleaned.');
  } finally {
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a temporary path collision does not delete a file owned by someone else', async () => {
  const { root, tools } = fresh();
  const originalWrite = fs.writeFileSync;
  let collided;
  fs.writeFileSync = (path, content, options) => {
    if (String(path).includes('.runtime-write-')) {
      collided = path;
      originalWrite(path, 'foreign bytes', { flag: 'wx' });
    }
    return originalWrite(path, content, options);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => toolNamed(tools, 'runtime_write_text')
      .execute({ path: 'out.txt', content: 'new bytes' }), (error) => error.code === 'target_exists');
    assert.ok(collided, 'The temporary collision must actually occur.');
    assert.equal(readFileSync(collided, 'utf8'), 'foreign bytes');
    assert.equal(existsSync(join(root, 'out.txt')), false);
  } finally {
    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test('both tools expose the shape the host registry expects', () => {
  const { root, tools } = fresh();
  try {
    assert.deepEqual(tools.map((t) => t.name), ['runtime_write_json', 'runtime_write_text']);
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.length > 0);
      assert.equal(tool.parameters.type, 'object');
      assert.deepEqual(tool.parameters.required, ['path', 'content']);
      assert.equal(typeof tool.execute, 'function');
      assert.equal(typeof tool.output.render, 'function');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the bounded replacement tool is opt-in and not part of the default create-only set', () => {
  const { root, tools } = fresh();
  try {
    assert.equal(tools.some((t) => t.name === 'runtime_replace_json'), false,
      'createWriteTools must not expose the replacement tool by default.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
