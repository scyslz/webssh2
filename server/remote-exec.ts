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
 */

import type { Client } from 'ssh2';
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
