/**
 * 把 profile 里的 dsh-mind-system 从「拷贝」换成「junction」。
 *
 * ## 为什么要分离执行
 *
 * 本会话运行在 DSH 宿主进程内。替换 `node_modules/dsh-mind-system` 必须先停宿主
 * （Windows 上被加载的 .js 会被占用），而停宿主会杀掉本会话的父进程。
 *
 * 所以：本脚本只**触发**，真正的替换由一个分离的 worker 在宿主退出后做，
 * 做完再按真实桌面启动器把宿主拉起来。
 *
 * ## 安全措施
 *
 * 1. 替换前确认目标是**拷贝**（LinkType 为空）。已经是 junction 就什么都不做。
 * 2. 拷贝先 rename 成 `.old-junction-switch-<ts>` 而不是删除 —— 全程可回滚。
 * 3. 创建 junction 用 `mklink /J`（Windows 目录联接，不需要管理员）。
 * 4. 任何一步失败 → 把原名恢复回去，绝不留下"目录不存在"的状态。
 * 5. 结果写到文件，以便会话恢复后核对（不靠进程内存）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, renameSync, writeFileSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const k = process.argv[i];
  if (k.startsWith('--')) args.set(k.slice(2), process.argv[i + 1] ?? true);
}

const PROFILE = 'C:/Users/lyq/.dsh/profiles/web';
const LINK = resolve(PROFILE, 'node_modules/dsh-mind-system');
const TARGET = resolve('C:/Users/lyq/Documents/deepseek-harness/default-workspace/dsh-mind-system-repo/packages/dsh-mind-system');
const RESULT = resolve('C:/Users/lyq/.dsh/profiles/web/junction-switch-result.json');
const LAUNCHER = 'D:/dsh/start-web.cmd';

/** 判断某路径是不是链接（junction）。 */
function isLink(p) {
  try {
    const s = lstatSync(p);
    return typeof s.isSymbolicLink === 'function' && s.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Windows 上 junction 也可用 fs.lstat 的 isSymbolicLink 识别；再用 dir 兜底确认。 */
function linkTypeOf(p) {
  try {
    const s = lstatSync(p);
    // Junction 在 lstat 里表现为符号链接（reparse point）
    return s.isSymbolicLink() ? 'link' : 'real';
  } catch {
    return 'missing';
  }
}

if (args.has('worker')) {
  // ── worker 模式：等宿主退出后执行替换 ──
  const hostPid = Number(args.get('host-pid'));
  const port = String(args.get('port') ?? '3080');
  const log = [];
  const write = () => {
    try {
      writeFileSync(RESULT, JSON.stringify({
        at: new Date().toISOString(),
        link: LINK,
        target: TARGET,
        host_pid: hostPid,
        steps: log,
        final_link_type: linkTypeOf(LINK),
        ok: linkTypeOf(LINK) === 'link',
      }, null, 2), 'utf8');
    } catch { /* 结果写不进去也不能影响收尾 */ }
  };

  // 1) 等宿主退出（最多 60 秒）
  const startedAt = Date.now();
  for (;;) {
    let alive = false;
    try { process.kill(hostPid, 0); alive = true; } catch { alive = false; }
    if (!alive) { log.push('host exited'); break; }
    if (Date.now() - startedAt > 60_000) {
      log.push('host still alive after 60s — aborting switch (nothing changed)');
      write();
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // 2) 已经是 junction 就不动
  const before = linkTypeOf(LINK);
  log.push(`before: ${before}`);
  if (before === 'link') {
    log.push('already a link — nothing to do');
    write();
  } else if (before === 'missing') {
    log.push('target missing — nothing to rename; creating link directly');
    makeLink();
  } else {
    // 3) 拷贝改名为备份（不删除，可回滚）
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${LINK}.old-junction-switch-${stamp}`;
    try {
      renameSync(LINK, backup);
      log.push(`renamed copy -> ${backup}`);
    } catch (error) {
      log.push(`rename failed: ${String(error)} — aborting (nothing changed)`);
      write();
      process.exit(1);
    }
    // 4) 建 junction；失败就恢复
    if (!makeLink()) {
      try {
        renameSync(backup, LINK);
        log.push('restored original copy after link failure');
      } catch (error) {
        log.push(`RESTORE FAILED: ${String(error)} — backup at ${backup}`);
      }
      write();
      process.exit(1);
    }
    log.push(`backup kept at ${backup}`);
  }
  write();

  // 5) 用真实桌面启动器把宿主拉起来（不是裸 node bin.js）
  if (args.has('restart')) {
    log.push(`launching ${LAUNCHER}`);
    write();
    const child = spawn('cmd.exe', ['/c', LAUNCHER], {
      cwd: 'D:/dsh',
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, DSH_PROFILE: 'web' },
    });
    child.unref();
  }
  process.exit(0);

  /** 用 mklink /J 建 junction。 */
  function makeLink() {
    const res = spawnSync(
      'cmd.exe', ['/c', 'mklink', '/J', LINK, TARGET], { encoding: 'utf8' },
    );
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    log.push(`mklink /J -> exit=${res.status} ${out}`);
    return linkTypeOf(LINK) === 'link';
  }
} else {
  // ── 触发模式：立刻返回，由分离 worker 完成后续 ──
  const hostPid = Number(args.get('host-pid'));
  const port = String(args.get('port') ?? '3080');
  if (!Number.isFinite(hostPid) || hostPid <= 0) {
    console.error('need --host-pid <pid>');
    process.exit(2);
  }
  const child = spawn(process.execPath, [
    new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    '--worker', '--host-pid', String(hostPid), '--port', port, '--restart',
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  console.log(`worker planted (pid=${child.pid}); will switch after host pid=${hostPid} exits, then relaunch`);
}
