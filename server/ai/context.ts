import { redactText, type RedactionCounts } from './redact.ts';

/**
 * 上下文装配 —— 把「终端里的一堆文本」压成「一小段可以出网的文本」。
 * 全是纯函数，便于单测；顺序是有讲究的，见 prepareContext。
 */

/**
 * 字符→token 的保守换算比。中文字符大约 1 字符 ≈ 1 token，
 * ASCII 约 4 字符 ≈ 1 token；按 2 估算意味着**宁可少发也不超预算**。
 */
export const CHARS_PER_TOKEN = 2;

/** 裁剪时头部保留的比例，其余留给尾部 —— 日志的结论通常在最后 */
const HEAD_RATIO = 0.35;

export const DEFAULT_QUESTION = '请解释这段终端输出：有没有异常？问题出在哪？下一步该查什么？';

export interface RawContext {
  text: string;
  source: 'selection' | 'tail';
  host?: string;
  username?: string;
  cwd?: string;
  os?: string;
  shell?: string;
  question?: string;
}

export interface ContextStats {
  rawLines: number;
  rawChars: number;
  lines: number;
  chars: number;
  omittedLines: number;
  collapsedLines: number;
  redactions: RedactionCounts;
  redactionTotal: number;
  estTokens: number;
  truncated: boolean;
}

export interface PreparedContext {
  /** 最终出网的文本（同时也展示给用户看） */
  text: string;
  env: string;
  question: string;
  stats: ContextStats;
}

const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_OTHER_RE = /\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_OSC_RE, '').replace(ANSI_CSI_RE, '').replace(ANSI_OTHER_RE, '');
}

/**
 * 进度条、spinner 这类输出靠 `\r` 原地刷新。xterm 的缓冲里每一行仍是带 `\r` 的
 * 完整写入序列，所以取每行最后一个 `\r` 之后的内容就等于只保留最终一帧。
 */
export function keepCarriageReturnTail(text: string): { text: string; dropped: number } {
  let dropped = 0;
  const lines = text.split('\n').map((line) => {
    const index = line.lastIndexOf('\r');
    if (index < 0) return line;
    dropped += 1;
    return line.slice(index + 1);
  });
  return { text: lines.join('\n'), dropped };
}

export function collapseRepeats(text: string): { text: string; collapsed: number } {
  const lines = text.split('\n');
  const output: string[] = [];
  let collapsed = 0;

  for (let i = 0; i < lines.length;) {
    let run = 1;
    while (i + run < lines.length && lines[i + run] === lines[i]) run += 1;

    if (run >= 3 && lines[i].trim() !== '') {
      output.push(`${lines[i]}    … 同上重复 ${run} 次`);
      collapsed += run - 1;
    } else {
      for (let k = 0; k < run; k += 1) output.push(lines[i]);
    }
    i += run;
  }

  return { text: output.join('\n'), collapsed };
}

export function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * 首尾保留、中间折叠。切点对齐到换行，避免留下半行让人（和模型）误读。
 */
export function clipMiddle(text: string, maxChars: number): { text: string; omittedLines: number; truncated: boolean } {
  const lineCount = (value: string) => (value ? value.split('\n').length : 0);
  if (text.length <= maxChars) return { text, omittedLines: 0, truncated: false };

  const headRaw = text.slice(0, Math.floor(maxChars * HEAD_RATIO));
  const tailRaw = text.slice(text.length - (maxChars - headRaw.length));

  const headBreak = headRaw.lastIndexOf('\n');
  const head = headBreak > 0 ? headRaw.slice(0, headBreak) : headRaw;
  const tailBreak = tailRaw.indexOf('\n');
  const tail = tailBreak >= 0 ? tailRaw.slice(tailBreak + 1) : tailRaw;

  const omittedLines = Math.max(0, lineCount(text) - lineCount(head) - lineCount(tail));
  return {
    text: `${head}\n\n… 略过 ${omittedLines} 行 …\n\n${tail}`,
    omittedLines,
    truncated: true,
  };
}

function buildEnvLine(raw: RawContext): string {
  const parts: string[] = [];
  if (raw.host) parts.push(`主机 ${raw.host}`);
  if (raw.username) parts.push(`用户 ${raw.username}`);
  if (raw.cwd) parts.push(`目录 ${raw.cwd}`);
  if (raw.os) parts.push(`系统 ${raw.os}`);
  if (raw.shell) parts.push(`shell ${raw.shell}`);
  parts.push(raw.source === 'selection' ? '来源：用户选中的终端片段' : '来源：终端最后若干行');
  return parts.join(' | ');
}

export function estimateTokens(chars: number) {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * 装配顺序：去噪 → **脱敏** → 裁剪。
 *
 * 脱敏必须排在裁剪之前：先裁再抹的话，一个跨裁剪边界的私钥块会被切成半截，
 * 头尾匹配不上 `-----BEGIN/END-----`，于是半截私钥直接出网。
 */
export function prepareContext(
  raw: RawContext,
  budget: { maxInputTokens: number; redactPrivateIp?: boolean },
): PreparedContext {
  const sourceText = raw.text || '';
  const rawLines = sourceText ? sourceText.split('\n').length : 0;
  const rawChars = sourceText.length;

  let text = stripAnsi(sourceText);
  const carriage = keepCarriageReturnTail(text);
  text = carriage.text;
  const repeats = collapseRepeats(text);
  text = repeats.text;
  text = collapseBlankLines(text);

  const redacted = redactText(text, { redactPrivateIp: budget.redactPrivateIp });

  /**
   * 预算换算成字符数。
   *
   * 这里的 200 字符下限纯粹是防御「调用方给了个荒唐的小值」；正常路径上
   * config 会把 maxInputTokens 夹在 500 以上，所以下限永远不会先咬到 ——
   * 也就是说**实际发出去的量不会超过预算**。
   */
  const maxChars = Math.max(200, Math.floor(budget.maxInputTokens * CHARS_PER_TOKEN));
  const clipped = clipMiddle(redacted.text, maxChars);

  return {
    text: clipped.text,
    env: buildEnvLine(raw),
    question: (raw.question || '').trim() || DEFAULT_QUESTION,
    stats: {
      rawLines,
      rawChars,
      lines: clipped.text ? clipped.text.split('\n').length : 0,
      chars: clipped.text.length,
      omittedLines: clipped.omittedLines,
      collapsedLines: repeats.collapsed + carriage.dropped,
      redactions: redacted.counts,
      redactionTotal: redacted.total,
      estTokens: estimateTokens(clipped.text.length),
      truncated: clipped.truncated,
    },
  };
}
