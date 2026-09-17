import { apiFetch, wsUrl } from './api';

/**
 * `/ai` 通道的客户端。与 sftpClient 不同，这里是**流式**的：
 * 一次 diagnose 会先收到 prepared，再连续收到 delta，最后 done 或 error。
 */

export interface AiConfigView {
  enabled: boolean;
  ready: boolean;
  reason?: string;
  baseUrl: string;
  model: string;
  endpoint: string;
  hasKey: boolean;
  keyFromEnv: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  redactPrivateIp: boolean;
  commandWhitelist: string[];
}

export type AiRiskLevel = 'safe' | 'caution' | 'dangerous';

export interface AiGradeHit {
  rule: string;
  label: string;
  level: AiRiskLevel;
}

export interface AiGradeSegment {
  raw: string;
  binary: string | null;
  level: AiRiskLevel;
  elevated: boolean;
  /** 内置只读表命中 **或** 在用户允许名单里 */
  whitelisted: boolean;
  /** 该命令明确出现在用户配置的允许名单里 */
  allowlisted: boolean;
  hits: string[];
}

/** 服务端判分结果。等级以这里为准，模型自评只作参考。 */
export interface AiGradeResult {
  level: AiRiskLevel;
  hits: AiGradeHit[];
  reasons: string[];
  /** 每个片段都够「只读」。**不等于**用户授权，别当成无人值守的许可 */
  allWhitelisted: boolean;
  /** 每个片段都在用户配置的允许名单里 —— 这才是用户显式授权 */
  allAllowlisted: boolean;
  rootSession: boolean;
  autoRunnable: boolean;
  segments: AiGradeSegment[];
}

export interface AiDraft {
  command: string;
  explain: string;
  /** 模型自评，仅作提示 */
  selfRisk: AiRiskLevel | null;
  prerequisites: string[];
  grade: AiGradeResult;
}

/* ------------------------- Agent 模式（P2） ------------------------- */

/** `/term` 侧实测的会话身份 */
export interface AiSessionIdent {
  status: 'ok' | 'unavailable';
  user?: string;
  uid?: number;
  isRoot?: boolean;
}

/** `/term` 侧一次结构化采集的结果 */
export interface AiExecResult {
  status: 'captured' | 'no-shell' | 'rejected' | 'error';
  stdout?: string;
  stderr?: string;
  /** null = 超时被中断或通道异常，拿不到真实退出码 */
  code?: number | null;
  truncated?: boolean;
  timedOut?: boolean;
  durationMs?: number;
  channelError?: string;
  error?: string;
}

/* ------------------------- Agent 模式 ------------------------- */

/**
 * Agent 循环住在服务端，这里只有「事件 + 一次应答」。
 *
 * 上一版循环在浏览器里：每一步都要「问模型 → 拿命令 → 找 /term 执行 → 把输出贴回
 * transcript → 再问一次」，历史每轮重发，身份还得由我们自报给服务端当免审批的依据。
 * 现在浏览器只剩两件事：把事件画出来，以及在被问到的时候回答「允许 / 拒绝」。
 */
export interface AiAgentToolCall {
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
  display: string;
}

export interface AiAgentToolResult {
  callId: string;
  tool: string;
  output: string;
  truncated: boolean;
}

export interface AiAgentApproval {
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
  display: string;
  level: AiRiskLevel;
  reasons: string[];
}

export interface AiAgentIdentity {
  user: string | null;
  uid: number | null;
  isRoot: boolean;
}

export interface AiAgentDone {
  answer: string;
  steps: number;
  /** final = 模型自己收尾；max-steps = 撞到步数上限；cancelled = 用户中断 */
  stopReason: 'final' | 'max-steps' | 'cancelled';
  toolCalls: number;
  ms?: number;
}

/**
 * 执行桥：由 TerminalView 注册，持有那条 WS 的人才能发 /term 控制帧。
 *
 * 保留它是因为 P1 的「把命令填进终端输入行」仍然需要它；
 * Agent 已经不走这座桥了 —— 它在服务端直接借 SSH 会话执行。
 */
export interface TerminalBridge {
  capture: (command: string, options?: { timeoutMs?: number; auto?: boolean }) => Promise<AiExecResult>;
  identify: () => Promise<AiSessionIdent>;
}

export interface AiContextStats {
  rawLines: number;
  rawChars: number;
  lines: number;
  chars: number;
  omittedLines: number;
  collapsedLines: number;
  redactions: Record<string, number>;
  redactionTotal: number;
  estTokens: number;
  truncated: boolean;
}

export interface AiDiagnoseRequest {
  text: string;
  source: 'selection' | 'tail';
  host?: string;
  username?: string;
  cwd?: string;
  question?: string;
}

export interface AiDoneMeta {
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  finishReason?: string;
  firstTokenMs?: number;
  ms?: number;
  chars?: number;
}

export interface AiHandlers {
  onPrepared?: (payload: { text: string; env: string; question: string; stats: AiContextStats }) => void;
  onDelta?: (text: string) => void;
  onDone?: (meta: AiDoneMeta) => void;
  /**
   * fallback === 'readonly' 表示服务端没能把模型输出解析成结构化命令，
   * 已降级为只读展示：调用方应把已收到的 delta 当普通回答渲染，
   * **不提供任何执行入口**。
   */
  /**
   * `info.raw`：解析失败这类情况下服务端回传的模型原文（已截断）。
   * 界面要把它显示出来 —— 一句「无法解析」是死胡同，用户得看见模型到底吐了什么才能判断
   * 是模型不行还是目标描述得不好。
   */
  onError?: (msg: string, aborted: boolean, info?: { fallback?: 'readonly'; reason?: string; raw?: string }) => void;
  onDraft?: (draft: AiDraft, meta: AiDoneMeta) => void;
  onStatus?: (status: 'connecting' | 'open' | 'closed') => void;

  /* ---- Agent：服务端驱动的循环，浏览器只负责渲染与应答 ---- */
  onAgentStart?: (payload: { maxSteps: number }) => void;
  /** 服务端实测出来的远端身份；null 表示没探到 */
  onAgentIdentity?: (identity: AiAgentIdentity) => void;
  onAgentStep?: (step: number) => void;
  onAgentMessage?: (content: string) => void;
  onAgentToolCall?: (call: AiAgentToolCall) => void;
  onAgentToolResult?: (result: AiAgentToolResult) => void;
  /**
   * 需要用户表态。返回一个 Promise，由界面在用户点 Allow / Deny 时 resolve。
   * 不 resolve 循环就停在那里 —— 这是刻意的，审批不能被超时绕过。
   */
  onAgentApproval?: (request: AiAgentApproval) => Promise<boolean>;
  onAgentDone?: (payload: AiAgentDone) => void;
  onAgentError?: (msg: string, aborted: boolean) => void;
}

const CONNECT_TIMEOUT_MS = 8000;
const PING_INTERVAL_MS = 20000;

export class AiWSClient {
  private ws: WebSocket | null = null;
  private pingTimer: number | null = null;
  private pendingConnect: Promise<void> | null = null;
  private handlers: AiHandlers = {};
  private currentId: string | null = null;
  private seq = 0;

  onConfig?: (config: AiConfigView) => void;

  connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.pendingConnect) return this.pendingConnect;

    this.handlers.onStatus?.('connecting');

    this.pendingConnect = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl('/ai', ''));
      this.ws = ws;

      const timer = window.setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          try { ws.close(); } catch {}
          reject(new Error('AI channel timed out'));
        }
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        clearTimeout(timer);
        this.startPing();
        this.handlers.onStatus?.('open');
        resolve();
      };

      ws.onmessage = (ev) => {
        let message: any;
        try {
          message = JSON.parse(ev.data);
        } catch {
          return;
        }
        this.dispatch(message);
      };

      ws.onclose = () => {
        clearTimeout(timer);
        this.stopPing();
        // 旧连接迟到的 close 不能动新连接的状态（同一个 client 可能已经重连过）
        if (this.ws !== ws) return;
        this.ws = null;
        this.pendingConnect = null;
        // 流到一半断线：主动告诉调用方，否则面板会永远停在「生成中」
        if (this.currentId) {
          this.currentId = null;
          this.handlers.onError?.('Connection lost before the response finished. Retry.', false);
        }
        this.handlers.onStatus?.('closed');
      };

      ws.onerror = () => {
        clearTimeout(timer);
        if (ws.readyState !== WebSocket.OPEN) reject(new Error('AI channel connect failed'));
      };
    });

    this.pendingConnect = this.pendingConnect.catch((err) => {
      this.pendingConnect = null;
      throw err;
    });

    return this.pendingConnect;
  }

  private dispatch(message: any) {
    // 连接级消息（不带 id）与请求级消息分开处理
    if (message.type === 'ready' || message.type === 'config') {
      if (message.config) this.onConfig?.(message.config);
      return;
    }
    if (message.type === 'pong') return;
    if (message.id && this.currentId && message.id !== this.currentId) return;

    switch (message.type) {
      case 'prepared':
        this.handlers.onPrepared?.({
          text: message.text || '',
          env: message.env || '',
          question: message.question || '',
          stats: message.stats,
        });
        return;
      case 'delta':
        this.handlers.onDelta?.(message.text || '');
        return;
      case 'done':
        this.currentId = null;
        this.handlers.onDone?.({
          model: message.model,
          usage: message.usage,
          finishReason: message.finishReason,
          firstTokenMs: message.firstTokenMs,
          ms: message.ms,
          chars: message.chars,
        });
        return;
      case 'draft':
        this.currentId = null;
        this.handlers.onDraft?.(
          {
            command: message.command || '',
            explain: message.explain || '',
            selfRisk: message.selfRisk ?? null,
            prerequisites: Array.isArray(message.prerequisites) ? message.prerequisites : [],
            grade: {
              level: message.grade?.level || 'caution',
              hits: message.grade?.hits || [],
              reasons: message.grade?.reasons || [],
              allWhitelisted: Boolean(message.grade?.allWhitelisted),
              allAllowlisted: Boolean(message.grade?.allAllowlisted),
              rootSession: Boolean(message.grade?.rootSession),
              autoRunnable: Boolean(message.grade?.autoRunnable),
              segments: message.grade?.segments || [],
            },
          },
          {
            model: message.model,
            usage: message.usage,
            finishReason: message.finishReason,
            firstTokenMs: message.firstTokenMs,
            ms: message.ms,
            chars: message.chars,
          },
        );
        return;
      case 'agent_start':
        this.handlers.onAgentStart?.({ maxSteps: Number(message.maxSteps) || 20 });
        return;
      case 'agent_identity':
        this.handlers.onAgentIdentity?.({
          user: typeof message.user === 'string' ? message.user : null,
          uid: typeof message.uid === 'number' ? message.uid : null,
          isRoot: Boolean(message.isRoot),
        });
        return;
      case 'agent_step':
        this.handlers.onAgentStep?.(Number(message.step) || 0);
        return;
      case 'agent_message':
        this.handlers.onAgentMessage?.(String(message.content || ''));
        return;
      case 'agent_tool_call':
        this.handlers.onAgentToolCall?.({
          callId: String(message.callId || ''),
          tool: String(message.tool || ''),
          arguments: message.arguments && typeof message.arguments === 'object' ? message.arguments : {},
          display: String(message.display || ''),
        });
        return;
      case 'agent_tool_result':
        this.handlers.onAgentToolResult?.({
          callId: String(message.callId || ''),
          tool: String(message.tool || ''),
          output: String(message.output || ''),
          truncated: Boolean(message.truncated),
        });
        return;
      case 'agent_approval_required': {
        // 循环此刻正 await 在服务端。必须应答，否则它会一直挂着 ——
        // 拿不到应答就按拒绝处理，宁可少做一步也不让人以为已经批准了。
        const callId = String(message.callId || '');
        const handler = this.handlers.onAgentApproval;
        if (!handler) {
          this.respondApproval(callId, false);
          return;
        }
        void Promise.resolve(handler({
          callId,
          tool: String(message.tool || ''),
          arguments: message.arguments && typeof message.arguments === 'object' ? message.arguments : {},
          display: String(message.display || ''),
          level: (['safe', 'caution', 'dangerous'].includes(message.level) ? message.level : 'caution') as AiRiskLevel,
          reasons: Array.isArray(message.reasons) ? message.reasons.map(String) : [],
        }))
          .then((allow) => this.respondApproval(callId, allow === true))
          .catch(() => this.respondApproval(callId, false));
        return;
      }
      case 'agent_done':
        this.currentId = null;
        this.handlers.onAgentDone?.({
          answer: String(message.answer || ''),
          steps: Number(message.steps) || 0,
          stopReason: (['final', 'max-steps', 'cancelled'].includes(message.stopReason)
            ? message.stopReason
            : 'final') as AiAgentDone['stopReason'],
          toolCalls: Number(message.toolCalls) || 0,
          ms: typeof message.ms === 'number' ? message.ms : undefined,
        });
        return;
      case 'agent_error':
        this.currentId = null;
        this.handlers.onAgentError?.(String(message.msg || 'Agent failed'), Boolean(message.aborted));
        return;
      case 'error':
        this.currentId = null;
        this.handlers.onError?.(message.msg || 'Request failed', Boolean(message.aborted), {
          fallback: message.fallback === 'readonly' ? 'readonly' : undefined,
          reason: typeof message.reason === 'string' ? message.reason : undefined,
          raw: typeof message.raw === 'string' ? message.raw : undefined,
        });
        return;
      default:
        return;
    }
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'ping' }));
    }, PING_INTERVAL_MS);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** 返回本次请求 id；调用方可用它做「这批 delta 属于谁」的判断 */
  async diagnose(request: AiDiagnoseRequest, handlers: AiHandlers): Promise<string> {
    return this.send('diagnose', request, handlers);
  }

  /**
   * 生成命令草稿。delta 里流的是模型的原始输出（可能是 JSON），
   * 结构化结果在 `onDraft` 里给；解析失败时走 `onError` 且 fallback='readonly'。
   */
  async draft(request: AiDiagnoseRequest, handlers: AiHandlers): Promise<string> {
    return this.send('draft', request, handlers);
  }

  /**
   * 开跑一次 Agent。
   *
   * 与 diagnose/draft 的关键差别：这一个请求背后是**服务端的一整个循环**，
   * 会持续收到 tool_call / tool_result / approval_required，最后才是 done。
   * 中途要表态就通过 `handlers.onAgentApproval`。
   *
   * @param sessionId 要借用的 SSH 会话。Agent 复用**当前这个终端 tab** 的连接，
   *                  不给就跑不起来 —— 一个只会思考不能执行的 Agent 没有意义。
   */
  async agent(
    request: AiDiagnoseRequest,
    options: { sessionId: string; maxSteps: number },
    handlers: AiHandlers,
  ): Promise<string> {
    return this.send('agent', request, handlers, {
      sessionId: options.sessionId,
      maxSteps: options.maxSteps,
    });
  }

  /** 回答一次审批。循环在服务端 await 着这个应答 */
  private respondApproval(callId: string, allow: boolean) {
    if (!this.currentId) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      type: 'agent_approval',
      id: this.currentId,
      callId,
      allow,
    }));
  }

  private async send(
    type: 'diagnose' | 'draft' | 'agent',
    request: AiDiagnoseRequest,
    handlers: AiHandlers,
    extra?: Record<string, unknown>,
  ): Promise<string> {
    await this.connect();
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('AI channel not connected');

    const id = `${Date.now()}-${++this.seq}`;
    this.handlers = handlers;
    this.currentId = id;
    this.ws.send(JSON.stringify({ id, type, context: request, ...(extra || {}) }));
    return id;
  }

  cancel() {
    if (!this.currentId) return;
    const id = this.currentId;
    this.currentId = null;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'cancel', id }));
    this.handlers.onError?.('Cancelled', true);
  }

  close() {
    this.stopPing();
    this.currentId = null;
    if (this.ws) {
      try { this.ws.close(1000); } catch {}
      this.ws = null;
    }
    this.pendingConnect = null;
  }
}

/**
 * 把失败响应拼成一句能读的错误。
 *
 * 服务端现在对接口路径统一回 JSON（未匹配 404、内部异常 500 都带 `{error}`），
 * 所以这里优先取 body.error —— 直接把「路由不存在 / 写文件失败」这类真实原因说清楚，
 * 而不是只丢一个 HTTP 状态码让人猜。
 */
async function describeFailure(res: Response): Promise<string> {
  let detail = '';
  try {
    const body = await res.clone().json();
    if (body && typeof body.error === 'string') detail = body.error;
  } catch {
    // 老服务端 / 反代会回 HTML，取不到 detail 就只报状态码
  }
  return detail ? `HTTP ${res.status} — ${detail}` : `HTTP ${res.status}`;
}

export async function fetchAiConfig(): Promise<AiConfigView> {
  const res = await apiFetch('/ai/config');
  if (!res.ok) throw new Error(`Failed to load AI config (${await describeFailure(res)})`);
  return res.json();
}

export async function saveAiConfig(
  patch: Partial<Pick<AiConfigView, 'enabled' | 'baseUrl' | 'model' | 'redactPrivateIp' | 'maxInputTokens' | 'maxOutputTokens' | 'commandWhitelist'>>,
  apiKey?: string | null,
): Promise<AiConfigView> {
  const body: Record<string, unknown> = { ...patch };
  if (apiKey !== undefined) body.apiKey = apiKey;
  const res = await apiFetch('/ai/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed to save AI config (${await describeFailure(res)})`);
  return res.json();
}

export async function testAiConfig(): Promise<{ ok: boolean; message: string; model?: string }> {
  const res = await apiFetch('/ai/test', { method: 'POST' });
  if (!res.ok) return { ok: false, message: await describeFailure(res) };
  return res.json();
}
