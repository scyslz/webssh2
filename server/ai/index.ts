import { WebSocket } from 'ws';
import { sshLog } from '../lib.ts';
import { publicAiConfig, resolveAiConfig } from './config.ts';
import { prepareContext, type RawContext } from './context.ts';
import { parseDraft } from './draft.ts';
import { gradeCommand } from './grade.ts';
import { buildDiagnoseMessages, buildDraftMessages } from './prompts.ts';
import { AiProviderError, streamChatCompletion } from './provider.ts';

/**
 * `/ai` WebSocket 通道。
 *
 * 刻意做成**无状态**：上下文由浏览器提供（它本来就有终端缓冲），服务端不查 SSH 会话、
 * 不碰 SFTP。这样这个通道既不继承 SSH 凭据，也不需要 sessionId —— 出问题的面最小。
 *
 * 协议：
 *   客户端 → 服务端：{type:'ping'} | {type:'config'}
 *                  | {type:'diagnose', id, context}   只读解读
 *                  | {type:'draft', id, context}      生成命令草稿（服务端判分后才下发）
 *                  | {type:'cancel', id}
 *   服务端 → 客户端：{type:'ready'|'config'|'pong'}
 *                  | {type:'prepared'|'delta'|'done'|'error', id}
 *                  | {type:'draft', id}              带判分结果的结构化命令
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

/**
 * delta 合帧器：逐 token 发帧在移动端会被拆包风暴拖垮。
 * 两个模式共用，所以单独抽出来。
 */
function createDeltaBuffer(send: Send, id: string) {
  let pending = '';
  let timer: NodeJS.Timeout | null = null;

  const flush = () => {
    if (!pending) return;
    send({ type: 'delta', id, text: pending });
    pending = '';
  };
  const push = (text: string) => {
    pending += text;
    if (pending.length >= FLUSH_CHARS) {
      if (timer) { clearTimeout(timer); timer = null; }
      flush();
      return;
    }
    if (!timer) timer = setTimeout(() => { timer = null; flush(); }, FLUSH_INTERVAL_MS);
  };
  const stop = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  return { push, flush, stop };
}

function readContext(message: any): RawContext {
  const incoming = message.context || {};
  return {
    text: typeof incoming.text === 'string' ? incoming.text : '',
    source: incoming.source === 'selection' ? 'selection' : 'tail',
    host: typeof incoming.host === 'string' ? incoming.host.slice(0, 200) : undefined,
    username: typeof incoming.username === 'string' ? incoming.username.slice(0, 200) : undefined,
    cwd: typeof incoming.cwd === 'string' ? incoming.cwd.slice(0, 400) : undefined,
    question: typeof incoming.question === 'string' ? incoming.question.slice(0, 2000) : undefined,
  };
}

function sendPrepared(
  send: Send,
  id: string,
  prepared: ReturnType<typeof prepareContext>,
) {
  send({
    type: 'prepared',
    id,
    text: prepared.text,
    env: prepared.env,
    question: prepared.question,
    stats: prepared.stats,
  });
}

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

      case 'draft':
        void runDraft(message, send, state);
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

  const raw = readContext(message);

  if (!raw.text.trim()) {
    send({ type: 'error', id, msg: '没有可分析的终端内容' });
    return;
  }

  const prepared = prepareContext(raw, {
    maxInputTokens: config.maxInputTokens,
    redactPrivateIp: config.redactPrivateIp,
  });

  // 先把「实际要发出去的内容」回传：用户看得见才谈得上信任
  sendPrepared(send, id, prepared);

  state.active?.controller.abort();
  const controller = new AbortController();
  state.active = { id, controller };

  const buffer = createDeltaBuffer(send, id);
  const startedAt = Date.now();

  try {
    const outcome = await streamChatCompletion({
      config,
      messages: buildDiagnoseMessages(prepared),
      signal: controller.signal,
      onDelta: buffer.push,
    });

    buffer.stop();
    buffer.flush();

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
    buffer.stop();
    // 已经吐出去的内容保留，接一个中断说明，避免面板上留下没有解释的半截答案
    buffer.flush();
    const aborted = controller.signal.aborted;
    const msg = aborted ? '已取消' : (err instanceof AiProviderError ? err.message : (err?.message || '调用失败'));
    send({ type: 'error', id, msg, aborted });
    if (!aborted) sshLog('ai diagnose failed', { source: raw.source, status: err?.status, message: msg });
  } finally {
    if (state.active?.id === id) state.active = null;
  }
}

/**
 * draft 模式：让模型输出一条结构化命令，**服务端判分之后**才下发给前端。
 *
 * 两条不可退让的规矩：
 * 1. 解析失败一律降级成只读展示（前端拿已收到的 delta 当普通回答渲染），
 *    绝不允许把半截 JSON 或一段散文当作命令递给用户 —— 那是最容易出事的路径。
 * 2. 下发的等级以 `gradeCommand` 为准，模型自评只作为 `selfRisk` 附在旁边对比。
 *
 * 关于 root 判定：这里的用户名来自浏览器，理论上不可信。本轮没有安全影响
 * （UI 上任何执行都要用户显式点一下，autoRunnable 只是个提示标签）；
 * 等 Agent 模式落地、真要做无人值守执行时，登录用户必须改从 SSH 会话读，
 * 不能采信前端自报。
 */
async function runDraft(
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

  const raw = readContext(message);
  if (!raw.question || !raw.question.trim()) {
    send({ type: 'error', id, msg: '请先用一句话描述你的需求' });
    return;
  }

  const prepared = prepareContext(raw, {
    maxInputTokens: config.maxInputTokens,
    redactPrivateIp: config.redactPrivateIp,
  });

  sendPrepared(send, id, prepared);

  state.active?.controller.abort();
  const controller = new AbortController();
  state.active = { id, controller };

  const buffer = createDeltaBuffer(send, id);
  const startedAt = Date.now();
  let collected = '';
  const collect = (text: string) => {
    collected += text;
    buffer.push(text);
  };

  try {
    const outcome = await streamChatCompletion({
      config,
      messages: buildDraftMessages(prepared),
      signal: controller.signal,
      onDelta: collect,
    });

    buffer.stop();
    buffer.flush();

    const draft = parseDraft(collected);
    if (!draft) {
      // 降级：前端已通过 delta 拿到原文，这里只告诉它「按只读渲染」
      send({
        type: 'error',
        id,
        msg: '模型没有返回可用的命令结构，已降级为只读展示（未生成任何可执行内容）',
        fallback: 'readonly',
      });
      sshLog('ai draft degraded', {
        host: raw.host,
        chars: outcome.chars,
        finishReason: outcome.finishReason,
        ms: Date.now() - startedAt,
      });
      return;
    }

    const grade = gradeCommand(draft.command, {
      whitelist: config.commandWhitelist,
      sessionUser: raw.username,
    });

    send({
      type: 'draft',
      id,
      command: draft.command,
      explain: draft.explain,
      selfRisk: draft.selfRisk,
      prerequisites: draft.prerequisites,
      grade: {
        level: grade.level,
        hits: grade.hits,
        reasons: grade.reasons,
        allWhitelisted: grade.allWhitelisted,
        rootSession: grade.rootSession,
        autoRunnable: grade.autoRunnable,
        segments: grade.segments.map((s) => ({
          raw: s.raw,
          binary: s.binary,
          level: s.level,
          elevated: s.elevated,
          whitelisted: s.whitelisted,
          hits: s.hits,
        })),
      },
      model: outcome.model || config.model,
      usage: outcome.usage,
      finishReason: outcome.finishReason,
      firstTokenMs: outcome.firstTokenMs,
      ms: Date.now() - startedAt,
      chars: outcome.chars,
    });

    // 日志只记判分结论，不记命令内容本身（命令里常带路径、容器名等敏感信息）
    sshLog('ai draft done', {
      host: raw.host,
      gradeLevel: grade.level,
      gradeRules: grade.hits.map((h) => h.rule),
      segments: grade.segments.length,
      autoRunnable: grade.autoRunnable,
      rootSession: grade.rootSession,
      selfRisk: draft.selfRisk ?? 'none',
      chars: outcome.chars,
      ms: Date.now() - startedAt,
    });
  } catch (err: any) {
    buffer.stop();
    buffer.flush();
    const aborted = controller.signal.aborted;
    const msg = aborted ? '已取消' : (err instanceof AiProviderError ? err.message : (err?.message || '调用失败'));
    send({ type: 'error', id, msg, aborted, fallback: 'readonly' });
    if (!aborted) sshLog('ai draft failed', { host: raw.host, status: err?.status, message: msg });
  } finally {
    if (state.active?.id === id) state.active = null;
  }
}
