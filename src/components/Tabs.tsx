import React from 'react';
import { SSHTab } from '../types';
import { Terminal, FolderTree, X, Columns } from 'lucide-react';

interface TabsProps {
  tabs: SSHTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onToggleView: (id: string, view: 'terminal' | 'sftp' | 'split') => void;
  theme?: string;
}

export const Tabs: React.FC<TabsProps> = ({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onToggleView,
  theme,
}) => {
  if (tabs.length === 0) return null;

  const isLight = theme === 'light';
  const currentTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div
      className={`border-b flex items-center justify-between px-2 py-0.5 select-none transition-colors ${
        isLight ? 'bg-slate-100 border-slate-200' : 'bg-slate-900/90 border-slate-800'
      }`}
    >
      <div className="flex items-center gap-0.5 overflow-x-auto scrollbar-none py-0 max-w-[58%] sm:max-w-[70%]">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              className={`group flex items-center gap-0.5 px-1 sm:px-2.5 py-1 rounded-t-md text-[10px] sm:text-[11px] font-mono transition cursor-pointer border-t border-x min-w-0 ${
                isActive
                  ? isLight
                    ? 'bg-white border-slate-300 text-slate-900 shadow-2xs font-semibold'
                    : 'bg-slate-950 border-slate-700 text-slate-100 shadow-xs'
                  : isLight
                  ? 'bg-slate-200/50 border-transparent text-slate-600 hover:text-slate-900 hover:bg-slate-200'
                  : 'bg-slate-900 border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  tab.connected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'
                }`}
              />
              <span className="truncate max-w-[68px] sm:max-w-[130px] font-medium">{tab.title}</span>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                className={`opacity-100 md:opacity-0 md:group-hover:opacity-100 rounded p-0.5 transition shrink-0 ${
                  isLight
                    ? 'hover:bg-slate-200 text-slate-500 hover:text-slate-800'
                    : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>

      {currentTab && (
        <div
          className={`flex items-center gap-0.5 p-0.5 rounded-md border ${
            isLight ? 'bg-white/80 border-slate-300' : 'bg-slate-950/60 border-slate-800'
          }`}
        >
          <button
            onClick={() => onToggleView(currentTab.id, 'terminal')}
            className={`p-1.5 rounded transition cursor-pointer ${
              currentTab.activeView === 'terminal'
                ? isLight
                  ? 'bg-emerald-100 text-emerald-800 font-semibold border border-emerald-300'
                  : 'bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30'
                : isLight
                ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
            title="Terminal"
          >
            <Terminal className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => onToggleView(currentTab.id, 'sftp')}
            className={`p-1.5 rounded transition cursor-pointer ${
              currentTab.activeView === 'sftp'
                ? isLight
                  ? 'bg-blue-100 text-blue-800 font-semibold border border-blue-300'
                  : 'bg-blue-500/20 text-blue-300 font-semibold border border-blue-500/30'
                : isLight
                ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
            title="SFTP Files"
          >
            <FolderTree className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => onToggleView(currentTab.id, 'split')}
            className={`p-1.5 rounded transition cursor-pointer ${
              currentTab.activeView === 'split'
                ? isLight
                  ? 'bg-purple-100 text-purple-800 font-semibold border border-purple-300'
                  : 'bg-purple-500/20 text-purple-300 font-semibold border border-purple-500/30'
                : isLight
                ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
            title="Split View"
          >
            <Columns className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};
