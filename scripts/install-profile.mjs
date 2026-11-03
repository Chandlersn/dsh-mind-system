/**
 * 把聚合包装进 DSH profile（**拷贝**，不是硬链接）。
 *
 * 用法：
 *   node scripts/install-profile.mjs                        # 默认 ~/.dsh/profiles/web/node_modules
 *   node scripts/install-profile.mjs --profile <node_modules 目录>
 *   node scripts/install-profile.mjs --dry-run              # 只说要做什么
 *
 * 为什么需要脚本而不是一条 `cp -r`：
 *
 * 1. 若目标目录与源码共享 inode（硬链接），`cp -r` 会**顺着链接改写源码**；
 * 2. 直接覆盖目录会在中途留下半套文件，此时 dsh 若去 import 就会崩；
 * 3. 2026-11-03 实际发生过：手工 `rm -rf` + `mv` 因为沙箱把 cp 落在隔离层里，
 *    结果只删掉了真实目录、没换成新的——运行实例当场缺文件。
 *
 * 所以顺序固定为：**先拷到同级临时目录 → 校验 → 再换**。任何一步失败，旧副本原样不动。
 *
 * @module scripts/install-profile
 */
import { cpSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { computeTargets, compare, repoRoot } from './build/plan.mjs';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const profileArg = argv.indexOf('--profile');
const profileRoot =
	profileArg >= 0
		? argv[profileArg + 1]
		: process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'web', 'node_modules');

if (profileRoot === undefined) throw new Error('--profile 后面要跟一个目录');

const { manifest, pkgRoot, files } = await computeTargets();
const target = join(profileRoot, 'dsh-mind-system');

// 1) 产物必须先和源一致，否则装进去的是旧东西。
const diff = compare(pkgRoot, files, manifest.stamp ?? 'build-stamp.json');
const drift = diff.missing.length + diff.changed.length + diff.extra.length;
if (drift > 0) {
	console.error(
		`产物与源不一致（${drift} 处），先跑 npm run build。装一份陈旧产物是最难查的故障。`
	);
	process.exit(1);
}

// 2) 目标目录必须**看起来**是已装的 dsh-mind-system，避免 --profile 打错把别的东西删了。
if (existsSync(target)) {
	let name;
	try {
		name = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name;
	} catch {
		name = undefined;
	}
	if (name !== 'dsh-mind-system') {
		console.error(`拒绝操作：${target} 存在，但不是 dsh-mind-system（package.json name=${name}）。`);
		process.exit(1);
	}
}

const staging = `${target}.installing-${process.pid}`;
console.log(`源  ：${pkgRoot}`);
console.log(`目标：${target}`);
if (dryRun) {
	console.log(`（dry-run）会先拷到 ${staging}，校验通过后再替换目标目录。`);
	process.exit(0);
}

// 3) 先拷到同级临时目录。同级是必须的——rename 不能跨卷。
rmSync(staging, { recursive: true, force: true });
cpSync(pkgRoot, staging, { recursive: true });

// 4) 校验：文件数与关键不变量。任何一条不符，旧副本不动。
//    基准取**源目录**的实际文件数，而不是产物表的大小——产物表只含成员文件和指纹，
//    包根的手写文件（index.js、manifest、README…）不在表里，但必须一起装进去。
const { walkFiles } = await import('./build/plan.mjs');
const expect = walkFiles(pkgRoot).length;
const got = walkFiles(staging).length;
if (got !== expect) {
	rmSync(staging, { recursive: true, force: true });
	console.error(`拒绝替换：新副本有 ${got} 个文件，源目录有 ${expect} 个。`);
	process.exit(1);
}

const clientPath = join(staging, 'memory', 'client.js');
if (!readFileSync(clientPath, 'utf8').includes("\tid: 'dsh-mind-system',")) {
	rmSync(staging, { recursive: true, force: true });
	console.error('拒绝替换：新副本里 memory/client.js 的注册 id 不是 dsh-mind-system。');
	process.exit(1);
}

// 5) 换。旧目录整个删掉——它是拷贝，删了不影响源码。
rmSync(target, { recursive: true, force: true });
renameSync(staging, target);

console.log(`已安装 ${got} 个文件（拷贝，非硬链接）。`);
console.log('重启 dsh 后生效：源码改了不会自动进运行实例。');
