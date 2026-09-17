import { WebSocket } from 'ws';
import { sshLog } from '../lib.ts';
import { execCapture } from '../remote-exec.ts';
import { publicAiConfig, resolveAiConfig } from './config.ts';
import { prepareContext, type RawContext } from './context.ts';
import { parseDraft } from './draft.ts';
import { gradeCommand } from './grade.ts';
import {
  AGENT_DEFAULT_MAX_STEPS,
  AGENT_MAX_STEPS_HARD_LIMIT,
  runAgentLoop,
} from './agent-loop.ts';
import { buildAgentToolMessages, buildDiagnoseMessages, buildDraftMessages } from './prompts.ts';
import { AiProviderError, streamChatCompletion } from './provider.ts';
import type { AgentIdentity } from './tools.ts';

/**
 * `/ai` WebSocket 通道。
 *
 * 刻意做成**无状态**：上下文由浏览器提供（它本来就有终端缓冲），服务端不查 SSH 会话、
 * 不碰 SFTP。这样这个通道既不继承 SSH 凭据，也不需要 sessionId —— 出问题的面最小。
 *
 * Agent 模式同样守这条线：服务端每收到一次 `agent` 请求只推进**一个回合**，
 * 循环状态由浏览器持有；真正的执行发生在持有会话的 `/term` 通道。
 *
 * 协议：
 *   客户端 → 服务端：{type:'ping'} | {type:'config'}
 *                  | {type:'diagnose', id, context}   只读解读
 *                  | {type:'draft', id, context}      生成命令草稿（服务端判分后才下发）
 *                  | {type:'agent', id, context, sessionId, maxSteps}
 *                  | {type:'agent_approval', id, callId, allow}
 *                  | {type:'cancel', id}
 *   服务端 → 客户端：{type:'ready'|'config'|'pong'}
 *                  | {type:'prepared'|'delta'|'done'|'error', id}
 *                  | {type:'draft', id}              带判分结果的结构化命令
 *                  | {type:'agent_start'|'agent_step'|'agent_message', id}
 *                  | {type:'agent_tool_call'|'agent_tool_result', id, callId}
 *                  | {type:'agent_approval_required', id, callId}  等客户端回 agent_approval
 *                  | {type:'agent_done'|'agent_error', id}
 *
 * Agent 是这条规则里唯一的例外：**只有它会被借到一个已存在的 SSH 会话上去跑工具**。
 * 借的方式是注入的 `AiSshHooks.getSession(sessionId)` —— 拿不到就直接不开跑，
 * 且连接本身的生命周期仍然归 /term 管，/ai 不持有凭据、不负责重连。
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

interface ChannelState {
  active: ActiveRequest | null;
  /**
   * 把当前挂起的审批收掉。
   *
   * 取消时必须走这里 —— 否则 Agent 循环会永远 await 在 `requestApproval` 上，
   * 界面显示已停止、服务端却还占着一次模型调用的上下文。
   */
  respondApproval?: ((callId: string, allow: boolean) => void) | null;
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

/**
 * Agent 借 SSH 会话的入口。
 *
 * 由 session-manager 注入 —— 会话表在它的闭包里，ai 模块拿不到也不需要拿。
 * 这里只要求一个能用的 ssh2 Client，身份由 agent 自己 `id -un` 实测。
 */
export interface AiSshHooks {
  getSession(sessionId: string): { client: any } | undefined;
}

export function handleAiConnection(ws: WebSocket, hooks?: AiSshHooks) {
  const send: Send = (payload) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  // 同一连接同时只允许一个在跑的请求，避免连点把成本翻倍
  const state: ChannelState = { active: null, respondApproval: null };

  send({ type: 'ready', config: publicAiConfig() });

  ws.on('message', (raw: Buffer | string) => {
    const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
    if (size > MAX_INBOUND_BYTES) {
      send({ type: 'error', msg: 'Context too large (limit 512KB)' });
      return;
    }

    let message: any;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'));
    } catch {
      send({ type: 'error', msg: 'Message is not valid JSON' });
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
          // callId 传空串 = 无视匹配，直接以「拒绝」收掉挂起的审批
          state.respondApproval?.('', false);
          state.active = null;
        }
        return;

      case 'agent_approval':
        if (typeof message.callId === 'string') {
          state.respondApproval?.(message.callId, message.allow === true);
        }
        return;

      case 'diagnose':
        void runDiagnose(message, send, state);
        return;

      case 'draft':
        void runDraft(message, send, state);
        return;

      case 'agent':
        void runAgent(message, send, state, hooks);
        return;

      default:
        send({ type: 'error', msg: `Unknown message type: ${message?.type}` });
        return;
    }
  });

  ws.on('close', () => {
    state.active?.controller.abort();
    // 连接都没了，挂着的审批不可能再有人回答 —— 不收掉就是泄漏一次模型调用
    state.respondApproval?.('', false);
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
    send({ type: 'error', id, msg: config.reason || 'AI is not configured' });
    return;
  }

  const raw = readContext(message);

  if (!raw.text.trim()) {
    send({ type: 'error', id, msg: 'No terminal content to analyze' });
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
    const msg = aborted ? 'Cancelled' : (err instanceof AiProviderError ? err.message : (err?.message || 'Request failed'));
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
    send({ type: 'error', id, msg: config.reason || 'AI is not configured' });
    return;
  }

  const raw = readContext(message);
  if (!raw.question || !raw.question.trim()) {
    send({ type: 'error', id, msg: 'Describe what you want in one line' });
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
        msg: 'Model returned no usable command structure - degraded to read-only',
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
        allAllowlisted: grade.allAllowlisted,
        rootSession: grade.rootSession,
        autoRunnable: grade.autoRunnable,
        segments: grade.segments.map((s) => ({
          raw: s.raw,
          binary: s.binary,
          level: s.level,
          elevated: s.elevated,
          whitelisted: s.whitelisted,
          allowlisted: s.allowlisted,
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
    const msg = aborted ? 'Cancelled' : (err instanceof AiProviderError ? err.message : (err?.message || 'Request failed'));
    send({ type: 'error', id, msg, aborted, fallback: 'readonly' });
    if (!aborted) sshLog('ai draft failed', { host: raw.host, status: err?.status, message: msg });
  } finally {
    if (state.active?.id === id) state.active = null;
  }
}

/**
 * 实测远端的登录身份。
 *
 * 这是「能不能免审批自动执行」的依据，所以必须**服务端自己跑出来**，
 * 而不是听浏览器报 —— 上一版让前端传 `session.source === 'terminal'` 当凭证，
 * 那是自报，浏览器想造就能造。现在它只是 `id -un` 的输出。
 *
 * 探不到（没 shell / 超时 / 非 0）返回 null，调用方的处理是「一律要审批」，
 * 而不是「一律拒绝」—— 拿不到身份不该让 Agent 彻底不能干活。
 */
async function resolveIdentity(client: any): Promise<AgentIdentity | null> {
  try {
    const outcome = await execCapture(client, 'id -un; id -u', {
      timeoutMs: 10_000,
      maxBytes: 4096,
    });
    if (outcome.kind !== 'captured' || outcome.code !== 0) return null;

    const [user, uidText] = outcome.stdout.split('\n').map((line) => line.trim());
    if (!user || !/^[a-z_][a-z0-9_.-]*$/i.test(user)) return null;

    const uid = Number(uidText);
    return {
      user,
      uid: Number.isFinite(uid) ? uid : -1,
      isRoot: user === 'root' || uid === 0,
    };
  } catch {
    return null;
  }
}

/**
 * Agent 模式：跑一个完整的工具调用循环。
 *
 * 循环住在服务端（见 agent-loop.ts 的说明），这里负责三件事：
 *  1. 借 SSH 会话 —— 借不到就明确报错，而不是先跑起来再在第一步失败；
 *  2. 把循环里的事件翻译成 WS 帧；
 *  3. 把审批请求挂起，等客户端回 `agent_approval`。
 *
 * 审批挂起是这里唯一的异步阻塞点。取消时必须把它以「拒绝」收掉，
 * 否则循环会永远 await 着，界面显示已停、服务端却还占着上下文。
 */
async function runAgent(
  message: any,
  send: Send,
  state: ChannelState,
  hooks?: AiSshHooks,
) {
  const id = typeof message.id === 'string' && message.id ? message.id : `req-${Date.now()}`;
  const config = resolveAiConfig();

  if (!config.enabled || config.reason) {
    send({ type: 'agent_error', id, msg: config.reason || 'AI is not configured', reason: 'config' });
    return;
  }

  const raw = readContext(message);
  if (!raw.question || !raw.question.trim()) {
    send({ type: 'agent_error', id, msg: 'Describe what you want the agent to do', reason: 'empty-goal' });
    return;
  }

  const sessionId = typeof message.sessionId === 'string' ? message.sessionId.trim() : '';
  const session = sessionId ? hooks?.getSession(sessionId) : undefined;
  if (!session?.client) {
    send({
      type: 'agent_error',
      id,
      msg: 'No live SSH session. The Agent reuses the current terminal connection — connect a terminal tab first.',
      reason: 'no-session',
    });
    return;
  }

  const rawMax = Number(message.maxSteps);
  const maxSteps = Number.isFinite(rawMax) && rawMax > 0
    ? Math.min(Math.max(Math.floor(rawMax), 1), AGENT_MAX_STEPS_HARD_LIMIT)
    : AGENT_DEFAULT_MAX_STEPS;

  const prepared = prepareContext(raw, {
    maxInputTokens: config.maxInputTokens,
    redactPrivateIp: config.redactPrivateIp,
  });
  sendPrepared(send, id, prepared);

  state.active?.controller.abort();
  const controller = new AbortController();
  state.active = { id, controller };

  /** 同一时刻只会有一个审批在等 —— 循环是串行的，这点和 state.active 一致 */
  let pendingApproval: { callId: string; resolve: (allow: boolean) => void } | null = null;

  const settleApproval = (callId: string, allow: boolean) => {
    const pending = pendingApproval;
    if (!pending) return;
    // callId 为空 = 无视匹配（取消 / 断连时用）
    if (callId && pending.callId !== callId) return;
    pendingApproval = null;
    pending.resolve(allow);
  };
  state.respondApproval = settleApproval;

  send({ type: 'agent_start', id, maxSteps });

  const startedAt = Date.now();

  try {
    const identity = await resolveIdentity(session.client);
    send({
      type: 'agent_identity',
      id,
      user: identity?.user ?? null,
      uid: identity?.uid ?? null,
      isRoot: identity?.isRoot ?? false,
    });

    const result = await runAgentLoop({
      config,
      messages: buildAgentToolMessages({ goal: raw.question, prepared, maxSteps }),
      client: session.client,
      whitelist: config.commandWhitelist,
      identity,
      maxSteps,
      signal: controller.signal,
      events: {
        onStep: (step) => send({ type: 'agent_step', id, step }),
        onMessage: (content) => send({ type: 'agent_message', id, content }),
        onToolCall: (call) => send({
          type: 'agent_tool_call',
          id,
          callId: call.id,
          tool: call.name,
          arguments: call.arguments,
          display: call.display,
        }),
        onToolResult: (payload) => send({
          type: 'agent_tool_result',
          id,
          callId: payload.callId,
          tool: payload.name,
          output: payload.output,
          truncated: payload.truncated,
        }),
        requestApproval: (request) => new Promise<boolean>((resolve) => {
          pendingApproval = { callId: request.callId, resolve };
          send({
            type: 'agent_approval_required',
            id,
            callId: request.callId,
            tool: request.name,
            arguments: request.arguments,
            display: request.display,
            level: request.level,
            reasons: request.reasons,
          });
        }),
      },
    });

    send({
      type: 'agent_done',
      id,
      answer: result.answer,
      steps: result.steps,
      stopReason: result.stopReason,
      toolCalls: result.toolCalls,
      ms: Date.now() - startedAt,
    });

    sshLog('ai agent done', {
      host: raw.host,
      steps: result.steps,
      toolCalls: result.toolCalls,
      stopReason: result.stopReason,
      ms: Date.now() - startedAt,
    });
  } catch (err: any) {
    const aborted = controller.signal.aborted;
    const msg = aborted
      ? 'Cancelled'
      : (err instanceof AiProviderError ? err.message : (err?.message || 'Agent failed'));

    send({ type: 'agent_error', id, msg, aborted, reason: aborted ? 'cancelled' : 'error' });
    if (!aborted) {
      sshLog('ai agent failed', { host: raw.host, status: err?.status, message: msg });
    }
  } finally {
    state.respondApproval = null;
    if (state.active?.id === id) state.active = null;
  }
}
