import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, linkSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const fail = (code, message) => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const inside = (root, target) => {
  const name = relative(root, target);
  return name !== '' && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
};

/** Resolve missing parents while rejecting lexical and existing symlink escapes. */
function resolveInside(root, target) {
  if (typeof target !== 'string' || target.trim() === '' || target.includes('\0')) {
    fail('invalid_path', 'A target file path is required.');
  }
  const absolute = resolve(root, target);
  if (!inside(root, absolute)) fail('out_of_scope', 'The target escapes the runtime workspace.');
  // Alternate data streams and device names are not ordinary file targets on Windows.
  if (process.platform === 'win32' && relative(root, absolute).split(/[\\/]/).some(segment =>
    /[:]/.test(segment) || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    fail('invalid_path', 'The target must name an ordinary workspace file.');
  }
  let ancestor = dirname(absolute);
  const missing = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) fail('invalid_path', 'No existing target ancestor.');
    missing.unshift(relative(parent, ancestor));
    ancestor = parent;
  }
  const realAncestor = realpathSync(ancestor);
  if (realAncestor !== root && !inside(root, realAncestor)) {
    fail('out_of_scope', 'The target parent resolves outside the runtime workspace.');
  }
  return join(realAncestor, ...missing, relative(dirname(absolute), absolute));
}

/** Publish complete bytes without replacing a target created by another writer. */
function writeAtomic(target, content) {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.runtime-write-${randomUUID()}.tmp`);
  let ownsTemporary = false;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    ownsTemporary = true;
    // A hard link refuses an existing leaf atomically; rename could clobber it after a race.
    linkSync(temporary, target);
  } catch (error) {
    if (error.code === 'EEXIST') fail('target_exists', 'Refusing to replace an existing workspace file.');
    throw error;
  } finally {
    // Publication may have succeeded. Cleanup failure must not turn that effect into a false failure.
    if (ownsTemporary) {
      try { rmSync(temporary); } catch { /* An orphan temp is safe to inspect later. */ }
    }
  }
}

function createWriteTool({ name, root, description, prepare }) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Target file, relative to the runtime workspace or absolute inside it.' },
        content: { type: 'string', description: 'The UTF-8 content to write.' },
        createOnly: { type: 'boolean', enum: [true], description: 'Must be true when supplied; existing files are always refused.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      if (args?.createOnly !== undefined && args.createOnly !== true) {
        fail('overwrite_not_allowed', 'Runtime write tools only create new files.');
      }
      const target = resolveInside(root, args?.path);
      const content = prepare(args?.content);
      writeAtomic(target, content);
      return { path: target, bytes: Buffer.byteLength(content, 'utf8'), created: true };
    },
  };
}

/** Native create-only tools for the mount scope. No overwrite or automatic compensation is granted.
 * Hard-link publication requires local filesystem support and does not promise power-loss durability.
 * Parent paths are checked at call time; concurrent hostile directory replacement is outside this contract.
 */
export function createWriteTools({ root }) {
  if (typeof root !== 'string' || root.trim() === '') fail('invalid_scope', 'A workspace root is required.');
  const rootReal = realpathSync(root);
  return [
    createWriteTool({
      name: 'runtime_write_json', root: rootReal,
      description: 'Create a UTF-8 JSON file inside the runtime workspace. Refuse existing files and paths outside the workspace. Publish complete bytes without replacing a concurrent writer.',
      prepare(content) {
        if (typeof content !== 'string') fail('invalid_content', 'JSON content must be a string.');
        try { JSON.parse(content); } catch { fail('invalid_content', 'The content is not valid JSON.'); }
        return content;
      },
    }),
    createWriteTool({
      name: 'runtime_write_text', root: rootReal,
      description: 'Create a UTF-8 text file inside the runtime workspace. Refuse existing files and paths outside the workspace. Publish complete bytes without replacing a concurrent writer.',
      prepare(content) {
        if (typeof content !== 'string') fail('invalid_content', 'Text content must be a string.');
        return content;
      },
    }),
  ];
}
