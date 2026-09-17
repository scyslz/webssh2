/**
 * 通过 SSH exec 通道在远端执行 shell 命令。
 *
 * 为什么需要它：SFTP 协议层没有服务端 copy 原语，`rmdir` 也只能删空目录，
 * 所以「复制 / 跨盘移动 / 递归删除」用纯 SFTP 实现时，数据必须绕回本进程再写回去
 * —— 同一台机器上复制文件，却让全部字节穿越两趟公网。
 * 改走 `cp` / `mv` / `rm` 后这些操作全在远端本地完成，网络流量归零。
 *
 * 但不是所有账号都有 shell（`ForceCommand internal-sftp`、受限 shell、rssh）。
 * 所以这里做**能力探测**并缓存结果：只有探测通过才走 shell，否则调用方必须回退到 SFTP 实现。
 * 探测用一次 `echo <marker>`：通道建不起来、退出码非 0、或 stdout 里没有 marker（被 ForceCommand
 * 换成了 internal-sftp 就会这样），都判定为「没有可用 shell」。
 *
 * 文件里有两套东西，别混：
 *  - `createExecRunner` —— 文件操作用的「成功/失败/没 shell」三态，只关心成败。
 *  - `execCapture` —— AI 输出分析用的完整采集，带 stdout/stderr/退出码。
 */

import type { Client } from 'ssh2';
import { StringDecoder } from 'node:string_decoder';
import { sshLog } from './lib.ts';

const PROBE_MARKER = '__webssh_exec_ok__';

/** 一次远端命令的结果 */
export type ExecResult =
  | { kind: 'done' }
  /** 命令跑起来了但失败 —— 调用方**不可**回退到 SFTP，否则会二次写入 */
  | { kind: 'failed'; message: string }
  /** 没有可用的 shell —— 调用方应回退到 SFTP 实现 */
  | { kind: 'no-shell' };

export interface ExecRunner {
  run(command: string, done: (result: ExecResult) => void): void;
}

/**
 * POSIX 单引号转义。返回 null 表示该字符串无法安全表达，调用方必须放弃 shell 路径。
 *
 * 单引号内除 `'` 外一切都是字面量，所以 `'` 用 `'\''`（关引号 → 转义 → 重开引号）绕过。
 * NUL 和换行在 argv 层面就是分隔符/终止符，无法表达，直接拒绝。
 */
export function shellQuote(raw: string): string | null {
  if (!raw) return null;
  if (/[\0\r\n]/.test(raw)) return null;
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

/** 拼接一条命令；任一参数无法转义时返回 null，调用方需回退 SFTP */
export function buildCommand(prefix: string, args: string[]): string | null {
  const quoted: string[] = [];
  for (const arg of args) {
    const q = shellQuote(arg);
    if (q === null) return null;
    quoted.push(q);
  }
  return `${prefix} ${quoted.join(' ')}`;
}

/* ------------------------------------------------------------------ *
 * 结构化采集（AI Agent 用）
 *
 * 上面那套 `ExecRunner` 只回答「成功 / 失败 / 没 shell」，够文件操作用，
 * 但做输出分析不够 —— 判断一条命令为什么失败，stdout、stderr、退出码三者缺一不可。
 * `execCapture` 是它的补充：同样是走 `conn.exec()`，但把输出完整带回来。
 *
 * 两点刻意保持独立：
 *  1. **不改 `ExecResult`** —— `sftp-ops` 依赖它的三态语义（尤其「跑起来了但非 0
 *     不能回退 SFTP，否则二次写入」这条），加字段会把这个约束搅浑。
 *  2. **用 Promise 而不是回调** —— 调用方（终端 WS 帧）本来就是异步链路。
 * ------------------------------------------------------------------ */

/** 一次采集的结果 */
export interface CaptureResult {
  stdout: string;
  stderr: string;
  /** 远端退出码；`null` 表示超时被掐断或通道异常结束，拿不到真实退出码 */
  code: number | null;
  /** 输出超过字节上限，尾部已被丢弃 */
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  /** 通道层错误（不是命令失败），例如连接中断 */
  channelError?: string;
}

export type CaptureOutcome = ({ kind: 'captured' } & CaptureResult) | { kind: 'no-shell' };

export interface CaptureOptions {
  /** 本地等待上限，到点掐通道。默认 20s */
  timeoutMs?: number;
  /** stdout / stderr **各自**累计的字节上限，默认 128 KiB */
  maxBytes?: number;
  /**
   * 在远端套一层 `timeout`，让远端自己杀进程。
   *
   * 为什么需要：本地超时只能关掉 SSH 通道，sshd 会不会连带杀掉远端子进程取决于
   * 服务端实现，**不保证**。套 `timeout` 是唯一可靠的远端自保手段。
   * 代价：极简系统（没有 coreutils、busybox 也没编 `timeout`）会以 127 失败，
   * 调用方需要能识别这种情况再退一步。默认关闭。
   */
  enforceRemoteTimeout?: boolean;
}

const DEFAULT_CAPTURE_TIMEOUT_MS = 20_000;
const DEFAULT_CAPTURE_MAX_BYTES = 128 * 1024;

/**
 * 采集一次远端命令的完整输出。
 *
 * 命令会被前缀 `LC_ALL=C LANG=C`：让 stderr 保持英文原文，否则错误分类器要面对
 * 每种语言一套措辞。命令本身仍可自行覆盖这两个变量。
 *
 * 输出上限到顶后**继续消费但不记录** —— 通道的输出窗口打满就永不 close，
 * 停掉监听会让这次采集永远不返回。
 */
export async function execCapture(
  client: Client,
  command: string,
  options: CaptureOptions = {},
): Promise<CaptureOutcome> {
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_CAPTURE_TIMEOUT_MS;
  const maxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : DEFAULT_CAPTURE_MAX_BYTES;

  const prefixed = options.enforceRemoteTimeout
    ? `LC_ALL=C LANG=C timeout -k 2 ${Math.max(1, Math.ceil(timeoutMs / 1000))} -- ${command}`
    : `LC_ALL=C LANG=C ${command}`;

  return new Promise<CaptureOutcome>((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (outcome: CaptureOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };

    let stream: any;
    try {
      client.exec(prefixed, (err: Error | undefined, s: any) => {
        if (err) return finish({ kind: 'no-shell' });
        stream = s;
        attach(stream);
      });
    } catch {
      // 同步抛错 = 客户端未连接/已断开
      finish({ kind: 'no-shell' });
      return;
    }

    function attach(s: any) {
      const outDecoder = new StringDecoder('utf8');
      const errDecoder = new StringDecoder('utf8');
      let stdout = '';
      let stderr = '';
      let outBytes = 0;
      let errBytes = 0;
      let truncated = false;
      let timedOut = false;
      let channelError: string | undefined;

      const append = (chunk: Buffer, toStderr: boolean) => {
        const used = toStderr ? errBytes : outBytes;
        if (used >= maxBytes) {
          truncated = true;
          return;
        }
        const remain = maxBytes - used;
        const slice = chunk.length > remain ? chunk.subarray(0, remain) : chunk;
        if (chunk.length > remain) truncated = true;
        if (toStderr) {
          errBytes += slice.length;
          stderr += errDecoder.write(slice);
        } else {
          outBytes += slice.length;
          stdout += outDecoder.write(slice);
        }
      };

      const snapshot = (code: number | null): CaptureOutcome => ({
        kind: 'captured',
        stdout: stdout + outDecoder.end(),
        stderr: stderr + errDecoder.end(),
        code,
        truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
        ...(channelError ? { channelError } : {}),
      });

      // 必须消费 stdout，否则通道输出窗口打满后不会关闭
      s.on('data', (chunk: Buffer) => append(chunk, false));
      s.stderr?.on('data', (chunk: Buffer) => append(chunk, true));
      s.on('close', (code: number | null) => finish(snapshot(code === undefined ? null : code)));
      s.on('error', (e: Error) => {
        channelError = e.message;
        finish(snapshot(null));
      });

      timer = setTimeout(() => {
        timedOut = true;
        // signal 请求 OpenSSH 默认不实现（会回 failure），所以真正的兜底是 close()；
        // 远端子进程是否被连带杀掉取决于服务端，不保证。
        try { s.signal?.('KILL'); } catch {}
        try { s.close(); } catch {}
        finish(snapshot(null));
      }, timeoutMs);
    }
  });
}

type RunnerState = 'unknown' | 'probing' | 'ready' | 'unavailable';

export function createExecRunner(client: Client): ExecRunner {
  let state: RunnerState = 'unknown';
  let waiting: Array<(ok: boolean) => void> = [];

  const execOnce = (command: string, done: (result: ExecResult) => void) => {
    let settled = false;
    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      done(result);
    };
    try {
      client.exec(command, (err: Error | undefined, stream: any) => {
        if (err) return finish({ kind: 'no-shell' });
        let stderr = '';
        // 必须消费 stdout，否则通道的输出窗口打满后不会关闭
        stream.on('data', () => {});
        stream.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
        stream.on('close', (code: number | null) => {
          if (code === 0) return finish({ kind: 'done' });
          finish({
            kind: 'failed',
            message: stderr.trim() || `remote command exited with code ${code === null || code === undefined ? 'unknown' : code}`,
          });
        });
        stream.on('error', (e: Error) => finish({ kind: 'failed', message: e.message }));
      });
    } catch (e: any) {
      // 同步抛错 = 客户端未连接/已断开，等同没有可用 shell
      finish({ kind: 'no-shell' });
    }
  };

  const probe = () => {
    let stdout = '';
    let settled = false;

    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      state = ok ? 'ready' : 'unavailable';
      if (!ok) sshLog('SSH exec unavailable, SFTP-only fallback enabled');
      const pending = waiting;
      waiting = [];
      pending.forEach((fn) => fn(ok));
    };

    try {
      client.exec(`echo ${PROBE_MARKER}`, (err: Error | undefined, stream: any) => {
        if (err) return settle(false);
        stream.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        stream.stderr?.on('data', () => {});
        stream.on('close', (code: number | null) => settle(code === 0 && stdout.includes(PROBE_MARKER)));
        stream.on('error', () => settle(false));
      });
    } catch {
      settle(false);
    }
  };

  return {
    run(command, done) {
      if (state === 'ready') return execOnce(command, done);
      if (state === 'unavailable') return done({ kind: 'no-shell' });
      // 探测还没结束：排队等结果，避免同一批请求各探一次
      waiting.push((ok) => (ok ? execOnce(command, done) : done({ kind: 'no-shell' })));
      if (state === 'unknown') {
        state = 'probing';
        probe();
      }
    },
  };
}
