import React, { useEffect, useState } from 'react';
import { X, Server, Trash2, ExternalLink, Activity, Radio } from 'lucide-react';
import { SessionHealth } from '../sysClient';
import { SSHTab } from '../types';
import { apiFetch, apiUrl } from '../api';

interface SessionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessions: SessionHealth[];
  onAttachSession: (session: SessionHealth, force?: boolean) => void;
  onKillSession: (sessionId: string) => void;
  tabs: SSHTab[];
  theme?: string;
}

export const SessionsModal: React.FC<SessionsModalProps> = ({
  isOpen,
  onClose,
  sessions,
  onAttachSession,
  onKillSession,
  tabs,
  theme,
}) => {
  const isLight = theme === 'light';
  const [killedIds, setKilledIds] = useState<Set<string>>(new Set());

  // 清理 killedIds（当 sessions 更新时）
  useEffect(() => {
    setKilledIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (sessions.some((s) => s.sessionId === id)) next.add(id);
      }
      return next;
    });
  }, [sessions]);

  const tabIds = new Set(tabs.map((t) => t.id));
  const tabTitles = new Map(tabs.map((t) => [t.id, t.title]));

  const visibleSessions = sessions.filter((s) => !killedIds.has(s.sessionId));

  const getRestoreTone = (sess: SessionHealth) => {
    if (tabIds.has(sess.ownerClientId ?? '')) {
      return isLight
        ? 'bg-amber-100 hover:bg-amber-200 text-amber-800 border-amber-300'
        : 'bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border-amber-500/30';
    }
    if (sess.attachedClients > 0) {
      return isLight
        ? 'bg-rose-100 hover:bg-rose-200 text-rose-800 border-rose-300'
        : 'bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border-rose-500/30';
    }
    return isLight
      ? 'bg-emerald-100 hover:bg-emerald-200 text-emerald-800 border-emerald-300'
      : 'bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border-emerald-500/30';
  };

  const getRestoreTitle = (sess: SessionHealth) => {
    if (tabIds.has(sess.ownerClientId ?? '')) return 'Already opened in this browser — click to restore';
    if (sess.attachedClients > 0) return 'Occupied by another client — use Force to take over';
    return 'Available — click to restore here';
  };

  const formatRecent = (ts: number): string => {
    const diff = Date.now() - ts;
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  };

  const formatAbs = (ts: number) => {
    const d = new Date(ts);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${mm}/${dd} ${hh}:${mi}:${ss}`;
  };

  const handleKillSession = async (sessionId: string) => {
    // 乐观隐藏
    setKilledIds((prev) => new Set(prev).add(sessionId));
    try {
      await apiFetch(apiUrl('/ssh/sessions/kill'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: [sessionId] }),
      });
      onKillSession(sessionId);
    } catch (err) {
      // 失败时恢复
      setKilledIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4 z-50 select-none animate-in fade-in duration-150">
      <div
        className={`border rounded-xl w-full max-w-xl max-sm:max-w-full max-sm:mx-0 max-sm:max-h-[92vh] shadow-2xl flex flex-col overflow-hidden ${
          isLight ? 'bg-white border-slate-200 text-slate-800' : 'bg-slate-900 border-slate-800 text-slate-100'
        }`}
      >
        {/* Modal Header */}
        <div
          className={`px-3 sm:px-4 py-2.5 sm:py-3 border-b flex items-center justify-between shrink-0 ${
            isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-slate-800'
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 shrink-0">
              <Activity className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-xs sm:text-sm tracking-tight truncate">Active Sessions</h3>
              <p className="text-[11px] text-slate-400 hidden sm:block">View & restore persistent SSH backend sessions across devices</p>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-[10px] text-slate-500 hidden sm:inline mr-1">
              {visibleSessions.length} active
            </span>
            <button
              onClick={onClose}
              className={`p-1.5 rounded-lg border transition cursor-pointer ${
                isLight
                  ? 'hover:bg-slate-200 border-slate-300 text-slate-600'
                  : 'hover:bg-slate-800 border-slate-700 text-slate-300'
              }`}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Sessions List Content */}
        <div className="p-3 sm:p-4 flex-1 overflow-y-auto space-y-2 min-h-[180px] sm:min-h-[220px]">
          {visibleSessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-2">
              <Radio className="w-8 h-8 text-slate-600 animate-pulse" />
              <p className="text-xs font-medium">No active SSH sessions running on server.</p>
              <p className="text-[11px] text-slate-500">Connect to a server to create persistent sessions.</p>
            </div>
          ) : (
            visibleSessions
              .sort((a, b) => b.lastActivity - a.lastActivity)
              .map((sess) => {
                const restoreTone = getRestoreTone(sess);
                const restoreTitleText = getRestoreTitle(sess);
                const hostLabel = `${sess.username}@${sess.host}:${sess.port}`;
                const tabTitle = tabTitles.get(sess.ownerClientId ?? '') || sess.title;
                const showHost = tabTitle && tabTitle !== hostLabel;

                return (
                  <div
                    key={sess.sessionId}
                    className={`p-2 sm:p-3 rounded-lg border transition flex items-center justify-between gap-2 sm:gap-3 ${
                      isLight
                        ? 'bg-slate-50 hover:bg-slate-100 border-slate-200'
                        : 'bg-slate-950/60 hover:bg-slate-950 border-slate-800/80'
                    }`}
                  >
                    <div className="flex items-center gap-2 sm:gap-3 overflow-hidden">
                      <div className="p-1.5 sm:p-2 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                        <Server className="w-3.5 sm:w-4 sm:h-4" />
                      </div>

                      <div className="min-w-0">
                        <span className="font-mono text-[11px] sm:text-xs font-bold truncate block">
                          {tabTitle || hostLabel}
                        </span>
                        {showHost && (
                          <span className="text-[10px] text-slate-500 font-mono truncate block mt-0.5">
                            {hostLabel}
                          </span>
                        )}
                        <span className="text-[10px] text-slate-500 font-mono mt-0.5 block">
                          Created {formatAbs(sess.connectedAt)}
                          {sess.attachedClients === 0 && (
                          <span className="text-slate-400"> &middot; {formatRecent(sess.lastActivity)}</span>
                          )}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => {
                          onAttachSession(sess, sess.attachedClients > 0 && !tabIds.has(sess.ownerClientId ?? ''));
                          onClose();
                        }}
                        className={`flex items-center gap-1 p-1.5 sm:px-2 sm:py-1 rounded-md border text-xs font-medium transition cursor-pointer shadow-xs ${restoreTone}`}
                        title={restoreTitleText}
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>

                      <button
                        onClick={() => handleKillSession(sess.sessionId)}
                        className={`p-1.5 rounded-md border transition cursor-pointer ${
                          isLight
                            ? 'hover:bg-rose-100 hover:border-rose-300 text-rose-600 border-slate-300'
                            : 'hover:bg-rose-950/60 hover:border-rose-800 text-rose-400 border-slate-800'
                        }`}
                        title="Terminate Session"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })
          )}
        </div>

        {/* Modal Footer */}
        <div
          className={`px-3 sm:px-4 py-2 border-t flex items-center justify-end text-[11px] text-slate-400 shrink-0 ${
            isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-slate-800'
          }`}
        >
          <span className="text-slate-400">Active sessions persist in backend container memory &middot; Auto-refreshed via /sys</span>
        </div>
      </div>
    </div>
  );
};
