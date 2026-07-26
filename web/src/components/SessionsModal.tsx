import React, { useState, useEffect } from 'react';
import { X, Server, RefreshCw, Trash2, ExternalLink, Activity, Radio } from 'lucide-react';
import { SSHTab } from '../types';
import { apiFetch, apiUrl } from '../api';

export interface BackendSession {
  id: string;
  host: string;
  port: number;
  username: string;
  createdAt: number;
  lastActivity: number;
  attachedClients: number;
  shared?: boolean;
  credentialId?: string;
  ownerClientId?: string;
  title?: string;
}

interface SessionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRefresh: (forceRefresh: boolean) => Promise<BackendSession[]>;
  onAttachSession: (session: BackendSession, force?: boolean) => void;
  onKillSession: (sessionId: string) => void;
  tabs: SSHTab[];
  theme?: string;
}

export const SessionsModal: React.FC<SessionsModalProps> = ({
  isOpen,
  onClose,
  onRefresh,
  onAttachSession,
  onKillSession,
  tabs,
  theme,
}) => {
  const isLight = theme === 'light';
  const [sessions, setSessions] = useState<BackendSession[]>([]);

  const loadSessions = async (force = false) => {
    const list = await onRefresh(force);
    setSessions(list);
  };

  useEffect(() => {
    if (isOpen) loadSessions();
  }, [isOpen]);

  const tabIds = new Set(tabs.map((t) => t.id));
  const tabTitles = new Map(tabs.map((t) => [t.id, t.title]));

  const getRestoreTone = (sess: BackendSession) => {
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

  const getRestoreTitle = (sess: BackendSession) => {
    if (tabIds.has(sess.ownerClientId ?? '')) return 'Already opened in this browser — click to restore';
    if (sess.attachedClients > 0) return 'Occupied by another client — use Force to take over';
    return 'Available — click to restore here';
  };

  const formatLastActiveTime = (timestamp: number) =>
    new Date(timestamp).toLocaleString([], {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

  const handleKillSession = async (sessionId: string) => {
    try {
      await apiFetch(apiUrl('/ssh/sessions/kill'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: [sessionId] }),
      });
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      onKillSession(sessionId);
    } catch (err) {
      // ignore
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 z-50 select-none animate-in fade-in duration-150">
      <div
        className={`border rounded-xl w-full max-w-xl max-h-[85vh] shadow-2xl flex flex-col overflow-hidden ${
          isLight ? 'bg-white border-slate-200 text-slate-800' : 'bg-slate-900 border-slate-800 text-slate-100'
        }`}
      >
        {/* Modal Header */}
        <div
          className={`px-4 py-3 border-b flex items-center justify-between shrink-0 ${
            isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-slate-800'
          }`}
        >
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
              <Activity className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm tracking-tight">Active Sessions Manager</h3>
              <p className="text-[11px] text-slate-400">View & restore persistent SSH backend sessions across devices</p>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => loadSessions(true)}
              className={`p-1.5 rounded-lg border transition cursor-pointer ${
                isLight
                  ? 'hover:bg-slate-200 border-slate-300 text-slate-600'
                  : 'hover:bg-slate-800 border-slate-700 text-slate-300'
              }`}
              title="Refresh Sessions"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
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
        <div className="p-4 flex-1 overflow-y-auto space-y-2 min-h-[220px]">
          {sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-2">
              <Radio className="w-8 h-8 text-slate-600 animate-pulse" />
              <p className="text-xs font-medium">No active SSH sessions running on server.</p>
              <p className="text-[11px] text-slate-500">Connect to a server to create persistent sessions.</p>
            </div>
          ) : (
            sessions.map((sess) => {
              const restoreTone = getRestoreTone(sess);
              const restoreTitle = getRestoreTitle(sess);

              return (
                <div
                  key={sess.id}
                  className={`p-3 rounded-lg border transition flex items-center justify-between gap-3 ${
                    isLight
                      ? 'bg-slate-50 hover:bg-slate-100 border-slate-200'
                      : 'bg-slate-950/60 hover:bg-slate-950 border-slate-800/80'
                  }`}
                >
                  <div className="flex items-center gap-3 overflow-hidden">
                    <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                      <Server className="w-4 h-4" />
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold truncate">
                          {tabTitles.get(sess.ownerClientId ?? '') || sess.title || `${sess.username}@${sess.host}:${sess.port}`}
                        </span>
                        {(tabTitles.has(sess.ownerClientId ?? '') || sess.title) && (
                          <span className="text-[10px] text-slate-500 font-mono truncate">{sess.username}@{sess.host}:{sess.port}</span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-400 font-mono mt-0.5 truncate">
                        <span>{sess.id}</span>
                      </div>
                      <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                        <span>Last Active: {formatLastActiveTime(sess.lastActivity)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => {
                        onAttachSession(sess, sess.attachedClients > 0 && !tabIds.has(sess.ownerClientId ?? ''));
                        onClose();
                      }}
                      className={`flex items-center gap-1 px-2 py-1 rounded-md border text-xs font-medium transition cursor-pointer shadow-xs ${restoreTone}`}
                      title={restoreTitle}
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </button>

                    <button
                      onClick={() => handleKillSession(sess.id)}
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
            }))}
        </div>

        {/* Modal Footer */}
        <div
          className={`px-4 py-2 border-t flex items-center justify-between text-[11px] text-slate-400 shrink-0 ${
            isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-slate-800'
          }`}
        >
          <span>Active sessions persist in backend container memory</span>
          <button
            onClick={onClose}
            className="px-3 py-1 rounded border bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700 text-xs font-medium transition cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
