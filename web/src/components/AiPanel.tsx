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
  type AiConfigView,
  type AiContextStats,
  type AiDiagnoseRequest,
  type AiDoneMeta,
  type AiDraft,
  type AiRiskLevel,
} from '../aiClient';
import { ConfirmDialog } from './ConfirmDialog';
import { isLightTheme } from '../theme';

/**
 * AI 面板（P0 只读诊断 + P1 命令草稿）。
 *
 * 三条刻意做出来的规矩：
 * 1. 诊断模式里没有「执行」按钮 —— 只解释不操作。
 * 2. 命令草稿的风险等级**以服务端判分显示**，模型自评只在旁边做对照；
 *    两者不一致时，界面显示的是判分结果。
 * 3. 「执行」在界面上永远排在「仅填入」后面，且高风险命令必须再过一次确认框。
 *    底层不变量没变：命令是写进终端输入行，回车永远是用户按的（除了他显式点执行）。
 * 4. 「实际发送内容」默认展开：用户得能看见到底把什么发出去了，才谈得上信任。
 * 5. 未配置时面板自己承担配置表单，不把 AI 设置塞进全局设置里（自托管场景
 *    大多数人是靠环境变量喂 key 的，UI 只是兜底）。
 */

interface AiPanelProps {
  request: AiDiagnoseRequest | null;
  onClose: () => void;
  theme?: string;
  /** 目标终端的 SSH 连接是否就绪；没连上就不能执行命令 */
  terminalConnected?: boolean;
  /** 把命令写进终端输入行。submit=false 只填入不回车。返回是否发送成功 */
  onRunCommand?: (command: string, submit: boolean) => boolean;
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
const RISK_LABEL: Record<AiRiskLevel, string> = { safe: '只读', caution: '需谨慎', dangerous: '高风险' };

type Phase = 'idle' | 'streaming' | 'done' | 'error';

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
  request,
  onClose,
  theme,
  terminalConnected = false,
  onRunCommand,
}) => {
  const isLight = isLightTheme(theme);
  const risk = isLight ? RISK_STYLE : RISK_STYLE_DARK;

  const clientRef = useRef<AiWSClient | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const lastRunRef = useRef<{ text: string; source: 'selection' | 'tail'; question?: string } | null>(null);
  /** 回调里读 draft 原文用，避免把 draftRaw 塞进 runDraft 的依赖里导致反复重建 */
  const draftRawRef = useRef('');

  const [config, setConfig] = useState<AiConfigView | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [prepared, setPrepared] = useState<PreparedView | null>(null);
  const [answer, setAnswer] = useState('');
  const [meta, setMeta] = useState<AiDoneMeta | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(true);
  const [pending, setPending] = useState<AiDiagnoseRequest | null>(null);
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

  // ---- P1 命令草稿 ----
  /** 当前流的是哪种请求，决定 delta 往哪写、底部按钮显示什么 */
  const [mode, setMode] = useState<'diagnose' | 'draft'>('diagnose');
  const [askText, setAskText] = useState('');
  const [draft, setDraft] = useState<AiDraft | null>(null);
  /** draft 模式流下来的原文（JSON）。只在解析失败降级时才会展示给人看 */
  const [draftRaw, setDraftRaw] = useState('');
  const [degraded, setDegraded] = useState(false);
  const [confirmRunOpen, setConfirmRunOpen] = useState(false);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const lastDraftRef = useRef<{ text: string; source: 'selection' | 'tail'; question: string } | null>(null);

  const palette = useMemo(() => (isLight ? {
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
      .catch((err) => { if (!cancelled) setConfigError(err.message || '读取配置失败'); });

    return () => {
      cancelled = true;
      client.close();
      clientRef.current = null;
    };
  }, [applyConfig]);

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
          host: request?.host,
          username: request?.username,
          cwd: request?.cwd,
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
      setErrorMsg(err?.message || '发起请求失败');
      setPhase('error');
    }
  }, [request?.host, request?.username, request?.cwd]);

  /**
   * 生成命令草稿。
   *
   * delta 不写进「回答」区 —— 那里流出来的是 JSON，给人看没意义；
   * 只攒进 draftRaw，供解析失败降级时原样展示。
   */
  const runDraft = useCallback(async (question: string) => {
    const client = clientRef.current;
    if (!client || !question.trim()) return;

    const text = request?.text ?? '';
    const source = request?.source ?? 'tail';
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
        { text, source, question, host: request?.host, username: request?.username, cwd: request?.cwd },
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
      setErrorMsg(err?.message || '发起请求失败');
      setPhase('error');
    }
  }, [request?.text, request?.source, request?.host, request?.username, request?.cwd]);

  // 请求进来（用户点了 AI 按钮）→ 等配置就绪后再发
  useEffect(() => {
    if (request) setPending(request);
  }, [request]);

  useEffect(() => {
    if (!pending || !config?.ready) return;
    const current = pending;
    setPending(null);
    void runDiagnose({ text: current.text, source: current.source, question: current.question });
  }, [pending, config?.ready, runDiagnose]);

  // 流式过程中自动滚到底部，但用户主动上滚后不要抢滚动条
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [answer, prepared, draft, degraded]);

  const handleScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

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
      setConfigError(err?.message || '保存失败');
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
      setTestResult({ ok: false, message: err?.message || '测试失败' });
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
    if (mode === 'draft') {
      if (lastDraftRef.current) void runDraft(lastDraftRef.current.question);
      return;
    }
    if (!lastRunRef.current) return;
    void runDiagnose(lastRunRef.current);
  };

  const handleFollowUp = () => {
    const question = followUp.trim();
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

  /** 从诊断结果追问式地要命令，省得用户再打一遍需求 */
  const handleDraftFromAnswer = () => {
    void runDraft('根据上面的输出，给出下一步该执行的命令');
  };

  /** submit=false：只把命令写进输入行；submit=true：连回车一起发出去 */
  const dispatchCommand = (submit: boolean) => {
    if (!draft || !onRunCommand) return;
    const ok = onRunCommand(draft.command, submit);
    setRunNotice(
      ok
        ? (submit ? '已发送到终端执行' : '已填入终端输入行，确认无误后自己按回车')
        : '终端未连接，命令没有发出去',
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
  const redactions = prepared ? redactionSummary(prepared.stats) : '';

  const buttonClass = 'flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border transition cursor-pointer disabled:opacity-40';

  return (
    <div className={`absolute right-0 top-0 z-30 h-full w-full sm:w-[26rem] flex flex-col border-l ${palette.panel}`}>
      <div className={`flex items-center justify-between gap-2 px-3 py-2 border-b ${palette.header}`}>
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
          <span className="text-xs font-medium truncate">AI 诊断</span>
          {config?.ready && (
            <span className={`text-[10px] font-mono truncate ${palette.subtle}`}>{config.model || '默认模型'}</span>
          )}
        </div>
        <button onClick={onClose} className={`p-1 rounded cursor-pointer ${palette.button}`} title="关闭">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div ref={bodyRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 py-2 space-y-3 text-xs">
        {configError && (
          <div className="flex items-start gap-2 text-rose-500">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{configError}</span>
          </div>
        )}

        {/* 未就绪：把配置表单直接放在这里 */}
        {(!config?.ready || !config) && (
          <div className={`rounded border p-2.5 space-y-2 ${palette.card}`}>
            <div className="flex items-center gap-1.5 font-medium">
              <Settings2 className="w-3.5 h-3.5" />
              <span>模型服务配置</span>
            </div>
            <p className={`text-[11px] leading-relaxed ${palette.subtle}`}>
              填任意 OpenAI 兼容端点即可（DeepSeek / 通义 / Kimi / vLLM / 本地 Ollama）。
              也可以用环境变量 <code className="font-mono">WEBSSH_AI_BASE_URL</code>、
              <code className="font-mono">WEBSSH_AI_MODEL</code>、
              <code className="font-mono">WEBSSH_AI_API_KEY</code> 提供，环境变量优先。
            </p>

            <label className="block space-y-1">
              <span className={palette.subtle}>服务地址</span>
              <input
                value={formBaseUrl}
                onChange={(e) => setFormBaseUrl(e.target.value)}
                placeholder="https://api.deepseek.com 或 http://127.0.0.1:11434/v1"
                className={`w-full rounded border px-2 py-1 text-[11px] font-mono focus:outline-none ${palette.input}`}
              />
            </label>

            <label className="block space-y-1">
              <span className={palette.subtle}>模型</span>
              <input
                value={formModel}
                onChange={(e) => setFormModel(e.target.value)}
                placeholder="deepseek-chat / qwen-plus / llama3.1:8b"
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
                placeholder={config?.keyFromEnv ? '由环境变量提供' : config?.hasKey ? '已保存，留空则不修改' : 'sk-…'}
                className={`w-full rounded border px-2 py-1 text-[11px] font-mono focus:outline-none disabled:opacity-50 ${palette.input}`}
              />
            </label>

            <label className="flex items-start gap-2 leading-relaxed">
              <input
                type="checkbox"
                checked={formRedactIp}
                onChange={(e) => setFormRedactIp(e.target.checked)}
                className="mt-0.5"
              />
              <span className={palette.subtle}>
                连内网地址一起抹掉。默认关闭 —— 内网 IP 往往是排查的关键线索，
                而它并不是凭据；合规要求严格的部署可以打开。
              </span>
            </label>

            <label className="block space-y-1">
              <span className={palette.subtle}>命令白名单（可选，逗号分隔）</span>
              <input
                value={formWhitelist}
                onChange={(e) => setFormWhitelist(e.target.value)}
                placeholder="myctl, deploy"
                className={`w-full rounded border px-2 py-1 text-[11px] font-mono focus:outline-none ${palette.input}`}
              />
              <span className={`block text-[10px] leading-relaxed ${palette.subtle}`}>
                只收命令名。加进来的命令在「非 root 会话 + 判分只读」时才允许无人值守执行；
                白名单<b>绕不过风险等级</b> —— 把 rm 加进来，rm -rf / 依然会被判高风险。
              </span>
            </label>

            <div className="flex items-center gap-2">
              <button onClick={handleSave} disabled={saving} className={`${buttonClass} ${palette.primary}`}>
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                <span>保存</span>
              </button>
              <button onClick={handleTest} disabled={testing || !config?.hasKey} className={`${buttonClass} ${palette.button}`}>
                {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                <span>测试连接</span>
              </button>
            </div>

            {testResult && (
              <div className={testResult.ok ? 'text-emerald-500' : 'text-rose-500'}>
                {testResult.ok ? '连接正常' : testResult.message}
                {testResult.model ? `（${testResult.model}）` : ''}
              </div>
            )}
          </div>
        )}

        {/* 就绪但没有任务：给个引导 */}
        {config?.ready && phase === 'idle' && (
          <p className={`leading-relaxed ${palette.subtle}`}>
            选中终端里的一段输出后点工具栏的 AI 图标，会在**不发送任何东西**之前先把要出网的内容列出来给你看。
            没选中内容时，会取终端最后若干行。
          </p>
        )}

        {/* 出网可见性：默认展开，让用户先看清发的是什么 */}
        {prepared && (
          <div className={`rounded border ${palette.card}`}>
            <button
              onClick={() => setShowContext((prev) => !prev)}
              className="w-full flex items-center gap-1.5 px-2.5 py-2 text-left cursor-pointer"
            >
              {showContext ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
              <span className="font-medium shrink-0">实际发送内容</span>
              <span className={`text-[10px] font-mono truncate ${palette.subtle}`}>
                {prepared.stats.rawLines > 0
                  ? `${prepared.stats.rawLines}→${prepared.stats.lines} 行 · 约 ${prepared.stats.estTokens} tokens`
                  : '本次没有终端内容'}
                {prepared.stats.redactionTotal ? ` · 已抹除 ${prepared.stats.redactionTotal} 处` : ''}
              </span>
            </button>

            {showContext && (
              <div className="px-2.5 pb-2.5 space-y-2">
                <div className={`text-[10px] font-mono break-all ${palette.subtle}`}>{prepared.env}</div>
                {(redactions || prepared.stats.omittedLines > 0) && (
                  <div className={`text-[10px] font-mono ${palette.subtle}`}>
                    {redactions ? `脱敏：${redactions}` : ''}
                    {redactions && prepared.stats.omittedLines ? ' · ' : ''}
                    {prepared.stats.omittedLines ? `中间略过 ${prepared.stats.omittedLines} 行` : ''}
                  </div>
                )}
                {prepared.text ? (
                  <pre className={`max-h-56 overflow-auto rounded border p-2 text-[10px] leading-relaxed font-mono whitespace-pre-wrap break-all ${palette.code}`}>
                    {prepared.text}
                  </pre>
                ) : (
                  // 纯「生成命令」时没有终端内容可发，别摆一个空代码框看着像坏了
                  <p className={`text-[10px] leading-relaxed ${palette.subtle}`}>
                    这次没有终端内容，出网的只有上面的需求描述、主机与登录用户。
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
              <span>生成命令</span>
            </div>
            <p className={`text-[11px] leading-relaxed ${palette.subtle}`}>
              用一句话说清要做什么。AI 只负责提议，命令会先由服务端按规则表判分，
              再由你决定是「仅填入」还是「执行」。
            </p>
            <div className="flex items-center gap-1.5">
              <input
                value={askText}
                onChange={(e) => setAskText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleGenerate(); }}
                disabled={streaming}
                placeholder="查看 docker 容器状态"
                className={`flex-1 min-w-0 rounded border px-2 py-1 text-[11px] focus:outline-none disabled:opacity-50 ${palette.input}`}
              />
              <button
                onClick={handleGenerate}
                disabled={!askText.trim() || streaming}
                className={`${buttonClass} ${palette.primary}`}
              >
                <span>生成</span>
              </button>
            </div>
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
                  <span className={`text-[10px] font-mono ${palette.subtle}`}>服务端判分</span>
                  {draft.selfRisk && draft.selfRisk !== draft.grade.level && (
                    <span className={`text-[10px] font-mono ${risk[draft.selfRisk].text}`}>
                      模型自评 {RISK_LABEL[draft.selfRisk]}（不一致，以判分为准）
                    </span>
                  )}
                  {draft.grade.allWhitelisted && (
                    <span className={`text-[10px] font-mono ${palette.subtle}`}>全部在只读白名单内</span>
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
                  <div className={`text-[11px] leading-relaxed ${palette.subtle}`}>
                    前置条件：{draft.prerequisites.join('；')}
                  </div>
                )}

                {draft.grade.rootSession && (
                  <div className={`text-[10px] ${palette.subtle}`}>
                    当前以 root 登录，自动执行判定已关闭（仍然可以手动确认执行）
                  </div>
                )}

                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => dispatchCommand(false)}
                    disabled={!terminalConnected || !onRunCommand}
                    className={`${buttonClass} ${palette.button}`}
                    title="只写进终端输入行，不按回车"
                  >
                    <CornerDownLeft className="w-3 h-3" />
                    <span>仅填入</span>
                  </button>
                  <button
                    onClick={handleRunClick}
                    disabled={!terminalConnected || !onRunCommand}
                    className={`${buttonClass} ${draft.grade.level === 'dangerous' ? palette.danger : palette.primary}`}
                    title="填入并回车执行"
                  >
                    <Play className="w-3 h-3" />
                    <span>执行</span>
                  </button>
                  <button onClick={handleCopy} className={`${buttonClass} ${palette.button}`}>
                    {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                    <span>复制</span>
                  </button>
                  {!terminalConnected && (
                    <span className={`text-[10px] ${palette.subtle}`}>终端未连接</span>
                  )}
                </div>

                {runNotice && (
                  <div className={`text-[10px] leading-relaxed ${palette.subtle}`}>{runNotice}</div>
                )}
              </>
            ) : (
              <div className="flex items-center gap-1.5 text-[11px]">
                <Loader2 className="w-3 h-3 animate-spin text-indigo-500" />
                <span className={palette.subtle}>正在生成命令…</span>
              </div>
            )}
          </div>
        )}

        {/* 降级：模型没给出可解析的结构，只展示原文，不给任何执行入口 */}
        {degraded && (
          <div className={`rounded border p-2 text-[11px] leading-relaxed ${risk.caution.border} ${risk.caution.text}`}>
            模型没有返回可用的命令结构，下面只是它的原始输出 —— 已降级为只读，本次没有生成任何可执行内容。
          </div>
        )}

        {/* 回答：诊断模式，或草稿降级后展示模型原文 */}
        {(mode === 'diagnose' || degraded) && (answer || streaming) && (
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="font-medium">回答</span>
              {streaming && <Loader2 className="w-3 h-3 animate-spin text-indigo-500" />}
            </div>
            <div className="leading-relaxed whitespace-pre-wrap break-words">
              {answer || <span className={palette.subtle}>等待首个 token…</span>}
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
            <span>按这个结论生成可执行命令</span>
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
            {meta.firstTokenMs !== undefined ? `首 token ${meta.firstTokenMs}ms · ` : ''}
            {meta.ms !== undefined ? `总 ${meta.ms}ms · ` : ''}
            {`${meta.chars || 0} 字符`}
            {meta.usage?.total_tokens ? ` · ${meta.usage.total_tokens} tokens` : ''}
            {meta.finishReason === 'length' ? ' · ⚠ 回答被 max_tokens 截断' : ''}
          </div>
        )}
      </div>

      {/* 底部操作区 */}
      <div className={`border-t px-3 py-2 space-y-2 ${palette.header}`}>
        <div className="flex items-center gap-2">
          {streaming ? (
            <button onClick={() => clientRef.current?.cancel()} className={`${buttonClass} ${palette.danger}`}>
              <Square className="w-3 h-3" />
              <span>停止</span>
            </button>
          ) : (
            <button
              onClick={handleRegenerate}
              disabled={mode === 'draft' ? !lastDraftRef.current : !lastRunRef.current}
              className={`${buttonClass} ${palette.button}`}
            >
              <RefreshCw className="w-3 h-3" />
              <span>重新生成</span>
            </button>
          )}
          <button
            onClick={handleCopy}
            disabled={!(mode === 'draft' ? draft : answer)}
            className={`${buttonClass} ${palette.button}`}
          >
            {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
            <span>复制</span>
          </button>
          {/* 这句话在两种模式下含义不同，别让它说谎 */}
          <span className={`ml-auto text-[10px] font-mono ${palette.subtle}`}>
            {mode === 'draft' ? '判分后由你确认' : '只读，不执行命令'}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <input
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleFollowUp(); }}
            disabled={!config?.ready || streaming}
            placeholder="就这段输出继续追问…"
            className={`flex-1 min-w-0 rounded border px-2 py-1 text-[11px] focus:outline-none disabled:opacity-50 ${palette.input}`}
          />
          <button
            onClick={handleFollowUp}
            disabled={!followUp.trim() || !config?.ready || streaming}
            className={`${buttonClass} ${palette.primary}`}
          >
            追问
          </button>
        </div>
      </div>

      {/* 高风险命令的二次确认。复用项目里已有的危险操作确认对话框 */}
      <ConfirmDialog
        isOpen={confirmRunOpen}
        theme={theme}
        title="确认执行高风险命令"
        confirmLabel="仍然执行"
        cancelLabel="取消"
        message={
          <span className="block space-y-1.5">
            <span className="block">服务端判分把这条命令标为「高风险」，它可能造成不可逆的改动：</span>
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
