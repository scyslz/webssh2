import React from 'react';
import { Copy, Clipboard, Keyboard, CloudOff, Share2, ZoomIn, ZoomOut, Trash2, RefreshCw, ChevronUp, ChevronDown, Terminal, Sparkles } from 'lucide-react';

interface TerminalToolbarProps {
  isLight: boolean;
  connected: boolean;
  tabConnected?: boolean;
  offlineSuspended: boolean;
  connecting: boolean;
  selectedText: string;
  disableCopy: boolean;
  showKeyBar: boolean;
  showQuickCmds: boolean;
  offlineHoldEnabled: boolean;
  sharedSession: boolean;
  clientLatencyMs: number | null;
  sshLatencyMs: number | null;
  onSelectMode: () => void;
  onCopySelection: () => void;
  onAskAi: () => void;
  onPaste: () => void;
  onToggleKeyBar: () => void;
  onToggleQuickCmds: () => void;
  onToggleOfflineHold: () => void;
  onToggleSharedSession: () => void;
  onFontSizeIncrease: () => void;
  onFontSizeDecrease: () => void;
  onClearTerminal: () => void;
  onRecoverSession: () => void;
}

const formatLatency = (value: number | null) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${Math.round(value)}` : '--';

const getLatencyToneClass = (value: number | null, isLight: boolean) => {
  if (typeof value !== 'number') {
    return isLight ? 'text-slate-500' : 'text-slate-400';
  }
  if (value >= 200) {
    return isLight ? 'text-rose-600' : 'text-rose-400';
  }
  if (value >= 100) {
    return isLight ? 'text-amber-600' : 'text-amber-400';
  }
  return isLight ? 'text-emerald-600' : 'text-emerald-400';
};

export const TerminalToolbar: React.FC<TerminalToolbarProps> = ({
  isLight,
  connected,
  tabConnected,
  offlineSuspended,
  connecting,
  selectedText,
  disableCopy,
  showKeyBar,
  showQuickCmds,
  offlineHoldEnabled,
  sharedSession,
  clientLatencyMs,
  sshLatencyMs,
  onSelectMode,
  onCopySelection,
  onAskAi,
  onPaste,
  onToggleKeyBar,
  onToggleQuickCmds,
  onToggleOfflineHold,
  onToggleSharedSession,
  onFontSizeIncrease,
  onFontSizeDecrease,
  onClearTerminal,
  onRecoverSession,
}) => {
  const btnBg = isLight
    ? 'bg-white hover:bg-slate-200 text-slate-700 border-slate-300'
    : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700';

  const latencyBadgeClass = isLight
    ? 'bg-white text-slate-700 border-slate-300'
    : 'bg-slate-800 text-slate-300 border-slate-700';

  return (
    <div
      className={`border-b px-2 py-0.5 flex items-center justify-between text-[11px] gap-1.5 transition-colors ${
        isLight ? 'bg-slate-100 border-slate-200 text-slate-800' : 'bg-slate-900 border-slate-800 text-slate-100'
      }`}
    >
      {/* 左侧可横向滚动（min-w-0 让它能收缩，不会把右侧固定按钮挤出容器）；
          右侧 shrink-0 固定，刷新/字号等按钮永远可见。 */}
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-none flex-1 min-w-0">
        <button
          onClick={onSelectMode}
          disabled={!(connected || offlineSuspended)}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border transition cursor-pointer shrink-0 disabled:opacity-40 ${
            isLight
              ? 'bg-white hover:bg-slate-200 text-indigo-600 border-slate-300'
              : 'bg-slate-800 hover:bg-slate-700 text-indigo-300 border-slate-700'
          }`}
          title="Select Text"
        >
          <Copy className="w-3 h-3 text-indigo-500" />
        </button>

        <button
          onClick={onCopySelection}
          disabled={disableCopy}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border transition cursor-pointer shrink-0 ${
            selectedText
              ? 'bg-amber-500/20 text-amber-600 border-amber-500/40 shadow-xs animate-pulse'
              : `${btnBg} disabled:opacity-40`
          }`}
          title="Copy Selection"
        >
          <Copy className="w-3 h-3 text-amber-500" />
          {selectedText && <span className="text-[9px] font-mono">({selectedText.length})</span>}
        </button>

        {/* 只负责打开 AI 面板。分析要用户在面板里再点一次 —— 开面板就自动发几十 KB
            终端文本，既浪费也没机会让人先确认要问什么。 */}
        <button
          onClick={onPaste}
          disabled={!(connected || offlineSuspended)}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border transition cursor-pointer shrink-0 disabled:opacity-40 ${btnBg}`}
          title="Paste Clipboard Content"
        >
          <Clipboard className="w-3 h-3 text-emerald-500" />
        </button>

        <button
          onClick={onAskAi}
          disabled={!(connected || offlineSuspended)}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border transition cursor-pointer shrink-0 disabled:opacity-40 ${btnBg}`}
          title="Ask AI about this terminal"
        >
          <Sparkles className="w-3 h-3 text-indigo-500" />
        </button>

        <button
          onClick={onToggleKeyBar}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border transition cursor-pointer shrink-0 ${
            showKeyBar
              ? isLight
                ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                : 'bg-slate-800 text-emerald-400 border-emerald-500/40'
              : btnBg
          }`}
          title="Toggle Quick Keys Bar"
        >
          <Keyboard className="w-3 h-3" />
          {showKeyBar ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>

        <button
          onClick={onToggleOfflineHold}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border transition cursor-pointer shrink-0 ${
            offlineHoldEnabled
              ? isLight
                ? offlineSuspended
                  ? 'bg-amber-100 text-amber-800 border-amber-300'
                  : 'bg-sky-100 text-sky-800 border-sky-300'
                : offlineSuspended
                ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                : 'bg-sky-500/15 text-sky-300 border-sky-500/30'
              : btnBg
          }`}
          title={offlineHoldEnabled ? (offlineSuspended ? 'Offline hold enabled: reconnect on next input' : 'Offline hold enabled') : 'Enable offline hold mode'}
        >
          <CloudOff className="w-3 h-3" />
        </button>

        <button
          onClick={onToggleSharedSession}
          disabled={!connected}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border transition cursor-pointer shrink-0 disabled:opacity-40 ${
            sharedSession
              ? isLight
                ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
              : btnBg
          }`}
          title={sharedSession ? 'Session sharing enabled' : 'Enable session sharing'}
        >
          <Share2 className="w-3 h-3" />
        </button>

        <button
          onClick={onToggleQuickCmds}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border transition cursor-pointer shrink-0 ${
            showQuickCmds
              ? isLight
                ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                : 'bg-slate-800 text-emerald-400 border-emerald-500/40'
              : btnBg
          }`}
          title="Toggle Quick Commands"
        >
          <Terminal className="w-3 h-3" />
        </button>

        <div
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0 border ${latencyBadgeClass}`}
          title={`Browser to WebSSH: ${formatLatency(clientLatencyMs)} | WebSSH to SSH host: ${formatLatency(sshLatencyMs)}`}
        >
          {connected || offlineSuspended ? (
            <>
              <span className={getLatencyToneClass(clientLatencyMs, isLight)}>{formatLatency(clientLatencyMs)}</span>
              <span className="opacity-50">|</span>
              <span className={getLatencyToneClass(sshLatencyMs, isLight)}>{formatLatency(sshLatencyMs)}</span>
            </>
          ) : (
            <span className="opacity-50">-|-</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-0.5 shrink-0">
        <button
          onClick={onFontSizeIncrease}
          className={`p-0.5 rounded transition ${
            isLight ? 'hover:bg-slate-200 text-slate-600 hover:text-slate-900' : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'
          }`}
          title="Increase Font Size"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onFontSizeDecrease}
          className={`p-0.5 rounded transition ${
            isLight ? 'hover:bg-slate-200 text-slate-600 hover:text-slate-900' : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'
          }`}
          title="Decrease Font Size"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onClearTerminal}
          className={`p-0.5 rounded transition ${
            isLight ? 'hover:bg-slate-200 text-slate-600 hover:text-slate-900' : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'
          }`}
          title="Clear Screen"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onRecoverSession}
          className={`p-0.5 rounded transition ${
            isLight ? 'hover:bg-slate-200 text-slate-600 hover:text-slate-900' : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'
          } ${connecting ? 'animate-spin' : ''}`}
          title="Restore Session Or Reconnect"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
