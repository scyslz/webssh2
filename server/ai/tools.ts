/**
 * Agent 的工具箱：四个 SSH 工具 + 分级。
 *
 * ## 为什么是「工具」而不是「让模型吐 JSON 再抠」
 *
 * 上一版让模型输出 `{"action":{"command":"…"}}`，我们再从散文里抠 JSON。
 * 这条路在小模型上不可靠：它会在 JSON 前后加寒暄、加 markdown 围栏、或者干脆讲一段话。
 * 抠不出来整轮就废了 —— 一个**格式问题**被当成**致命错误**处理。
 *
 * 改成原生 tool calling 以后，结构由 API 保证：`tool_calls[].function.arguments` 一定
 * 是模型按 schema 生成的，拿不到就是没调工具。抠 JSON 那套（model-text.ts）从此只在
 * draft 模式里用。
 *
 * ## 分级仍然是服务端的事
 *
 * 工具是模型选的，**能不能跑是我们定的**。工具只回答「这是什么等级、要不要人点头」，
 * 真正的执行在 `executeToolCall`，而那一步只有在审批通过后才被调用。
 * 判分规则在 grade.ts，那里是按命令片段分析的 —— 模型说 `ssh_list` 我们也不信，
 * 只要它最终落到 ssh_exec，就还是按 shell 命令判。
 *
 * ## 关于「不新建 SSH 连接」
 *
 * `ssh_read` / `ssh_write` / `ssh_list` 走 SFTP：它是**同一条 SSH 连接上的新 channel**，
 * 不是新连接，不重新认证、不占新的 TCP。-channel 本身惰性建立、整轮复用。
 * SFTP 不可用（服务端没开 sftp 子系统）时，read / list 回退到 shell，
 * write 直接报错 —— 用 shell heredoc 写文件意味着路径和内容都要过一遍引号，
 * 模型给的字符串我们不打算赌。
 */

import type { Client } from 'ssh2';
import { execCapture, shellQuote } from '../remote-exec.ts';
import { gradeCommand, type RiskLevel } from './grade.ts';

/** ssh_exec 单条输出上限（stdout 与 stderr 各自计），超出截断 */
export const EXEC_MAX_BYTES = 50 * 1024;
/** ssh_read 上限，超出截断 */
export const READ_MAX_BYTES = 100 * 1024;
/** ssh_exec 默认超时 */
export const EXEC_DEFAULT_TIMEOUT_MS = 30_000;
/** ssh_exec 超时上限：再大就是让一次工具调用挂住整轮 */
export const EXEC_MAX_TIMEOUT_MS = 300_000;
/** 单条命令长度上限。超过这个长度基本是模型跑偏了在生成垃圾 */
const MAX_COMMAND_CHARS = 8192;
/** 单次写入内容上限 */
const MAX_WRITE_BYTES = 512 * 1024;
/** 单次列目录返回的条目上限 */
const MAX_LIST_ENTRIES = 500;

const TRUNCATED_NOTE = (label: string, limit: number) =>
  `\n[output truncated: ${label} exceeded ${Math.round(limit / 1024)}KB]`;

/* ------------------------------ 工具声明 ------------------------------ */

export type AgentToolName = 'ssh_exec' | 'ssh_read' | 'ssh_write' | 'ssh_list';

export interface ToolFunctionSchema {
  name: AgentToolName;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * 给模型的工具声明。
 *
 * description 里明确写了「默认只读、改动要先确认现状」—— 提示词不是安全机制，
 * 但能显著减少需要人工拦截的次数。
 */
export const AGENT_TOOLS: Array<{ type: 'function'; function: ToolFunctionSchema }> = [
  {
    type: 'function',
    function: {
      name: 'ssh_exec',
      description:
        'Run a shell command on the remote server over the existing SSH session. '
        + 'Returns exit code, stdout and stderr. Prefer read-only inspection commands. '
        + 'Destructive or service-affecting commands require user approval.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run. No sudo, no interactive prompts.' },
          timeout: { type: 'number', description: 'Timeout in seconds. Default 30, max 300.' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ssh_read',
      description: 'Read a text file from the remote server. Output is capped at 100KB. Use for config and log inspection.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the file to read.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ssh_write',
      description:
        'Write a text file on the remote server. This always requires user approval. '
        + 'Prefer writing to /tmp first and inspect the current content with ssh_read before overwriting.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the file to write.' },
          content: { type: 'string', description: 'Full file content to write.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ssh_list',
      description: 'List a directory on the remote server. Returns name, type, size and permissions.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the directory to list.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
];

/* ------------------------------ 执行上下文 ------------------------------ */

/** 远端实测出来的登录身份。null 表示没探到 —— 此时一律不自动执行 */
export interface AgentIdentity {
  user: string;
  uid: number;
  isRoot: boolean;
}

/** ssh2 的 SFTPWrapper。只用得到下面几个方法，这里不引它的完整类型 */
interface SftpHandle {
  open(path: string, flags: string, cb: (err: any, handle: Buffer) => void): void;
  fstat(handle: Buffer, cb: (err: any, attrs: { size?: number }) => void): void;
  read(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: (err: any, bytesRead: number) => void,
  ): void;
  close(handle: Buffer, cb: (err?: any) => void): void;
  readdir(path: string, cb: (err: any, list: any[]) => void): void;
  writeFile(path: string, data: Buffer | string, cb: (err?: any) => void): void;
  end(): void;
}

export interface ToolContext {
  client: Client;
  /** 用户在 AI 设置里显式放行的命令名 */
  whitelist: string[];
  identity: AgentIdentity | null;
  /**
   * 惰性建立、整轮复用的 SFTP channel。
   *
   * 注意这是复用**同一条 SSH 连接**，不是新建连接；建立失败会返回 null 而不是抛，
   * 让 read/list 有机会回退到 shell。
   */
  sftp: () => Promise<SftpHandle | null>;
  /** 轮次结束时释放 SFTP channel。不 end 的话 sshd 侧会一直留着它 */
  dispose: () => void;
}

/**
 * 造一个工具上下文。
 *
 * `sftp` 只建一次：同一轮 agent 里 read / write / list 可能各来几次，
 * 每次都开新 channel 纯属浪费，而 channel 本身没有并发限制需要规避。
 */
export function createToolContext(args: {
  client: Client;
  whitelist: string[];
  identity: AgentIdentity | null;
}): ToolContext {
  let handle: SftpHandle | null = null;
  let attempted = false;

  const sftp = () => new Promise<SftpHandle | null>((resolve) => {
    if (handle) return resolve(handle);
    if (attempted) return resolve(null);
    attempted = true;
    try {
      (args.client as any).sftp((err: any, created: any) => {
        if (err || !created) return resolve(null);
        handle = created as SftpHandle;
        resolve(handle);
      });
    } catch {
      resolve(null);
    }
  });

  const dispose = () => {
    if (!handle) return;
    try { handle.end(); } catch {}
    handle = null;
  };

  return { client: args.client, whitelist: args.whitelist, identity: args.identity, sftp, dispose };
}

/* ------------------------------ 参数校验 ------------------------------ */

/** 参数不合法时抛这个；调用方会把它变成一条 tool 消息回灌给模型，让模型自己改 */
export class ToolArgumentError extends Error {}

function readString(args: Record<string, unknown>, key: string, maxChars: number): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolArgumentError(`"${key}" is required and must be a non-empty string`);
  }
  if (value.length > maxChars) {
    throw new ToolArgumentError(`"${key}" is too long (${value.length} chars, limit ${maxChars})`);
  }
  // NUL / 换行在路径和命令里都是麻烦制造者：前者截断 C 字符串，后者能续出新的一行
  if (/[\0]/.test(value)) throw new ToolArgumentError(`"${key}" contains a NUL byte`);
  return value;
}

function readPath(args: Record<string, unknown>): string {
  const path = readString(args, 'path', 4096);
  if (!path.startsWith('/')) {
    throw new ToolArgumentError(`"path" must be absolute (got: ${path})`);
  }
  return path;
}

function readTimeout(args: Record<string, unknown>): number {
  const raw = args.timeout;
  if (raw === undefined || raw === null) return EXEC_DEFAULT_TIMEOUT_MS;
  const seconds = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new ToolArgumentError('"timeout" must be a positive number of seconds');
  }
  return Math.min(Math.floor(seconds * 1000), EXEC_MAX_TIMEOUT_MS);
}

/* ------------------------------ 分级 ------------------------------ */

export interface ToolPlan {
  level: RiskLevel;
  reasons: string[];
  /** 需要人在界面上点头。为 false 才允许无人值守地跑 */
  needsApproval: boolean;
}

/**
 * 执行**之前**的判断：这个调用是什么等级、要不要审批。
 *
 * 三条规则：
 * 1. `ssh_write` 永远要审批 —— 写文件是不可逆的，没有例外。
 * 2. `ssh_read` / `ssh_list` 是纯读，直接放行；它们不经过 shell，模型塞什么都不影响。
 * 3. `ssh_exec` 交给 grade.ts 按命令片段判。可以免审批的条件是
 *    「判分 safe **且** 在用户允许名单里 **且** 身份实测过 **且** 不是 root」
 *    —— 四个条件同时成立，缺一就要人点头。
 *
 * 身份这条值得多说一句：以前它由浏览器自报（`session.source === 'terminal'`），
 * 现在循环搬到服务端、身份是服务端自己 `id -un` 跑出来的，浏览器无从伪造。
 */
export function planToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): ToolPlan {
  if (name === 'ssh_write') {
    return { level: 'caution', reasons: ['Writes a file - always confirmed by you'], needsApproval: true };
  }

  if (name === 'ssh_read' || name === 'ssh_list') {
    // 校验放在这里而不是执行时：参数不合法要能立刻回给模型，别等它跑完一圈
    readPath(args);
    return { level: 'safe', reasons: [], needsApproval: false };
  }

  if (name !== 'ssh_exec') {
    /**
     * 未知工具**不送去审批**。
     *
     * 让人去批准一个不存在的工具没有意义，而且会把它挡在 `executeToolCall` 那条
     * 「unknown tool，可用的是这四个」的提示后面 —— 那句话才是模型能拿来纠错的东西。
     * 这里放行是安全的：未知工具在 executeToolCall 里只会产出一段错误文本，不碰任何东西。
     */
    return { level: 'safe', reasons: [], needsApproval: false };
  }

  const command = readString(args, 'command', MAX_COMMAND_CHARS);
  if (/[\r\n]/.test(command)) {
    throw new ToolArgumentError('"command" must be a single line');
  }

  const grade = gradeCommand(command, {
    whitelist: ctx.whitelist,
    sessionUser: ctx.identity?.user,
    isRoot: ctx.identity?.isRoot ?? false,
  });

  const autoRunnable =
    grade.autoRunnable && ctx.identity !== null && !ctx.identity!.isRoot;

  return {
    level: grade.level,
    reasons: autoRunnable ? [] : grade.reasons,
    needsApproval: !autoRunnable,
  };
}

/* ------------------------------ 执行 ------------------------------ */

export interface ToolOutcome {
  /** 回灌给模型的文本。失败也走这里 —— 让模型看见错误并自己换个办法 */
  content: string;
  truncated: boolean;
}

/** ssh_exec：走 exec channel（不是用户的 PTY），终端里看不到，两者互不干扰 */
async function execShell(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const command = readString(args, 'command', MAX_COMMAND_CHARS);
  if (/[\r\n]/.test(command)) throw new ToolArgumentError('"command" must be a single line');
  const timeoutMs = readTimeout(args);

  const outcome = await execCapture(ctx.client, command, {
    timeoutMs,
    maxBytes: EXEC_MAX_BYTES,
    // 远端再套一层 timeout：本地掐断只关通道，sshd 不一定杀掉子进程
    enforceRemoteTimeout: true,
  });

  if (outcome.kind === 'no-shell') {
    return {
      content: 'error: no usable shell on this session (the account may be restricted to SFTP). '
        + 'Use ssh_read / ssh_list / ssh_write instead.',
      truncated: false,
    };
  }

  const codeText = outcome.timedOut ? 'timeout' : (outcome.code === null ? 'unknown' : String(outcome.code));
  const lines = [
    `exit_code: ${codeText}`,
    `duration: ${outcome.durationMs}ms`,
  ];
  if (outcome.channelError) lines.push(`channel_error: ${outcome.channelError}`);
  lines.push('stdout:', outcome.stdout || '(empty)');
  if (outcome.stderr.trim()) lines.push('stderr:', outcome.stderr);

  const truncated = outcome.truncated;
  if (truncated) lines.push(TRUNCATED_NOTE('output', EXEC_MAX_BYTES));

  return { content: lines.join('\n'), truncated };
}

async function readFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const path = readPath(args);
  const sftp = await ctx.sftp();

  if (sftp) {
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      sftp.open(path, 'r', (err: any, handle: Buffer) => {
        if (err) return reject(err);
        sftp.fstat(handle, (statErr: any, attrs: any) => {
          if (statErr) {
            try { sftp.close(handle, () => {}); } catch {}
            return reject(statErr);
          }
          const want = Math.min(Number(attrs?.size) || READ_MAX_BYTES + 1, READ_MAX_BYTES + 1);
          const buf = Buffer.alloc(Math.max(want, 1));
          sftp.read(handle, buf, 0, want, 0, (readErr: any, bytesRead: number) => {
            try { sftp.close(handle, () => {}); } catch {}
            if (readErr) return reject(readErr);
            resolve(buf.subarray(0, bytesRead));
          });
        });
      });
    });

    const truncated = buffer.length > READ_MAX_BYTES;
    const text = buffer.subarray(0, Math.min(buffer.length, READ_MAX_BYTES)).toString('utf8');
    return {
      content: truncated ? text + TRUNCATED_NOTE('file', READ_MAX_BYTES) : text,
      truncated,
    };
  }

  // SFTP 不可用 → 回退 shell。路径必须转义，否则模型一个空格就能变成第二条命令
  const quoted = shellQuote(path);
  if (!quoted) throw new ToolArgumentError('"path" cannot be expressed safely in a shell command');
  const outcome = await execCapture(ctx.client, `LC_ALL=C LANG=C cat -- ${quoted}`, {
    timeoutMs: EXEC_DEFAULT_TIMEOUT_MS,
    maxBytes: READ_MAX_BYTES,
  });
  if (outcome.kind === 'no-shell') {
    return { content: 'error: neither SFTP nor a usable shell is available on this session.', truncated: false };
  }
  if (outcome.code !== 0) {
    return {
      content: `error: exit ${outcome.code}\n${outcome.stderr.trim() || outcome.stdout.trim() || '(no output)'}`,
      truncated: false,
    };
  }
  return {
    content: outcome.truncated
      ? outcome.stdout + TRUNCATED_NOTE('file', READ_MAX_BYTES)
      : outcome.stdout,
    truncated: outcome.truncated,
  };
}

async function listDir(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const path = readPath(args);
  const sftp = await ctx.sftp();

  if (sftp) {
    const entries = await new Promise<any[]>((resolve, reject) => {
      sftp.readdir(path, (err: any, list: any[]) => (err ? reject(err) : resolve(list || [])));
    });

    const shown = entries.slice(0, MAX_LIST_ENTRIES);
    const lines = shown.map((entry) => {
      const attrs = entry.attrs || {};
      const mode = typeof attrs.mode === 'number' ? (attrs.mode & 0o777).toString(8).padStart(3, '0') : '???';
      const kind = attrs.isDirectory?.() ? 'd' : (attrs.isSymbolicLink?.() ? 'l' : '-');
      const size = typeof attrs.size === 'number' ? String(attrs.size) : '?';
      return `${kind}${mode} ${size.padStart(10)} ${entry.filename}`;
    });

    const head = [`path: ${path}`, `${entries.length} entries`, ''];
    const tail = entries.length > shown.length ? ['', `... ${entries.length - shown.length} more (not shown)`] : [];
    return { content: [...head, ...lines, ...tail].join('\n'), truncated: false };
  }

  const quoted = shellQuote(path);
  if (!quoted) throw new ToolArgumentError('"path" cannot be expressed safely in a shell command');
  const outcome = await execCapture(ctx.client, `LC_ALL=C LANG=C ls -la -- ${quoted}`, {
    timeoutMs: EXEC_DEFAULT_TIMEOUT_MS,
    maxBytes: EXEC_MAX_BYTES,
  });
  if (outcome.kind === 'no-shell') {
    return { content: 'error: neither SFTP nor a usable shell is available on this session.', truncated: false };
  }
  if (outcome.code !== 0) {
    return {
      content: `error: exit ${outcome.code}\n${outcome.stderr.trim() || '(no output)'}`,
      truncated: false,
    };
  }
  return { content: outcome.stdout, truncated: outcome.truncated };
}

async function writeFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const path = readPath(args);
  const content = readString(args, 'content', MAX_WRITE_BYTES);
  const sftp = await ctx.sftp();

  if (!sftp) {
    return {
      content: 'error: this session has no SFTP channel, so ssh_write is unavailable. '
        + 'Report this to the user instead of retrying.',
      truncated: false,
    };
  }

  const before = await new Promise<{ existed: boolean; size?: number }>((resolve) => {
    sftp.open(path, 'r', (err: any, handle: Buffer) => {
      if (err) return resolve({ existed: false });
      sftp.fstat(handle, (_e: any, attrs: any) => {
        try { sftp.close(handle, () => {}); } catch {}
        resolve({ existed: true, size: Number(attrs?.size) || 0 });
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    sftp.writeFile(path, Buffer.from(content, 'utf8'), (err?: any) => (err ? reject(err) : resolve()));
  });

  const note = before.existed
    ? `overwrote ${path} (was ${before.size} bytes)`
    : `created ${path}`;
  return { content: `ok: ${note}, wrote ${Buffer.byteLength(content, 'utf8')} bytes`, truncated: false };
}

/**
 * 执行一个工具调用。
 *
 * 约定：**除了连接层异常，一律不抛**。参数错、工具名不认识、命令失败、权限不够
 * —— 全部变成一段文本回给模型。模型看得见错误才能换条路；直接抛只会让整轮白跑。
 */
export async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'ssh_exec':
        return await execShell(ctx, args);
      case 'ssh_read':
        return await readFile(ctx, args);
      case 'ssh_write':
        return await writeFile(ctx, args);
      case 'ssh_list':
        return await listDir(ctx, args);
      default:
        return {
          content: `error: unknown tool "${name}". Available: ssh_exec, ssh_read, ssh_write, ssh_list.`,
          truncated: false,
        };
    }
  } catch (err: any) {
    if (err instanceof ToolArgumentError) {
      return { content: `error: invalid arguments - ${err.message}`, truncated: false };
    }
    const message = err?.message || String(err);
    // 连接断了是要让循环停下来的真错误，不能当成「换条路再试」
    if (/not connected|ECONNRESET|socket|channel/i.test(message)) throw err;
    return { content: `error: ${message}`, truncated: false };
  }
}
