import { REASONING_MIN_OUTPUT_TOKENS, resolveChatEndpoint, resolveModelsEndpoint, type ResolvedAiConfig } from './config.ts';
import type { ChatMessage } from './prompts.ts';

/**
 * OpenAI 兼容的流式对话客户端。刻意**不引 SDK**：
 * 端点用的是 `/chat/completions` 这一事实标准（OpenAI / DeepSeek / 通义 / Kimi /
 * vLLM / LiteLLM / Ollama 都吃），用 fetch + 手写 SSE 帧解析就能覆盖，
 * 和这个项目里其它协议（WS SFTP、remote-exec）手写到底的风格一致。
 */

export interface StreamUsage {
  prompt_tokens?: number;
  input_tokens?: number;
  completion_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  /** DeepSeek / llmproxy 风格：缓存命中的 prompt token 数 */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  /** 网关直出的命中数（与 prompt_tokens_details.cached_tokens 等价） */
  cached_tokens?: number;
  cache_read_input_tokens?: number;
  /** 推理 token 的另一种落点（llmproxy 老字段） */
  completion_thinking_tokens?: number;
  /** OpenAI / llmproxy 风格 */
  prompt_tokens_details?: {
    cached_tokens?: number;
    cached_creation_tokens?: number;
    cache_write_tokens?: number;
  };
  /** Responses 风格 */
  input_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

/** prompt 总 token 数：兼容 chat（prompt_tokens）与 responses（input_tokens）两种形状 */
export function promptTokens(usage?: StreamUsage): number | undefined {
  const value = usage?.prompt_tokens ?? usage?.input_tokens;
  return typeof value === 'number' ? value : undefined;
}

/**
 * 缓存命中的 prompt token 数。不同网关放的位置不一样：
 * `prompt_tokens_details.cached_tokens`（OpenAI / llmproxy 归一化后）、
 * `input_tokens_details.cached_tokens`（Responses 原生）、
 * `prompt_cache_hit_tokens` / `cached_tokens` / `cache_read_input_tokens`（DeepSeek / 网关直出）。
 *
 * 返回 undefined 表示这个端点根本没报缓存字段 —— 和「报了 0」是两件事，
 * 前者不该在界面上显示成 0% 命中。
 */
export function cachedTokens(usage?: StreamUsage): number | undefined {
  const candidates = [
    usage?.prompt_tokens_details?.cached_tokens,
    usage?.input_tokens_details?.cached_tokens,
    usage?.prompt_cache_hit_tokens,
    usage?.cached_tokens,
    usage?.cache_read_input_tokens,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (candidates.length === 0) return undefined;
  // 有的网关会把不认识的字段填 0，把真正有值的字段放在另一处；
  // 只要有一处报了正数就用正数，全 0 才返回 0（= 端点确实报了「没命中」）。
  return candidates.find((value) => value > 0) ?? 0;
}

export function reasoningTokens(usage?: StreamUsage): number | undefined {
  const candidates = [
    usage?.completion_tokens_details?.reasoning_tokens,
    usage?.completion_thinking_tokens,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (candidates.length === 0) return undefined;
  return candidates.find((value) => value > 0) ?? 0;
}

export interface StreamOutcome {
  model?: string;
  usage?: StreamUsage;
  finishReason?: string;
  chars: number;
  /** 只用于诊断「思考吃光了输出预算」，不把 CoT 回传给前端 */
  reasoningChars?: number;
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
  /** 本轮流式思考的字符数；只用于错误诊断，不进入 content */
  reasoningChars?: number;
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
  cacheKey?: string,
): Promise<Response> {
  const endpoint = resolveChatEndpoint(config.baseUrl);
  /**
   * Reasoning: auto 什么都不发，沿用端点默认；off 发 none（OpenAI 兼容语义）；
   * 其余档位原样发。值域见 lib.ts 的 AiReasoningEffort。
   */
  const reasoning = config.reasoningEffort && config.reasoningEffort !== 'auto'
    ? config.reasoningEffort
    : '';
  const reasoningActive = Boolean(reasoning) && reasoning !== 'off';

  const payload: Record<string, unknown> = {
    model: config.model,
    messages,
    stream,
    max_tokens: reasoningActive
      ? Math.max(config.maxOutputTokens, REASONING_MIN_OUTPUT_TOKENS)
      : config.maxOutputTokens,
  };
  // 推理模型普遍不接受自定义 temperature（有的直接 400）。开了推理就交给端点默认值。
  if (!reasoningActive) payload.temperature = 0.2;
  if (reasoning) payload.reasoning_effort = reasoning === 'off' ? 'none' : reasoning;
  if (stream) payload.stream_options = { include_usage: true };
  // 稳定前缀缓存的路由键：同一个 AI 会话的所有请求共用一个 key，
  // 网关才能把后续 turn 落到同一份 KV 缓存上（OpenAI Responses / llmproxy 都认）。
  if (cacheKey) payload.prompt_cache_key = cacheKey;
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

  // 有些网关不接受 stream_options / prompt_cache_key，会直接 400；去掉它重试一次。
  // 只对 400 且错误里明确提到该字段时重试，避免把真正的配置错误也吞掉。
  if (response.status === 400) {
    const body = await response.text().catch(() => '');
    if (payload.prompt_cache_key && /prompt_cache_key/i.test(body)) {
      delete payload.prompt_cache_key;
      return send(payload);
    }
    if (stream && payload.stream_options && /stream_options/i.test(body)) {
      delete payload.stream_options;
      return send(payload);
    }
    if (payload.reasoning_effort && /reasoning|effort|thinking/i.test(body)) {
      throw new AiProviderError(
        `This model endpoint rejected reasoning effort "${String(payload.reasoning_effort)}". `
        + 'Set Reasoning to Auto (or to a level this endpoint supports). '
        + `Upstream said: ${extractErrorMessage(body)}`,
        400,
      );
    }
    // 老网关只会说「unknown field」，不会指名道姓；沿用原来的兜底：
    // 去掉 stream_options 再试一次（它是纯可选字段，去掉不影响结果）。
    if (stream && payload.stream_options && /unknown|unrecognized|unexpected/i.test(body)) {
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
  /** 稳定的会话级缓存路由键（见 postChat） */
  cacheKey?: string;
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
    const response = await postChat(config, messages, true, controller.signal, undefined, args.cacheKey);

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
      let reasoningChars = 0;
      try {
        const parsed = JSON.parse(raw);
        content = parsed?.choices?.[0]?.message?.content || parsed?.choices?.[0]?.text || '';
        model = parsed?.model;
        usage = parsed?.usage;
        const reasoning = parsed?.choices?.[0]?.message?.reasoning_content ?? parsed?.choices?.[0]?.message?.reasoning;
        if (typeof reasoning === 'string') reasoningChars = reasoning.length;
      } catch {
        throw new AiProviderError(`Model service returned unparsable content (content-type=${contentType || 'unknown'})`);
      }
      if (content) onDelta(content);
      return { model, usage, chars: content.length, reasoningChars, firstTokenMs: content ? Date.now() : undefined };
    }

    const reader = response.body?.getReader();
    if (!reader) throw new AiProviderError('Model service returned no body');

    const decoder = new TextDecoder();
    let buffer = '';
    let chars = 0;
    let reasoningChars = 0;
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
        // 思考内容不进用户可见的答案，只计数：用来在「思考吃光预算」时给一条人话错误。
        const reasoningDelta = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
        if (typeof reasoningDelta === 'string' && reasoningDelta) reasoningChars += reasoningDelta.length;
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

    // 有思考、没有正文、且明确是 length：99% 是 max_tokens 被思考吃完了。
    // 不报这条，界面只会显示一个「Done」加空白答案，用户完全无从下手。
    if (chars === 0 && reasoningChars > 0 && finishReason === 'length') {
      throw new AiProviderError(
        'The model used its whole output budget on reasoning before writing an answer. '
        + 'Raise max output tokens or lower the reasoning effort.',
      );
    }

    return { model, usage, finishReason, chars, reasoningChars, firstTokenMs };
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
 * 带工具的**流式**对话，供 Agent Loop 使用。
 *
 * 上游只吃 `stream:true`（非流式直接拒），所以这里全程 SSE：
 * content 逐块拼，tool_calls 按 index 拼 `arguments` 增量，结束后再一次性返回整轮结果。
 * 调用方看到的形状与旧的非流式版本一致，只是请求本身是流式的。
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
  onDelta?: (text: string) => void;
  /** 稳定的会话级缓存路由键（见 postChat） */
  cacheKey?: string;
}): Promise<ChatCompletionResult> {
  const { config, messages, signal, onDelta } = args;
  if (!resolveChatEndpoint(config.baseUrl)) throw new AiProviderError('Base URL not set');

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await postChat(config, messages, true, controller.signal, args.tools, args.cacheKey);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
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

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      const raw = await response.text();
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new AiProviderError('Model service returned unparsable JSON');
      }
      if (parsed?.error) throw new AiProviderError(parsed.error?.message || 'Model service error');
      const choice = parsed?.choices?.[0];
      const msg = choice?.message ?? {};
      const content = typeof msg.content === 'string' ? msg.content : null;
      if (content && onDelta) onDelta(content);
      const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : msg.reasoning;
      const reasoningChars = typeof reasoning === 'string' ? reasoning.length : 0;
      const toolCalls = Array.isArray(msg.tool_calls)
        ? msg.tool_calls.filter((call: any) => call?.id && call?.function?.name)
        : undefined;
      if (!content && !toolCalls?.length && reasoningChars > 0 && choice?.finish_reason === 'length') {
        throw new AiProviderError(
          'The model used its whole output budget on reasoning before writing an answer. '
          + 'Raise max output tokens or lower the reasoning effort.',
        );
      }
      return {
        message: {
          role: 'assistant',
          content,
          ...(toolCalls && toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        model: parsed.model,
        usage: parsed.usage,
        finishReason: choice?.finish_reason,
        reasoningChars,
        ms: Date.now() - startedAt,
      };
    }

    const reader = response.body?.getReader();
    if (!reader) throw new AiProviderError('Model service returned no body');

    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoningChars = 0;
    let model: string | undefined;
    let usage: StreamUsage | undefined;
    let finishReason: string | undefined;
    const buckets = new Map<number, { id: string; name: string; arguments: string }>();

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
          continue;
        }
        if (json.error) throw new AiProviderError(json.error.message || 'Model service error');
        if (json.model) model = json.model;
        if (json.usage) usage = json.usage;
        const choice = json.choices?.[0];
        const delta = choice?.delta ?? {};
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          onDelta?.(delta.content);
        }
        // DeepSeek / OpenAI 兼容网关把思考放在 reasoning_content（responses 转换层可能叫 reasoning）。
        // 不进 content —— 那不是答案；只计数，供「思考吃光预算」的诊断用。
        const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoningDelta === 'string' && reasoningDelta) reasoningChars += reasoningDelta.length;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            let b = buckets.get(idx);
            if (!b) {
              b = { id: '', name: '', arguments: '' };
              buckets.set(idx, b);
            }
            if (typeof tc.id === 'string' && tc.id) b.id = tc.id;
            const fn = tc.function ?? {};
            if (typeof fn.name === 'string' && fn.name) b.name = fn.name;
            if (typeof fn.arguments === 'string' && fn.arguments) b.arguments += fn.arguments;
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        handleFrame(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim()) handleFrame(buffer);

    const toolCalls: ToolCallSpec[] = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, b]) => b.id && b.name)
      .map(([, b]) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments || '{}' } }));

    if (!content && toolCalls.length === 0 && reasoningChars > 0 && finishReason === 'length') {
      throw new AiProviderError(
        'The model used its whole output budget on reasoning before writing an answer. '
        + 'Raise max output tokens or lower the reasoning effort.',
      );
    }

    return {
      message: {
        role: 'assistant',
        content: content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      model,
      usage,
      finishReason,
      reasoningChars,
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

/** 配置页的「测试连接」：一次最小的流式调用，只关心能不能通。 */
export async function verifyAiConfig(config: ResolvedAiConfig): Promise<{ ok: boolean; message: string; model?: string }> {
  if (!resolveChatEndpoint(config.baseUrl)) return { ok: false, message: 'Base URL not set' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await postChat(
      // 连接测试要的是「快且便宜」：不显式开推理，8 个 token 就够验通。
      { ...config, maxOutputTokens: 8, reasoningEffort: 'auto' },
      [{ role: 'user', content: 'hi' }],
      true,
      controller.signal,
    );
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, message: `HTTP ${response.status}: ${extractErrorMessage(body)}` };
    }
    let model: string | undefined;
    try {
      const raw = await response.text();
      const m = raw.match(/"model"\s*:\s*"([^"]+)"/);
      if (m) model = m[1];
    } catch {}
    return { ok: true, message: 'Connected', model };
  } catch (err: any) {
    return { ok: false, message: err?.name === 'AbortError' ? 'Timed out' : `Connection failed: ${err?.message || err}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 从 OpenAI / ollama / 中转层的 `/models` 响应里提取模型 id（三种常见形状） */
function parseModelIds(body: string): string[] {
  try {
    const parsed = JSON.parse(body);
    const rows = Array.isArray(parsed?.data)
      ? parsed.data
      : Array.isArray(parsed?.models)
        ? parsed.models
        : [];
    const ids: string[] = [];
    for (const row of rows) {
      const id = typeof row === 'string' ? row : (row?.id || row?.name || row?.model);
      if (typeof id === 'string' && id.trim() && !ids.includes(id.trim())) ids.push(id.trim());
    }
    return ids.sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * 拉取端点支持的模型列表，供设置页「Fetch」按钮使用。
 *
 * 允许传未保存的 baseUrl / apiKey：用户通常是先填地址和 key，再点 Fetch，
 * 最后才 Save；如果只读已保存配置，这个按钮在首次配置时永远不可用。
 */
export async function listAiModels(
  config: ResolvedAiConfig,
  override?: { baseUrl?: string; apiKey?: string },
): Promise<{ ok: boolean; models?: string[]; message?: string }> {
  const baseUrl = (override?.baseUrl ?? config.baseUrl).trim();
  const apiKey = override?.apiKey !== undefined ? override.apiKey : config.apiKey;
  const endpoint = resolveModelsEndpoint(baseUrl);
  if (!endpoint) return { ok: false, message: 'Base URL not set' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetch(endpoint, { method: 'GET', headers, signal: controller.signal });
    const body = await response.text();
    if (!response.ok) {
      return { ok: false, message: `HTTP ${response.status}: ${extractErrorMessage(body)}` };
    }
    const models = parseModelIds(body);
    if (!models.length) return { ok: false, message: 'No models returned' };
    return { ok: true, models };
  } catch (err: any) {
    return {
      ok: false,
      message: err?.name === 'AbortError' ? 'Timed out' : `Fetch failed: ${err?.message || err}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
