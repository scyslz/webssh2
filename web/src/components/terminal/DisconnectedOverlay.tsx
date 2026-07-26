import React from 'react';
import { ShieldAlert, RefreshCw, CirclePlus } from 'lucide-react';

interface DisconnectedOverlayProps {
  isLight: boolean;
  errorMsg: string | null;
  sessionId?: string;
  isInvalidSessionError: boolean;
  canForceRestore: boolean;
  onRecoverSession?: (force?: boolean) => void;
  onNewSession?: () => void;
}

export const DisconnectedOverlay: React.FC<DisconnectedOverlayProps> = ({
  isLight,
  errorMsg,
  sessionId,
  isInvalidSessionError,
  canForceRestore,
  onRecoverSession,
  onNewSession,
}) => (
  <div className={`absolute inset-0 backdrop-blur-xs flex flex-col items-center justify-center gap-3 p-4 z-10 ${
    isLight ? 'bg-white/80' : 'bg-slate-950/80'
  }`}>
    <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-full text-rose-400">
      <ShieldAlert className="w-8 h-8" />
    </div>
    <div className="text-center max-w-md">
      <h3 className={`font-bold text-base ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>Terminal Disconnected</h3>
      <p className={`text-xs font-mono mt-1 ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>{errorMsg || 'SSH connection was closed or timed out.'}</p>
    </div>
    {(errorMsg?.includes('already attached') || errorMsg?.includes('taken over')) && (
      <p className={`text-[11px] font-mono text-center max-w-md ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>
        Session is attached elsewhere. Start a new session here or use the session manager to restore it explicitly.
      </p>
    )}
    <div className="flex flex-col items-center gap-2">
      {sessionId && !isInvalidSessionError && !canForceRestore && (
        <button
          onClick={() => onRecoverSession?.()}
          className="w-48 flex items-center justify-center gap-1.5 px-4 py-2 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium shadow-md transition cursor-pointer"
        >
          <RefreshCw className="w-4 h-4 shrink-0" />
          <span className="leading-none">Restore Session</span>
        </button>
      )}
      {canForceRestore && (
        <button
          onClick={() => onRecoverSession?.(true)}
          className="w-48 flex items-center justify-center gap-1.5 px-4 py-2 rounded-md bg-rose-700 hover:bg-rose-600 text-white text-xs font-medium shadow-md transition cursor-pointer"
        >
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span className="leading-none">Force Restore</span>
        </button>
      )}
      <button
        onClick={() => onNewSession?.()}
        className="w-48 flex items-center justify-center gap-1.5 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium shadow-md transition cursor-pointer"
      >
          <CirclePlus className="w-4 h-4 shrink-0" />
          <span className="leading-none">New Session</span>
      </button>
    </div>
  </div>
);