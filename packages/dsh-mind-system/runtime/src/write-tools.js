import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, linkSync, rmSync, readFileSync, writeFileSync, realpathSync,
  closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readSync, writeSync,
} from 'node:fs';
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

const SHA256 = /^[a-f0-9]{64}$/;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Reject a target that is not an ordinary, single-link file inside `root`.
 *
 * `resolveInside` already rejects lexical escapes, symlinked parents, Windows device names and
 * alternate data streams. The remaining checks are about the leaf itself: it must already exist,
 * be a regular non-symlink file, and have exactly one hard link (nlink===1). A multi-link target is
 * refused because an in-place overwrite would silently mutate the other links.
 */
function assertReplacableTarget(root, args) {
  const target = resolveInside(root, args?.path);
  if (typeof args?.content !== 'string') fail('invalid_content', 'Replacement content must be a string.');
  if (typeof args?.expectedSha256 !== 'string' || !SHA256.test(args.expectedSha256)) {
    fail('invalid_hash', 'expectedSha256 must be a lowercase 64-character hex SHA-256.');
  }
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('target_not_regular', 'Replacement requires a regular non-symlink file.');
  if (stat.nlink !== 1) fail('target_linked', 'Replacement requires a single-link file (nlink===1).');
  const observed = sha256(readFileSync(target));
  if (observed !== args.expectedSha256) fail('hash_mismatch', 'The target no longer matches the expected SHA-256.');
  return { target, observed, stat };
}

/**
 * Atomically replace the bytes of an existing file in place, preserving its inode.
 *
 * The file is opened with O_RDWR (never O_TRUNC, never a temp rename), re-read and re-hashed under the
 * lock of the open descriptor, and fstat-ed again to confirm nlink and inode are unchanged. Only then
 * is it truncated and the new bytes written, with a final fstat confirming inode/nlink held through
 * the commit. Because the descriptor pins the same inode, concurrent hard-link creation cannot redirect
 * the write, and no other path is ever created or removed.
 */
function replaceInPlace(target, { expectedSha256, content, observed, stat }) {
  let fd;
  try {
    fd = openSync(target, constants.O_RDWR);
    const live = fstatSync(fd);
    if (!live.isFile() || live.nlink !== 1 || live.ino !== stat.ino || live.dev !== stat.dev) {
      fail('target_changed', 'The target inode or link count changed before commit.');
    }
    const current = Buffer.alloc(live.size);
    let offset = 0;
    while (offset < current.length) offset += readSync(fd, current, offset, current.length - offset, offset);
    if (sha256(current) !== expectedSha256 || sha256(current) !== observed) {
      fail('hash_mismatch', 'The target changed between validation and commit.');
    }
    const replacement = Buffer.from(content, 'utf8');
    ftruncateSync(fd, 0);
    let written = 0;
    while (written < replacement.length) written += writeSync(fd, replacement, written, replacement.length - written, written);
    const after = fstatSync(fd);
    if (after.ino !== stat.ino || after.dev !== stat.dev || after.nlink !== 1 || after.size !== replacement.length) {
      fail('target_changed', 'The target inode, link count or size changed during commit.');
    }
    return { bytes: replacement.length, inode: stat.ino };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* Descriptor cleanup cannot undo a committed write. */ } }
  }
}

/**
 * Opt-in, host-owned bounded replacement for the create-only write tools.
 *
 * Registered only when the host explicitly enables it; the model cannot widen authority by calling it,
 * because admission already checks the task template's `allowedTools` and the repair policy's strict
 * schema. This tool never creates, renames, or removes a file.
 */
export function createReplaceTool({ root }) {
  if (typeof root !== 'string' || root.trim() === '') fail('invalid_scope', 'A workspace root is required.');
  const rootReal = realpathSync(root);
  return {
    name: 'runtime_replace_json',
    description: 'Atomically replace the UTF-8 content of an existing single-link JSON file inside the '
      + 'runtime workspace, preserving its inode. The exact current SHA-256 must be supplied and is '
      + 're-checked at commit; symlinks, extra hard links and paths outside the workspace are refused.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Existing target file, relative to the runtime workspace or absolute inside it.' },
        content: { type: 'string', description: 'The UTF-8 JSON content to write.' },
        expectedSha256: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'SHA-256 of the current file bytes.' },
      },
      required: ['path', 'content', 'expectedSha256'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' }, bytes: { type: 'integer' }, replaced: { type: 'boolean' }, inode: { type: 'integer' },
        },
        required: ['path', 'bytes', 'replaced'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const checked = assertReplacableTarget(rootReal, args);
      try { JSON.parse(args.content); }
      catch { fail('invalid_content', 'The replacement content is not valid JSON.'); }
      const result = replaceInPlace(checked.target, {
        expectedSha256: args.expectedSha256, content: args.content,
        observed: checked.observed, stat: checked.stat,
      });
      return { path: checked.target, bytes: result.bytes, replaced: true, inode: result.inode };
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
