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
  messages: ChatMessage[],
  stream: boolean,
  signal: AbortSignal,
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

  const send = (body: Record<string, unknown>) => fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
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
    throw new AiProviderError(`模型服务返回 400：${extractErrorMessage(body)}`, 400);
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
  if (!endpoint) throw new AiProviderError('模型服务地址未配置');
  if (!config.apiKey) throw new AiProviderError('API Key 未配置');

  // 外部取消 + 总超时合成一个内部 signal，避免把超时暴露成「用户取消」
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await postChat(config, messages, true, controller.signal);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AiProviderError(`模型服务返回 ${response.status}：${extractErrorMessage(body)}`, response.status);
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
        throw new AiProviderError(`模型服务返回了无法解析的内容（content-type=${contentType || 'unknown'}）`);
      }
      if (content) onDelta(content);
      return { model, usage, chars: content.length, firstTokenMs: content ? Date.now() : undefined };
    }

    const reader = response.body?.getReader();
    if (!reader) throw new AiProviderError('模型服务没有返回响应体');

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
        if (json.error) throw new AiProviderError(json.error.message || '模型服务返回错误');
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
    if (signal.aborted) throw new AiProviderError('已取消');
    if (err?.name === 'AbortError') throw new AiProviderError('请求模型服务超时');
    if (err instanceof AiProviderError) throw err;
    throw new AiProviderError(`调用模型服务失败：${err?.message || err}`);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** 配置页的「测试连接」：一次最小的非流式调用，只关心能不能通。 */
export async function verifyAiConfig(config: ResolvedAiConfig): Promise<{ ok: boolean; message: string; model?: string }> {
  if (!resolveChatEndpoint(config.baseUrl)) return { ok: false, message: '模型服务地址未配置' };
  if (!config.apiKey) return { ok: false, message: 'API Key 未配置' };

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
      return { ok: false, message: `HTTP ${response.status}：${extractErrorMessage(body)}` };
    }
    let model: string | undefined;
    try {
      model = JSON.parse(body)?.model;
    } catch {}
    return { ok: true, message: '连接正常', model };
  } catch (err: any) {
    return { ok: false, message: err?.name === 'AbortError' ? '连接超时' : `连接失败：${err?.message || err}` };
  } finally {
    clearTimeout(timer);
  }
}
