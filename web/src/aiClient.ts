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

/** 发给服务端的对话历史（纯文字，用于让 Agent 延续上下文）。role 限定为两端都会用的两个 */
export type ChatMessage = { role: 'user' | 'assistant'; content: string };

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
  /** 高危：界面只给 Approve / Deny */
  dangerous: boolean;
  /** 是否提供「Approve Session」 */
  canRemember: boolean;
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

export interface AiHistoryEntry {
  kind: 'user' | 'text' | 'agent';
  text?: string;
  withScreen?: boolean;
  answer?: string;
  error?: string;
  aborted?: boolean;
  goal?: string;
  identity?: unknown;
  items?: Array<Record<string, unknown>>;
  final?: string;
  stopReason?: string;
  steps?: number;
  /** 条目创建时间（epoch ms），由服务端给，刷新/接管后仍在 */
  at?: number;
  /** agent run 的服务端实测总耗时（完成后才有） */
  ms?: number;
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
  /** resumed=true 表示这是重连后接回的一条**已在跑**的会话，不是新开的 */
  onAgentStart?: (payload: { maxSteps: number; resumed?: boolean; startedAt?: number }) => void;
  /** 服务端实测出来的远端身份；null 表示没探到 */
  onAgentIdentity?: (identity: AiAgentIdentity) => void;
  onAgentStep?: (step: number) => void;
  onAgentMessage?: (content: string) => void;
  onAgentToolCall?: (call: AiAgentToolCall) => void;
  onAgentToolResult?: (result: AiAgentToolResult) => void;
  /**
   * 需要用户表态。返回一个 Promise（含 remember 标志），由界面在用户点 Allow / Deny 时 resolve。
   * 不 resolve 循环就停在那里 —— 这是刻意的，审批不能被超时绕过。
   */
  onAgentApproval?: (request: AiAgentApproval) => Promise<{ allow: boolean; remember: boolean }>;
  /** 因「本次会话已放行」而跳过审批时触发，前端据此把这条工具标成 auto-approved */
  onAgentToolApproved?: (payload: { callId: string; method: 'once' | 'session' }) => void;
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
  /**
   * 被动跟随 handlers：接管/围观时本地没发过请求（handlers 为空），
   * 服务端回放与实时事件走这里渲染。不随 send 覆盖，跨请求有效。
   */
  private passiveHandlers: AiHandlers = {};
  /** 本地发出去的 run id（send 建的）。只属于它的事件才走 handlers */
  private ownedId: string | null = null;
  private currentId: string | null = null;
  private seq = 0;
  /**
   * 绑定的 SSH 会话。绑定后：
   *  - 建连时作为 query 传给 /ai，服务端据此 attach 到对应 AI 会话（复用其 run / 缓冲 / 审批记忆）；
   *  - 断线后自动重连，服务端会把断开期间缓冲的事件重放回来，用户看到同一条跑动中的会话。
   */
  private sessionId = '';
  private reconnectTimer: number | null = null;
  private closedByUser = false;

  onConfig?: (config: AiConfigView) => void;
  /**
   * 重连接回一条**已在跑**的会话时触发（不随 send 覆盖，跨请求有效）。
   *
   * 服务端在重连后先发 `agent_start{resumed}`，再重放断开期间缓冲的事件。
   * 面板据此新建一条 entry 承接后续重放/实时的 tool_call / tool_result / done。
   */
  onResumed?: (payload: { id: string; resumed?: boolean; startedAt?: number }) => void;
  /**
   * 新连接 attach 时发现服务端有一条**非 agent** 的 run 在跑（diagnose/draft）。
   *
   * 这类 run 没有 `agent_start` 可认回，只能从 `ready` 帧得知；delta 本身也不进
   * 服务端缓冲，所以接管方接手后只能从此刻起继续渲染。面板据此建一条 text entry
   * 承接后续 `onDelta`/`onDone`。
   */
  onFollowedRun?: (payload: { id: string; kind: 'diagnose' | 'draft'; startedAt?: number }) => void;
  /**
   * 新连接（重连 / 别的设备接管同一 SSH 会话）时，服务端回放整段对话历史。
   * 面板据此重建聊天窗口 —— 与 onResumed 不同，这是**完整的历史快照**，
   * 收到后应替换当前列表再继续。
   */
  onHistory?: (entries: AiHistoryEntry[]) => void;
  /** 服务端确认历史已清空 */
  onCleared?: () => void;
  /**
   * 面板开关状态（会话级，跨设备同步）。
   *
   * - 建连后的 ready 帧会带一次当前状态；
   * - 任一设备切换面板时广播。
   * 前端据此自动打开/关闭面板，实现「重连或接管后延续原设备的面板状态」。
   */
  onPanelState?: (open: boolean) => void;

  /**
   * 安装被动跟随 handlers：本地没发过请求时（接管/围观），
   * 属于跟随会话的事件走这里渲染。不随 send 覆盖。
   */
  setPassiveHandlers(handlers: AiHandlers) {
    this.passiveHandlers = handlers || {};
  }

  /** 绑定 / 更新目标 SSH 会话。变了就断开重连到新的 AI 会话 */
  setSession(sessionId: string | undefined) {
    const next = sessionId || '';
    if (next === this.sessionId) return;
    this.sessionId = next;
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try { old.close(); } catch {}
    }
    this.pendingConnect = null;
    if (next && !this.closedByUser) void this.connect().catch(() => {});
  }

  connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.pendingConnect) return this.pendingConnect;

    this.closedByUser = false;
    this.handlers.onStatus?.('connecting');

    this.pendingConnect = new Promise<void>((resolve, reject) => {
      const params = this.sessionId ? `sessionId=${encodeURIComponent(this.sessionId)}` : '';
      const ws = new WebSocket(wsUrl('/ai', params));
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
        this.handlers.onStatus?.('closed');
        // 网络级断开：服务端会话仍在跑，自动重连去接回缓冲的事件。
        // 主动 close()（面板/tab 关闭）不重连。
        if (!this.closedByUser && this.sessionId) this.scheduleReconnect();
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

  private scheduleReconnect() {
    if (this.reconnectTimer !== null || this.closedByUser) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByUser) return;
      this.connect().catch(() => this.scheduleReconnect());
    }, 2000);
  }

  private dispatch(message: any) {
    // 连接级消息（不带 id）与请求级消息分开处理
    if (message.type === 'ready' || message.type === 'config') {
      if (message.config) this.onConfig?.(message.config);
      /*
       * ready 帧带回当前面板开关状态，但**只在 true 时**通知上层打开面板。
       *
       * 不能在 false 时触发「关闭」：新 tab 刚刚挂载面板时，自己的 ai_panel_open
       * 还没送到服务端，ready 里的 panelOpen 仍是上一次的 false —— 若据此关闭，
       * 面板会「刚弹出就被卸载」，然后再被用户点开，表现为挂载两次。
       * 真正的「别人关掉了面板」由运行时的 ai_panel_state 广播表达，不走这里。
       */
      if (message.type === 'ready' && message.panelOpen === true) {
        this.onPanelState?.(true);
      }
      // ready 里带着「有一条 run 在跑」的信息。agent 走随后的 agent_start 认回；
      // 非 agent（diagnose/draft）没有 agent_start，这里直接通知面板建 text entry。
      if (message.type === 'ready' && message.resumed && message.resumedKind && message.resumedKind !== 'agent') {
        // 非 agent 的跟随流不会有 agent_start，currentId 得在这里认回来，
        // 否则随后到达的 delta/done 会因「id 不匹配 currentId(null)」被整批丢掉。
        this.currentId = String(message.resumed);
        this.onFollowedRun?.({
          id: String(message.resumed),
          kind: message.resumedKind,
          startedAt: typeof message.resumedStartedAt === 'number' ? message.resumedStartedAt : undefined,
        });
      }
      return;
    }
    if (message.type === 'pong') return;

    // 面板开关状态变化（别的设备打开/关闭了）
    if (message.type === 'ai_panel_state') {
      this.onPanelState?.(message.open === true);
      return;
    }

    // 会话历史快照：新连接（重连 / 接管）时服务端回放整段对话，交给面板重建
    if (message.type === 'ai_history') {
      this.onHistory?.(Array.isArray(message.entries) ? message.entries : []);
      return;
    }
    if (message.type === 'cleared') {
      this.onCleared?.();
      return;
    }

    // 跟随认回：`agent_start` 的 id 不是本地发出去的（ownedId 对不上），
    // 说明这是别人跑起来的会话（接管 / 重连后别人的 run / attach 后新开的 run）。
    // 先把 currentId 认回来，否则下面的 id 匹配会把它的后续事件全丢掉；
    // 再交给 onResumed（独立回调，不被 send 覆盖）让面板建 entry 承接。
    // 自己发出去的 run（id === ownedId）走正常 handlers 链路；重连回自己的 run
    //（resumed 且 id === ownedId）同样要过 onResumed 复用 entry。
    if (message.type === 'agent_start' && message.id) {
      const id = String(message.id);
      const startedAt = typeof message.startedAt === 'number' ? message.startedAt : undefined;
      const isOwned = this.ownedId !== null && id === this.ownedId;
      if (id === this.currentId) {
        if (message.resumed) this.onResumed?.({ id, resumed: true, startedAt });
        else this.handlers.onAgentStart?.({ maxSteps: 0, startedAt });
        return;
      }
      if (!isOwned) {
        this.currentId = id;
        this.onResumed?.({ id, resumed: Boolean(message.resumed), startedAt });
        return;
      }
      if (message.resumed) {
        this.currentId = id;
        this.onResumed?.({ id, resumed: true, startedAt });
        return;
      }
    }

    // 只处理属于「当前跟踪」的消息。currentId 为 null（已停止/连接刚建）或 id 不匹配时，
    // 一律丢弃 —— 否则被中止的那一跑残留的 agent_done / agent_message 会漏进新请求的回调，
    // 表现为「停止后还在输出」或「新指令显示旧结果」。
    if (message.id && message.id !== this.currentId) return;

    // 路由：自己发出去的 run 走 handlers；跟随的 run（id !== ownedId）只走 passiveHandlers。
    // 接管方没发过请求、handlers 为空时，靠的就是这一路 —— 否则回放/实时全被丢掉，
    // 只能靠刷新拿静态历史。不回落到 handlers：那可能是上一轮遗留的闭包，会写进错的 entry。
    const isOwnedMsg = Boolean(message.id && this.ownedId !== null && message.id === this.ownedId);
    const h: AiHandlers = isOwnedMsg ? this.handlers : this.passiveHandlers;

    switch (message.type) {
      case 'prepared':
        h.onPrepared?.({
          text: message.text || '',
          env: message.env || '',
          question: message.question || '',
          stats: message.stats,
        });
        return;
      case 'delta':
        h.onDelta?.(message.text || '');
        return;
      case 'done':
        this.clearTracked(message.id);
        h.onDone?.({
          model: message.model,
          usage: message.usage,
          finishReason: message.finishReason,
          firstTokenMs: message.firstTokenMs,
          ms: message.ms,
          chars: message.chars,
        });
        return;
      case 'draft':
        this.clearTracked(message.id);
        h.onDraft?.(
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
        h.onAgentStart?.({ maxSteps: Number(message.maxSteps) || 20, resumed: Boolean(message.resumed) });
        return;
      case 'agent_identity':
        h.onAgentIdentity?.({
          user: typeof message.user === 'string' ? message.user : null,
          uid: typeof message.uid === 'number' ? message.uid : null,
          isRoot: Boolean(message.isRoot),
        });
        return;
      case 'agent_step':
        h.onAgentStep?.(Number(message.step) || 0);
        return;
      case 'agent_message':
        h.onAgentMessage?.(String(message.content || ''));
        return;
      case 'agent_tool_call':
        h.onAgentToolCall?.({
          callId: String(message.callId || ''),
          tool: String(message.tool || ''),
          arguments: message.arguments && typeof message.arguments === 'object' ? message.arguments : {},
          display: String(message.display || ''),
        });
        return;
      case 'agent_tool_result':
        h.onAgentToolResult?.({
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
        const handler = h.onAgentApproval;
        if (!handler) {
          this.respondApproval(callId, false, false);
          return;
        }
        void Promise.resolve(handler({
          callId,
          tool: String(message.tool || ''),
          arguments: message.arguments && typeof message.arguments === 'object' ? message.arguments : {},
          display: String(message.display || ''),
          level: (['safe', 'caution', 'dangerous'].includes(message.level) ? message.level : 'caution') as AiRiskLevel,
          reasons: Array.isArray(message.reasons) ? message.reasons.map(String) : [],
          dangerous: message.dangerous === true,
          canRemember: message.canRemember === true,
        }))
          // remember 再按 canRemember 兜一层：高危即使前端误传也不进 auto。
          .then((decision) => this.respondApproval(
            callId,
            decision.allow === true,
            decision.remember === true && message.canRemember === true && message.dangerous !== true,
          ))
          .catch(() => this.respondApproval(callId, false, false));
        return;
      }
      case 'agent_tool_approved':
        h.onAgentToolApproved?.({
          callId: String(message.callId || ''),
          method: message.method === 'session' ? 'session' : 'once',
        });
        return;
      case 'agent_done':
        this.clearTracked(message.id);
        h.onAgentDone?.({
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
        this.clearTracked(message.id);
        h.onAgentError?.(String(message.msg || 'Agent failed'), Boolean(message.aborted));
        return;
      case 'error':
        this.clearTracked(message.id);
        h.onError?.(message.msg || 'Request failed', Boolean(message.aborted), {
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
   * @param history 同一条对话里前几轮的问答（纯文字），让模型延续上下文。
   */
  async agent(
    request: AiDiagnoseRequest,
    options: { sessionId: string; maxSteps: number; history?: ChatMessage[] },
    handlers: AiHandlers,
  ): Promise<string> {
    return this.send('agent', request, handlers, {
      sessionId: options.sessionId,
      maxSteps: options.maxSteps,
      ...(options.history && options.history.length ? { history: options.history } : {}),
    });
  }

  /** 回答一次审批。循环在服务端 await 着这个应答 */
  private respondApproval(callId: string, allow: boolean, remember: boolean) {
    if (!this.currentId) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      type: 'agent_approval',
      id: this.currentId,
      callId,
      allow,
      remember,
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
    this.ownedId = id;
    this.currentId = id;
    this.ws.send(JSON.stringify({ id, type, context: request, ...(extra || {}) }));
    return id;
  }

  /** 让服务端清空这条会话的对话历史（与本地清空配套） */
  clearHistory() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'clear' }));
  }

  /** 上报面板开关状态（会话级，服务端记住并同步给其它设备） */
  setPanelOpen(open: boolean) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: open ? 'ai_panel_open' : 'ai_panel_close' }));
    }
  }

  /** 一次 run 结束（done/error）：只清跟踪态，不动别人的 handlers */
  private clearTracked(id: unknown) {
    if (typeof id === 'string' && id && id !== this.currentId) return;
    this.currentId = null;
    if (typeof id === 'string' && id && id === this.ownedId) this.ownedId = null;
  }

  cancel() {
    if (!this.currentId) return;
    const id = this.currentId;
    this.currentId = null;
    if (id === this.ownedId) this.ownedId = null;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'cancel', id }));
    this.handlers.onError?.('Cancelled', true);
  }

  close() {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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

/**
 * 查询某 SSH 会话的 AI 面板是否开着。
 *
 * 接管设备在**挂载面板之前**调用：没有面板就没有 /ai 连接，也就收不到 ready.panelOpen，
 * 所以必须先用 HTTP 问一次，才知道要不要自动打开面板。
 */
export async function fetchAiPanelOpen(sessionId: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/ai/panel-state?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return false;
    const data = await res.json();
    return data?.open === true;
  } catch {
    return false;
  }
}
