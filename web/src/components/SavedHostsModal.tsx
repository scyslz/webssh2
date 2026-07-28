import React from 'react';
import { SSHInfo } from '../types';
import { X, Server, Trash2, Play, Lock, Key, Pencil } from 'lucide-react';

interface SavedHostsModalProps {
  isOpen: boolean;
  onClose: () => void;
  savedHosts: SSHInfo[];
  onSelectHost: (host: SSHInfo) => void;
  onDeleteHost: (index: number) => void;
  onEditHost: (host: SSHInfo, index: number) => void;
  theme?: string;
}

export const SavedHostsModal: React.FC<SavedHostsModalProps> = ({
  isOpen,
  onClose,
  savedHosts,
  onSelectHost,
  onDeleteHost,
  onEditHost,
  theme,
}) => {
  if (!isOpen) return null;

  const isLight = theme === 'light';

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4 z-50 select-none">
      <div
        className={`border rounded-xl w-full max-w-lg max-sm:max-w-full max-sm:mx-0 max-sm:max-h-[90vh] shadow-2xl overflow-hidden flex flex-col transition-colors ${
          isLight ? 'bg-white border-slate-200 text-slate-800' : 'bg-slate-900 border-slate-800 text-slate-100'
        }`}
      >
        {/* Header */}
        <div
          className={`px-3 sm:px-5 py-2.5 sm:py-3 border-b flex items-center justify-between ${
            isLight ? 'bg-slate-100 border-slate-200' : 'bg-slate-950 border-slate-800'
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <Server className="w-4 h-4 text-emerald-500 shrink-0" />
            <h2 className={`font-bold text-xs sm:text-sm truncate ${isLight ? 'text-slate-900' : 'text-slate-100'}`}>
              Saved SSH Connections
            </h2>
          </div>
          <button
            onClick={onClose}
            className={`transition p-1 shrink-0 ${isLight ? 'text-slate-400 hover:text-slate-700' : 'text-slate-400 hover:text-slate-200'}`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body List */}
        <div className="p-3 sm:p-4 overflow-y-auto space-y-2 flex-1">
          {savedHosts.length === 0 ? (
            <div className={`py-12 text-center text-xs font-mono ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>
              No saved SSH connections yet. Click "New Connection" to save one.
            </div>
          ) : (
            savedHosts.map((host, idx) => {
              const hostLabel = `${host.username}@${host.host}:${host.port || 22}`;
              const showHost = host.name && host.name !== `${host.username}@${host.host}` && host.name !== hostLabel;

              return (
              <div
                key={idx}
                className={`p-2 sm:p-3 rounded-lg flex items-center justify-between group transition border ${
                  isLight
                    ? 'bg-slate-50 border-slate-200 hover:border-slate-300'
                    : 'bg-slate-950 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                  <div
                    className={`w-7 h-7 sm:w-8 sm:h-8 rounded flex items-center justify-center shrink-0 ${
                      isLight ? 'bg-slate-200 text-slate-700' : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    {host.logintype === 1 ? <Key className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-amber-500" /> : <Lock className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-500" />}
                  </div>
                  <div className="truncate">
                    <span className={`font-bold text-[11px] sm:text-xs truncate block ${isLight ? 'text-slate-900' : 'text-slate-200'}`}>
                      {host.name || hostLabel}
                    </span>
                    {showHost && (
                      <span className={`text-[10px] font-mono truncate block mt-0.5 ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                        {hostLabel}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1 sm:gap-2 shrink-0">
                  <button
                    onClick={() => {
                      onEditHost(host, idx);
                      onClose();
                    }}
                    className={`p-1.5 rounded transition ${
                      isLight ? 'hover:bg-slate-200 text-slate-400 hover:text-sky-600' : 'hover:bg-slate-800 text-slate-500 hover:text-sky-400'
                    }`}
                    title="Edit Saved Host"
                  >
                    <Pencil className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                  </button>
                  <button
                    onClick={() => {
                      onSelectHost(host);
                      onClose();
                    }}
                    className="flex items-center gap-1 px-2 sm:px-3 py-1 sm:py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] sm:text-xs font-medium transition cursor-pointer"
                  >
                    <Play className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                    <span className="hidden sm:inline">Connect</span>
                  </button>
                  <button
                    onClick={() => onDeleteHost(idx)}
                    className={`p-1.5 rounded transition ${
                      isLight ? 'hover:bg-slate-200 text-slate-400 hover:text-rose-600' : 'hover:bg-slate-800 text-slate-500 hover:text-rose-400'
                    }`}
                    title="Delete Saved Host"
                  >
                    <Trash2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                  </button>
                </div>
              </div>
              );
            })
          )}
        </div>

        <div className={`px-3 sm:px-5 py-2 border-t flex justify-end ${isLight ? 'bg-slate-100 border-slate-200' : 'bg-slate-950 border-slate-800'}`}>
          <span className="text-[11px] text-slate-400">Saved connection profiles</span>
        </div>
      </div>
    </div>
  );
};
