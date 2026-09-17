import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownLeft,
  Loader2,
  Play,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Sparkles,
  Square,
  Wand2,
  X,
} from 'lucide-react';
import {
  AiWSClient,
  fetchAiConfig,
  saveAiConfig,
  testAiConfig,
  type AiAgentApproval,
  type AiAgentDone,
  type AiAgentIdentity,
  type AiConfigView,
  type AiContextStats,
  type AiDoneMeta,
  type AiDraft,
  type AiGradeResult,
  type AiRiskLevel,
  type TerminalBridge,
} from '../aiClient';
import { ConfirmDialog } from './ConfirmDialog';
import { isLightTheme } from '../theme';

/**
 * AI 面板（P0 只读诊断 + P1 命令草稿 + P2 Agent）。
 *
 * 刻意做出来的规矩：
 * 1. 诊断模式里没有「执行」按钮 —— 只解释不操作。
 * 2. 命令草稿的风险等级**以服务端判分显示**，模型自评只在旁边做对照；
 *    两者不一致时，界面显示的是判分结果。
 * 3. 「执行」在界面上永远排在「填入」后面，且高风险命令必须再过一次确认框。
 *    底层不变量没变：命令是写进终端输入行，回车永远是用户按的（除了他显式点执行）。
 * 4. 「Sending」默认展开：用户得能看见到底把什么发出去了，才谈得上信任。
 * 5. 未配置时面板自己承担配置表单，不把 AI 设置塞进全局设置里（自托管场景
 *    大多数人是靠环境变量喂 key 的，UI 只是兜底）。
 * 6. Agent 的循环**不在**这里 —— 它在服务端跑，浏览器只渲染事件流和回答审批。
 *    界面上每一条工具调用都先露面再执行：需要你点头的会停在 `awaiting`，
 *    「Deny」和「Allow」一样显眼 —— 别让人因为找不到「不」而默认放行。
 * 7. **打开面板不发任何请求**，也不预先抓上下文快照。终端文本一律在点
 *    「Explain / Generate / Start」那一刻现取（`getContext`）：
 *    出网的内容得是用户刚确认过的，而不是打开面板时那一屏的旧内容。
 *
 * 界面文案统一用简洁英文：这个面板是工具，不是说明文档，能一句话说完就不写三句。
 */

interface AiPanelProps {
  onClose: () => void;
  theme?: string;
  /** 目标机描述（host/user）。面板自己不持有 SSH 凭据 */
  target?: { host?: string; username?: string; cwd?: string };
  /**
   * 当前 tab 的 SSH 会话 id。Agent 复用这个会话执行工具。
   *
   * 注意面板拿到的是 id 不是连接 —— 它只是告诉服务端「去借那一条」，
   * 借不到（未连接 / 已回收）服务端会明确报错，面板这里也提前拦一道。
   */
  sessionId?: string;
  /**
   * 现取终端上下文：有选区取选区，否则取末尾若干行。
   *
   * 是函数不是快照：面板打开时并不抓文本。开面板 → 用户决定要问什么 → 点按钮那一刻才取，
   * 这样既不会「打开就自动出网」，拿到的也不会是打开面板那一刻的旧屏幕。
   */
  getContext?: () => { text: string; source: 'selection' | 'tail' } | null;
  /** 目标终端的 SSH 连接是否就绪；没连上就不能执行命令 */
  terminalConnected?: boolean;
  /** 把命令写进终端输入行。submit=false 只填入不回车。返回是否发送成功 */
  onRunCommand?: (command: string, submit: boolean) => boolean;
  /**
   * 取当前 tab 的执行桥（结构化采集 + 身份探测）。
   *
   * 是 getter 不是值：桥由 TerminalView 在 effect 里注册，晚于父组件渲染，
   * 渲染期取到的永远是 null。Agent 循环真正开跑时才调用它。
   */
  getExecBridge?: () => TerminalBridge | null;
}

/** 风险色带：判分结果是唯一的着色依据 */
const RISK_STYLE: Record<AiRiskLevel, { badge: string; border: string; text: string }> = {
  safe: { badge: 'bg-emerald-100 text-emerald-700', border: 'border-emerald-300', text: 'text-emerald-600' },
  caution: { badge: 'bg-amber-100 text-amber-700', border: 'border-amber-300', text: 'text-amber-600' },
  dangerous: { badge: 'bg-rose-100 text-rose-700', border: 'border-rose-300', text: 'text-rose-600' },
};
const RISK_STYLE_DARK: Record<AiRiskLevel, { badge: string; border: string; text: string }> = {
  safe: { badge: 'bg-emerald-950 text-emerald-300', border: 'border-emerald-800', text: 'text-emerald-400' },
  caution: { badge: 'bg-amber-950 text-amber-300', border: 'border-amber-800', text: 'text-amber-400' },
  dangerous: { badge: 'bg-rose-950 text-rose-300', border: 'border-rose-800', text: 'text-rose-400' },
};
const RISK_LABEL: Record<AiRiskLevel, string> = { safe: 'read-only', caution: 'caution', dangerous: 'high risk' };

type Phase = 'idle' | 'streaming' | 'done' | 'error';

type Palette = Record<'panel' | 'header' | 'subtle' | 'card' | 'code' | 'input' | 'button' | 'primary' | 'danger', string>;

/* ------------------------- Agent 模式 ------------------------- */

/** 默认步数上限，与服务端 AGENT_DEFAULT_MAX_STEPS 对齐 */
const AGENT_MAX_STEPS = 20;
/** 工具输出在面板里的展示上限，超出掐头去尾留中间，避免长日志把面板撑爆 */
const AGENT_OUTPUT_CLIP_CHARS = 4000;

/** 工具调用的状态。awaiting = 停在审批闸上等人 */
type ToolStatus = 'pending' | 'awaiting' | 'running' | 'done' | 'denied';

/** Agent 事件流里的一条。服务端推什么我们画什么，本地不做决策 */
type AgentItem =
  | { kind: 'message'; key: string; text: string }
  | {
      kind: 'tool';
      key: string;
      callId: string;
      tool: string;
      display: string;
      status: ToolStatus;
      level?: AiRiskLevel;
      reasons?: string[];
      output?: string;
      truncated?: boolean;
    };

/** 把工具的入参画成人看得懂的一行 */
const describeCall = (item: Extract<AgentItem, { kind: 'tool' }>): string => {
  const args = item.display ? item.display.replace(/\s+/g, ' ').trim() : '';
  return args.length > 300 ? `${args.slice(0, 300)}…` : (args || '(no arguments)');
};

/** 掐中间：长输出保留头尾，中间用省略号代替 */
const clipOutput = (text: string) => {
  if (text.length <= AGENT_OUTPUT_CLIP_CHARS) return text;
  const head = Math.floor(AGENT_OUTPUT_CLIP_CHARS * 0.6);
  const tail = AGENT_OUTPUT_CLIP_CHARS - head;
  return `${text.slice(0, head)}\n… ${text.length - AGENT_OUTPUT_CLIP_CHARS} chars omitted …\n${text.slice(-tail)}`;
};

const buttonClass = 'flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border transition cursor-pointer disabled:opacity-40';

interface AgentItemRowProps {
  item: Extract<AgentItem, { kind: 'tool' }>;
  risk: Record<AiRiskLevel, { badge: string; border: string; text: string }>;
  palette: Palette;
  onAllow: () => void;
  onDeny: () => void;
}

/**
 * Agent 的一次工具调用。
 *
 * 三处刻意的安排：
 * 1. 调用**先露面再执行** —— 工具名和参数渲染出来的时候，它还什么都没做。
 * 2. 要审批的停在 `awaiting`，「Deny」和「Allow」同等显眼：
 *    拒绝这一步和放行一样容易，否则用户会因为在界面上找不到「不」而默认放行。
 * 3. 风险等级来自服务端判分（`level`），不是模型自评。
 */
const AgentItemRow: React.FC<AgentItemRowProps> = ({ item, risk, palette, onAllow, onDeny }) => {
  const level = item.level;

  return (
    <div className={`rounded border p-2.5 space-y-1.5 ${level ? risk[level].border : palette.card}`}>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${palette.card}`}>{item.tool}</span>
        {level && (
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${risk[level].badge}`}>
            {RISK_LABEL[level]}
          </span>
        )}
        {item.status === 'pending' && <Loader2 className="w-3 h-3 animate-spin text-indigo-500" />}
        {item.status === 'denied' && <span className={`text-[10px] ${palette.subtle}`}>denied</span>}
      </div>

      <pre className={`max-h-24 overflow-auto rounded border p-2 text-[11px] font-mono whitespace-pre-wrap break-all ${palette.code}`}>
        {describeCall(item)}
      </pre>

      {item.status === 'awaiting' && item.reasons && item.reasons.length > 0 && (
        <ul className={`space-y-0.5 ${risk[item.level ?? 'caution'].text}`}>
          {item.reasons.map((reason) => (
            <li key={reason} className="flex items-start gap-1.5">
              <ShieldAlert className="w-3 h-3 mt-0.5 shrink-0" />
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      )}

      {item.status === 'awaiting' && (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={onAllow}
            className={`${buttonClass} ${item.level === 'dangerous' ? palette.danger : palette.primary}`}
          >
            <Play className="w-3 h-3" />
            <span>Allow</span>
          </button>
          <button onClick={onDeny} className={`${buttonClass} ${palette.button}`}>
            <X className="w-3 h-3" />
            <span>Deny</span>
          </button>
        </div>
      )}

      {item.status === 'done' && item.output !== undefined && (
        <pre className={`max-h-40 overflow-auto rounded border p-2 text-[10px] leading-relaxed font-mono whitespace-pre-wrap break-all ${palette.code}`}>
          {item.output ? clipOutput(item.output) : '(no output)'}
          {item.truncated ? '\n[truncated]' : ''}
        </pre>
      )}
    </div>
  );
};

interface PreparedView {
  text: string;
  env: string;
  question: string;
  stats: AiContextStats;
}

const redactionSummary = (stats: AiContextStats) => {
  if (!stats.redactionTotal) return '';
  const parts = Object.entries(stats.redactions || {})
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key}×${count}`);
  return parts.join(' ');
};

export const AiPanel: React.FC<AiPanelProps> = ({
  onClose,
  theme,
  target,
  sessionId,
  getContext,
  terminalConnected = false,
  onRunCommand,
  getExecBridge,
}) => {
  const isLight = isLightTheme(theme);
  const risk = isLight ? RISK_STYLE : RISK_STYLE_DARK;

  const clientRef = useRef<AiWSClient | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const lastRunRef = useRef<{ text: string; source: 'selection' | 'tail'; question?: string } | null>(null);
  /** 回调里读 draft 原文用，避免把 draftRaw 塞进 runDraft 的依赖里导致反复重建 */
  const draftRawRef = useRef('');
  /** 上下文只在用户点按钮的那一刻取一次，之后追问 / 重新生成都沿用这份，避免答案前后对不上 */
  const lastContextRef = useRef<{ text: string; source: 'selection' | 'tail' } | null>(null);

  const [config, setConfig] = useState<AiConfigView | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [prepared, setPrepared] = useState<PreparedView | null>(null);
  const [answer, setAnswer] = useState('');
  const [meta, setMeta] = useState<AiDoneMeta | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(true);
  /**
   * 打开面板时瞄一眼上下文，只为把「Explain」按钮写清楚（选区还是末尾若干行）。
   * 纯本地读取、不发请求；真正发的时候再取一次，取的是那一刻的屏幕内容。
   */
  const [peek] = useState<{ source: 'selection' | 'tail' }>(() => ({
    source: getContext?.()?.source ?? 'tail',
  }));
  const [followUp, setFollowUp] = useState('');
  const [copied, setCopied] = useState(false);

  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formModel, setFormModel] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formRedactIp, setFormRedactIp] = useState(false);
  const [formWhitelist, setFormWhitelist] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  /**
   * 配置表单默认只在「未就绪」时出现，但就绪之后用户仍然可能要改模型/地址 ——
   * 没有这个开关，保存过一次就再也进不去表单了。
   */
  const [showSettings, setShowSettings] = useState(false);

  // ---- P1 命令草稿 ----
  /** 当前流的是哪种请求，决定 delta 往哪写、底部按钮显示什么 */
  const [mode, setMode] = useState<'diagnose' | 'draft' | 'agent'>('diagnose');
  const [askText, setAskText] = useState('');
  const [draft, setDraft] = useState<AiDraft | null>(null);
  /** draft 模式流下来的原文（JSON）。只在解析失败降级时才会展示给人看 */
  const [draftRaw, setDraftRaw] = useState('');
  const [degraded, setDegraded] = useState(false);
  const [confirmRunOpen, setConfirmRunOpen] = useState(false);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const lastDraftRef = useRef<{ text: string; source: 'selection' | 'tail'; question: string } | null>(null);

  // ---- Agent 模式 ----
  const [agentGoal, setAgentGoal] = useState('');
  /** 服务端推过来的事件流，按到达顺序渲染 */
  const [agentItems, setAgentItems] = useState<AgentItem[]>([]);
  const [agentFinal, setAgentFinal] = useState('');
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentIdentity, setAgentIdentity] = useState<AiAgentIdentity | null>(null);
  const [agentStep, setAgentStep] = useState(0);
  const [agentDone, setAgentDone] = useState<AiAgentDone | null>(null);
  const [agentRunning, setAgentRunning] = useState(false);
  /**
   * 审批闸的 resolve。存 ref 而不是 state：它是给 await 用的，不是给渲染用的。
   * 服务端在等这个应答，界面上对应的那条会停在 `awaiting`。
   */
  const approvalRef = useRef<((allow: boolean) => void) | null>(null);
  /** 每次开跑 +1；迟到的事件一律丢弃 */
  const agentRunIdRef = useRef(0);
  /** 上一次的目标，给「重新生成」用 */
  const lastAgentGoalRef = useRef('');

  const palette = useMemo<Palette>(() => (isLight ? {
    panel: 'bg-white border-slate-200 text-slate-800',
    header: 'bg-slate-50 border-slate-200',
    subtle: 'text-slate-500',
    card: 'bg-slate-50 border-slate-200',
    code: 'bg-white border-slate-200 text-slate-700',
    input: 'bg-white border-slate-300 text-slate-800 focus:border-slate-500',
    button: 'bg-white hover:bg-slate-100 text-slate-700 border-slate-300',
    primary: 'bg-indigo-600 hover:bg-indigo-500 text-white border-indigo-600',
    danger: 'bg-white hover:bg-rose-50 text-rose-600 border-rose-300',
  } : {
    panel: 'bg-slate-900 border-slate-800 text-slate-100',
    header: 'bg-slate-950 border-slate-800',
    subtle: 'text-slate-400',
    card: 'bg-slate-950 border-slate-800',
    code: 'bg-slate-950 border-slate-800 text-slate-300',
    input: 'bg-slate-950 border-slate-700 text-slate-100 focus:border-slate-500',
    button: 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700',
    primary: 'bg-indigo-600 hover:bg-indigo-500 text-white border-indigo-500',
    danger: 'bg-slate-800 hover:bg-rose-950 text-rose-300 border-rose-800',
  }), [isLight]);

  const applyConfig = useCallback((next: AiConfigView) => {
    setConfig(next);
    setFormBaseUrl((prev) => (prev ? prev : next.baseUrl));
    setFormModel((prev) => (prev ? prev : next.model));
    setFormRedactIp(next.redactPrivateIp);
    setFormWhitelist((prev) => (prev ? prev : (next.commandWhitelist || []).join(', ')));
  }, []);

  // 初始化：拉配置 + 建长连接（长连接本身不发请求，只在有任务时用）
  useEffect(() => {
    let cancelled = false;
    const client = new AiWSClient();
    client.onConfig = (next) => { if (!cancelled) applyConfig(next); };
    clientRef.current = client;

    fetchAiConfig()
      .then((next) => { if (!cancelled) applyConfig(next); })
      .catch((err) => { if (!cancelled) setConfigError(err.message || 'Failed to load config'); });

    return () => {
      cancelled = true;
      client.close();
      clientRef.current = null;
    };
  }, [applyConfig]);

  /**
   * 现取上下文。取不到（终端还没内容）就返回 null，由调用方决定怎么提示 ——
   * 这里不替用户兜底成「那就发空的吧」：拿空上下文问出来的答案没有意义，
   * 而静默发一份空的上去，用户只会以为是模型不行。
   */
  const takeContext = useCallback(() => {
    const ctx = getContext?.() ?? null;
    if (!ctx || !ctx.text.trim()) return null;
    lastContextRef.current = ctx;
    return ctx;
  }, [getContext]);

  const runDiagnose = useCallback(async (input: { text: string; source: 'selection' | 'tail'; question?: string }) => {
    const client = clientRef.current;
    if (!client) return;

    lastRunRef.current = input;
    setMode('diagnose');
    setDraft(null);
    setDraftRaw('');
    setDegraded(false);
    setRunNotice(null);
    setPhase('streaming');
    setAnswer('');
    setPrepared(null);
    setMeta(null);
    setErrorMsg(null);

    try {
      await client.diagnose(
        {
          text: input.text,
          source: input.source,
          question: input.question,
          host: target?.host,
          username: target?.username,
          cwd: target?.cwd,
        },
        {
          onPrepared: (payload) => setPrepared(payload),
          onDelta: (text) => setAnswer((prev) => prev + text),
          onDone: (result) => { setMeta(result); setPhase('done'); },
          onError: (msg, aborted) => {
            setErrorMsg(msg);
            setPhase(aborted ? 'done' : 'error');
          },
        },
      );
    } catch (err: any) {
      setErrorMsg(err?.message || 'Request failed');
      setPhase('error');
    }
  }, [target?.host, target?.username, target?.cwd]);

  /**
   * 生成命令草稿。
   *
   * delta 不写进「回答」区 —— 那里流出来的是 JSON，给人看没意义；
   * 只攒进 draftRaw，供解析失败降级时原样展示。
   */
  const runDraft = useCallback(async (question: string) => {
    const client = clientRef.current;
    if (!client || !question.trim()) return;

    // 生成命令不要求必须有终端内容：很多时候用户只是想问「怎么查某某」。
    // 但**有**内容时要用当下的那份，所以这里也是现取，不是用打开面板时的快照。
    const ctx = getContext?.() ?? null;
    const text = ctx?.text ?? lastContextRef.current?.text ?? '';
    const source = ctx?.source ?? lastContextRef.current?.source ?? 'tail';
    lastDraftRef.current = { text, source, question };

    setMode('draft');
    setPhase('streaming');
    setAnswer('');
    setDraft(null);
    setDraftRaw('');
    draftRawRef.current = '';
    setDegraded(false);
    setRunNotice(null);
    setPrepared(null);
    setMeta(null);
    setErrorMsg(null);

    try {
      await client.draft(
        { text, source, question, host: target?.host, username: target?.username, cwd: target?.cwd },
        {
          onPrepared: (payload) => setPrepared(payload),
          onDelta: (chunk) => {
            draftRawRef.current += chunk;
            setDraftRaw((prev) => prev + chunk);
          },
          onDraft: (result, resultMeta) => {
            setDraft(result);
            setMeta(resultMeta);
            setPhase('done');
          },
          onError: (msg, aborted, info) => {
            setErrorMsg(msg);
            if (info?.fallback === 'readonly') {
              // 服务端没能解析出结构 → 把原文当只读回答展示，不提供任何执行入口
              setAnswer(draftRawRef.current);
              setDegraded(true);
              setPhase('done');
            } else {
              setPhase(aborted ? 'done' : 'error');
            }
          },
        },
      );
    } catch (err: any) {
      setErrorMsg(err?.message || 'Request failed');
      setPhase('error');
    }
  }, [getContext, target?.host, target?.username, target?.cwd]);

  /* ------------------------- Agent 循环（服务端驱动） ------------------------- */

  /** 按 callId 局部刷新一条工具记录 */
  const patchTool = useCallback((callId: string, patch: Partial<Extract<AgentItem, { kind: 'tool' }>>) => {
    setAgentItems((prev) => prev.map((item) => (
      item.kind === 'tool' && item.callId === callId ? { ...item, ...patch } : item
    )));
  }, []);

  /**
   * 起跑一次 Agent。
   *
   * 循环在服务端，这里只做三件事：发一个 `agent` 请求、把事件流画出来、
   * 以及在被问到的时候回答「允许 / 拒绝」。
   *
   * 没有会话 id 就直接拒绝 —— Agent 复用当前终端那条 SSH 连接。
   * 让它跑起来再在第一步失败，不如现在就说清楚为什么跑不了。
   */
  const runAgent = useCallback((goal: string) => {
    const client = clientRef.current;
    if (!client) return;

    const runId = ++agentRunIdRef.current;
    const alive = () => agentRunIdRef.current === runId;
    approvalRef.current = null;

    setMode('agent');
    setPhase('streaming');
    setAnswer('');
    setDraft(null);
    setDraftRaw('');
    draftRawRef.current = '';
    setDegraded(false);
    setPrepared(null);
    setMeta(null);
    setErrorMsg(null);
    setRunNotice(null);
    setAgentError(null);
    setAgentFinal('');
    setAgentItems([]);
    setAgentIdentity(null);
    setAgentStep(0);
    setAgentDone(null);
    setAgentRunning(true);

    if (!sessionId || !terminalConnected) {
      setAgentRunning(false);
      setPhase('error');
      setAgentError('No live terminal session. The Agent reuses the current SSH connection.');
      return;
    }

    // Agent 也现取上下文：它要拿终端当前状态当起点，用旧快照会答非所问
    const ctx = getContext?.() ?? lastContextRef.current;

    client.agent(
      {
        text: ctx?.text ?? '',
        source: ctx?.source ?? 'tail',
        question: goal,
        host: target?.host,
        username: target?.username,
        cwd: target?.cwd,
      },
      { sessionId, maxSteps: AGENT_MAX_STEPS },
      {
        onPrepared: (payload) => { if (alive()) setPrepared(payload); },
        onAgentIdentity: (identity) => { if (alive()) setAgentIdentity(identity); },
        onAgentStep: (step) => { if (alive()) setAgentStep(step); },
        onAgentMessage: (content) => {
          if (!alive() || !content.trim()) return;
          setAgentItems((prev) => [...prev, { kind: 'message', key: `msg-${prev.length}`, text: content }]);
        },
        onAgentToolCall: (call) => {
          if (!alive()) return;
          setAgentItems((prev) => [...prev, {
            kind: 'tool',
            key: call.callId,
            callId: call.callId,
            tool: call.tool,
            display: call.display,
            status: 'running',
          }]);
        },
        onAgentToolResult: (result) => {
          if (!alive()) return;
          patchTool(result.callId, { status: 'done', output: result.output, truncated: result.truncated });
        },
        onAgentApproval: (request: AiAgentApproval) => new Promise<boolean>((resolve) => {
          // 已被取消或重开：立刻拒绝，别让服务端继续等一个永远不会来的应答
          if (!alive()) {
            resolve(false);
            return;
          }
          approvalRef.current = resolve;
          patchTool(request.callId, { status: 'awaiting', level: request.level, reasons: request.reasons });
        }),
        onAgentDone: (payload) => {
          if (!alive()) return;
          setAgentFinal(payload.answer);
          setAgentDone(payload);
          setAgentRunning(false);
          setPhase('done');
        },
        onAgentError: (msg, aborted) => {
          if (!alive()) return;
          setAgentRunning(false);
          setPhase('done');
          // 用户自己取消的不算错误，不拿红字吓他
          if (!aborted) setAgentError(msg);
        },
      },
    ).catch((err: any) => {
      if (!alive()) return;
      setAgentRunning(false);
      setPhase('error');
      setAgentError(err?.message || 'Agent failed to start');
    });
  }, [getContext, patchTool, sessionId, target?.cwd, target?.host, target?.username, terminalConnected]);

  const handleStartAgent = () => {
    const goal = agentGoal.trim();
    if (!goal) return;
    setAgentGoal('');
    lastAgentGoalRef.current = goal;
    runAgent(goal);
  };

  /** 允许 / 拒绝一次审批。resolve 之后服务端那边的循环继续往下走 */
  const decideApproval = useCallback((allow: boolean) => {
    const resolve = approvalRef.current;
    approvalRef.current = null;
    resolve?.(allow);
  }, []);

  /** 停：先让迟到事件失配，再把挂着的审批以「拒绝」收掉，最后通知服务端取消 */
  const handleStopAgent = () => {
    agentRunIdRef.current += 1;
    decideApproval(false);
    clientRef.current?.cancel();
    setAgentRunning(false);
    setPhase('done');
  };

  /**
   * 面板打开时**不自动发任何请求**。
   *
   * 之前的行为是：点开就抓一份上下文直接开跑。问题有三个 —— 出网内容用户还没看过、
   * 慢模型下开个面板就得等、以及用户往往只是想打开面板再决定问什么。
   * 现在一律等用户点「Explain / Generate / Start」。
   */
  const handleExplain = () => {
    const ctx = takeContext();
    if (!ctx) {
      setErrorMsg('Nothing to analyze yet — the terminal has no output.');
      return;
    }
    void runDiagnose({ text: ctx.text, source: ctx.source });
  };

  // 流式过程中自动滚到底部，但用户主动上滚后不要抢滚动条
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [answer, prepared, draft, degraded, agentItems, agentFinal, agentError]);

  const handleScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  /** 贴底。聚焦输入框时也调一次：键盘弹出后可视区只剩一半，盯着被顶上去的旧消息没意义 */
  const stickToBottomNow = () => {
    stickToBottomRef.current = true;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  /**
   * 软键盘弹出/收起会改变可视高度，滚动容器跟着变矮 ——
   * 这时 scrollTop 不变、底部内容会掉到看不见的地方，所以贴底状态要重新贴一次。
   */
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      if (!stickToBottomRef.current) return;
      const el = bodyRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setTestResult(null);
    try {
      const next = await saveAiConfig(
        {
          baseUrl: formBaseUrl,
          model: formModel,
          redactPrivateIp: formRedactIp,
          // 逗号 / 换行分隔；服务端还会再清洗一遍（只收命令名）
          commandWhitelist: formWhitelist.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
        },
        // 留空表示不动密钥：避免「改个模型名」把 key 清掉
        formApiKey.trim() ? formApiKey.trim() : undefined,
      );
      setConfig(next);
      setFormApiKey('');
      setConfigError(null);
    } catch (err: any) {
      setConfigError(err?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testAiConfig());
    } catch (err: any) {
      setTestResult({ ok: false, message: err?.message || 'Test failed' });
    } finally {
      setTesting(false);
    }
  };

  const handleCopy = () => {
    const text = mode === 'draft' && draft ? draft.command : answer;
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };

  const handleRegenerate = () => {
    if (mode === 'agent') {
      // 重新生成沿用同一个目标，但上下文要现取 —— 屏幕上的东西已经变了
      if (lastAgentGoalRef.current) runAgent(lastAgentGoalRef.current);
      return;
    }
    if (mode === 'draft') {
      if (lastDraftRef.current) void runDraft(lastDraftRef.current.question);
      return;
    }
    if (!lastRunRef.current) return;
    // 重新生成要拿**当下**的上下文：用户想的是「换个说法再问一遍屏幕上的东西」，
    // 沿用旧快照会让「重新生成」看起来像没生效。追问则相反，见 handleFollowUp。
    const fresh = takeContext();
    void runDiagnose({
      text: fresh?.text ?? lastRunRef.current.text,
      source: fresh?.source ?? lastRunRef.current.source,
      question: lastRunRef.current.question,
    });
  };

  const handleFollowUp = () => {
    const question = followUp.trim();
    // 追问沿用本次会话的上下文快照：对话前后看的是同一份输出，答案才接得上
    if (!question || !lastRunRef.current) return;
    setFollowUp('');
    void runDiagnose({ ...lastRunRef.current, question });
  };

  const handleGenerate = () => {
    const question = askText.trim();
    if (!question) return;
    setAskText('');
    void runDraft(question);
  };

  /** 从诊断结果追问式地要命令，省得用户再打一遍需求。
   *  这是给模型的提示词，跟界面语言一致走英文。 */
  const handleDraftFromAnswer = () => {
    void runDraft('Based on the output above, give the next command to run.');
  };

  /** submit=false：只把命令写进输入行；submit=true：连回车一起发出去 */
  const dispatchCommand = (submit: boolean) => {
    if (!draft || !onRunCommand) return;
    const ok = onRunCommand(draft.command, submit);
    setRunNotice(
      ok
        ? (submit ? 'Sent to terminal' : 'Filled in — press Enter to run')
        : 'Terminal offline, nothing sent',
    );
  };

  const handleRunClick = () => {
    if (!draft) return;
    // 高风险必须再确认一次；其余等级也走一次确认，避免误触
    if (draft.grade.level === 'dangerous') {
      setConfirmRunOpen(true);
      return;
    }
    dispatchCommand(true);
  };

  const streaming = phase === 'streaming';
  /** 有活儿在跑：底部按钮、输入框禁用都看这个，别让用户在流式过程中插队 */
  const busy = streaming || agentRunning;
  const redactions = prepared ? redactionSummary(prepared.stats) : '';

  return (
    <div className={`absolute right-0 top-0 z-30 h-full w-full sm:w-[26rem] flex flex-col border-l ${palette.panel}`}>
      {/* shrink-0：可视区被软键盘压到只剩一半时，头尾两栏不能被挤扁 */}
      <div className={`flex items-center justify-between gap-2 px-3 py-2 border-b shrink-0 ${palette.header}`}>
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
          <span className="text-xs font-medium truncate">AI</span>
          {config?.ready && (
            <span className={`text-[10px] font-mono truncate ${palette.subtle}`}>{config.model}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {config?.ready && (
            <button
              onClick={() => setShowSettings((prev) => !prev)}
              className={`p-1 rounded cursor-pointer ${showSettings ? palette.primary : palette.button}`}
              title="Settings"
            >
              <Settings2 className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={onClose} className={`p-1 rounded cursor-pointer ${palette.button}`} title="Close">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div ref={bodyRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 py-2 space-y-3 text-xs">
        {configError && (
          <div className="flex items-start gap-2 text-rose-500">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{configError}</span>
          </div>
        )}

        {/* 未就绪时自动展开；就绪后靠齿轮手动打开 */}
        {(!config?.ready || !config || showSettings) && (
          <div className={`rounded border p-2.5 space-y-2 ${palette.card}`}>
            <div className="flex items-center gap-1.5 font-medium">
              <Settings2 className="w-3.5 h-3.5" />
              <span>Model</span>
            </div>

            <label className="block space-y-1">
              <span className={palette.subtle}>Base URL</span>
              <input
                value={formBaseUrl}
                onChange={(e) => setFormBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                className={`w-full rounded border px-2 py-1 text-[11px] font-mono focus:outline-none ${palette.input}`}
              />
            </label>

            <label className="block space-y-1">
              <span className={palette.subtle}>Model</span>
              <input
                value={formModel}
                onChange={(e) => setFormModel(e.target.value)}
                placeholder="gpt-4o-mini"
                className={`w-full rounded border px-2 py-1 text-[11px] font-mono focus:outline-none ${palette.input}`}
              />
            </label>

            <label className="block space-y-1">
              <span className={palette.subtle}>API Key</span>
              <input
                type="password"
                value={formApiKey}
                onChange={(e) => setFormApiKey(e.target.value)}
                disabled={config?.keyFromEnv}
                placeholder={config?.keyFromEnv ? 'from env' : config?.hasKey ? 'saved' : 'optional'}
                className={`w-full rounded border px-2 py-1 text-[11px] font-mono focus:outline-none disabled:opacity-50 ${palette.input}`}
              />
            </label>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={formRedactIp}
                onChange={(e) => setFormRedactIp(e.target.checked)}
              />
              <span className={palette.subtle}>Redact private IPs</span>
            </label>

            <label className="block space-y-1">
              <span className={palette.subtle}>Auto-run allowlist</span>
              <input
                value={formWhitelist}
                onChange={(e) => setFormWhitelist(e.target.value)}
                placeholder="myctl, deploy"
                className={`w-full rounded border px-2 py-1 text-[11px] font-mono focus:outline-none ${palette.input}`}
              />
            </label>

            <div className="flex items-center gap-2">
              <button onClick={handleSave} disabled={saving} className={`${buttonClass} ${palette.primary}`}>
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                <span>Save</span>
              </button>
              <button onClick={handleTest} disabled={testing || !config?.ready} className={`${buttonClass} ${palette.button}`}>
                {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                <span>Test</span>
              </button>
            </div>

            {testResult && (
              <div className={testResult.ok ? 'text-emerald-500' : 'text-rose-500'}>
                {testResult.ok ? 'Connected' : testResult.message}
                {testResult.model ? ` (${testResult.model})` : ''}
              </div>
            )}
          </div>
        )}

        {/* 分析的入口。按钮上写清楚将要分析的是选区还是末尾若干行 ——
            用户点之前就该知道要发出去的是什么 */}
        {config?.ready && (
          <div className={`rounded border p-2.5 space-y-2 ${palette.card}`}>
            <button
              onClick={handleExplain}
              disabled={busy}
              className={`${buttonClass} ${palette.primary} w-full justify-center`}
            >
              <Sparkles className="w-3 h-3" />
              <span>{peek.source === 'selection' ? 'Explain selection' : 'Explain recent output'}</span>
            </button>
            <p className={`text-[10px] leading-relaxed ${palette.subtle}`}>
              Read-only. Nothing runs.
            </p>
          </div>
        )}

        {/* 出网可见性：默认展开，让用户先看清发的是什么 */}
        {prepared && (
          <div className={`rounded border ${palette.card}`}>
            <button
              onClick={() => setShowContext((prev) => !prev)}
              className="w-full flex items-center gap-1.5 px-2.5 py-2 text-left cursor-pointer"
            >
              {showContext ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
              <span className="font-medium shrink-0">Sending</span>
              <span className={`text-[10px] font-mono truncate ${palette.subtle}`}>
                {prepared.stats.rawLines > 0
                  ? `${prepared.stats.rawLines}→${prepared.stats.lines} lines · ~${prepared.stats.estTokens} tokens`
                  : 'no terminal content'}
                {prepared.stats.redactionTotal ? ` · ${prepared.stats.redactionTotal} redacted` : ''}
              </span>
            </button>

            {showContext && (
              <div className="px-2.5 pb-2.5 space-y-2">
                <div className={`text-[10px] font-mono break-all ${palette.subtle}`}>{prepared.env}</div>
                {(redactions || prepared.stats.omittedLines > 0) && (
                  <div className={`text-[10px] font-mono ${palette.subtle}`}>
                    {redactions ? `redacted: ${redactions}` : ''}
                    {redactions && prepared.stats.omittedLines ? ' · ' : ''}
                    {prepared.stats.omittedLines ? `${prepared.stats.omittedLines} lines omitted` : ''}
                  </div>
                )}
                {prepared.text ? (
                  <pre className={`max-h-56 overflow-auto rounded border p-2 text-[10px] leading-relaxed font-mono whitespace-pre-wrap break-all ${palette.code}`}>
                    {prepared.text}
                  </pre>
                ) : (
                  // 纯「生成命令」时没有终端内容可发，别摆一个空代码框看着像坏了
                  <p className={`text-[10px] leading-relaxed ${palette.subtle}`}>
                    No terminal content. Only your request, host and user are sent.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* 自然语言 → 命令。生成物一律先过服务端判分再露面 */}
        {config?.ready && (
          <div className={`rounded border p-2.5 space-y-2 ${palette.card}`}>
            <div className="flex items-center gap-1.5 font-medium">
              <Wand2 className="w-3.5 h-3.5 text-indigo-500" />
              <span>Generate command</span>
            </div>
            <p className={`text-[10px] leading-relaxed ${palette.subtle}`}>
              Describe a task. You confirm before it runs.
            </p>
            <div className="flex items-center gap-1.5">
              <input
                value={askText}
                onChange={(e) => setAskText(e.target.value)}
                onFocus={stickToBottomNow}
                onKeyDown={(e) => { if (e.key === 'Enter') handleGenerate(); }}
                disabled={streaming}
                placeholder="show docker container status"
                className={`flex-1 min-w-0 rounded border px-2 py-1 text-[11px] focus:outline-none disabled:opacity-50 ${palette.input}`}
              />
              <button
                onClick={handleGenerate}
                disabled={!askText.trim() || streaming}
                className={`${buttonClass} ${palette.primary}`}
              >
                <span>Generate</span>
              </button>
            </div>
          </div>
        )}

        {/* Agent：多步。判分过关且身份实测过的步骤自己跑，其余停下来等人 */}
        {config?.ready && (
          <div className={`rounded border p-2.5 space-y-2 ${palette.card}`}>
            <div className="flex items-center gap-1.5 font-medium">
              <Bot className="w-3.5 h-3.5 text-indigo-500" />
              <span>Agent</span>
              <span className={`ml-auto text-[10px] font-mono ${palette.subtle}`}>max {AGENT_MAX_STEPS} steps</span>
            </div>
            <p className={`text-[10px] leading-relaxed ${palette.subtle}`}>
              Runs read-only steps on its own. Writes and risky commands wait for you.
            </p>
            <div className="flex items-center gap-1.5">
              <input
                value={agentGoal}
                onChange={(e) => setAgentGoal(e.target.value)}
                onFocus={stickToBottomNow}
                onKeyDown={(e) => { if (e.key === 'Enter') handleStartAgent(); }}
                disabled={busy}
                placeholder="why is nginx slow here?"
                className={`flex-1 min-w-0 rounded border px-2 py-1 text-[11px] focus:outline-none disabled:opacity-50 ${palette.input}`}
              />
              <button
                onClick={handleStartAgent}
                disabled={!agentGoal.trim() || busy || !terminalConnected || !sessionId}
                className={`${buttonClass} ${palette.primary}`}
              >
                <Play className="w-3 h-3" />
                <span>Start</span>
              </button>
            </div>
            {!(terminalConnected && sessionId) && (
              <div className={`text-[10px] ${palette.subtle}`}>needs a live terminal</div>
            )}
          </div>
        )}

        {/* Agent 事件流：服务端推什么画什么，需要表态的那条停在审批闸上 */}
        {mode === 'agent' && (agentItems.length > 0 || agentFinal || agentError) && (
          <div className="space-y-2">
            {agentIdentity && (
              <div className={`text-[10px] font-mono ${palette.subtle}`}>
                {agentIdentity.user
                  ? `remote user: ${agentIdentity.user}${agentIdentity.isRoot ? ' (root)' : ''}${agentIdentity.isRoot ? ' — every step needs approval' : ''}`
                  : 'remote user: unknown — every step needs approval'}
                {agentStep ? ` · step ${agentStep}` : ''}
              </div>
            )}

            {agentItems.map((item) => (
              item.kind === 'message' ? (
                <p key={item.key} className="leading-relaxed whitespace-pre-wrap break-words">{item.text}</p>
              ) : (
                <AgentItemRow
                  key={item.key}
                  item={item}
                  risk={risk}
                  palette={palette}
                  onAllow={() => decideApproval(true)}
                  onDeny={() => decideApproval(false)}
                />
              )
            ))}

            {agentRunning && agentItems.length > 0 && (
              <div className={`flex items-center gap-1.5 text-[10px] ${palette.subtle}`}>
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>working…</span>
              </div>
            )}

            {agentFinal && (
              <div className={`rounded border p-2.5 space-y-1 ${palette.card}`}>
                <div className="flex items-center gap-1.5 font-medium">
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                  <span>Conclusion</span>
                </div>
                <div className="leading-relaxed whitespace-pre-wrap break-words">{agentFinal}</div>
              </div>
            )}

            {/* 撞到步数上限要说清楚，否则用户会以为它已经查完了 */}
            {agentDone?.stopReason === 'max-steps' && (
              <div className={`text-[10px] ${palette.subtle}`}>
                Stopped at the step limit ({agentDone.steps}). Raise the limit to continue.
              </div>
            )}

            {agentError && (
              <div className="flex items-start gap-2 text-rose-500">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span className="leading-relaxed">{agentError}</span>
              </div>
            )}
          </div>
        )}

        {/* 命令草稿：风险等级只认服务端判分，模型自评仅作对照 */}
        {mode === 'draft' && (draft || streaming) && (
          <div className={`rounded border space-y-2 p-2.5 ${draft ? risk[draft.grade.level].border : palette.card}`}>
            {draft ? (
              <>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${risk[draft.grade.level].badge}`}>
                    {RISK_LABEL[draft.grade.level]}
                  </span>
                  <span className={`text-[10px] font-mono ${palette.subtle}`}>server grade</span>
                  {draft.selfRisk && draft.selfRisk !== draft.grade.level && (
                    <span className={`text-[10px] font-mono ${risk[draft.selfRisk].text}`}>
                      model said {RISK_LABEL[draft.selfRisk]} (overridden)
                    </span>
                  )}
                  {(draft.grade.allWhitelisted || draft.grade.allAllowlisted) && (
                    <span className={`text-[10px] font-mono ${palette.subtle}`}>
                      {draft.grade.allAllowlisted ? 'all allowlisted' : 'all read-only'}
                    </span>
                  )}
                </div>

                {draft.explain && <p className="leading-relaxed">{draft.explain}</p>}

                <pre className={`max-h-40 overflow-auto rounded border p-2 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-all ${palette.code}`}>
                  {draft.command}
                </pre>

                {draft.grade.reasons.length > 0 && (
                  <ul className={`space-y-0.5 ${risk[draft.grade.level].text}`}>
                    {draft.grade.reasons.map((reason) => (
                      <li key={reason} className="flex items-start gap-1.5">
                        <ShieldAlert className="w-3 h-3 mt-0.5 shrink-0" />
                        <span>{reason}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {draft.grade.segments.length > 1 && (
                  <div className={`text-[10px] font-mono space-y-0.5 ${palette.subtle}`}>
                    {draft.grade.segments.map((seg, index) => (
                      <div key={`${index}-${seg.raw}`} className="truncate" title={seg.raw}>
                        {RISK_LABEL[seg.level]} · {seg.binary || '?'} · {seg.raw}
                      </div>
                    ))}
                  </div>
                )}

                {draft.prerequisites.length > 0 && (
                  <div className={`text-[10px] leading-relaxed ${palette.subtle}`}>
                    Requires: {draft.prerequisites.join('; ')}
                  </div>
                )}

                {draft.grade.rootSession && (
                  <div className={`text-[10px] ${palette.subtle}`}>
                    Root session — auto-run disabled (manual run still available)
                  </div>
                )}

                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => dispatchCommand(false)}
                    disabled={!terminalConnected || !onRunCommand}
                    className={`${buttonClass} ${palette.button}`}
                    title="Write to the input line without pressing Enter"
                  >
                    <CornerDownLeft className="w-3 h-3" />
                    <span>Fill</span>
                  </button>
                  <button
                    onClick={handleRunClick}
                    disabled={!terminalConnected || !onRunCommand}
                    className={`${buttonClass} ${draft.grade.level === 'dangerous' ? palette.danger : palette.primary}`}
                    title="Fill and press Enter"
                  >
                    <Play className="w-3 h-3" />
                    <span>Run</span>
                  </button>
                  <button onClick={handleCopy} className={`${buttonClass} ${palette.button}`}>
                    {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                    <span>Copy</span>
                  </button>
                  {!terminalConnected && (
                    <span className={`text-[10px] ${palette.subtle}`}>terminal offline</span>
                  )}
                </div>

                {runNotice && (
                  <div className={`text-[10px] leading-relaxed ${palette.subtle}`}>{runNotice}</div>
                )}
              </>
            ) : (
              <div className="flex items-center gap-1.5 text-[11px]">
                <Loader2 className="w-3 h-3 animate-spin text-indigo-500" />
                <span className={palette.subtle}>Generating…</span>
              </div>
            )}
          </div>
        )}

        {/* 降级：模型没给出可解析的结构，只展示原文，不给任何执行入口 */}
        {degraded && (
          <div className={`rounded border p-2 text-[11px] leading-relaxed ${risk.caution.border} ${risk.caution.text}`}>
            No usable command structure came back. Raw output below, read-only.
          </div>
        )}

        {/* 回答：诊断模式，或草稿降级后展示模型原文 */}
        {(mode === 'diagnose' || degraded) && (answer || streaming) && (
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="font-medium">Answer</span>
              {streaming && <Loader2 className="w-3 h-3 animate-spin text-indigo-500" />}
            </div>
            <div className="leading-relaxed whitespace-pre-wrap break-words">
              {answer || <span className={palette.subtle}>Waiting for first token…</span>}
            </div>
          </div>
        )}

        {/* 诊断完给一个「往下走」的入口：省得用户把需求再打一遍 */}
        {mode === 'diagnose' && phase === 'done' && !streaming && config?.ready && answer && (
          <button
            onClick={handleDraftFromAnswer}
            className={`${buttonClass} ${palette.primary} w-full justify-center`}
          >
            <Play className="w-3 h-3" />
            <span>Turn this into a command</span>
          </button>
        )}

        {errorMsg && (
          <div className={`flex items-start gap-2 ${phase === 'error' ? 'text-rose-500' : palette.subtle}`}>
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span className="leading-relaxed">{errorMsg}</span>
          </div>
        )}

        {meta && (
          <div className={`text-[10px] font-mono ${palette.subtle}`}>
            {meta.firstTokenMs !== undefined ? `first ${meta.firstTokenMs}ms · ` : ''}
            {meta.ms !== undefined ? `${meta.ms}ms total · ` : ''}
            {`${meta.chars || 0} chars`}
            {meta.usage?.total_tokens ? ` · ${meta.usage.total_tokens} tokens` : ''}
            {meta.finishReason === 'length' ? ' · truncated by max_tokens' : ''}
          </div>
        )}
      </div>

      {/* 底部操作区 */}
      <div className={`border-t px-3 py-2 space-y-2 shrink-0 ${palette.header}`}>
        <div className="flex items-center gap-2">
          {busy ? (
            <button
              onClick={() => (agentRunning ? handleStopAgent() : clientRef.current?.cancel())}
              className={`${buttonClass} ${palette.danger}`}
            >
              <Square className="w-3 h-3" />
              <span>Stop</span>
            </button>
          ) : (
            <button
              onClick={handleRegenerate}
              disabled={mode === 'agent'
                ? !lastAgentGoalRef.current
                : (mode === 'draft' ? !lastDraftRef.current : !lastRunRef.current)}
              className={`${buttonClass} ${palette.button}`}
            >
              <RefreshCw className="w-3 h-3" />
              <span>Regenerate</span>
            </button>
          )}
          <button
            onClick={handleCopy}
            disabled={!(mode === 'draft' ? draft : answer)}
            className={`${buttonClass} ${palette.button}`}
          >
            {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
            <span>Copy</span>
          </button>
          {/* 这句话在三种模式下含义不同，别让它说谎 */}
          <span className={`ml-auto text-[10px] font-mono ${palette.subtle}`}>
            {mode === 'agent'
              ? 'you approve risky steps'
              : (mode === 'draft' ? 'you confirm after grading' : 'read-only, never runs')}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <input
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            onFocus={stickToBottomNow}
            onKeyDown={(e) => { if (e.key === 'Enter') handleFollowUp(); }}
            disabled={!config?.ready || busy}
            placeholder="Ask a follow-up…"
            className={`flex-1 min-w-0 rounded border px-2 py-1 text-[11px] focus:outline-none disabled:opacity-50 ${palette.input}`}
          />
          <button
            onClick={handleFollowUp}
            disabled={!followUp.trim() || !config?.ready || busy}
            className={`${buttonClass} ${palette.primary}`}
          >
            Ask
          </button>
        </div>
      </div>

      {/* 高风险命令的二次确认。复用项目里已有的危险操作确认对话框 */}
      <ConfirmDialog
        isOpen={confirmRunOpen}
        theme={theme}
        title="Run high-risk command?"
        confirmLabel="Run anyway"
        cancelLabel="Cancel"
        message={
          <span className="block space-y-1.5">
            <span className="block">The server graded this command as high risk. It may be irreversible:</span>
            {draft && (
              <span className="block">
                {draft.grade.reasons.map((reason) => (
                  <span key={reason} className="block">· {reason}</span>
                ))}
              </span>
            )}
            {draft && (
              <code className="block mt-1 rounded bg-black/10 px-2 py-1 font-mono text-[11px] break-all whitespace-pre-wrap">
                {draft.command}
              </code>
            )}
          </span>
        }
        onConfirm={() => {
          setConfirmRunOpen(false);
          dispatchCommand(true);
        }}
        onCancel={() => setConfirmRunOpen(false)}
      />
    </div>
  );
};
