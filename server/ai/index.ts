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
  createApprovalMemory,
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
  /**
   * 这次 run 的类型。接管方 attach 时据此决定要不要发 `agent_start{resumed}`：
   * 只有 agent 才有一条需要「认回」的循环，diagnose/draft 是一次性流式请求，
   * 误发 agent_start 会让接管方凭空白建一张空的 Agent 卡片。
   */
  kind: 'diagnose' | 'draft' | 'agent';
  /** run 起点（epoch ms），接管方据此延续计时而不是从 0 开始 */
  startedAt: number;
}

/**
 * 会话历史（单会话）。
 *
 * 与 `buffer`（断线期间的临时事件暂存）不同，这是**长期保留**的对话记录，
 * 供新连接（重连、别的设备接管同一 SSH 会话）重建整个聊天窗口。
 * 生命周期跟 `AiSession` 走 —— 也就是跟 SSH 会话；SSH 会话销毁才清。
 *
 * 粒度是「前端能直接渲染的一条消息」，不是原始 SSE 式事件流：
 * 之所以这么选，是因为接管方需要的是「看到一模一样的对话」，而不是重放协议。
 */
type AiHistoryEntry =
  | { kind: 'user'; text: string; withScreen: boolean; at: number }
  | { kind: 'text'; answer: string; error?: string; aborted?: boolean; at: number }
  | {
      kind: 'agent';
      goal: string;
      identity?: unknown;
      items: Array<Record<string, unknown>>;
      final?: string;
      error?: string;
      aborted?: boolean;
      stopReason?: string;
      steps?: number;
      /** run 开始时间（epoch ms）。卡片据此显示起始时间，刷新/接管后也算得出耗时 */
      at: number;
      /** 服务端实测总耗时（完成后才有）。历史回放时用来显示「took Xs」 */
      ms?: number;
    };

/**
 * AI 会话：按 sessionId 常驻，挂在 SSHSession 上（见 session-manager 的 `ai` 字段）。
 *
 * 与 SSH 会话同构：socket 只是**观察者**，可以随时 detach / re-attach；
 * 会话本身（进行中的 run、审批记忆、事件缓冲、对话历史）不因前端断开而销毁。
 *
 * - `sockets`：当前挂着的观察者，事件同时广播给全部。
 * - `buffer`：本会话最近的事件日志。前端断开期间产生的输出留在里面，
 *   重连时按序重放，所以断线不会丢结果，也无需中止循环。
 * - `history`：长期保留的对话记录，供新连接重建聊天窗口。
 * - `active`：正在跑的那一次请求。断开不 abort —— 循环继续，输出进缓冲。
 * - `approvalMemory`：session 级放行记忆，跨连接保留（换会话即随会话销毁）。
 */
interface AiSession {
  sessionId: string;
  sockets: Set<WebSocket>;
  active: ActiveRequest | null;
  /**
   * 把当前挂起的审批收掉。
   *
   * 取消时必须走这里 —— 否则 Agent 循环会永远 await 在 `requestApproval` 上，
   * 界面显示已停止、服务端却还占着一次模型调用的上下文。
   *
   * 断开连接**不**调用它：审批按产品要求无限等待，重连后仍可应答。
   */
  respondApproval?: ((callId: string, allow: boolean, remember?: boolean) => void) | null;
  /**
   * 当前挂起审批的详情（callId / 工具 / 等级 / 理由）。
   *
   * 断开或接管时不会丢：新连接 attach 时据此**重新发起**审批请求，
   * 让新的观察者有机会应答。审批帧本身不进 buffer（重放会被误自动应答）。
   */
  pendingApprovalInfo?: Record<string, unknown> | null;
  approvalMemory: ReturnType<typeof createApprovalMemory> | null;
  /** 事件日志，供重连重放。有字节上限，超了从最老的丢 */
  buffer: Array<Record<string, unknown>>;
  bufferBytes: number;
  /** 单会话的对话历史，新连接 attach 时回放 */
  history: AiHistoryEntry[];
  /**
   * AI 面板是否处于打开状态（会话级，跨连接）。
   *
   * 前端开关面板时上报，服务端记住。新连接（重连 / 别的设备接管）attach 时回放这个
   * 状态：接管方据此自动打开面板 —— 不用去猜「原设备刚才开没开」。
   */
  panelOpen: boolean;
}

const AI_BUFFER_MAX_BYTES = 512 * 1024;
/**
 * 对话历史上限。`buffer` 有 512KB 上限，history 以前没有 —— 长会话（尤其每轮
 * 带大量 tool 输出）会无界增长。按条数 + 估算字节双重裁剪，超出丢最老的轮次。
 * 条数给足（接管方能看到完整的近期上下文），靠字节上限兜住内存：
 * 单条 agent record 可能含上百 KB 的工具输出，所以字节才是真正的约束。
 */
const AI_HISTORY_MAX_ENTRIES = 200;
const AI_HISTORY_MAX_BYTES = 5 * 1024 * 1024;

/** 追加一条历史并在超限时从最老的开始丢（永不丢最后一条，保证当前轮可见） */
function pushHistory(session: AiSession, entry: AiHistoryEntry): void {
  session.history.push(entry);
  // 估算总字节（entry 结构简单，JSON 长度足够近似）
  let bytes = 0;
  for (const e of session.history) bytes += JSON.stringify(e).length;
  while (
    session.history.length > 1
    && (session.history.length > AI_HISTORY_MAX_ENTRIES || bytes > AI_HISTORY_MAX_BYTES)
  ) {
    const dropped = session.history.shift();
    if (dropped) bytes -= JSON.stringify(dropped).length;
  }
}

export function createAiSession(sessionId: string): AiSession {
  return {
    sessionId,
    sockets: new Set(),
    active: null,
    respondApproval: null,
    approvalMemory: null,
    buffer: [],
    bufferBytes: 0,
    history: [],
    panelOpen: false,
  };
}

/** 会话销毁/SSH 断开时调用：中止在跑的 run，踢掉所有观察连接，释放缓冲 */
export function disposeAiSession(session: AiSession | undefined) {
  if (!session) return;
  session.active?.controller.abort();
  session.respondApproval?.('', false);
  session.active = null;
  session.respondApproval = null;
  // 会话没了，挂着的 AI socket 也不该继续以为自己能工作 —— 主动关闭，
  // 让前端明确知道「这条会话已失效」，而不是留着一个永远收不到回应的连接。
  closeAiSockets(session, 'session closed');
  session.buffer = [];
  session.bufferBytes = 0;
  session.history = [];
}

export type { AiSession };

/**
 * 只关闭挂在会话上的 AI 连接，**保留**历史、审批记忆与正在跑的 run。
 *
 * 用途是「会话易主 / 观察者被踢」：原设备的连接必须断，但会话本身（及其上下文）
 * 仍在，接管方新开 /ai 时会重新回放历史。
 */
export function closeAiSockets(session: AiSession | undefined, reason = 'closed') {
  if (!session) return;
  for (const socket of session.sockets) {
    try { socket.close(1000, reason); } catch {}
  }
  session.sockets.clear();
}

/** 会话级事件投递：广播给所有观察者，同时进缓冲供重连重放 */
function makeSessionSend(session: AiSession): Send {
  return (payload) => {
    const frame = JSON.stringify(payload);
    for (const socket of session.sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    }
    // 只对当次请求有意义、或不该重放的东西，不进缓冲：
    //  - `prepared` 回执很大且只对发起方有意义；
    //  - `agent_approval_required` 是**实时审批请求**，重放给新连接会被前端当成
    //    一次「需要应答」的请求，而新连接往往没有对应的 handlers，于是自动发出
    //    deny/allow —— 这正是「A 等待审批，B 接管后审批状态错乱」的来源。
    //    挂起审批的恢复由 attach 时重新发起处理（见 handleAiConnection）。
    const type = payload.type as string;
    if (
      type === 'delta'
      || type === 'prepared'
      || type === 'pong'
      || type === 'config'
      || type === 'agent_approval_required'
    ) return;
    session.buffer.push(payload);
    session.bufferBytes += frame.length;
    while (session.bufferBytes > AI_BUFFER_MAX_BYTES && session.buffer.length > 1) {
      const dropped = session.buffer.shift();
      if (dropped) session.bufferBytes -= JSON.stringify(dropped).length;
    }
  };
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
  /**
   * 取得（或按需创建）该 SSH 会话的 AI 会话对象。生命周期跟随 SSH 会话，
   * /ai 连接只是 attach 上去；断开只 detach，进行中的 run 与缓冲都留在会话上。
   */
  getAiSession(sessionId: string): AiSession;
}

/**
 * 建立一条 `/ai` 连接。
 *
 * 与旧版的根本差别：旧版每个连接一份 `ChannelState`，连接一断就 abort 掉正在跑的 Agent，
 * 重连拿不到之前的过程。现在 AI 状态按 `sessionId` 常驻在 SSH 会话上，
 * 连接只做三件事：attach、转发消息、detach。断开后循环继续跑、输出进缓冲，
 * 重连时先重放缓冲再实时转发 —— 用户看到的是同一条跑动中的会话。
 */
export function handleAiConnection(ws: WebSocket, hooks?: AiSshHooks, sessionIdFromUrl?: string) {
  const sessionId = (sessionIdFromUrl || '').trim();
  sshLog('ai ws connect', { sessionId: sessionId || '(none)', hasHooks: Boolean(hooks?.getAiSession) });
  const session = sessionId && hooks?.getAiSession ? hooks.getAiSession(sessionId) : null;
  sshLog('ai ws session resolved', { sessionId: sessionId || '(none)', attached: Boolean(session), historyLen: session?.history.length ?? -1 });

  if (!session) {
    // 没有会话可挂：只能按老样子当临时连接用（无缓冲、无复用）。
    // 正常前端都会带 sessionId，走到这里说明是旧客户端或会话已回收。
    ws.send(JSON.stringify({ type: 'ready', config: publicAiConfig() }));
    const transient: AiSession = createAiSession('');
    attachSocket(transient, ws, hooks);
    return;
  }

  session.sockets.add(ws);
  // 新连接（重连 / 别的设备接管）：先把整段对话历史回放给前端重建聊天窗口，
  // 再补一份当前配置、面板开关状态与「进行中」的进度，最后重放断开期间缓冲的事件。
  ws.send(JSON.stringify({
    type: 'ready',
    config: publicAiConfig(),
    resumed: session.active?.id ?? null,
    resumedKind: session.active?.kind ?? null,
    resumedStartedAt: session.active?.startedAt ?? null,
    panelOpen: session.panelOpen,
  }));
  if (session.history.length) {
    // 历史先于 resumed 发：接管方先拿到完整快照，再据 agent_start 认回「正在跑」的那条，
    // 往快照最后那条未完成的 agent record 里继续追，而不是另起一张空卡片。
    ws.send(JSON.stringify({ type: 'ai_history', entries: session.history }));
  }
  // 只有 agent 才有一条需要认回的循环。diagnose/draft 是一次性流式请求，
  // 发 agent_start 会让接管方凭空白建一张空的 Agent 卡片（历史里根本没有对应记录）。
  if (session.active?.kind === 'agent') {
    ws.send(JSON.stringify({
      type: 'agent_start',
      id: session.active.id,
      maxSteps: 0,
      startedAt: session.active.startedAt,
      resumed: true,
    }));
  }
  // 缓冲重放：只补 history 快照**覆盖不到**的那部分。
  //
  // 历史快照是「边跑边填」的（runAgent 创建 record 即入 history，tool/message 实时写进
  // record.items），所以 agent 的聚合事件（agent_message/tool_call/tool_result/done…）
  // 早已体现在快照里；再重放一遍会让接管方把同一批工具调用看两遍。这里只重放
  // 非 agent 的零星帧（如有），agent 一律交给 history + 后续实时事件。
  for (const event of session.buffer) {
    if (String(event.type).startsWith('agent_')) continue;
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }
  // 有挂起审批时，重新向新连接发起请求 —— 旧连接已经不在（或被接管），
  // 新连接才是此刻能应答的人。审批帧不进 buffer，所以这里显式补发。
  if (session.pendingApprovalInfo) {
    ws.send(JSON.stringify(session.pendingApprovalInfo));
  }

  attachSocket(session, ws, hooks);
}

/**
 * 把一条 socket 接到会话上，处理它发来的消息。
 *
 * 拆出来是为了「有 sessionId」和「无 sessionId 的临时连接」两条路径共用同一套消息处理。
 */
function attachSocket(session: AiSession, ws: WebSocket, hooks?: AiSshHooks) {
  const send = makeSessionSend(session);

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

      case 'ai_panel_open':
      case 'ai_panel_close': {
        // 面板开关是会话级状态：一个设备打开/关闭，要同步给其它设备（含之后接入的）。
        const open = message.type === 'ai_panel_open';
        sshLog('ai panel state', { sessionId: session.sessionId, open });
        if (session.panelOpen !== open) {
          session.panelOpen = open;
          // 广播给所有观察者；发送方自己收到也无妨（幂等）
          for (const socket of session.sockets) {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'ai_panel_state', open }));
            }
          }
        }
        return;
      }

      case 'clear':
        // 清空这条 AI 会话的对话历史与事件缓冲。历史按 SSH 会话存，
        // 不清的话接管设备还会看到刚被「清空」的内容。
        session.history = [];
        session.buffer = [];
        session.bufferBytes = 0;
        send({ type: 'cleared' });
        return;

      case 'cancel':
        if (session.active && (!message.id || session.active.id === message.id)) {
          session.active.controller.abort();
          // callId 传空串 = 无视匹配，直接以「拒绝」收掉挂起的审批
          session.respondApproval?.('', false);
          session.active = null;
        }
        return;

      case 'agent_approval':
        if (typeof message.callId === 'string') {
          session.respondApproval?.(message.callId, message.allow === true, message.remember === true);
        }
        return;

      case 'diagnose':
        void runDiagnose(message, send, session);
        return;

      case 'draft':
        void runDraft(message, send, session);
        return;

      case 'agent':
        void runAgent(message, send, session, hooks);
        return;

      default:
        send({ type: 'error', msg: `Unknown message type: ${message?.type}` });
        return;
    }
  });

  ws.on('close', () => {
    session.sockets.delete(ws);
    // 断开**不**中止 run、不清审批：按产品要求，Agent 继续跑、输出进缓冲，审批无限等待，
    // 重连（同 sessionId）后从这里重放。会话销毁时才由 session-manager 收尾。
  });
}

async function runDiagnose(
  message: any,
  send: Send,
  state: AiSession,
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
  pushHistory(state, { kind: 'user', text: raw.question || '', withScreen: Boolean(raw.text.trim()), at: Date.now() });

  state.active?.controller.abort();
  const controller = new AbortController();
  const startedAt = Date.now();
  state.active = { id, controller, kind: 'diagnose', startedAt };

  const buffer = createDeltaBuffer(send, id);
  let answerText = '';
  const pushDelta = (text: string) => {
    answerText += text;
    buffer.push(text);
  };

  try {
    const outcome = await streamChatCompletion({
      config,
      messages: buildDiagnoseMessages(prepared),
      signal: controller.signal,
      onDelta: pushDelta,
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
    pushHistory(state, { kind: 'text', answer: answerText, at: startedAt });

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
    pushHistory(state, { kind: 'text', answer: answerText, error: msg, aborted, at: startedAt });
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
  state: AiSession,
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
  const startedAt = Date.now();
  state.active = { id, controller, kind: 'draft', startedAt };

  const buffer = createDeltaBuffer(send, id);
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
  state: AiSession,
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
  // run 的起点在**服务端**定：前端只负责显示，不自己从 0 计时。
  // 这样刷新 / 接管后仍能算出真实已耗时，而不是重新从 0 开始。
  const startedAt = Date.now();
  state.active = { id, controller, kind: 'agent', startedAt };

  /** 同一时刻只会有一个审批在等 —— 循环是串行的，这点和 state.active 一致 */
  let pendingApproval: { callId: string; resolve: (decision: { allow: boolean; remember: boolean }) => void } | null = null;

  const settleApproval = (callId: string, allow: boolean, remember = false) => {
    const pending = pendingApproval;
    if (!pending) return;
    // callId 为空 = 无视匹配（取消 / 断连时用）
    if (callId && pending.callId !== callId) return;
    pendingApproval = null;
    state.pendingApprovalInfo = null;
    pending.resolve({ allow, remember });
  };
  state.respondApproval = settleApproval;

  send({ type: 'agent_start', id, maxSteps, startedAt });

  // 审批记忆：挂在 AI 会话上（跟随 SSH 会话生命周期）。点过「Allow for session」后，
  // 这条会话之后的所有 runAgent 请求里同类工具都自动放行；前端断开重连也保留。
  if (!state.approvalMemory) state.approvalMemory = createApprovalMemory();
  const approvalMemory = state.approvalMemory;

  // 这一轮的对话记录，边跑边填。**创建即入 history**：这样一条进行中的 run
  // 也能在接管 / 重连时被回放出来（否则对方只看到「执行中」却没有任何上下文）。
  // 结束/出错时只更新字段，不重复 push。
  const record: Extract<AiHistoryEntry, { kind: 'agent' }> = {
    kind: 'agent',
    goal: raw.question || '',
    items: [],
    at: startedAt,
  };
  pushHistory(state, { kind: 'user', text: raw.question || '', withScreen: Boolean(raw.text.trim()), at: startedAt });
  pushHistory(state, record);

  try {
    const identity = await resolveIdentity(session.client);
    record.identity = identity
      ? { user: identity.user, uid: identity.uid, isRoot: identity.isRoot }
      : null;
    send({
      type: 'agent_identity',
      id,
      user: identity?.user ?? null,
      uid: identity?.uid ?? null,
      isRoot: identity?.isRoot ?? false,
    });

    const result = await runAgentLoop({
      config,
      messages: buildAgentToolMessages({
        goal: raw.question,
        prepared,
        maxSteps,
        history: Array.isArray(message.history) ? message.history : undefined,
      }),
      client: session.client,
      whitelist: config.commandWhitelist,
      identity,
      maxSteps,
      signal: controller.signal,
      approvalMemory,
      events: {
        onStep: (step) => send({ type: 'agent_step', id, step }),
        onMessage: (content) => {
          if (content.trim()) record.items.push({ kind: 'message', text: content });
          send({ type: 'agent_message', id, content });
        },
        onToolCall: (call) => {
          record.items.push({
            kind: 'tool',
            callId: call.id,
            tool: call.name,
            display: call.display,
            status: 'running',
          });
          send({
            type: 'agent_tool_call',
            id,
            callId: call.id,
            tool: call.name,
            arguments: call.arguments,
            display: call.display,
          });
        },
        onToolResult: (payload) => {
          const item = record.items.find((it) => it.kind === 'tool' && it.callId === payload.callId);
          if (item) {
            item.status = 'done';
            item.output = payload.output;
            item.truncated = payload.truncated;
          }
          send({
            type: 'agent_tool_result',
            id,
            callId: payload.callId,
            tool: payload.name,
            output: payload.output,
            truncated: payload.truncated,
          });
        },
        onToolApproved: (callId, method) => {
          const item = record.items.find((it) => it.kind === 'tool' && it.callId === callId);
          if (item) item.status = 'auto';
          send({
            type: 'agent_tool_approved',
            id,
            callId,
            method,
          });
        },
        requestApproval: (request) => new Promise<{ allow: boolean; remember: boolean }>((resolve) => {
          pendingApproval = { callId: request.callId, resolve };
          const item = record.items.find((it) => it.kind === 'tool' && it.callId === request.callId);
          if (item) {
            item.status = 'awaiting';
            item.level = request.level;
            item.reasons = request.reasons;
            item.dangerous = request.dangerous;
            item.canRemember = request.canRemember;
          }
          const frame = {
            type: 'agent_approval_required',
            id,
            callId: request.callId,
            tool: request.name,
            arguments: request.arguments,
            display: request.display,
            level: request.level,
            reasons: request.reasons,
            dangerous: request.dangerous,
            canRemember: request.canRemember,
          };
          // 存详情，供新连接 attach 时重新发起（审批帧本身不进 buffer，避免被误自动应答）
          state.pendingApprovalInfo = frame;
          send(frame);
        }),
      },
    });

    record.final = result.answer;
    record.stopReason = result.stopReason;
    record.steps = result.steps;
    record.ms = Date.now() - startedAt;
    send({
      type: 'agent_done',
      id,
      answer: result.answer,
      steps: result.steps,
      stopReason: result.stopReason,
      toolCalls: result.toolCalls,
      ms: record.ms,
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

    record.error = msg;
    record.aborted = aborted;
    send({ type: 'agent_error', id, msg, aborted, reason: aborted ? 'cancelled' : 'error' });
    if (!aborted) {
      sshLog('ai agent failed', { host: raw.host, status: err?.status, message: msg });
    }
  } finally {
    state.respondApproval = null;
    state.pendingApprovalInfo = null;
    if (state.active?.id === id) state.active = null;
  }
}
