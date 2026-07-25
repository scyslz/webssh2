import React from 'react';
import { Terminal, Plus, Bookmark, Settings, Activity } from 'lucide-react';
import { WebSSHConfig } from '../types';

interface HeaderProps {
  onNewConnection: () => void;
  onOpenSessions: () => void;
  onOpenSavedHosts: () => void;
  onOpenSettings: () => void;
  config: WebSSHConfig;
  savedCount: number;
  activeSessionCount?: number;
}

export const Header: React.FC<HeaderProps> = ({
  onNewConnection,
  onOpenSessions,
  onOpenSavedHosts,
  onOpenSettings,
  config,
  savedCount,
  activeSessionCount = 0,
}) => {
  const isLight = config.theme === 'light';

  const btnBaseClass =
    'w-8 h-7 flex items-center justify-center rounded border transition cursor-pointer relative shrink-0 shadow-2xs';

  return (
    <header
      className={`border-b px-3 py-1.5 flex items-center justify-between shadow-xs select-none transition-colors ${
        isLight ? 'bg-white border-slate-200 text-slate-800' : 'bg-slate-900 border-slate-800 text-slate-100'
      }`}
    >
      <div className="flex items-center gap-2">
        <div
          className={`w-6 h-6 rounded-md flex items-center justify-center ${
            isLight
              ? 'bg-emerald-50 border border-emerald-200 text-emerald-600'
              : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
          }`}
        >
          <Terminal className="w-3.5 h-3.5" />
        </div>
        <div className="flex items-center gap-1.5">
          <h1 className={`font-bold text-xs tracking-tight ${isLight ? 'text-slate-900' : 'text-slate-100'}`}>
            WebSSH
          </h1>
          
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        {/* New Connection Button */}
        <button
          onClick={onNewConnection}
          className={`${btnBaseClass} bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-500`}
          title="New Connection"
        >
          <Plus className="w-4 h-4" />
        </button>

        {/* Sessions Manager Button */}
        <button
          onClick={onOpenSessions}
          className={`${btnBaseClass} ${
            isLight
              ? 'bg-slate-100 hover:bg-slate-200 border-slate-300 text-emerald-600'
              : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-emerald-400'
          }`}
          title="Active Sessions Manager"
        >
          <Activity className="w-4 h-4" />
          {activeSessionCount > 0 && (
            <span
              className={`absolute -top-1 -right-1 text-[8px] font-bold rounded-full w-3.5 h-3.5 flex items-center justify-center border shadow-xs ${
                isLight
                  ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                  : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
              }`}
            >
              {activeSessionCount}
            </span>
          )}
        </button>

        {/* Saved Hosts Button */}
        <button
          onClick={onOpenSavedHosts}
          className={`${btnBaseClass} ${
            isLight
              ? 'bg-slate-100 hover:bg-slate-200 border-slate-300 text-slate-700'
              : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'
          }`}
          title="Saved Hosts"
        >
          <Bookmark className="w-3.5 h-3.5 text-amber-500" />
          {savedCount > 0 && (
            <span
              className={`absolute -top-1 -right-1 text-[8px] font-bold rounded-full w-3.5 h-3.5 flex items-center justify-center border shadow-xs ${
                isLight
                  ? 'bg-amber-100 text-amber-800 border-amber-300'
                  : 'bg-amber-500/20 text-amber-300 border-amber-500/40'
              }`}
            >
              {savedCount}
            </span>
          )}
        </button>

        {/* Settings Button */}
        <button
          onClick={onOpenSettings}
          className={`${btnBaseClass} ${
            isLight
              ? 'bg-slate-100 hover:bg-slate-200 border-slate-300 text-slate-700'
              : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300'
          }`}
          title="Settings"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>
    </header>
  );
};

