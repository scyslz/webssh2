/**
 * SFTP 复制 / 移动 / 递归删除原语。
 *
 * 每个操作有两条执行路径：
 *   1. **shell 快路径**（`exec` 可用）—— `cp` / `mv` / `rm` 全在远端本地完成，数据不出机器；
 *   2. **SFTP 兜底**（无 shell 的账号，如 `ForceCommand internal-sftp`）—— 协议层自己递归。
 *
 * 分流规则是这里最要紧的一点：只有 exec **通道建不起来**才回退；命令跑起来了但返回非 0
 * 时**必须直接报错**，否则 `cp` 半途失败会再跑一遍流式复制，叠加出脏文件。
 *
 * 另外 `mkdir` / `rename` 不需要快路径：SFTP 的 `MKDIR` / `RENAME` 就是服务端本地的
 * `mkdir(2)` / `rename(2)`，数据量本来就是 0，而且同文件系统下 `RENAME` 还是原子的。
 *
 * 这里刻意不依赖 ssh2 的类型，只按「鸭子类型」调用传入的 sftp handle，
 * 便于用内存实现做单元测试。
 */

import type { ExecRunner } from './remote-exec.ts';
import { buildCommand } from './remote-exec.ts';

/** 只按鸭子类型约束用到的 SFTP 子集 */
export interface SftpLike {
  createReadStream(path: string): any;
  createWriteStream(path: string, options?: { mode?: number }): any;
  stat(path: string, cb: (err?: any, attrs?: any) => void): void;
  mkdir(path: string, attrs: { mode?: number } | undefined, cb: (err?: any) => void): void;
  readdir(path: string, cb: (err: any, entries: any[]) => void): void;
  unlink(path: string, cb: (err?: any) => void): void;
  rmdir(path: string, cb: (err?: any) => void): void;
  rename(from: string, to: string, cb: (err?: any) => void): void;
}

/** 一次操作需要的全部上下文：SFTP handle 必备，exec 可选（不可用即走兜底） */
export interface OpContext {
  sftp: SftpLike;
  exec?: ExecRunner;
}

/** shell 快路径的三种结局 */
type NativeOutcome =
  | { type: 'ok' }
  /** 没有可用的 shell → 调用方改用 SFTP 实现 */
  | { type: 'fallback' }
  /** 命令确实跑了但失败 → 直接报错，不可回退 */
  | { type: 'error'; error: Error };

function joinPath(parent: string, name: string) {
  return parent.endsWith('/') ? `${parent}${name}` : `${parent}/${name}`;
}

function toError(err: any): Error | undefined {
  if (!err) return undefined;
  return err instanceof Error ? err : new Error(String(err));
}

/** 从 SFTP attrs 里取出权限位（去掉文件类型位） */
function modeOf(attrs: any): number | undefined {
  const mode = attrs?.mode;
  return typeof mode === 'number' ? mode & 0o777 : undefined;
}

/** 判断远端路径是否存在（stat 报错即视为不存在） */
export function sftpPathExists(sftp: SftpLike, targetPath: string, cb: (exists: boolean) => void) {
  sftp.stat(targetPath, (err?: any) => cb(!err));
}

/**
 * 把目录放进它自己内部（含目标就等于源）是非法操作，会导致无限递归。
 * 用 `${sourcePath}/` 前缀比较，避免把 `/a/b2` 误判成在 `/a/b` 里面。
 */
function selfReferenceError(sourcePath: string, targetPath: string, isDir: boolean): Error | undefined {
  if (!isDir) return undefined;
  if (targetPath === sourcePath || targetPath.startsWith(`${sourcePath}/`)) {
    return new Error('Target is inside the source directory');
  }
  return undefined;
}

/**
 * 尝试走 shell 快路径。
 *
 * 若 exec 不可用（没传、命令无法转义、或探测判定无 shell），回调 `fallback`，
 * 由调用方接上 SFTP 实现 —— 这样 SFTP-only 账号依然可用。
 */
function runNative(ctx: OpContext, prefix: string, args: string[], out: (outcome: NativeOutcome) => void) {
  if (!ctx.exec) return out({ type: 'fallback' });
  const command = buildCommand(prefix, args);
  if (command === null) return out({ type: 'fallback' });
  ctx.exec.run(command, (result) => {
    if (result.kind === 'done') return out({ type: 'ok' });
    if (result.kind === 'no-shell') return out({ type: 'fallback' });
    out({ type: 'error', error: new Error(result.message) });
  });
}

/**
 * 底层递归复制：会覆盖已存在的目标，**仅限内部使用**。
 *
 * - 文件：读流 pipe 到写流，并把源权限位透传给 `createWriteStream`，
 *   否则复制出来的脚本会丢掉可执行位（ssh2 的写流默认 `0o666`）。
 * - 目录：先 mkdir，再逐项串行递归（避免一次打爆 SFTP channel 的并发窗口）。
 * - `done` 只会被调用一次：ssh2 stream 的 error / close 可能都触发，内部有 settled 保护。
 *
 * `knownMode` 由上一层 `readdir` 的 attrs 直接带下来，省掉每个文件一次 `stat` 往返。
 */
function copyTree(
  sftp: SftpLike,
  sourcePath: string,
  targetPath: string,
  isDir: boolean,
  done: (err?: Error) => void,
  knownMode?: number,
) {
  let settled = false;
  const finish = (err?: Error) => {
    if (settled) return;
    settled = true;
    done(err);
  };

  if (isDir && (targetPath === sourcePath || targetPath.startsWith(`${sourcePath}/`))) {
    return finish(new Error('Target is inside the source directory'));
  }

  if (!isDir) {
    const readStream = sftp.createReadStream(sourcePath);
    const writeStream = sftp.createWriteStream(targetPath, knownMode === undefined ? undefined : { mode: knownMode });
    readStream.on('error', (err: Error) => finish(err));
    writeStream.on('error', (err: Error) => finish(err));
    writeStream.on('close', () => finish());
    readStream.pipe(writeStream);
    return;
  }

  sftp.mkdir(targetPath, knownMode === undefined ? undefined : { mode: knownMode }, (mkdirErr: any) => {
    if (mkdirErr) return finish(toError(mkdirErr));
    sftp.readdir(sourcePath, (readErr: any, entries: any[]) => {
      if (readErr) return finish(toError(readErr));
      let index = 0;
      const step = () => {
        if (index >= entries.length) return finish();
        const entry = entries[index++];
        copyTree(
          sftp,
          joinPath(sourcePath, entry.filename),
          joinPath(targetPath, entry.filename),
          entry.attrs.isDirectory(),
          (err?: Error) => (err ? finish(err) : step()),
          modeOf(entry.attrs),
        );
      };
      step();
    });
  });
}

/** 兜底复制的入口：先取一次顶层权限位，再交给 copyTree */
function copyViaSftp(sftp: SftpLike, sourcePath: string, targetPath: string, isDir: boolean, done: (err?: Error) => void) {
  sftp.stat(sourcePath, (statErr: any, attrs: any) => {
    copyTree(sftp, sourcePath, targetPath, isDir, done, statErr ? undefined : modeOf(attrs));
  });
}

/**
 * 复制一个远端条目（对外入口）。
 *
 * 目标已存在时直接报错，不覆盖 —— `cp` 默认静默覆盖，覆盖是静默数据丢失，
 * 必须让用户显式先删（不用 `cp -n`，那样区分不了「跳过」和「成功」）。
 */
export function copyEntry(
  ctx: OpContext,
  sourcePath: string,
  targetPath: string,
  isDir: boolean,
  done: (err?: Error) => void,
) {
  const selfRef = selfReferenceError(sourcePath, targetPath, isDir);
  if (selfRef) return done(selfRef);
  sftpPathExists(ctx.sftp, targetPath, (exists) => {
    if (exists) return done(new Error('Target already exists'));
    // `-p` 保留权限与时间戳。非 root 用户无法保留属主时 GNU/BSD/busybox 的 cp 都会静默跳过，
    // 不会因此返回非 0，所以这里不会把成功的复制误报成失败。
    runNative(ctx, 'cp', ['-R', '-p', '--', sourcePath, targetPath], (outcome) => {
      if (outcome.type === 'ok') return done();
      if (outcome.type === 'error') return done(outcome.error);
      copyViaSftp(ctx.sftp, sourcePath, targetPath, isDir, done);
    });
  });
}

/**
 * 移动一个远端条目（对外入口）。
 *
 * 先走 SFTP `rename`（同文件系统上是原子的、零拷贝，且比起一个 shell 更省）。
 * 失败时**不能盲目退回复制**：rename 失败有两种原因，必须区分开 ——
 *   1. 跨文件系统（语义等价于 EXDEV）→ 退到 `mv`（coreutils 自己就带 copy+unlink 退化）或流式复制；
 *   2. 目标已存在 → 必须报错终止，否则「复制覆盖 + 删源」会把目标文件静默毁掉。
 */
export function moveEntry(
  ctx: OpContext,
  sourcePath: string,
  targetPath: string,
  isDir: boolean,
  done: (err?: Error) => void,
) {
  if (targetPath === sourcePath) return done();
  const selfRef = selfReferenceError(sourcePath, targetPath, isDir);
  if (selfRef) return done(selfRef);

  ctx.sftp.rename(sourcePath, targetPath, (renameErr: any) => {
    if (!renameErr) return done();
    sftpPathExists(ctx.sftp, targetPath, (exists) => {
      if (exists) return done(new Error('Target already exists'));
      runNative(ctx, 'mv', ['--', sourcePath, targetPath], (outcome) => {
        if (outcome.type === 'ok') return done();
        if (outcome.type === 'error') return done(outcome.error);
        copyViaSftp(ctx.sftp, sourcePath, targetPath, isDir, (copyErr?: Error) => {
          if (copyErr) return done(copyErr);
          removeSftpPath(ctx.sftp, sourcePath, isDir, done);
        });
      });
    });
  });
}

/**
 * 递归删除一个远端路径（对外入口）。
 *
 * 文件走协议层 `unlink` —— 一次往返，起 shell 没有任何收益。
 * 目录用 `rm -rf` —— 协议层得自底向上逐项 `readdir` + `rmdir`，N 个文件就是约 2N 次往返；
 * 而且 `rmdir` 只能删空目录，中间出错容易留下半删状态。
 */
export function removeEntry(
  ctx: OpContext,
  targetPath: string,
  isDir: boolean,
  done: (err?: Error) => void,
) {
  if (!targetPath || targetPath === '/') return done(new Error('Refusing to remove the root path'));
  if (!isDir) return ctx.sftp.unlink(targetPath, (err?: any) => done(toError(err)));
  runNative(ctx, 'rm', ['-rf', '--', targetPath], (outcome) => {
    if (outcome.type === 'ok') return done();
    if (outcome.type === 'error') return done(outcome.error);
    removeSftpPath(ctx.sftp, targetPath, true, done);
  });
}

/**
 * 纯 SFTP 递归删除，同时也是 `removeEntry` 的兜底实现。
 *
 * SFTP 的 `rmdir` 只能删空目录，所以必须自底向上：先清空子项，再删自身。
 */
export function removeSftpPath(
  sftp: SftpLike,
  targetPath: string,
  isDir: boolean,
  done: (err?: Error) => void,
) {
  if (!isDir) return sftp.unlink(targetPath, (err?: any) => done(toError(err)));
  sftp.readdir(targetPath, (readErr: any, entries: any[]) => {
    if (readErr) return done(toError(readErr));
    let index = 0;
    const step = () => {
      if (index >= entries.length) return sftp.rmdir(targetPath, (err?: any) => done(toError(err)));
      const entry = entries[index++];
      removeSftpPath(
        sftp,
        joinPath(targetPath, entry.filename),
        entry.attrs.isDirectory(),
        (err?: Error) => (err ? done(err) : step()),
      );
    };
    step();
  });
}
