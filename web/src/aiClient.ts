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
  whitelisted: boolean;
  hits: string[];
}

/** 服务端判分结果。等级以这里为准，模型自评只作参考。 */
export interface AiGradeResult {
  level: AiRiskLevel;
  hits: AiGradeHit[];
  reasons: string[];
  allWhitelisted: boolean;
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
  onError?: (msg: string, aborted: boolean, info?: { fallback?: 'readonly' }) => void;
  onDraft?: (draft: AiDraft, meta: AiDoneMeta) => void;
  onStatus?: (status: 'connecting' | 'open' | 'closed') => void;
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
          reject(new Error('AI 通道连接超时'));
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
        this.pendingConnect = null;
        // 流到一半断线：主动告诉调用方，否则面板会永远停在「生成中」
        if (this.currentId) {
          this.currentId = null;
          this.handlers.onError?.('AI 通道已断开', false);
        }
        this.handlers.onStatus?.('closed');
      };

      ws.onerror = () => {
        clearTimeout(timer);
        if (ws.readyState !== WebSocket.OPEN) reject(new Error('AI 通道连接失败'));
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
      case 'error':
        this.currentId = null;
        this.handlers.onError?.(message.msg || '调用失败', Boolean(message.aborted), {
          fallback: message.fallback === 'readonly' ? 'readonly' : undefined,
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

  private async send(
    type: 'diagnose' | 'draft',
    request: AiDiagnoseRequest,
    handlers: AiHandlers,
  ): Promise<string> {
    await this.connect();
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('AI 通道未连接');

    const id = `${Date.now()}-${++this.seq}`;
    this.handlers = handlers;
    this.currentId = id;
    this.ws.send(JSON.stringify({ id, type, context: request }));
    return id;
  }

  cancel() {
    if (!this.currentId) return;
    const id = this.currentId;
    this.currentId = null;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'cancel', id }));
    this.handlers.onError?.('已取消', true);
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

export async function fetchAiConfig(): Promise<AiConfigView> {
  const res = await apiFetch('/ai/config');
  if (!res.ok) throw new Error(`读取 AI 配置失败（HTTP ${res.status}）`);
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
  if (!res.ok) throw new Error(`保存 AI 配置失败（HTTP ${res.status}）`);
  return res.json();
}

export async function testAiConfig(): Promise<{ ok: boolean; message: string; model?: string }> {
  const res = await apiFetch('/ai/test', { method: 'POST' });
  if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
  return res.json();
}
