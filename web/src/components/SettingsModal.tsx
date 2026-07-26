import React from 'react';
import { WebSSHConfig } from '../types';
import { themeOptions, isLightTheme } from '../theme';
import { X, Settings, Monitor, Type, Clock, LogOut, Lock, Shield } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: WebSSHConfig;
  onChangeConfig: (newConfig: WebSSHConfig) => void;
  onLogout?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  config,
  onChangeConfig,
  onLogout,
}) => {
  if (!isOpen) return null;

  const isLight = isLightTheme(config.theme);
  const fieldClass = `w-full border rounded-lg px-3 py-2 text-base sm:text-xs focus:outline-none font-mono ${
    isLight
      ? 'bg-white border-slate-300 text-slate-800 focus:border-slate-500'
      : 'bg-slate-950 border-slate-800 text-slate-200 focus:border-slate-700'
  }`;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 select-none">
      <div
        className={`border rounded-xl w-full max-w-md max-h-[min(88vh,44rem)] shadow-2xl overflow-hidden transition-colors flex flex-col ${
          isLight ? 'bg-white border-slate-200 text-slate-800' : 'bg-slate-900 border-slate-800 text-slate-100'
        }`}
      >
        {/* Header */}
        <div
          className={`px-5 py-3 border-b flex items-center justify-between ${
            isLight ? 'bg-slate-100 border-slate-200' : 'bg-slate-950 border-slate-800'
          }`}
        >
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-emerald-500" />
            <h2 className={`font-bold text-sm ${isLight ? 'text-slate-900' : 'text-slate-100'}`}>
              Terminal & Connection Settings
            </h2>
          </div>
          <button
            onClick={onClose}
            className={`transition p-1 ${isLight ? 'text-slate-400 hover:text-slate-700' : 'text-slate-400 hover:text-slate-200'}`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 overflow-y-auto overscroll-contain">
          <div>
            <label className={`block text-xs font-medium mb-2 flex items-center gap-1.5 ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
              <Monitor className="w-3.5 h-3.5 text-blue-500" />
              <span>Terminal Theme</span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              {themeOptions.map((t) => (
                <button
                  key={t.id}
                  onClick={() => onChangeConfig({ ...config, theme: t.id })}
                  className={`p-2.5 rounded-lg border text-xs font-medium text-left flex items-center justify-between transition cursor-pointer ${t.bg} ${
                    config.theme === t.id
                      ? 'ring-2 ring-emerald-500 border-emerald-500 font-bold'
                      : 'opacity-80 hover:opacity-100'
                  }`}
                >
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className={`block text-xs font-medium mb-1 flex items-center gap-1.5 ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
              <Type className="w-3.5 h-3.5 text-amber-500" />
              <span>Terminal Font Size ({config.fontSize}px)</span>
            </label>
            <input
              type="range"
              min={11}
              max={22}
              value={config.fontSize}
              onChange={(e) => onChangeConfig({ ...config, fontSize: Number(e.target.value) })}
              className="w-full accent-emerald-500 cursor-pointer"
            />
          </div>

          <div>
            <label className={`block text-xs font-medium mb-1 flex items-center gap-1.5 ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
              <Clock className="w-3.5 h-3.5 text-purple-500" />
              <span>Background Timeout (min)</span>
            </label>
            <input
              type="number"
              min={1}
              max={10080}
              value={config.timeout}
              onChange={(e) => onChangeConfig({ ...config, timeout: Math.max(1, Number(e.target.value)) })}
              className={fieldClass}
            />
            <p className="text-[10px] text-slate-400 mt-1">
              Keep SSH alive after tab disconnect. Default 120 min.
            </p>
          </div>

          <div className={`pt-2 border-t ${isLight ? 'border-slate-200' : 'border-slate-800'}`}>
            <label className={`flex items-center gap-2 text-xs cursor-pointer ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
              <input
                type="checkbox"
                checked={config.savePass}
                onChange={(e) => onChangeConfig({ ...config, savePass: e.target.checked })}
                className="rounded border-slate-400 bg-white text-emerald-600 focus:ring-0"
              />
              <span>Remember saved passwords</span>
            </label>
          </div>

          <div className={`pt-2 border-t space-y-3 ${isLight ? 'border-slate-200' : 'border-slate-800'}`}>
            <label className={`block text-xs font-medium mb-1 flex items-center gap-1.5 ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
              <Shield className="w-3.5 h-3.5 text-sky-500" />
              <span>Transport & Origin Checks</span>
            </label>
            <label className={`flex items-center gap-2 text-xs cursor-pointer ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
              <input
                type="checkbox"
                checked={config.httpsEnforced}
                onChange={(e) => onChangeConfig({ ...config, httpsEnforced: e.target.checked })}
                className="rounded border-slate-400 bg-white text-emerald-600 focus:ring-0"
              />
              <span>Require HTTPS / WSS</span>
            </label>
            <label className={`flex items-center gap-2 text-xs cursor-pointer ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
              <input
                type="checkbox"
                checked={config.originCheckEnabled}
                onChange={(e) => onChangeConfig({ ...config, originCheckEnabled: e.target.checked })}
                className="rounded border-slate-400 bg-white text-emerald-600 focus:ring-0"
              />
              <span>Enable browser Origin validation</span>
            </label>
          </div>

          <div className={`pt-2 border-t space-y-3 ${isLight ? 'border-slate-200' : 'border-slate-800'}`}>
            <label className={`flex items-center gap-2 text-xs cursor-pointer ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
              <input
                type="checkbox"
                checked={config.authEnabled}
                onChange={(e) => onChangeConfig({ ...config, authEnabled: e.target.checked })}
                className="rounded border-slate-400 bg-white text-emerald-600 focus:ring-0"
              />
              <span>Enable login protection</span>
            </label>

            {config.authEnabled && (
              <div className="space-y-3">
                <div>
                  <label className={`block text-xs font-medium mb-1 flex items-center gap-1.5 ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
                    <Lock className="w-3.5 h-3.5 text-emerald-500" />
                    <span>Login Username</span>
                  </label>
                  <input
                    type="text"
                    value={config.authUsername}
                    onChange={(e) => onChangeConfig({ ...config, authUsername: e.target.value })}
                    className={fieldClass}
                  />
                </div>
                <div>
                  <label className={`block text-xs font-medium mb-1 flex items-center gap-1.5 ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
                    <Lock className="w-3.5 h-3.5 text-rose-500" />
                    <span>Login Password</span>
                  </label>
                  <input
                    type="password"
                    value={config.authPassword}
                    onChange={(e) => onChangeConfig({ ...config, authPassword: e.target.value })}
                    className={fieldClass}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        <div className={`px-5 py-3 border-t flex items-center justify-between gap-3 ${isLight ? 'bg-slate-100 border-slate-200' : 'bg-slate-950 border-slate-800'}`}>
          {config.authEnabled && onLogout ? (
            <button
              onClick={onLogout}
              className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold transition cursor-pointer inline-flex items-center gap-1.5"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Logout</span>
            </button>
          ) : (
            <span />
          )}
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
