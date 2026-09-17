/**
 * Agent Loop。
 *
 * ## 循环住在服务端
 *
 * 上一版住在浏览器：服务端每收一次 `agent` 只推进一个回合，浏览器拿决策 → 找 /term 执行
 * → 把结果贴回 transcript → 再发一回合。这么切是为了保住 `/ai` 无状态、不碰 SSH，
 * 代价是每回合重发一遍历史，而且「能不能自动跑」得靠浏览器自报身份来判。
 *
 * 现在循环搬回服务端，两个问题一起消失：
 *  - 消息历史留在内存里，不用来回搬；
 *  - 身份是服务端自己 `id -un` 跑出来的，浏览器无从伪造 —— 审批判断的依据从「自报」变成「实测」。
 *
 * `/ai` 仍然**不持有 SSH 凭据**：它只是被临时借到一个已存在的 session 上去执行工具，
 * 借不到（sessionId 无效 / 会话已断）就直接不开跑。SSH 连接的生命周期仍归 /term 管。
 *
 * ## 错误分两类，处理方式相反
 *
 *  - **可恢复的**（参数写错、工具名拼错、命令非 0 退出、权限不够）→ 变成一条 tool 消息
 *    回灌给模型。模型看得见错误才能换条路，这是 Agent 之所以是 Agent 的地方。
 *  - **不可恢复的**（SSH 断了、用户取消、模型服务挂了）→ 抛出去，由调用方终止整轮。
 *
 * 这条界线画在 tools.ts 的 `executeToolCall` 里：它只在连接层异常时抛。
 *
 * ## 步数是硬上限，不是建议
 *
 * 到顶就停，并且**明确告诉用户为什么停**。静默停下会让人以为 Agent 已经查完了。
 */

import type { ResolvedAiConfig } from './config.ts';
import { chatCompletion, type LLMessage, type ToolCallSpec } from './provider.ts';
import {
  AGENT_TOOLS,
  createToolContext,
  executeToolCall,
  planToolCall,
  type AgentIdentity,
  type ToolContext,
} from './tools.ts';
import type { RiskLevel } from './grade.ts';

/** 默认步数上限 */
export const AGENT_DEFAULT_MAX_STEPS = 20;
/** 硬顶：前端传更大的值也压回来 */
export const AGENT_MAX_STEPS_HARD_LIMIT = 40;
/** 一轮里最多接受的工具调用数，防止模型一口气吐几十个 */
const MAX_TOOL_CALLS_PER_TURN = 8;
/**
 * 消息历史的总字符预算。超出后从**最老的 tool 消息**开始清内容。
 *
 * 第一版不做摘要式压缩（那是 spec 里明确的「预留接口」），只做这件事：
 * 保证最近几步的完整输出还在 —— 它们才是下一步决策的依据。
 */
const HISTORY_CHAR_BUDGET = 120_000;
/** 单次工具调用展示给界面的参数长度上限 */
const MAX_DISPLAY_ARG_CHARS = 2000;

export interface AgentToolCallView {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** 原始参数文本，给界面展示用（已截断） */
  display: string;
}

export interface AgentApprovalRequest {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  display: string;
  level: RiskLevel;
  reasons: string[];
}

export interface AgentEventSink {
  /** 开始第 step 轮（从 1 起） */
  onStep?: (step: number) => void;
  /** 模型的文字输出（可能只是它的一句说明，不是最终结论） */
  onMessage?: (text: string) => void;
  onToolCall?: (call: AgentToolCallView) => void;
  onToolResult?: (payload: { callId: string; name: string; output: string; truncated: boolean }) => void;
  /** 需要人点头。resolve(false) = 拒绝；取消时应 resolve(false) 而不是挂住 */
  requestApproval: (request: AgentApprovalRequest) => Promise<boolean>;
}

export type AgentStopReason = 'final' | 'max-steps' | 'cancelled';

export interface AgentRunResult {
  answer: string;
  steps: number;
  stopReason: AgentStopReason;
  /** 走过的工具调用次数 */
  toolCalls: number;
  modelCalls: number;
}

export interface AgentRunArgs {
  config: ResolvedAiConfig;
  /** 起始消息（system + 首个 user），由 buildAgentToolMessages 产出 */
  messages: LLMessage[];
  client: any;
  whitelist: string[];
  identity: AgentIdentity | null;
  maxSteps?: number;
  signal: AbortSignal;
  events: AgentEventSink;
  /** 单轮模型调用的超时 */
  modelTimeoutMs?: number;
}

/** 把古老的工具输出清掉，给最近几步腾地方 */
function trimHistory(messages: LLMessage[]): void {
  let total = 0;
  for (const message of messages) total += (message.content?.length ?? 0) + 200;

  if (total <= HISTORY_CHAR_BUDGET) return;

  // 从最老的开始清，但永不删 system，也保留最后 4 条消息（当前轮正在用的）
  for (let i = 1; i < messages.length - 4 && total > HISTORY_CHAR_BUDGET; i += 1) {
    const message = messages[i] as any;
    if (message.role === 'tool' && typeof message.content === 'string' && message.content) {
      total -= message.content.length;
      message.content = '[trimmed from history]';
    }
  }
}

export async function runAgentLoop(args: AgentRunArgs): Promise<AgentRunResult> {
  const {
    config, messages: seed, client, whitelist, identity, signal, events,
  } = args;

  const maxSteps = Math.min(
    Math.max(Math.floor(args.maxSteps ?? AGENT_DEFAULT_MAX_STEPS), 1),
    AGENT_MAX_STEPS_HARD_LIMIT,
  );

  const ctx: ToolContext = createToolContext({ client, whitelist, identity });
  const history: LLMessage[] = [...seed];

  let steps = 0;
  let toolCalls = 0;
  let modelCalls = 0;
  let lastText = '';

  try {
    while (steps < maxSteps) {
      if (signal.aborted) return { answer: lastText, steps, stopReason: 'cancelled', toolCalls, modelCalls };

      steps += 1;
      events.onStep?.(steps);

      const result = await chatCompletion({
        config,
        messages: history,
        tools: AGENT_TOOLS as any,
        signal,
        ...(args.modelTimeoutMs ? { timeoutMs: args.modelTimeoutMs } : {}),
      });
      modelCalls += 1;

      const { content, tool_calls: calls } = result.message;
      if (content) {
        lastText = content;
        events.onMessage?.(content);
      }

      // 没有工具调用 = 模型认为任务完成了，这就是最终回答
      if (!calls || calls.length === 0) {
        return {
          answer: content || lastText || '(the model returned no answer)',
          steps,
          stopReason: 'final',
          toolCalls,
          modelCalls,
        };
      }

      // 原样回灌 assistant 的 tool_calls：模型靠 id 把结果对回自己的请求
      history.push({ role: 'assistant', content: content ?? null, tool_calls: calls });

      for (const call of calls.slice(0, MAX_TOOL_CALLS_PER_TURN)) {
        if (signal.aborted) {
          return { answer: lastText, steps, stopReason: 'cancelled', toolCalls, modelCalls };
        }
        toolCalls += 1;
        await runOneCall(call, ctx, history, events, signal);
      }

      trimHistory(history);
    }

    return {
      answer: `Step limit reached (${maxSteps}) - stopping here. `
        + (lastText ? `Last thing the model said:\n\n${lastText}` : 'Raise the step limit to continue.'),
      steps,
      stopReason: 'max-steps',
      toolCalls,
      modelCalls,
    };
  } finally {
    ctx.dispose();
  }
}

/** 执行单个工具调用并把结果推回历史。可恢复的错误一律变成 tool 消息 */
async function runOneCall(
  call: ToolCallSpec,
  ctx: ToolContext,
  history: LLMessage[],
  events: AgentEventSink,
  signal: AbortSignal,
): Promise<void> {
  const callId = call.id;
  const name = call.function?.name || '';
  const rawArgs = call.function?.arguments || '';
  const display = rawArgs.length > MAX_DISPLAY_ARG_CHARS
    ? `${rawArgs.slice(0, MAX_DISPLAY_ARG_CHARS)}… (${rawArgs.length - MAX_DISPLAY_ARG_CHARS} more chars)`
    : rawArgs;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawArgs || '{}');
  } catch {
    pushToolResult(history, events, {
      callId,
      name,
      output: 'error: arguments were not valid JSON. Send a single JSON object matching the tool schema.',
    });
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    pushToolResult(history, events, {
      callId,
      name,
      output: 'error: arguments must be a JSON object.',
    });
    return;
  }

  // 先分级：参数不合法在这里就回给模型，不用等它跑一圈
  let plan;
  try {
    plan = planToolCall(name, parsed, ctx);
  } catch (err: any) {
    pushToolResult(history, events, {
      callId,
      name,
      output: `error: invalid arguments - ${err?.message || err}`,
    });
    return;
  }

  events.onToolCall?.({ id: callId, name, arguments: parsed, display });

  if (plan.needsApproval) {
    /**
     * 审批与取消赛跑。
     *
     * 界面那侧挂着一个永远没人点的对话框时，取消必须还能收得了场 ——
     * 不能让人点了 Stop 之后，服务端还占着一个模型调用的上下文在那儿干等。
     * 这条是兜底：正常路径下调用方（/ai 通道）收到 cancel 会主动以「拒绝」应答。
     */
    const allowed = await Promise.race([
      events.requestApproval({
        callId, name, arguments: parsed, display, level: plan.level, reasons: plan.reasons,
      }),
      new Promise<boolean>((resolve) => {
        if (signal.aborted) return resolve(false);
        signal.addEventListener('abort', () => resolve(false), { once: true });
      }),
    ]);
    if (!allowed || signal.aborted) {
      pushToolResult(history, events, {
        callId,
        name,
        // 明确告诉它「别重试」：否则小模型会把同一条命令再发一遍
        output: '[denied] The user declined this action. Do not retry it. '
          + 'Continue with a read-only approach, or report what you found so far.',
      });
      return;
    }
  }

  const outcome = await executeToolCall(name, parsed, ctx);
  pushToolResult(history, events, {
    callId,
    name,
    output: outcome.content,
    truncated: outcome.truncated,
  });
}

function pushToolResult(
  history: LLMessage[],
  events: AgentEventSink,
  payload: { callId: string; name: string; output: string; truncated?: boolean },
) {
  history.push({ role: 'tool', tool_call_id: payload.callId, content: payload.output });
  events.onToolResult?.({
    callId: payload.callId,
    name: payload.name,
    output: payload.output,
    truncated: Boolean(payload.truncated),
  });
}
