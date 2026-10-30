import {
  dataPath,
  readAppConfig,
  readEncryptedFile,
  writeAppConfig,
  writeEncryptedFile,
  type AiReasoningEffort,
  type AiSettings,
} from '../lib.ts';

/**
 * AI 配置的两处存放：
 * - 非机密项（baseUrl / model / 预算 / 开关）进 conf/webssh_config.json，跟其它配置一起；
 * - apiKey 单独进 <数据目录>/ai_secrets.json 的加密存储，不进普通配置文件。
 *
 * 环境变量优先级**高于**落盘配置，方便容器化部署时不落任何 secret：
 *   WEBSSH_AI_BASE_URL / WEBSSH_AI_MODEL / WEBSSH_AI_API_KEY
 */
const AI_SECRET_FILE = 'ai_secrets.json';

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128000;
export const DEFAULT_MAX_INPUT_TOKENS = 8000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2000;
/**
 * 开启推理后输出预算的下限。
 *
 * `max_tokens` 同时覆盖思考与最终回答；2000 的默认值很容易被思考吃干净，
 * 结果就是内容为空、finish_reason=length。这里只在「明确开了推理」时抬到 4096，
 * 不改变 auto/off 下的既有行为。
 */
export const REASONING_MIN_OUTPUT_TOKENS = 4096;
/** 上下限用来兜住手填的离谱值；下限 500 保证 prepareContext 的字符下限不会先咬到预算 */
const MIN_CONTEXT_WINDOW_TOKENS = 2000;
const MAX_CONTEXT_WINDOW_TOKENS = 2_000_000;
const MIN_MAX_INPUT_TOKENS = 500;
const MAX_MAX_INPUT_TOKENS = 2_000_000;
const MIN_MAX_OUTPUT_TOKENS = 128;
const MAX_MAX_OUTPUT_TOKENS = 1_000_000;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(value)));

/** 白名单条数上限，纯粹防手滑贴进来一整份 /usr/bin 清单 */
const MAX_COMMAND_WHITELIST = 50;

/**
 * 白名单只收**命令名**，不收路径、也不收「带参数的整条命令」。
 * 这样语义唯一：白名单 = 「这个二进制可以自动跑」，而不是「匹配这个字符串的都可以」。
 * 带空格的条目直接丢掉 —— 否则用户填 `rm -rf /tmp` 会以为自己很安全，
 * 实际上那条规则既难匹配、又会给人错误的安全感。
 */
export function normalizeWhitelist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const name = item.trim().toLowerCase();
    if (!name || name.length > 64) continue;
    if (!/^[a-z0-9._+-]+$/.test(name)) continue;
    if (!out.includes(name)) out.push(name);
    if (out.length >= MAX_COMMAND_WHITELIST) break;
  }
  return out;
}

export interface ResolvedAiConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 模型上下文窗口（总输入预算，给 agent history 定预算用） */
  contextWindowTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  reasoningEffort: AiReasoningEffort;
  redactPrivateIp: boolean;
  commandWhitelist: string[];
  keyFromEnv: boolean;
  /** 未就绪的原因，直接可以显示给用户 */
  reason?: string;
}

export interface PublicAiConfig {
  enabled: boolean;
  ready: boolean;
  reason?: string;
  baseUrl: string;
  model: string;
  endpoint: string;
  hasKey: boolean;
  keyFromEnv: boolean;
  contextWindowTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  reasoningEffort: AiReasoningEffort;
  redactPrivateIp: boolean;
  commandWhitelist: string[];
}

const REASONING_EFFORTS: AiReasoningEffort[] = ['auto', 'off', 'low', 'medium', 'high', 'max'];

/** 把任意来路的值收进值域；认不出来就当 auto（不改变端点默认行为） */
export function normalizeReasoningEffort(value: unknown): AiReasoningEffort {
  const effort = String(value ?? '').trim().toLowerCase();
  return (REASONING_EFFORTS as string[]).includes(effort)
    ? effort as AiReasoningEffort
    : 'auto';
}

interface AiSecret {
  apiKey?: string;
}

function readSecret(): AiSecret {
  return readEncryptedFile<AiSecret>(dataPath(AI_SECRET_FILE), {});
}

/**
 * 把用户填的 baseUrl 归一成 chat completions 端点。允许三种写法：
 *   https://api.deepseek.com            → https://api.deepseek.com/v1/chat/completions
 *   https://api.openai.com/v1           → https://api.openai.com/v1/chat/completions
 *   http://localhost:11434/v1/chat/completions → 原样
 */
export function resolveChatEndpoint(baseUrl: string): string {
  const trimmed = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

/** 把 baseUrl 归一成 `/v1/models`，与 resolveChatEndpoint 同一套写法兼容 */
export function resolveModelsEndpoint(baseUrl: string): string {
  const trimmed = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/\/chat\/completions$/.test(trimmed)) return trimmed.replace(/\/chat\/completions$/, '/models');
  if (/\/models$/.test(trimmed)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/models`;
  return `${trimmed}/v1/models`;
}

export function resolveAiConfig(): ResolvedAiConfig {
  const settings: AiSettings = readAppConfig().ai || {};
  const secret = readSecret();

  const envKey = process.env.WEBSSH_AI_API_KEY || '';
  const apiKey = envKey || secret.apiKey || '';
  const baseUrl = (process.env.WEBSSH_AI_BASE_URL || settings.baseUrl || '').trim();
  const model = (process.env.WEBSSH_AI_MODEL || settings.model || '').trim();
  const reasoningEffort = normalizeReasoningEffort(
    process.env.WEBSSH_AI_REASONING || settings.reasoningEffort,
  );

  const contextWindowTokens = Number(settings.contextWindowTokens) > 0
    ? clamp(Number(settings.contextWindowTokens), MIN_CONTEXT_WINDOW_TOKENS, MAX_CONTEXT_WINDOW_TOKENS)
    : DEFAULT_CONTEXT_WINDOW_TOKENS;
  const maxInputTokens = Number(settings.maxInputTokens) > 0
    ? clamp(Number(settings.maxInputTokens), MIN_MAX_INPUT_TOKENS, MAX_MAX_INPUT_TOKENS)
    : DEFAULT_MAX_INPUT_TOKENS;
  const maxOutputTokens = Number(settings.maxOutputTokens) > 0
    ? clamp(Number(settings.maxOutputTokens), MIN_MAX_OUTPUT_TOKENS, MAX_MAX_OUTPUT_TOKENS)
    : DEFAULT_MAX_OUTPUT_TOKENS;

  // apiKey **不参与**就绪判定：局域网网关（ollama / vLLM / one-api 直连）多数不校验 key，
  // 强制要求会逼用户编一个假 key。真要鉴权的端点会在调用时报 401，错误照样能看见。
  const reason = !baseUrl
    ? 'Base URL not set'
    : !model
      ? 'Model not set'
      : undefined;

  return {
    // 三项齐备才默认开启；用户显式关掉则以用户为准
    enabled: settings.enabled ?? !reason,
    baseUrl,
    model,
    apiKey,
    contextWindowTokens,
    maxInputTokens,
    maxOutputTokens,
    reasoningEffort,
    redactPrivateIp: settings.redactPrivateIp ?? false,
    commandWhitelist: normalizeWhitelist(settings.commandWhitelist),
    keyFromEnv: Boolean(envKey),
    reason,
  };
}

export function publicAiConfig(): PublicAiConfig {
  const config = resolveAiConfig();
  return {
    enabled: config.enabled,
    ready: !config.reason,
    reason: config.reason,
    baseUrl: config.baseUrl,
    model: config.model,
    endpoint: resolveChatEndpoint(config.baseUrl),
    hasKey: Boolean(config.apiKey),
    keyFromEnv: config.keyFromEnv,
    contextWindowTokens: config.contextWindowTokens,
    maxInputTokens: config.maxInputTokens,
    maxOutputTokens: config.maxOutputTokens,
    reasoningEffort: config.reasoningEffort,
    redactPrivateIp: config.redactPrivateIp,
    commandWhitelist: config.commandWhitelist,
  };
}

/**
 * 保存设置。apiKey 单独处理：
 * - 传字符串 → 更新
 * - 传 null   → 清除
 * - 不传      → 保持不变
 */
export function saveAiSettings(
  patch: Partial<AiSettings>,
  apiKey?: string | null,
): PublicAiConfig {
  const config = readAppConfig();
  const next: AiSettings = { ...(config.ai || {}) };

  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.baseUrl !== undefined) next.baseUrl = String(patch.baseUrl).trim();
  if (patch.model !== undefined) next.model = String(patch.model).trim();
  if (patch.reasoningEffort !== undefined) next.reasoningEffort = normalizeReasoningEffort(patch.reasoningEffort);
  if (patch.redactPrivateIp !== undefined) next.redactPrivateIp = Boolean(patch.redactPrivateIp);
  if (patch.commandWhitelist !== undefined) next.commandWhitelist = normalizeWhitelist(patch.commandWhitelist);
  if (patch.contextWindowTokens !== undefined) {
    const value = Number(patch.contextWindowTokens);
    if (Number.isFinite(value) && value > 0) {
      next.contextWindowTokens = clamp(value, MIN_CONTEXT_WINDOW_TOKENS, MAX_CONTEXT_WINDOW_TOKENS);
    }
  }
  if (patch.maxInputTokens !== undefined) {
    const value = Number(patch.maxInputTokens);
    if (Number.isFinite(value) && value > 0) {
      next.maxInputTokens = clamp(value, MIN_MAX_INPUT_TOKENS, MAX_MAX_INPUT_TOKENS);
    }
  }
  if (patch.maxOutputTokens !== undefined) {
    const value = Number(patch.maxOutputTokens);
    if (Number.isFinite(value) && value > 0) {
      next.maxOutputTokens = clamp(value, MIN_MAX_OUTPUT_TOKENS, MAX_MAX_OUTPUT_TOKENS);
    }
  }

  writeAppConfig({ ...config, ai: next });

  if (apiKey !== undefined) {
    const secret = readSecret();
    const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (trimmed) writeEncryptedFile(dataPath(AI_SECRET_FILE), { ...secret, apiKey: trimmed });
    else {
      const { apiKey: _dropped, ...rest } = secret;
      writeEncryptedFile(dataPath(AI_SECRET_FILE), rest);
    }
  }

  return publicAiConfig();
}
