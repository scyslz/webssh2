import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  RefreshCw,
  Settings2,
  Sparkles,
  Square,
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
} from '../aiClient';
import { isLightTheme } from '../theme';

/**
 * AI 面板（P0：只读诊断）。
 *
 * 三条刻意做出来的规矩：
 * 1. 面板里没有「执行」按钮 —— P0 不产生任何可执行物，AI 只解释不操作。
 * 2. 「实际发送内容」默认展开：用户得能看见到底把什么发出去了，才谈得上信任。
 * 3. 未配置时面板自己承担配置表单，不把 AI 设置塞进全局设置里（自托管场景
 *    大多数人是靠环境变量喂 key 的，UI 只是兜底）。
 */

interface AiPanelProps {
  request: AiDiagnoseRequest | null;
  onClose: () => void;
  theme?: string;
}

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

export const AiPanel: React.FC<AiPanelProps> = ({ request, onClose, theme }) => {
  const isLight = isLightTheme(theme);

  const clientRef = useRef<AiWSClient | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const lastRunRef = useRef<{ text: string; source: 'selection' | 'tail'; question?: string } | null>(null);

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
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

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

  const run = useCallback(async (input: { text: string; source: 'selection' | 'tail'; question?: string }) => {
    const client = clientRef.current;
    if (!client) return;

    lastRunRef.current = input;
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

  // 请求进来（用户点了 AI 按钮）→ 等配置就绪后再发
  useEffect(() => {
    if (request) setPending(request);
  }, [request]);

  useEffect(() => {
    if (!pending || !config?.ready) return;
    const current = pending;
    setPending(null);
    void run({ text: current.text, source: current.source, question: current.question });
  }, [pending, config?.ready, run]);

  // 流式过程中自动滚到底部，但用户主动上滚后不要抢滚动条
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [answer, prepared]);

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
        { baseUrl: formBaseUrl, model: formModel, redactPrivateIp: formRedactIp },
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
    if (!answer) return;
    navigator.clipboard?.writeText(answer).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };

  const handleRegenerate = () => {
    if (!lastRunRef.current) return;
    void run(lastRunRef.current);
  };

  const handleFollowUp = () => {
    const question = followUp.trim();
    if (!question || !lastRunRef.current) return;
    setFollowUp('');
    void run({ ...lastRunRef.current, question });
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
                {prepared.stats.rawLines}→{prepared.stats.lines} 行 · 约 {prepared.stats.estTokens} tokens
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
                <pre className={`max-h-56 overflow-auto rounded border p-2 text-[10px] leading-relaxed font-mono whitespace-pre-wrap break-all ${palette.code}`}>
                  {prepared.text}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* 回答 */}
        {(answer || streaming) && (
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
            <button onClick={handleRegenerate} disabled={!lastRunRef.current} className={`${buttonClass} ${palette.button}`}>
              <RefreshCw className="w-3 h-3" />
              <span>重新生成</span>
            </button>
          )}
          <button onClick={handleCopy} disabled={!answer} className={`${buttonClass} ${palette.button}`}>
            {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
            <span>复制</span>
          </button>
          <span className={`ml-auto text-[10px] font-mono ${palette.subtle}`}>只读，不执行命令</span>
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
    </div>
  );
};
