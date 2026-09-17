import { resolveChatEndpoint, type ResolvedAiConfig } from './config.ts';
import type { ChatMessage } from './prompts.ts';

/**
 * OpenAI 兼容的流式对话客户端。刻意**不引 SDK**：
 * 端点用的是 `/chat/completions` 这一事实标准（OpenAI / DeepSeek / 通义 / Kimi /
 * vLLM / LiteLLM / Ollama 都吃），用 fetch + 手写 SSE 帧解析就能覆盖，
 * 和这个项目里其它协议（WS SFTP、remote-exec）手写到底的风格一致。
 */

export interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface StreamOutcome {
  model?: string;
  usage?: StreamUsage;
  finishReason?: string;
  chars: number;
  /** 首 token 延迟，毫秒 */
  firstTokenMs?: number;
}

export class AiProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'AiProviderError';
  }
}

/* --------------------------- Tool calling --------------------------- */

/** OpenAI 格式的工具声明 */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 模型要求调用的一个工具。`arguments` 是**字符串**，要不要解析由调用方决定 */
export interface ToolCallSpec {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** 工具执行结果回灌给模型的那条消息 */
export interface ToolResultMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

/** 带 tool_calls 的 assistant 消息。原样回灌，模型才知道自己在等哪个调用的结果 */
export interface AssistantToolCallMessage {
  role: 'assistant';
  content: string | null;
  tool_calls: ToolCallSpec[];
}

export type LLMessage = ChatMessage | ToolResultMessage | AssistantToolCallMessage;

export interface ChatCompletionResult {
  message: { role: 'assistant'; content: string | null; tool_calls?: ToolCallSpec[] };
  model?: string;
  usage?: StreamUsage;
  finishReason?: string;
  ms: number;
}

const DEFAULT_TIMEOUT_MS = 120000;

function extractErrorMessage(body: string) {
  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.message || parsed?.message || body.slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}

async function postChat(
  config: ResolvedAiConfig,
  messages: LLMessage[],
  stream: boolean,
  signal: AbortSignal,
  tools?: ToolSchema[],
): Promise<Response> {
  const endpoint = resolveChatEndpoint(config.baseUrl);
  const payload: Record<string, unknown> = {
    model: config.model,
    messages,
    stream,
    max_tokens: config.maxOutputTokens,
    temperature: 0.2,
  };
  if (stream) payload.stream_options = { include_usage: true };
  // 只在真的有工具时带上：不带工具却被网关以「不支持 tools」拒掉的悲剧就不用演了
  if (tools && tools.length) payload.tools = tools;

  // 局域网网关（ollama / vLLM / one-api 直连）通常不校验 key。留空就**不发**这个头，
  // 而不是逼用户编一个假 key —— 假 key 会被真实网关拒掉，反而把问题掩盖成 401。
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const send = (body: Record<string, unknown>) => fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  const response = await send(payload);

  // 有些网关不接受 stream_options，会直接 400；去掉它重试一次
  if (response.status === 400 && stream) {
    const body = await response.text().catch(() => '');
    if (/stream_options|unknown|unrecognized|unexpected/i.test(body)) {
      delete payload.stream_options;
      return send(payload);
    }
    throw new AiProviderError(`Model service returned 400: ${extractErrorMessage(body)}`, 400);
  }

  return response;
}

export async function streamChatCompletion(args: {
  config: ResolvedAiConfig;
  messages: ChatMessage[];
  signal: AbortSignal;
  onDelta: (text: string) => void;
  timeoutMs?: number;
}): Promise<StreamOutcome> {
  const { config, messages, signal, onDelta } = args;
  const endpoint = resolveChatEndpoint(config.baseUrl);
  if (!endpoint) throw new AiProviderError('Base URL not set');

  // 外部取消 + 总超时合成一个内部 signal，避免把超时暴露成「用户取消」
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await postChat(config, messages, true, controller.signal);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AiProviderError(`Model service returned ${response.status}: ${extractErrorMessage(body)}`, response.status);
    }

    const contentType = response.headers.get('content-type') || '';

    // 个别网关会忽略 stream:true 直接返回完整 JSON，兜住这种情况
    if (!contentType.includes('text/event-stream')) {
      const raw = await response.text();
      let content = '';
      let model: string | undefined;
      let usage: StreamUsage | undefined;
      try {
        const parsed = JSON.parse(raw);
        content = parsed?.choices?.[0]?.message?.content || parsed?.choices?.[0]?.text || '';
        model = parsed?.model;
        usage = parsed?.usage;
      } catch {
        throw new AiProviderError(`Model service returned unparsable content (content-type=${contentType || 'unknown'})`);
      }
      if (content) onDelta(content);
      return { model, usage, chars: content.length, firstTokenMs: content ? Date.now() : undefined };
    }

    const reader = response.body?.getReader();
    if (!reader) throw new AiProviderError('Model service returned no body');

    const decoder = new TextDecoder();
    let buffer = '';
    let chars = 0;
    let model: string | undefined;
    let usage: StreamUsage | undefined;
    let finishReason: string | undefined;
    let firstTokenMs: number | undefined;
    const startedAt = Date.now();

    const handleFrame = (frame: string) => {
      const payloads = frame
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());

      for (const payload of payloads) {
        if (!payload || payload === '[DONE]') continue;
        let json: any;
        try {
          json = JSON.parse(payload);
        } catch {
          continue; // 不完整或非 JSON 的帧，跳过而不是炸掉整条流
        }
        if (json.error) throw new AiProviderError(json.error.message || 'Model service error');
        if (json.model) model = json.model;
        if (json.usage) usage = json.usage;

        const choice = json.choices?.[0];
        const delta = choice?.delta?.content ?? choice?.text;
        if (typeof delta === 'string' && delta) {
          if (firstTokenMs === undefined) firstTokenMs = Date.now() - startedAt;
          chars += delta.length;
          onDelta(delta);
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // SSE 允许 CRLF 分帧，先归一化再找空行边界
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        handleFrame(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim()) handleFrame(buffer);

    return { model, usage, finishReason, chars, firstTokenMs };
  } catch (err: any) {
    if (signal.aborted) throw new AiProviderError('Cancelled');
    if (err?.name === 'AbortError') throw new AiProviderError('Model request timed out');
    if (err instanceof AiProviderError) throw err;
    throw new AiProviderError(`Model request failed: ${err?.message || err}`);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 一次**非流式**对话，供 Agent Loop 使用。
 *
 * 为什么不流式：Agent 回合的中间产物是 `tool_calls`，逐 token 流出来对用户毫无意义
 * （而且流式 tool_calls 是分片增量，拼装比这里整段解析麻烦得多）。
 * 进度靠 `agent_tool_call` / `agent_tool_result` 事件体现，那才是人看得懂的东西。
 *
 * `tools` 直接透传给网关：不绑 SDK，也不做「模拟 tool calling」
 * （有些框架在模型不支持时用提示词假装，那种假装有结构性缺陷，不做）。
 */
export async function chatCompletion(args: {
  config: ResolvedAiConfig;
  messages: LLMessage[];
  tools?: ToolSchema[];
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<ChatCompletionResult> {
  const { config, messages, signal } = args;
  if (!resolveChatEndpoint(config.baseUrl)) throw new AiProviderError('Base URL not set');

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await postChat(config, messages, false, controller.signal, args.tools);
    const body = await response.text();

    if (!response.ok) {
      /**
       * 网关不认 `tools` 太常见了（老版本 vLLM、某些中转层）。
       * 这种 400 必须说人话 —— 否则用户只看到「HTTP 400」，第一反应是自己把地址填错了，
       * 而真正的原因是这个模型端点不支持 function calling。
       */
      if (response.status === 400 && args.tools?.length && /tool|function_call/i.test(body)) {
        throw new AiProviderError(
          'This model endpoint rejected tool calling, which the Agent needs. '
          + 'Use a model with function-calling support, or use Explain / Generate command instead.',
          400,
        );
      }
      throw new AiProviderError(`Model service returned ${response.status}: ${extractErrorMessage(body)}`, response.status);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new AiProviderError('Model service returned unparsable JSON');
    }
    if (parsed?.error) throw new AiProviderError(parsed.error?.message || 'Model service error');

    const choice = parsed?.choices?.[0];
    const raw = choice?.message ?? {};
    const toolCalls = Array.isArray(raw.tool_calls)
      ? raw.tool_calls.filter((call: any) => call?.id && call?.function?.name)
      : undefined;

    return {
      message: {
        role: 'assistant',
        content: typeof raw.content === 'string' ? raw.content : null,
        ...(toolCalls && toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      model: parsed.model,
      usage: parsed.usage,
      finishReason: choice?.finish_reason,
      ms: Date.now() - startedAt,
    };
  } catch (err: any) {
    if (signal.aborted) throw new AiProviderError('Cancelled');
    if (err?.name === 'AbortError') throw new AiProviderError('Model request timed out');
    if (err instanceof AiProviderError) throw err;
    throw new AiProviderError(`Model request failed: ${err?.message || err}`);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** 配置页的「测试连接」：一次最小的非流式调用，只关心能不能通。 */
export async function verifyAiConfig(config: ResolvedAiConfig): Promise<{ ok: boolean; message: string; model?: string }> {
  if (!resolveChatEndpoint(config.baseUrl)) return { ok: false, message: 'Base URL not set' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await postChat(
      { ...config, maxOutputTokens: 8 },
      [{ role: 'user', content: 'hi' }],
      false,
      controller.signal,
    );
    const body = await response.text();
    if (!response.ok) {
      return { ok: false, message: `HTTP ${response.status}: ${extractErrorMessage(body)}` };
    }
    let model: string | undefined;
    try {
      model = JSON.parse(body)?.model;
    } catch {}
    return { ok: true, message: 'Connected', model };
  } catch (err: any) {
    return { ok: false, message: err?.name === 'AbortError' ? 'Timed out' : `Connection failed: ${err?.message || err}` };
  } finally {
    clearTimeout(timer);
  }
}
