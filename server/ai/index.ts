import { WebSocket } from 'ws';
import { sshLog } from '../lib.ts';
import { publicAiConfig, resolveAiConfig } from './config.ts';
import { prepareContext, type RawContext } from './context.ts';
import { buildDiagnoseMessages } from './prompts.ts';
import { AiProviderError, streamChatCompletion } from './provider.ts';

/**
 * `/ai` WebSocket 通道。
 *
 * 刻意做成**无状态**：上下文由浏览器提供（它本来就有终端缓冲），服务端不查 SSH 会话、
 * 不碰 SFTP。这样这个通道既不继承 SSH 凭据，也不需要 sessionId —— 出问题的面最小。
 *
 * 协议：
 *   客户端 → 服务端：{type:'ping'} | {type:'config'} | {type:'diagnose', id, context} | {type:'cancel', id}
 *   服务端 → 客户端：{type:'ready'|'config'|'pong'} | {type:'prepared'|'delta'|'done'|'error', id}
 */

/** 单条入站消息上限：正常上下文也就几十 KB，超过基本是异常客户端 */
const MAX_INBOUND_BYTES = 512 * 1024;
/** delta 合帧阈值与间隔：逐 token 发帧在移动端会被拆包风暴拖垮 */
const FLUSH_CHARS = 240;
const FLUSH_INTERVAL_MS = 60;

interface ActiveRequest {
  id: string;
  controller: AbortController;
}

type Send = (payload: Record<string, unknown>) => void;

export function handleAiConnection(ws: WebSocket) {
  const send: Send = (payload) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  // 同一连接同时只允许一个在跑的请求，避免连点把成本翻倍
  const state: { active: ActiveRequest | null } = { active: null };

  send({ type: 'ready', config: publicAiConfig() });

  ws.on('message', (raw: Buffer | string) => {
    const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
    if (size > MAX_INBOUND_BYTES) {
      send({ type: 'error', msg: '上下文过大，已拒绝（超过 512KB）' });
      return;
    }

    let message: any;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'));
    } catch {
      send({ type: 'error', msg: '消息不是合法 JSON' });
      return;
    }

    switch (message?.type) {
      case 'ping':
        send({ type: 'pong', ts: Date.now() });
        return;

      case 'config':
        send({ type: 'config', config: publicAiConfig() });
        return;

      case 'cancel':
        if (state.active && (!message.id || state.active.id === message.id)) {
          state.active.controller.abort();
          state.active = null;
        }
        return;

      case 'diagnose':
        void runDiagnose(message, send, state);
        return;

      default:
        send({ type: 'error', msg: `未知消息类型：${message?.type}` });
        return;
    }
  });

  ws.on('close', () => {
    state.active?.controller.abort();
    state.active = null;
  });
}

async function runDiagnose(
  message: any,
  send: Send,
  state: { active: ActiveRequest | null },
) {
  const id = typeof message.id === 'string' && message.id ? message.id : `req-${Date.now()}`;
  const config = resolveAiConfig();

  if (!config.enabled || config.reason) {
    send({ type: 'error', id, msg: config.reason || 'AI 功能未启用' });
    return;
  }

  const incoming = message.context || {};
  const raw: RawContext = {
    text: typeof incoming.text === 'string' ? incoming.text : '',
    source: incoming.source === 'selection' ? 'selection' : 'tail',
    host: typeof incoming.host === 'string' ? incoming.host.slice(0, 200) : undefined,
    username: typeof incoming.username === 'string' ? incoming.username.slice(0, 200) : undefined,
    cwd: typeof incoming.cwd === 'string' ? incoming.cwd.slice(0, 400) : undefined,
    question: typeof incoming.question === 'string' ? incoming.question.slice(0, 2000) : undefined,
  };

  if (!raw.text.trim()) {
    send({ type: 'error', id, msg: '没有可分析的终端内容' });
    return;
  }

  const prepared = prepareContext(raw, {
    maxInputTokens: config.maxInputTokens,
    redactPrivateIp: config.redactPrivateIp,
  });

  // 先把「实际要发出去的内容」回传：用户看得见才谈得上信任
  send({
    type: 'prepared',
    id,
    text: prepared.text,
    env: prepared.env,
    question: prepared.question,
    stats: prepared.stats,
  });

  state.active?.controller.abort();
  const controller = new AbortController();
  state.active = { id, controller };

  let pending = '';
  let flushTimer: NodeJS.Timeout | null = null;
  const flush = () => {
    if (!pending) return;
    send({ type: 'delta', id, text: pending });
    pending = '';
  };
  const push = (text: string) => {
    pending += text;
    if (pending.length >= FLUSH_CHARS) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      flush();
      return;
    }
    if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_INTERVAL_MS);
  };
  const stopFlush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  };

  const startedAt = Date.now();
  try {
    const outcome = await streamChatCompletion({
      config,
      messages: buildDiagnoseMessages(prepared),
      signal: controller.signal,
      onDelta: push,
    });

    stopFlush();
    flush();

    send({
      type: 'done',
      id,
      model: outcome.model || config.model,
      usage: outcome.usage,
      finishReason: outcome.finishReason,
      firstTokenMs: outcome.firstTokenMs,
      ms: Date.now() - startedAt,
      chars: outcome.chars,
    });

    // 只记元信息，绝不记内容
    sshLog('ai diagnose done', {
      source: raw.source,
      rawLines: prepared.stats.rawLines,
      sentChars: prepared.stats.chars,
      estTokens: prepared.stats.estTokens,
      redactions: prepared.stats.redactionTotal,
      omittedLines: prepared.stats.omittedLines,
      firstTokenMs: outcome.firstTokenMs,
      ms: Date.now() - startedAt,
      chars: outcome.chars,
    });
  } catch (err: any) {
    stopFlush();
    // 已经吐出去的内容保留，接一个中断说明，避免面板上留下没有解释的半截答案
    flush();
    const aborted = controller.signal.aborted;
    const msg = aborted ? '已取消' : (err instanceof AiProviderError ? err.message : (err?.message || '调用失败'));
    send({ type: 'error', id, msg, aborted });
    if (!aborted) sshLog('ai diagnose failed', { source: raw.source, status: err?.status, message: msg });
  } finally {
    if (state.active?.id === id) state.active = null;
  }
}
