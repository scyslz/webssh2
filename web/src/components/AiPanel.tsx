import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownLeft,
  Loader2,
  Play,
  Settings2,
  ShieldAlert,
  Sparkles,
  Square,
  Trash2,
  Monitor,
  X,
} from 'lucide-react';
import {
  AiWSClient,
  fetchAiConfig,
  saveAiConfig,
  testAiConfig,
  type AiAgentApproval,
  type AiAgentDone,
  type AiConfigView,
  type AiContextStats,
  type AiDoneMeta,
  type AiDraft,
  type AiRiskLevel,
  type TerminalBridge,
  type AiAgentIdentity,
  type ChatMessage,
  type AiHistoryEntry,
} from '../aiClient';
import { ConfirmDialog } from './ConfirmDialog';
import { isLightTheme } from '../theme';
import { globalGet, globalSet } from '../storage';

/**
 * AI 面板：统一对话窗口 + 多会话 + Agent（服务端驱动的工具循环）。
 *
 * 三个旧的入口（解释 / 生成命令 / Agent）合并成一个聊天框：
 *   - 有终端会话时，每条消息走 Agent（它既能只读解读、也能在审批后执行工具）；
 *   - 没有会话时，走只读诊断（diagnose）。
 *   - 「包含终端屏幕」开关控制这一条要不要把当前屏幕内容一起发上去；
 *     关掉它就只发你的问题 + host/user。
 *
 * 安全边界不变：
 *   1. 诊断路径永不执行；Agent 里写文件 / 高风险命令仍要人工审批。
 *   2. 风险等级以服务端判分显示，模型自评只作对照。
 *   3. 命令写进终端输入行，回车永远用户按（除非显式点 Run）。
 *   4. 多会话是**纯客户端**的——服务端不存历史，每条消息都从「当前屏幕 + 你的提问」重新开始。
 *      session 之间的区别只是面板里分开展示的对话。
 *   5. 审批支持「本次会话放行」：同类工具之后不再每次打断（记忆只活在这一次 runAgent 请求内）。
 */

interface AiPanelProps {
  onClose: () => void;
  theme?: string;
  /** 目标机描述（host/user）。面板自己不持有 SSH 凭据 */
  target?: { host?: string; username?: string; cwd?: string };
  /** 当前 tab 的 SSH 会话 id。Agent 复用这个会话执行工具。 */
  sessionId?: string;
  /** 现取终端上下文：有选区取选区，否则取末尾若干行。是函数不是快照 */
  getContext?: () => { text: string; source: 'selection' | 'tail' } | null;
  /** 目标终端的 SSH 连接是否就绪；没连上就只能走只读诊断 */
  terminalConnected?: boolean;
  /** 把命令写进终端输入行。submit=false 只填入不回车。返回是否发送成功 */
  onRunCommand?: (command: string, submit: boolean) => boolean;
  getExecBridge?: () => TerminalBridge | null;
  /**
   * 会话级面板开关状态变化（来自服务端，可能是别的设备的操作）。
   * App 据此自动打开/关闭对应 tab 的面板。
   */
  onPanelStateChange?: (open: boolean) => void;
}

/* ----------------------------- 风险着色 ----------------------------- */

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

const AGENT_DEFAULT_STEPS = 20;
const AGENT_OUTPUT_CLIP_CHARS = 4000;

type ToolStatus = 'pending' | 'awaiting' | 'running' | 'done' | 'denied' | 'auto';

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
      /** false = 破坏性命令，不提供「Allow for session」 */
      rememberable?: boolean;
      /** 高危：审批只给 Approve / Deny */
      dangerous?: boolean;
      /** 是否提供「Approve Session」 */
      canRemember?: boolean;
    };

const describeCall = (item: Extract<AgentItem, { kind: 'tool' }>): string => {
  const args = item.display ? item.display.replace(/\s+/g, ' ').trim() : '';
  return args.length > 300 ? `${args.slice(0, 300)}…` : (args || '(no arguments)');
};

const clipOutput = (text: string) => {
  if (text.length <= AGENT_OUTPUT_CLIP_CHARS) return text;
  const head = Math.floor(AGENT_OUTPUT_CLIP_CHARS * 0.6);
  const tail = AGENT_OUTPUT_CLIP_CHARS - head;
  return `${text.slice(0, head)}\n… ${text.length - AGENT_OUTPUT_CLIP_CHARS} chars omitted …\n${text.slice(-tail)}`;
};

const buttonClass = 'flex items-center gap-1 px-1.5 py-0.5 min-h-[26px] sm:px-2 sm:py-1 sm:min-h-[30px] rounded-md text-[11px] font-medium border transition cursor-pointer disabled:opacity-40';

const copyText = (text: string, onOk?: () => void) => {
  if (!text) return;
  navigator.clipboard?.writeText(text).then(() => onOk?.()).catch(() => {});
};

const EMPTY_PROMPTS = [
  'What just failed here?',
  'Explain the last error',
  'What should I check next?',
  'Summarize this output',
];

const formatElapsed = (ms: number) => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
};

/** 卡片起始时间的时钟显示（本地时区，HH:MM:SS） */
const formatClock = (at?: number) => {
  if (!at) return '';
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 每张卡片右上角/底部统一的起始时间标记 */
const StartedAt: React.FC<{ at?: number; palette: Palette; extra?: string }> = ({ at, palette, extra }) => {
  if (!at) return null;
  return (
    <span className={`text-[9px] font-mono ${palette.subtle}`} title={new Date(at).toLocaleString()}>
      {formatClock(at)}{extra ? ` · ${extra}` : ''}
    </span>
  );
};

type Palette = Record<'panel' | 'header' | 'subtle' | 'card' | 'code' | 'input' | 'button' | 'primary' | 'danger', string>;

/* ----------------------------- 会话 / 消息模型 ----------------------------- */

interface PreparedView {
  text: string;
  env: string;
  question: string;
  stats: AiContextStats;
}

interface ChatUserEntry {
  id: string;
  kind: 'user';
  text: string;
  withScreen: boolean;
  /** 创建时间（epoch ms）。本机建 = Date.now()；历史回放 = 服务端给的 at */
  at?: number;
}

interface ChatTextEntry {
  id: string;
  kind: 'text';
  answer: string;
  meta?: AiDoneMeta;
  error?: string;
  aborted?: boolean;
  degraded?: boolean;
  prepared?: PreparedView | null;
  streaming?: boolean;
  at?: number;
}

interface ChatDraftEntry {
  id: string;
  kind: 'draft';
  draft: AiDraft;
  meta?: AiDoneMeta;
  prepared?: PreparedView | null;
  error?: string;
  at?: number;
}

interface ChatAgentEntry {
  id: string;
  kind: 'agent';
  goal: string;
  identity?: AiAgentIdentity | null;
  items: AgentItem[];
  final?: string;
  error?: string;
  aborted?: boolean;
  stopReason?: AiAgentDone['stopReason'];
  steps?: number;
  prepared?: PreparedView | null;
  streaming?: boolean;
  at?: number;
  /** run 起点（epoch ms，服务端给）。用于卡片内耗时显示，刷新/接管后仍准确 */
  runStartedAt?: number;
  /** agent_done 的元信息（含服务端实测总耗时 ms） */
  meta?: AiDoneMeta;
}

type ChatEntry = ChatUserEntry | ChatTextEntry | ChatDraftEntry | ChatAgentEntry;

interface AiChatSession {
  id: string;
  title: string;
  messages: ChatEntry[];
  createdAt: number;
}

const newSession = (): AiChatSession => ({
  id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  title: 'New chat',
  messages: [],
  createdAt: Date.now(),
});

/**
 * 把服务端回放的一条历史记录还原成前端 entry。
 *
 * id 按序号生成、加 `h-` 前缀：历史条目是**已定型**的，不会再有流式更新，
 * 所以不需要稳定 key，只要一轮内唯一即可。
 */
const historyToEntry = (e: AiHistoryEntry, index: number): ChatEntry => {
  const id = `h-${index}`;
  if (e.kind === 'user') {
    return { id, kind: 'user', text: e.text || '', withScreen: Boolean(e.withScreen), at: e.at };
  }
  if (e.kind === 'text') {
    return { id, kind: 'text', answer: e.answer || '', error: e.error, aborted: e.aborted, streaming: false, at: e.at };
  }
  if (e.kind === 'agent') {
    const items: AgentItem[] = (e.items || []).map((it, i): AgentItem => {
      if (it.kind === 'message') return { kind: 'message', key: `h-${index}-m${i}`, text: String(it.text || '') };
      return {
        kind: 'tool',
        key: `h-${index}-t${i}`,
        callId: String(it.callId || `h-${index}-t${i}`),
        tool: String(it.tool || ''),
        display: String(it.display || ''),
        status: (it.status as ToolStatus) || 'done',
        level: it.level as AiRiskLevel | undefined,
        reasons: Array.isArray(it.reasons) ? it.reasons.map(String) : undefined,
        output: typeof it.output === 'string' ? it.output : undefined,
        truncated: Boolean(it.truncated),
        rememberable: it.rememberable !== false,
        dangerous: it.dangerous === true,
        canRemember: it.canRemember === true,
      };
    });
    return {
      id,
      kind: 'agent',
      goal: e.goal || '',
      identity: (e.identity as AiAgentIdentity | null) ?? null,
      items,
      final: e.final,
      error: e.error,
      aborted: e.aborted,
      stopReason: e.stopReason as AiAgentDone['stopReason'] | undefined,
      steps: e.steps,
      streaming: false,
      at: e.at,
      // 历史里这条 run 若已完成，runStartedAt 就是它的起点；未完成时接管方会由
      // resumed 的 startedAt 覆盖，所以这里统一用 at 兜底。
      runStartedAt: e.at,
      meta: e.ms !== undefined ? { ms: e.ms } : undefined,
    };
  }
  // text
  return { id, kind: 'text', answer: e.answer || '', error: e.error, aborted: e.aborted, streaming: false, at: e.at };
};

/** 从历史里取第一条用户提问当标题（服务端不存标题） */
const deriveTitle = (messages: ChatEntry[]): string => {
  const firstUser = messages.find((m) => m.kind === 'user') as ChatUserEntry | undefined;
  return firstUser?.text.trim().slice(0, 40) || 'New chat';
};

const redactionSummary = (stats: AiContextStats) => {
  if (!stats.redactionTotal) return '';
  return Object.entries(stats.redactions || {})
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key}×${count}`)
    .join(' ');
};

/* ----------------------------- Agent 工具行 ----------------------------- */

const AgentItemRow: React.FC<{
  item: Extract<AgentItem, { kind: 'tool' }>;
  risk: Record<AiRiskLevel, { badge: string; border: string; text: string }>;
  palette: Palette;
  onAllow: () => void;
  onAllowSession: () => void;
  onDeny: () => void;
}> = ({ item, risk, palette, onAllow, onAllowSession, onDeny }) => {
  const level = item.level;
  return (
    <div className={`rounded-md border p-1.5 sm:p-2.5 space-y-1 sm:space-y-1.5 ${level ? risk[level].border : palette.card}`}>
      <div className="flex items-center gap-1 sm:gap-1.5 flex-wrap">
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${palette.card}`}>{item.tool}</span>
        {level && (
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${risk[level].badge}`}>
            {RISK_LABEL[level]}
          </span>
        )}
        {item.status === 'pending' && <Loader2 className="w-3 h-3 animate-spin text-indigo-500" />}
        {item.status === 'auto' && <span className={`text-[10px] ${palette.subtle}`}>auto-approved</span>}
        {item.status === 'denied' && <span className={`text-[10px] ${palette.subtle}`}>denied</span>}
      </div>

      <pre className={`max-h-24 overflow-auto rounded-md border p-1.5 text-[11px] font-mono whitespace-pre-wrap break-all ${palette.code}`}>
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
        <div className="flex items-center gap-1.5 flex-wrap">
          <button onClick={onAllow} className={`${buttonClass} ${item.dangerous || item.level === 'dangerous' ? palette.danger : palette.primary}`}>
            <Play className="w-3 h-3" />
            <span>Approval</span>
          </button>
          {/* 常规改动才给「Approve Session」：点了之后本 SSH 会话的常规改动都自动跑。
              高危命令只给 Approve / Deny，永不提供 session 放行。 */}
          {item.canRemember && (
            <button onClick={onAllowSession} className={`${buttonClass} ${palette.button}`} title="Approve this and let routine changes run automatically for the rest of this session">
              <Check className="w-3 h-3" />
              <span>Session</span>
            </button>
          )}
          <button onClick={onDeny} className={`${buttonClass} ${palette.button}`}>
            <X className="w-3 h-3" />
            <span>Deny</span>
          </button>
        </div>
      )}

      {item.status === 'done' && item.output !== undefined && (
        <pre className={`max-h-40 overflow-auto rounded-md border p-1.5 text-[10px] leading-relaxed font-mono whitespace-pre-wrap break-all ${palette.code}`}>
          {item.output ? clipOutput(item.output) : '(no output)'}
          {item.truncated ? '\n[truncated]' : ''}
        </pre>
      )}
    </div>
  );
};

/* ----------------------------- 主组件 ----------------------------- */

export const AiPanel: React.FC<AiPanelProps> = ({
  onClose,
  theme,
  target,
  sessionId,
  getContext,
  terminalConnected = false,
  onRunCommand,
  getExecBridge,
  onPanelStateChange,
}) => {
  const isLight = isLightTheme(theme);
  const risk = isLight ? RISK_STYLE : RISK_STYLE_DARK;

  const clientRef = useRef<AiWSClient | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const [sessions, setSessions] = useState<AiChatSession[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const activeIdRef = useRef<string>('');
  /** 历史比初始会话先到时暂存于此（见初始化 effect） */
  const pendingHistoryRef = useRef<{ messages: ChatEntry[]; title: string } | null>(null);
  const [includeScreen, setIncludeScreen] = useState(false);

  const [config, setConfig] = useState<AiConfigView | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // 表单
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formModel, setFormModel] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formRedactIp, setFormRedactIp] = useState(false);
  const [formWhitelist, setFormWhitelist] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // 输入 / 运行态
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [lastRunNotice, setRunNotice] = useState<string | null>(null);
  const [maxSteps, setMaxSteps] = useState(() => {
    try {
      const v = Number(globalGet('webssh_ai_maxsteps'));
      return [5, 10, 20, 30, 50].includes(v) ? v : AGENT_DEFAULT_STEPS;
    } catch {
      return AGENT_DEFAULT_STEPS;
    }
  });
  const changeMaxSteps = useCallback((n: number) => {
    const v = [5, 10, 20, 30, 50].includes(n) ? n : AGENT_DEFAULT_STEPS;
    setMaxSteps(v);
    try { globalSet('webssh_ai_maxsteps', String(v)); } catch {}
  }, []);

  // draft 的高风险二次确认
  const [confirmRun, setConfirmRun] = useState<{ sessionId: string; entryId: string } | null>(null);

  // 运行计时：起点由**服务端**给（run 的真实开始时间），前端只按墙钟算差值。
  // 这样刷新 / 接管后不会从 0 重新计；拿不到服务端时间才退回本机 Date.now()。
  const busyStartRef = useRef<number | null>(null);
  const [runElapsedMs, setRunElapsedMs] = useState(0);
  const [runStep, setRunStep] = useState(0);
  const beginRun = (startedAt?: number) => {
    busyStartRef.current = startedAt ?? Date.now();
    setRunElapsedMs(Math.max(0, Date.now() - busyStartRef.current));
    setRunStep(0);
    setBusy(true);
    busyRef.current = true;
    setRunNotice(null);
  };
  const endRun = () => {
    busyStartRef.current = null;
    setBusy(false);
    busyRef.current = false;
  };

  // Agent 审批闸 resolve（非 state，给 await 用）
  const approvalRef = useRef<((allow: boolean, remember: boolean) => void) | null>(null);
  const agentRunIdRef = useRef(0);
  /**
   * 重连接回时要继续写入的 entry id。
   *
   * 断线前那条 agent entry 还在本地（页面没刷新）：重连后**接着往它里面追加**，
   * 不另开一条 —— 对用户而言就是同一次会话在继续，没必要区别「断线前/后」。
   * 若本地已经没有那条 entry（页面刷新过），才新建。
   */
  const resumedEntryRef = useRef<string | null>(null);
  /** 最近一条 agent entry 的 id，供重连时找回 */
  const lastAgentEntryRef = useRef<string | null>(null);
  /**
   * 被动跟随一条 diagnose/draft 流时承接 delta 的 text entry。
   *
   * agent run 靠 `agent_start{resumed}` 认回 entry；diagnose/draft 没有这个信号，
   * 只能从 `ready.resumed(+/Kind)` 得知。delta 本身不进服务端缓冲，所以中途接管
   * 只能从「此刻起」继续渲染 —— 已吐出的部分由 `ai_history` 里的 finalized 文本补。
   */
  const followedRunRef = useRef<{ id: string; kind: 'diagnose' | 'draft' } | null>(null);
  /** 跟随流已落地的 text entry id（首个 delta 到达时惰性创建） */
  const followedTextEntryRef = useRef<string | null>(null);
  /** 供 client 初始化 effect 调用（effect 早于下面的 useCallback 定义跑） */
  const appendEntryRef = useRef<(entry: ChatEntry) => void>(() => {});
  const patchEntryRef = useRef<(entryId: string, patch: Partial<ChatEntry>) => void>(() => {});
  const beginRunRef = useRef<(startedAt?: number) => void>(() => {});
  const endRunRef = useRef<() => void>(() => {});
  const appendAgentItemRef = useRef<(entryId: string, item: AgentItem) => void>(() => {});
  const patchAgentItemRef = useRef<(entryId: string, callId: string, patch: Partial<Extract<AgentItem, { kind: 'tool' }>>) => void>(() => {});
  const busyRef = useRef(false);
  const activeIdRefSet = (id: string) => { activeIdRef.current = id; };

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

  // 初始化：建会话、拉配置、建长连接。这是**唯一**创建初始会话的地方，
  // 保证 activeId / activeIdRef 一定被设上（否则 appendEntry 会找不到目标）。
  useEffect(() => {
    const first = newSession();
    setSessions([first]);
    setActiveId(first.id);
    activeIdRefSet(first.id);
    // 历史若在会话建好前就到了，这里补填进去
    const pending = pendingHistoryRef.current;
    if (pending) {
      pendingHistoryRef.current = null;
      setSessions([{ ...first, messages: pending.messages, title: pending.title }]);
    }
  }, []);

  const applyConfig = useCallback((next: AiConfigView) => {
    setConfig(next);
    setFormBaseUrl(next.baseUrl);
    setFormModel(next.model);
    setFormRedactIp(next.redactPrivateIp);
    setFormWhitelist((next.commandWhitelist || []).join(', '));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const client = new AiWSClient();
    client.onConfig = (next) => { if (!cancelled) applyConfig(next); };
    /**
     * 会话历史快照：重连 / 别的设备接管同一 SSH 会话时，服务端回放整段对话。
     *
     * 收到就把本地列表替换成这份历史 —— 因为对端（服务端会话）才是真相来源，
     * 本地可能压根没有这段（接管设备）或者已经过期。
     */
    client.onHistory = (entries) => {
      if (cancelled) return;
      const messages = entries.map((e, i) => historyToEntry(e, i));
      const title = deriveTitle(messages);
      /*
       * 服务端发历史时，若恰好有一条 run 正在跑，那条 record 也在这份快照里
       *（runAgent 创建 record 即入 history，边跑边填 items），特征是 final/error 都还没落。
       * 把它记成 lastAgentEntry，紧接着的 `agent_start{resumed}` 就会**接进这张卡片**继续追，
       * 而不是另起一张空卡片 —— 后者会让接管方看到两张卡：一张冻结的历史、一张空白。
       */
      const last = messages[messages.length - 1];
      lastAgentEntryRef.current =
        last && last.kind === 'agent' && !last.final && !last.error ? last.id : null;
      resumedEntryRef.current = null;
      followedTextEntryRef.current = null;
      const active = activeIdRef.current;
      if (!active) {
        // 会话还没建好（初始化 effect 尚未跑）：暂存，等它建好再填
        pendingHistoryRef.current = { messages, title };
        return;
      }
      setSessions((prev) => prev.map((s) => (s.id === active ? { ...s, messages, title } : s)));
    };
    /**
     * 重连接回一条**已在跑**的会话。
     *
     * 服务端在重连后先发 `agent_start{resumed}`，紧接着重放断开期间缓冲的事件。
     * 断线前那条 entry 通常还在（页面没刷新），直接复用它继续追加 —— 同一次会话，
     * 不做「断线前/后」的区分。只有本地已无那条 entry 时才新建一条承接。
     */
    client.onResumed = (payload) => {
      if (cancelled) return;
      const prior = lastAgentEntryRef.current;
      if (prior) {
        resumedEntryRef.current = prior;
        patchEntryRef.current(prior, { streaming: true, runStartedAt: payload.startedAt });
      } else {
        const entryId = `a-${Date.now()}`;
        resumedEntryRef.current = entryId;
        appendEntryRef.current({
          id: entryId, kind: 'agent', goal: '', items: [], prepared: null,
          streaming: true, at: payload.startedAt ?? Date.now(), runStartedAt: payload.startedAt,
        });
      }
      beginRunRef.current(payload.startedAt);
    };
    /**
     * 面板开关状态（会话级）：服务端在 ready 里带当前状态，之后别的设备切换时广播。
     * 转发给 App —— App 是「面板开在哪」的持有者，由它决定自动开/关。
     */
    client.onPanelState = (open) => {
      if (!cancelled) onPanelStateChange?.(open);
    };
    /**
     * 跟随一条**非 agent** 的 run（diagnose/draft）：只记下来，entry 等第一个 delta 再惰性创建。
     *
     * 不在 ready 里直接建 entry，是因为 ready 之后紧跟着 `ai_history` 会把消息列表整体替换，
     * 此刻建的 entry 会被冲掉。等 delta 到时历史早已落地，再建就稳了。
     */
    client.onFollowedRun = (payload) => {
      if (cancelled) return;
      followedRunRef.current = payload;
      followedTextEntryRef.current = null;
      beginRunRef.current(payload.startedAt);
    };
    client.onCleared = () => {
      if (cancelled) return;
      const active = activeIdRef.current;
      if (active) setSessions((prev) => prev.map((s) => (s.id === active ? { ...s, messages: [], title: 'New chat' } : s)));
    };
    /**
     * 被动跟随 handlers：本地没发过请求（接管 / 围观）时，属于对端 run 的
     * 回放与实时事件全走这里 —— 不装的话它们会被 client 直接丢掉，表现为
     * 「接管后没有输出，必须刷新才拿得到静态历史」。
     *
     * 用 ref 读目标 entry，不闭包捕获 state：这些回调跨渲染长期有效。
     */
    client.setPassiveHandlers({
      onPrepared: (payload) => {
        const target = resumedEntryRef.current;
        if (target) patchEntryRef.current(target, { prepared: payload });
      },
      onDelta: (chunk) => {
        const followed = followedRunRef.current;
        if (!followed) return;
        let target = followedTextEntryRef.current;
        if (!target) {
          target = `t-${Date.now()}`;
          followedTextEntryRef.current = target;
          appendEntryRef.current({ id: target, kind: 'text', answer: '', streaming: true, at: followed.startedAt ?? Date.now() });
        }
        // 增量累在 entry.answer 上；patchEntry 是浅合并，先读旧值再拼
        setSessions((prev) => prev.map((s) => {
          if (s.id !== activeIdRef.current) return s;
          return {
            ...s,
            messages: s.messages.map((m) => {
              if (m.id !== target || m.kind !== 'text') return m;
              return { ...m, answer: (m.answer || '') + chunk };
            }),
          };
        }));
      },
      onDone: (meta) => {
        const target = followedTextEntryRef.current;
        followedRunRef.current = null;
        followedTextEntryRef.current = null;
        if (target) patchEntryRef.current(target, { meta, streaming: false });
        endRunRef.current();
      },
      onDraft: (draft, meta) => {
        const target = followedTextEntryRef.current;
        followedRunRef.current = null;
        followedTextEntryRef.current = null;
        // 跟随 draft 时 entry 是以 text 形态惰性建的（delta 流的是原始 JSON），
        // 结构化结果到达后连 kind 一起改成 draft，渲染器才会切成命令卡片。
        if (target && draft) patchEntryRef.current(target, { kind: 'draft', draft, meta } as Partial<ChatEntry>);
        endRunRef.current();
      },
      onError: (msg, aborted) => {
        const target = followedTextEntryRef.current;
        followedRunRef.current = null;
        followedTextEntryRef.current = null;
        if (target) patchEntryRef.current(target, { error: msg, aborted, streaming: false });
        endRunRef.current();
      },
      onAgentStart: () => {
        // entry 的创建/认回由 onResumed 负责，这里只确保运行态
        beginRunRef.current();
      },
      onAgentIdentity: (identity) => {
        const target = resumedEntryRef.current;
        if (target) patchEntryRef.current(target, { identity });
      },
      onAgentStep: (step) => setRunStep(step),
      onAgentMessage: (content) => {
        if (!content.trim()) return;
        const target = resumedEntryRef.current;
        if (!target) return;
        appendAgentItemRef.current(target, { kind: 'message', key: `msg-${Date.now()}-${Math.random()}`, text: content });
      },
      onAgentToolCall: (call) => {
        const target = resumedEntryRef.current;
        if (!target) return;
        appendAgentItemRef.current(target, {
          kind: 'tool', key: call.callId, callId: call.callId, tool: call.tool, display: call.display, status: 'running',
        });
      },
      onAgentToolResult: (result) => {
        const target = resumedEntryRef.current;
        if (!target) return;
        patchAgentItemRef.current(target, result.callId, { status: 'done', output: result.output, truncated: result.truncated });
      },
      onAgentToolApproved: (payload) => {
        const target = resumedEntryRef.current;
        if (!target) return;
        patchAgentItemRef.current(target, payload.callId, { status: 'auto' });
      },
      onAgentApproval: (request) => new Promise<{ allow: boolean; remember: boolean }>((resolve) => {
        const target = resumedEntryRef.current;
        if (!target) { resolve({ allow: false, remember: false }); return; }
        approvalRef.current = (allow, remember) => { approvalRef.current = null; resolve({ allow, remember }); };
        const id = activeIdRef.current;
        setSessions((prev) => prev.map((s) => {
          if (s.id !== id) return s;
          return {
            ...s,
            messages: s.messages.map((m) => {
              if (m.id !== target || m.kind !== 'agent') return m;
              return { ...m, items: m.items.map((it) => (it.kind === 'tool' && it.callId === request.callId ? { ...it, status: 'awaiting', level: request.level, reasons: request.reasons, dangerous: request.dangerous, canRemember: request.canRemember } : it)) };
            }),
          };
        }));
      }),
      onAgentDone: (payload) => {
        const target = resumedEntryRef.current;
        resumedEntryRef.current = null;
        lastAgentEntryRef.current = null;
        if (target) patchEntryRef.current(target, {
          final: payload.answer, stopReason: payload.stopReason, steps: payload.steps, streaming: false,
          meta: { ms: payload.ms },
        });
        endRunRef.current();
      },
      onAgentError: (msg, aborted) => {
        const target = resumedEntryRef.current;
        resumedEntryRef.current = null;
        lastAgentEntryRef.current = null;
        if (target) patchEntryRef.current(target, { error: msg, aborted, streaming: false });
        endRunRef.current();
      },
    });
    // 绑定当前 tab 的 SSH 会话：/ai 连接据此 attach 到对应 AI 会话，
    // 服务端断连期间继续跑、缓冲事件，这里重连后自动接回（同一条会话）。
    client.setSession(sessionId);
    clientRef.current = client;

    fetchAiConfig()
      .then((next) => { if (!cancelled) applyConfig(next); })
      .catch((err) => { if (!cancelled) setConfigError(err.message || 'Failed to load config'); });

    // 本组件挂载 = 面板打开：连上后上报（服务端广播给其它设备）。
    // 断开时在 cleanup 上报 close —— 但要注意仅当连接已建立，否则发不出去也无所谓。
    const reportOpen = () => client.setPanelOpen(true);
    if (client.isOpen()) reportOpen();
    else void client.connect().then(reportOpen).catch(() => {});

    return () => {
      cancelled = true;
      // 注意：卸载**不**上报 close。终端断开会被动卸载面板，那不代表用户想关；
      // 服务端保留 panelOpen，重连后据此自动恢复。用户主动关闭走 handleClose。
      client.close();
      clientRef.current = null;
    };
  }, [applyConfig]);

  // 会话切换（重连/新开）时把绑定更新到新 sessionId
  useEffect(() => {
    clientRef.current?.setSession(sessionId);
  }, [sessionId]);

  const activeSession = sessions.find((s) => s.id === activeId) ?? sessions[0];

  /* ----------------- 会话级消息写入 ----------------- */

  const appendEntry = useCallback((entry: ChatEntry) => {
    const id = activeIdRef.current;
    setSessions((prev) => prev.map((s) =>
      s.id === id ? { ...s, messages: [...s.messages, entry] } : s,
    ));
  }, []);
  appendEntryRef.current = appendEntry;
  beginRunRef.current = beginRun;
  endRunRef.current = endRun;

  const patchEntry = useCallback((entryId: string, patch: Partial<ChatEntry>) => {
    const id = activeIdRef.current;
    setSessions((prev) => prev.map((s) =>
      s.id === id ? { ...s, messages: s.messages.map((m) => (m.id === entryId ? { ...m, ...patch } as ChatEntry : m)) } : s,
    ));
  }, []);
  patchEntryRef.current = patchEntry;

  const patchAgentItem = useCallback((entryId: string, callId: string, patch: Partial<Extract<AgentItem, { kind: 'tool' }>>) => {
    const id = activeIdRef.current;
    setSessions((prev) => prev.map((s) => {
      if (s.id !== id) return s;
      return {
        ...s,
        messages: s.messages.map((m) => {
          if (m.id !== entryId || m.kind !== 'agent') return m;
          return { ...m, items: m.items.map((it) => (it.kind === 'tool' && it.callId === callId ? { ...it, ...patch } : it)) };
        }),
      };
    }));
  }, []);

  const appendAgentItem = useCallback((entryId: string, item: AgentItem) => {
    const id = activeIdRef.current;
    setSessions((prev) => prev.map((s) => {
      if (s.id !== id) return s;
      return {
        ...s,
        messages: s.messages.map((m) => {
          if (m.id !== entryId || m.kind !== 'agent') return m;
          return { ...m, items: [...m.items, item] };
        }),
      };
    }));
  }, []);
  patchAgentItemRef.current = patchAgentItem;
  appendAgentItemRef.current = appendAgentItem;

  const setSessionTitleFromText = useCallback((entryId: string, text: string) => {
    const id = activeIdRef.current;
    setSessions((prev) => prev.map((s) => {
      if (s.id !== id || s.title !== 'New chat') return s;
      const title = text.trim().slice(0, 40) || 'New chat';
      return { ...s, title };
    }));
  }, []);

  /**
   * 把当前会话里**之前的**问答整理成模型可读的历史，让新一轮 Agent 延续上下文。
   * 只取文字：用户提问、文本回答、Agent 的结论与中间消息、draft 的命令与说明。
   * 不重放工具调用结果 —— 那些必须来自本次会话实测，否则模型会把过期输出当事实。
   */
  const buildHistory = useCallback((): ChatMessage[] => {
    const id = activeIdRef.current;
    const session = sessions.find((s) => s.id === id);
    if (!session) return [];
    const out: ChatMessage[] = [];
    for (const m of session.messages) {
      if (m.id.startsWith('a-') || m.id.startsWith('t-')) {
        // 跳过当前正在生成的那条（它的内容还没定型）
        if (m.streaming) continue;
      }
      if (m.kind === 'user') out.push({ role: 'user', content: m.text });
      else if (m.kind === 'text' && m.answer) out.push({ role: 'assistant', content: m.answer });
      else if (m.kind === 'draft') out.push({ role: 'assistant', content: `${m.draft.command}\n${m.draft.explain || ''}`.trim() });
      else if (m.kind === 'agent') {
        if (m.goal) out.push({ role: 'user', content: m.goal });
        for (const it of m.items) {
          if (it.kind === 'message') out.push({ role: 'assistant', content: it.text });
        }
        if (m.final) out.push({ role: 'assistant', content: m.final });
      }
    }
    return out;
  }, [sessions]);

  /* ----------------- 发送一条消息 ----------------- */

  const stopRun = useCallback(() => {
    agentRunIdRef.current += 1;
    const resolve = approvalRef.current;
    approvalRef.current = null;
    resolve?.(false, false);
    clientRef.current?.cancel();
    setBusy(false);
    busyRef.current = false;
  }, []);

  /**
   * 终端断开 → **本地**停掉正在跑的 Agent 的 UI 状态，但**不向服务端发 cancel**。
   *
   * 断开有两种：网络抖动（会话还在）和被别的设备接管（会话易主）。
   * 两种都不该由这里发 cancel：
   *  - 网络抖动：服务端 run 本来就要继续跑、输出进缓冲，cancel 会把它误杀；
   *  - 被接管：会话已归别人，cancel 会杀掉**接管方**正在跑的 run。
   * 真正的停止只能由用户点 Stop（那才走 stopRun → client.cancel）。
   * 这里只把本地 busy/审批闸收掉，避免 UI 停在「等待审批」的假象。
   */
  useEffect(() => {
    if (terminalConnected || !busyRef.current) return;
    agentRunIdRef.current += 1;
    const resolve = approvalRef.current;
    approvalRef.current = null;
    resolve?.(false, false);
    setBusy(false);
    busyRef.current = false;
  }, [terminalConnected]);

  const clearActiveSession = useCallback(() => {
    const id = activeIdRef.current;
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, messages: [], title: 'New chat' } : s)));
    // 服务端也存着这条会话的历史（供接管设备重建），不清的话下次挂载又会被回放回来
    clientRef.current?.clearHistory();
  }, []);

  const sendMessage = useCallback((rawText: string) => {
    const text = rawText.trim();
    if (!text) return;

    // `/clear` 清掉当前会话的全部上下文（对话历史 + 标题），不发给模型
    if (text === '/clear') {
      if (busyRef.current) stopRun();
      clearActiveSession();
      setInput('');
      return;
    }

    if (busyRef.current) return;

    const withScreen = includeScreen;
    const ctx = withScreen ? (getContext?.() ?? null) : null;
    const textToSend = ctx?.text ?? '';
    const sourceToSend = ctx?.source ?? 'tail';

    const userEntry: ChatUserEntry = { id: `u-${Date.now()}`, kind: 'user', text, withScreen, at: Date.now() };
    appendEntry(userEntry);
    setSessionTitleFromText(userEntry.id, text);
    setInput('');
    beginRun();

    const client = clientRef.current;
    if (!client) { endRun(); return; }

    // 没有活跃会话 → 只读诊断；有会话 → Agent（它涵盖只读解读与命令执行）
    const useAgent = Boolean(sessionId && terminalConnected);

    if (!useAgent) {
      const entryId = `t-${Date.now()}`;
      let acc = '';
      // 本机发起 = owned，跟随态一律让位，避免被动 handlers 又往同一 entry 里塞
      followedRunRef.current = null;
      followedTextEntryRef.current = null;
      appendEntry({ id: entryId, kind: 'text', answer: '', streaming: true, at: Date.now() });
      client.diagnose(
        { text: textToSend, source: sourceToSend, question: text, host: target?.host, username: target?.username, cwd: target?.cwd },
        {
          onPrepared: (payload) => patchEntry(entryId, { prepared: payload }),
          onDelta: (chunk) => { acc += chunk; patchEntry(entryId, { answer: acc }); },
          onDone: (meta) => { patchEntry(entryId, { meta, streaming: false }); endRun(); },
          onError: (msg, aborted) => {
            patchEntry(entryId, { error: msg, aborted, streaming: false });
            endRun();
          },
        },
      ).catch((err: any) => {
        patchEntry(entryId, { error: err?.message || 'Request failed', streaming: false });
        endRun();
      });
      return;
    }

    // Agent 路径
    const runId = ++agentRunIdRef.current;
    const alive = () => agentRunIdRef.current === runId;
    approvalRef.current = null;

    const history = buildHistory();

    const entryId = `a-${Date.now()}`;
    appendEntry({ id: entryId, kind: 'agent', goal: text, items: [], prepared: null, streaming: true, at: Date.now() });
    lastAgentEntryRef.current = entryId;
    resumedEntryRef.current = null;
    followedRunRef.current = null;
    followedTextEntryRef.current = null;

    client.agent(
      { text: textToSend, source: sourceToSend, question: text, host: target?.host, username: target?.username, cwd: target?.cwd },
      { sessionId: sessionId!, maxSteps, history },
      {
        onPrepared: (payload) => { if (alive()) patchEntry(entryId, { prepared: payload }); },
        onAgentIdentity: (identity) => { if (alive()) patchEntry(entryId, { identity }); },
        onAgentStep: (step) => { if (alive()) setRunStep(step); },
        onAgentMessage: (content) => {
          if (!content.trim()) return;
          const target = resumedEntryRef.current ?? entryId;
          if (!alive() && !resumedEntryRef.current) return;
          appendAgentItem(target, { kind: 'message', key: `msg-${Date.now()}-${Math.random()}`, text: content });
        },
        onAgentToolCall: (call) => {
          const target = resumedEntryRef.current ?? entryId;
          if (!alive() && !resumedEntryRef.current) return;
          appendAgentItem(target, { kind: 'tool', key: call.callId, callId: call.callId, tool: call.tool, display: call.display, status: 'running' });
        },
        onAgentToolResult: (result) => {
          const target = resumedEntryRef.current ?? entryId;
          if (!alive() && !resumedEntryRef.current) return;
          patchAgentItem(target, result.callId, { status: 'done', output: result.output, truncated: result.truncated });
        },
        onAgentToolApproved: (payload) => {
          const target = resumedEntryRef.current ?? entryId;
          if (!alive() && !resumedEntryRef.current) return;
          patchAgentItem(target, payload.callId, { status: 'auto' });
        },
        onAgentApproval: (request: AiAgentApproval) => new Promise<{ allow: boolean; remember: boolean }>((resolve) => {
          const target = resumedEntryRef.current ?? entryId;
          if (!alive() && !resumedEntryRef.current) { resolve({ allow: false, remember: false }); return; }
          approvalRef.current = (allow, remember) => { approvalRef.current = null; resolve({ allow, remember }); };
          const id = activeIdRef.current;
          setSessions((prev) => prev.map((s) => {
            if (s.id !== id) return s;
            return {
              ...s,
              messages: s.messages.map((m) => {
                if (m.id !== target || m.kind !== 'agent') return m;
                return { ...m, items: m.items.map((it) => (it.kind === 'tool' && it.callId === request.callId ? { ...it, status: 'awaiting', level: request.level, reasons: request.reasons, dangerous: request.dangerous, canRemember: request.canRemember } : it)) };
              }),
            };
          }));
        }),
        onAgentDone: (payload) => {
          const target = resumedEntryRef.current ?? entryId;
          if (!alive() && !resumedEntryRef.current) return;
          resumedEntryRef.current = null;
          lastAgentEntryRef.current = null;
          patchEntry(target, {
            final: payload.answer, stopReason: payload.stopReason, steps: payload.steps, streaming: false,
            meta: { ms: payload.ms },
          });
          endRun();
        },
        onAgentError: (msg, aborted) => {
          const target = resumedEntryRef.current ?? entryId;
          if (!alive() && !resumedEntryRef.current) return;
          resumedEntryRef.current = null;
          lastAgentEntryRef.current = null;
          patchEntry(target, { error: msg, aborted, streaming: false });
          endRun();
        },
      },
    ).catch((err: any) => {
      if (!alive()) return;
      patchEntry(entryId, { error: err?.message || 'Agent failed to start', streaming: false });
      endRun();
    });
  }, [appendEntry, appendAgentItem, includeScreen, getContext, target?.host, target?.username, target?.cwd, sessionId, terminalConnected, patchEntry, patchAgentItem, setSessionTitleFromText, buildHistory, clearActiveSession, stopRun, maxSteps]);

  /* ----------------- draft 命令执行 ----------------- */

  const dispatchCommand = useCallback((entry: ChatDraftEntry, submit: boolean) => {
    if (!onRunCommand) return;
    const ok = onRunCommand(entry.draft.command, submit);
    setRunNotice(ok ? (submit ? 'Sent to terminal' : 'Filled in — press Enter to run') : 'Terminal offline, nothing sent');
  }, [onRunCommand]);

  const handleRunClick = (entry: ChatDraftEntry) => {
    if (entry.draft.grade.level === 'dangerous') {
      setConfirmRun({ sessionId: activeId, entryId: entry.id });
      return;
    }
    dispatchCommand(entry, true);
  };

  /* ----------------- 配置保存 / 测试 ----------------- */

  const handleSave = async () => {
    setSaving(true);
    setTestResult(null);
    try {
      const next = await saveAiConfig(
        { baseUrl: formBaseUrl, model: formModel, redactPrivateIp: formRedactIp, commandWhitelist: formWhitelist.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) },
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

  const handleCopyEntry = useCallback((entryId: string, text: string) => {
    copyText(text, () => {
      setCopiedId(entryId);
      window.setTimeout(() => setCopiedId((prev) => (prev === entryId ? null : prev)), 1600);
    });
  }, []);

  /* ----------------- 滚动 ----------------- */

  const stickToBottomRef = useRef(true);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [sessions, activeId]);

  const handleScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  const stickToBottomNow = () => {
    stickToBottomRef.current = true;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    if (busy && busyStartRef.current) {
      const tick = () => setRunElapsedMs(Date.now() - busyStartRef.current!);
      tick();
      const id = window.setInterval(tick, 500);
      return () => window.clearInterval(id);
    }
    // busy 结束：停表并归零
    busyStartRef.current = null;
    setRunElapsedMs(0);
    setRunStep(0);
    return undefined;
  }, [busy]);

  // 从设置视图切回对话时，滚到最底（最新消息）
  useEffect(() => {
    if (!showSettings) stickToBottomNow();
  }, [showSettings]);

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

  return (
    <div className={`h-full w-full flex flex-col overflow-hidden border-l text-[11px] sm:text-xs ${palette.panel}`}>
      {/* 头部 */}
      <div className={`flex items-center justify-between gap-2 px-2 py-1.5 sm:px-3 sm:py-2 border-b shrink-0 ${palette.header}`}>
        <div className="flex items-center gap-1.5 min-w-0">
          <Sparkles className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
          <span className="text-[11px] sm:text-xs font-medium truncate">AI</span>
          {config?.ready && <span className={`text-[10px] font-mono truncate max-w-28 sm:max-w-none ${palette.subtle}`}>{config.model}</span>}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setShowSettings((prev) => !prev)} className={`p-1.5 sm:p-1 rounded-md cursor-pointer ${showSettings ? palette.primary : palette.button}`} title="Settings">
            <Settings2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => { clientRef.current?.setPanelOpen(false); onClose(); }}
            className={`p-1.5 sm:p-1 rounded-md cursor-pointer ${palette.button}`}
            title="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 单会话：显示当前对话标题 + 清空。多 chat 已移除（服务端按 SSH 会话只存一条） */}
      {!showSettings && (
      <div className={`flex items-center gap-1.5 px-2 py-1 border-b shrink-0 ${palette.header}`}>
        <span className={`flex-1 min-w-0 truncate text-[10px] font-mono ${palette.subtle}`} title={activeSession?.title || 'New chat'}>
          {activeSession?.title || 'New chat'}
        </span>
        <button
          onClick={() => { if (busyRef.current) stopRun(); clearActiveSession(); }}
          className={`p-1 min-w-[26px] min-h-[26px] sm:min-w-[30px] sm:min-h-[30px] flex items-center justify-center rounded-md border cursor-pointer shrink-0 ${palette.button}`}
          title="Clear conversation"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
      )}

      {/* 滚动容器：全局 body 是 touch-action:none（防终端手势冲突），
          这里必须显式恢复 pan-y，否则移动端历史列表滑不动。 */}
      <div
        ref={bodyRef}
        onScroll={handleScroll}
        style={{ touchAction: 'pan-y', overscrollBehavior: 'contain' }}
        className="thin-scrollbar flex-1 min-h-0 overflow-y-auto px-2 py-1.5 sm:px-3 sm:py-2 space-y-2 sm:space-y-3"
      >
        {!showSettings && (
          <>
            {configError && (
              <div className="flex items-start gap-2 text-rose-500">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{configError}</span>
              </div>
            )}

            {!config?.ready && (
              <p className={`text-[10px] leading-relaxed ${palette.subtle}`}>
                Add a model endpoint in Settings to start. No key is sent anywhere except your configured provider.
              </p>
            )}

            {config?.ready && !activeSession?.messages.length && (
              <div className="space-y-2">
                <p className={`text-[10px] leading-relaxed ${palette.subtle}`}>
                  {sessionId && terminalConnected ? 'Describe what broke or what you want done — risky steps ask first.' : 'Ask about the terminal output — read-only until a terminal is connected.'}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {EMPTY_PROMPTS.map((p) => (
                    <button key={p} onClick={() => sendMessage(p)} disabled={busy} className={`${buttonClass} ${palette.button}`}>
                      <span>{p}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 对话流 */}
            {activeSession?.messages.map((entry) => (
              <ChatEntryView
                key={entry.id}
                entry={entry}
                risk={risk}
                palette={palette}
                copiedId={copiedId}
                includeScreenDefault={includeScreen}
                onRun={(e) => handleRunClick(e as ChatDraftEntry)}
                onFill={(e) => dispatchCommand(e as ChatDraftEntry, false)}
                onCopyEntry={(id, text) => handleCopyEntry(id, text)}
                onApprove={(e, allow, remember) => {
                  // 乐观更新：先落状态再等服务端，避免点完按钮还挂在「等待审批」。
                  const item = e as unknown as Extract<AgentItem, { kind: 'tool' }>;
                  const target = resumedEntryRef.current ?? lastAgentEntryRef.current;
                  if (target && item.callId) {
                    patchAgentItemRef.current(target, item.callId, {
                      status: allow ? (remember && item.canRemember ? 'auto' : 'running') : 'denied',
                    });
                  }
                  const resolve = approvalRef.current;
                  approvalRef.current = null;
                  resolve?.(allow, remember);
                }}
              />
            ))}

            {lastRunNotice && <div className={`text-[10px] leading-relaxed ${palette.subtle}`}>{lastRunNotice}</div>}
          </>
        )}

        {/* 设置视图：切换 tab 的形式，独立于对话流 */}
        {showSettings && (
          <>
            {/* 未配置时的提示，已配置时由表单内 Save 处理 */}
            <div className={`rounded-md border p-2 sm:p-2.5 space-y-3 text-[12px] sm:text-[11px] leading-snug ${palette.card}`}>
              <div className="space-y-1.5">
                <div className={`text-[10px] font-semibold uppercase tracking-wider ${palette.subtle}`}>Model</div>
                <label className="block space-y-1">
                  <span className="font-medium">Base URL</span>
                  <input value={formBaseUrl} onChange={(e) => setFormBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" spellCheck={false} autoCapitalize="off" autoCorrect="off" className={`h-9 sm:h-[30px] w-full rounded-md border px-2 text-[16px] sm:text-[11px] leading-tight font-mono focus:outline-none ${palette.input}`} />
                </label>
                <label className="block space-y-1">
                  <span className="font-medium">Model</span>
                  <input value={formModel} onChange={(e) => setFormModel(e.target.value)} placeholder="gpt-4o-mini" spellCheck={false} autoCapitalize="off" autoCorrect="off" className={`h-9 sm:h-[30px] w-full rounded-md border px-2 text-[16px] sm:text-[11px] leading-tight font-mono focus:outline-none ${palette.input}`} />
                </label>
                <label className="block space-y-1">
                  <span className="font-medium">API Key</span>
                  <input type="password" value={formApiKey} onChange={(e) => setFormApiKey(e.target.value)} disabled={config?.keyFromEnv} placeholder={config?.keyFromEnv ? 'from env' : config?.hasKey ? 'saved' : 'optional'} autoComplete="off" className={`h-9 sm:h-[30px] w-full rounded-md border px-2 text-[16px] sm:text-[11px] leading-tight font-mono focus:outline-none disabled:opacity-50 ${palette.input}`} />
                </label>
              </div>
              <div className="space-y-1.5 border-t pt-2 border-inherit">
                <div className={`text-[10px] font-semibold uppercase tracking-wider ${palette.subtle}`}>Behavior</div>
                <label className="flex items-center gap-2 min-h-[36px] sm:min-h-[30px]">
                  <input type="checkbox" checked={formRedactIp} onChange={(e) => setFormRedactIp(e.target.checked)} className="w-4 h-4 shrink-0" />
                  <span>Redact private IPs</span>
                </label>
                <label className="block space-y-1">
                  <span className="font-medium">Auto-run allowlist</span>
                  <input value={formWhitelist} onChange={(e) => setFormWhitelist(e.target.value)} placeholder="myctl, deploy" spellCheck={false} autoCapitalize="off" autoCorrect="off" className={`h-9 sm:h-[30px] w-full rounded-md border px-2 text-[16px] sm:text-[11px] leading-tight font-mono focus:outline-none ${palette.input}`} />
                </label>
              </div>
              <div className="space-y-1.5 border-t pt-2 border-inherit">
                <div className={`text-[10px] font-semibold uppercase tracking-wider ${palette.subtle}`}>Agent</div>
                <label className="flex items-center gap-1.5">
                  <select
                    value={maxSteps}
                    onChange={(e) => changeMaxSteps(Number(e.target.value))}
                    disabled={busy}
                    className={`h-9 sm:h-[30px] rounded-md border px-1.5 text-[16px] sm:text-[11px] font-mono focus:outline-none disabled:opacity-50 ${palette.input}`}
                  >
                    {[5, 10, 20, 30, 50].map((n) => (
                      <option key={n} value={n}>max {n} steps</option>
                    ))}
                  </select>
                  <span className={`text-[10px] ${palette.subtle}`}>per request</span>
                </label>
              </div>
              <div className="flex items-center gap-1.5">
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
                <div className={`text-[11px] leading-snug break-words ${testResult.ok ? 'text-emerald-500' : 'text-rose-500'}`}>
                  {testResult.ok ? 'Connected' : testResult.message}
                  {testResult.ok && testResult.message ? ` (${testResult.message})` : ''}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* 底部输入：设置视图下不显示，单行：Screen 开关 + 输入 + 发送 */}
      {!showSettings && (
      <div className={`border-t px-2 py-1.5 sm:px-3 sm:py-2 space-y-1 shrink-0 ${palette.header}`}>
        {busy && (
          <div className="flex items-center gap-1.5">
            <span className={`text-[10px] font-mono truncate ${palette.subtle}`}>
              {formatElapsed(runElapsedMs)}{runStep > 0 ? ` · ${runStep}/${maxSteps}` : ''}
              {/* 只有真有工具卡在 awaiting 时才提示 approval —— 之前只要有 agent 在 streaming
                  就显示，正常跑动中也会误报，用户以为一直在等审批。 */}
              {activeSession?.messages.some((m) => m.kind === 'agent' && m.items.some((it) => it.kind === 'tool' && it.status === 'awaiting'))
                ? ' · waiting approval'
                : ' · …'}
            </span>
          </div>
        )}

        <div className="flex items-stretch gap-1.5">
          <button
            onClick={() => setIncludeScreen((prev) => !prev)}
            className={`${buttonClass} shrink-0 !px-1.5 justify-center ${includeScreen
              ? isLight ? 'bg-slate-200 border-slate-300 text-slate-700' : 'bg-slate-700 border-slate-600 text-slate-100'
              : palette.button}`}
            title={includeScreen ? 'Screen on — terminal screen is sent with your message' : 'Screen off — only your message is sent'}
          >
            <Monitor className="w-3.5 h-3.5" />
          </button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={stickToBottomNow}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); sendMessage(input); } }}
            disabled={busy || !config?.ready}
            rows={1}
            placeholder={sessionId && terminalConnected ? 'Ask or tell it what to do…' : 'Ask about the terminal…'}
            className={`flex-1 min-w-0 rounded-md border px-2 py-1 text-[11px] leading-[18px] focus:outline-none disabled:opacity-50 resize-none max-h-24 ${palette.input}`}
          />
          {busy ? (
            <button
              onClick={stopRun}
              className={`${buttonClass} ${palette.danger} shrink-0 !px-0 w-[30px] justify-center`}
              title="Stop"
            >
              <Square className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || !config?.ready}
              className={`${buttonClass} ${palette.primary} shrink-0 !px-0 w-[30px] justify-center`}
              title="Send"
            >
              <Play className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {!(terminalConnected && sessionId) && config?.ready && (
          <div className={`text-[10px] ${palette.subtle}`}>No live terminal — read-only answers only. Connect a terminal to let the agent run steps.</div>
        )}
      </div>
      )}

      {/* 高风险命令二次确认 */}
      <ConfirmDialog
        isOpen={Boolean(confirmRun)}
        theme={theme}
        title="Run high-risk command?"
        confirmLabel="Run anyway"
        cancelLabel="Cancel"
        message={
          <span className="block space-y-1.5">
            <span className="block">The server graded this command as high risk. It may be irreversible:</span>
            {(() => {
              const e = sessions.find((s) => s.id === confirmRun?.sessionId)?.messages.find((m) => m.id === confirmRun?.entryId);
              if (e && e.kind === 'draft') {
                return (
                  <span className="block">
                    {e.draft.grade.reasons.map((reason) => (<span key={reason} className="block">· {reason}</span>))}
                    <code className="block mt-1 rounded bg-black/10 px-2 py-1 font-mono text-[11px] break-all whitespace-pre-wrap">{e.draft.command}</code>
                  </span>
                );
              }
              return null;
            })()}
          </span>
        }
        onConfirm={() => {
          const e = sessions.find((s) => s.id === confirmRun?.sessionId)?.messages.find((m) => m.id === confirmRun?.entryId);
          setConfirmRun(null);
          if (e && e.kind === 'draft') dispatchCommand(e, true);
        }}
        onCancel={() => setConfirmRun(null)}
      />
    </div>
  );
};

/* ----------------------------- 消息渲染 ----------------------------- */

const PreparedBlock: React.FC<{ prepared: PreparedView | null | undefined; risk: any; palette: Palette }> = ({ prepared, risk, palette }) => {
  if (!prepared) return null;
  const redactions = prepared.stats.redactionTotal ? redactionSummary(prepared.stats) : '';
  const [open, setOpen] = useState(false);
  return (
    <div className={`rounded border ${palette.card}`}>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-1.5 px-2.5 py-2 text-left cursor-pointer">
        {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
        <span className="font-medium shrink-0">Sent</span>
        <span className={`text-[10px] font-mono truncate ${palette.subtle}`}>
          {prepared.stats.rawLines > 0 ? `${prepared.stats.rawLines}→${prepared.stats.lines} lines · ~${prepared.stats.estTokens} tokens` : 'no terminal content'}
          {prepared.stats.redactionTotal ? ` · ${prepared.stats.redactionTotal} redacted` : ''}
        </span>
      </button>
      {open && (
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
            <pre className={`max-h-56 overflow-auto rounded border p-2 text-[10px] leading-relaxed font-mono whitespace-pre-wrap break-all ${palette.code}`}>{prepared.text}</pre>
          ) : (
            <p className={`text-[10px] leading-relaxed ${palette.subtle}`}>No terminal content. Only your request, host and user are sent.</p>
          )}
        </div>
      )}
    </div>
  );
};

const ChatEntryView: React.FC<{
  entry: ChatEntry;
  risk: Record<AiRiskLevel, { badge: string; border: string; text: string }>;
  palette: Palette;
  copiedId: string | null;
  includeScreenDefault: boolean;
  onRun: (e: ChatDraftEntry) => void;
  onFill: (e: ChatDraftEntry) => void;
  onCopyEntry: (id: string, text: string) => void;
  onApprove: (e: ChatDraftEntry, allow: boolean, remember: boolean) => void;
}> = ({ entry, risk, palette, copiedId, onRun, onFill, onCopyEntry, onApprove }) => {
  const copyBtn = (id: string, text: string) => (
    <button onClick={() => onCopyEntry(id, text)} className={`${buttonClass} ${palette.button}`} title="Copy">
      {copiedId === id ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
      <span>{copiedId === id ? 'Copied' : 'Copy'}</span>
    </button>
  );
  if (entry.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className={`max-w-[88%] rounded-lg border px-2 py-1 sm:px-2.5 sm:py-1.5 ${palette.primary} text-white`}>
          <div className="whitespace-pre-wrap break-words leading-snug sm:leading-relaxed">{entry.text}</div>
          <div className="text-[9px] opacity-70 mt-0.5">
            {entry.withScreen ? 'with screen' : 'no screen'}{entry.at ? ` · ${formatClock(entry.at)}` : ''}
          </div>
        </div>
      </div>
    );
  }

  if (entry.kind === 'text') {
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-end"><StartedAt at={entry.at} palette={palette} /></div>
        <PreparedBlock prepared={entry.prepared} risk={risk} palette={palette} />
        {entry.streaming && !entry.answer && (
          <div className="flex items-center gap-1.5 text-[11px]"><Loader2 className="w-3 h-3 animate-spin text-indigo-500" /><span className={palette.subtle}>Thinking…</span></div>
        )}
        {entry.answer && <div className="leading-relaxed whitespace-pre-wrap break-words">{entry.answer}</div>}
        {entry.error && (
          <div className={`flex items-start gap-2 ${entry.aborted ? palette.subtle : 'text-rose-500'}`}>
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span className="leading-relaxed">{entry.error}</span>
          </div>
        )}
        {(entry.answer || entry.meta) && (
          <div className="flex items-center gap-2 flex-wrap">
            {entry.answer && copyBtn(entry.id, entry.answer)}
            {entry.meta && (
              <span className={`text-[10px] font-mono ${palette.subtle}`}>
                {entry.meta.ms !== undefined ? `${entry.meta.ms}ms · ` : ''}{`${entry.meta.chars || 0} chars`}
                {entry.meta.usage?.total_tokens ? ` · ${entry.meta.usage.total_tokens} tokens` : ''}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  if (entry.kind === 'draft') {
    const d = entry.draft;
    return (
      <div className="space-y-1.5 sm:space-y-2">
        <div className="flex items-center justify-end"><StartedAt at={entry.at} palette={palette} /></div>
        <PreparedBlock prepared={entry.prepared} risk={risk} palette={palette} />
        <div className={`rounded-md border space-y-1.5 sm:space-y-2 p-1.5 sm:p-2.5 ${risk[d.grade.level].border}`}>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${risk[d.grade.level].badge}`}>{RISK_LABEL[d.grade.level]}</span>
            <span className={`text-[10px] font-mono ${palette.subtle}`}>server grade</span>
            {d.selfRisk && d.selfRisk !== d.grade.level && (
              <span className={`text-[10px] font-mono ${risk[d.selfRisk].text}`}>model said {RISK_LABEL[d.selfRisk]} (overridden)</span>
            )}
          </div>
          {d.explain && <p className="leading-snug sm:leading-relaxed">{d.explain}</p>}
          <pre className={`max-h-40 overflow-auto rounded-md border p-1.5 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-all ${palette.code}`}>{d.command}</pre>
          {d.grade.reasons.length > 0 && (
            <ul className={`space-y-0.5 ${risk[d.grade.level].text}`}>
              {d.grade.reasons.map((reason) => (<li key={reason} className="flex items-start gap-1.5"><ShieldAlert className="w-3 h-3 mt-0.5 shrink-0" /><span>{reason}</span></li>))}
            </ul>
          )}
          {entry.error && (
            <div className="flex items-start gap-2 text-rose-500">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span className="leading-relaxed">{entry.error}</span>
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => onFill(entry)} disabled={!d} className={`${buttonClass} ${palette.button}`}><CornerDownLeft className="w-3 h-3" /><span>Fill</span></button>
            <button onClick={() => onRun(entry)} className={`${buttonClass} ${d.grade.level === 'dangerous' ? palette.danger : palette.primary}`}><Play className="w-3 h-3" /><span>Run</span></button>
            {copyBtn(entry.id, d.command)}
          </div>
          {entry.meta && (
            <div className={`text-[10px] font-mono ${palette.subtle}`}>
              {entry.meta.ms !== undefined ? `${entry.meta.ms}ms · ` : ''}{`${entry.meta.chars || 0} chars`}
              {entry.meta.usage?.total_tokens ? ` · ${entry.meta.usage.total_tokens} tokens` : ''}
            </div>
          )}
        </div>
      </div>
    );
  }

  // agent
  return (
    <div className="space-y-1.5 sm:space-y-2">
      <div className="flex items-center justify-end gap-2">
        <StartedAt
          at={entry.at ?? entry.runStartedAt}
          palette={palette}
          extra={!entry.streaming && entry.meta?.ms !== undefined ? `took ${formatElapsed(entry.meta.ms)}` : undefined}
        />
      </div>
      <PreparedBlock prepared={entry.prepared} risk={risk} palette={palette} />
      {entry.identity && entry.identity.user && (
        <div className={`text-[10px] font-mono ${palette.subtle}`}>
          {`remote user: ${entry.identity.user}${entry.identity.isRoot ? ' (root)' : ''}`}
        </div>
      )}
      {entry.items.map((item) =>
        item.kind === 'message' ? (
          <p key={item.key} className="leading-relaxed whitespace-pre-wrap break-words">{item.text}</p>
        ) : (
          <AgentItemRow
            key={item.key}
            item={item}
            risk={risk}
            palette={palette}
            onAllow={() => onApprove(item as ChatDraftEntry, true, false)}
            onAllowSession={() => onApprove(item as ChatDraftEntry, true, true)}
            onDeny={() => onApprove(item as ChatDraftEntry, false, false)}
          />
        ),
      )}
      {entry.streaming && entry.items.length > 0 && (
        <div className={`flex items-center gap-1.5 text-[10px] ${palette.subtle}`}><Loader2 className="w-3 h-3 animate-spin" /><span>working…</span></div>
      )}
      {entry.final && (
        <div className={`rounded-md border p-1.5 sm:p-2.5 space-y-1 ${palette.card}`}>
          <div className="flex items-center gap-1.5 font-medium"><Check className="w-3.5 h-3.5 text-emerald-500" /><span>Conclusion</span></div>
          <div className="leading-snug sm:leading-relaxed whitespace-pre-wrap break-words">{entry.final}</div>
          <div>{copyBtn(`${entry.id}-final`, entry.final)}</div>
        </div>
      )}
      {entry.stopReason === 'max-steps' && (
        <div className={`text-[10px] ${palette.subtle}`}>Stopped at the step limit. Raise steps in Settings and ask again.</div>
      )}
      {entry.error && (
        <div className="flex items-start gap-2 text-rose-500"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span className="leading-relaxed">{entry.error}</span></div>
      )}
    </div>
  );
};
