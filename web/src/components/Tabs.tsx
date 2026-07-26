import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { SSHTab } from '../types';
import { sessionGet } from '../storage';
import { Terminal, FolderTree, X, Columns } from 'lucide-react';

interface TabsProps {
  tabs: SSHTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCloseAllTabs?: () => void;
  onCloseOtherTabs?: (id: string) => void;
  onRenameTab: (id: string, title: string) => void;
  onDuplicateTab?: (id: string) => void;
  onToggleView: (id: string, view: 'terminal' | 'sftp' | 'split') => void;
  theme?: string;
}

interface ContextMenu {
  tabId: string;
  left: number;
  top: number;
}

export const Tabs: React.FC<TabsProps> = ({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onCloseAllTabs,
  onCloseOtherTabs,
  onDuplicateTab,
  onRenameTab,
  onToggleView,
  theme,
}) => {
  if (tabs.length === 0) return null;

  const isLight = theme === 'light';
  const currentTab = tabs.find((t) => t.id === activeTabId);
  const offlineHoldEnabled = typeof window !== 'undefined' && sessionGet('webssh_offline_hold') === '1';

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const editingValueRef = useRef('');
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (editingTabId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingTabId]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  useLayoutEffect(() => {
    if (!contextMenu || !menuRef.current) return;
    const el = menuRef.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = contextMenu.left;
    let top = contextMenu.top + 4;
    if (left + el.offsetWidth > vw) left = vw - el.offsetWidth - 8;
    if (top + el.offsetHeight > vh) top = contextMenu.top - el.offsetHeight - 4;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [contextMenu]);

  const commitRename = () => {
    if (!editingTabId) return;
    const val = editingValueRef.current.trim();
    if (val) onRenameTab(editingTabId, val);
    setEditingTabId(null);
  };

  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (editingTabId) commitRename();
    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenu({ tabId, left: rect.left, top: rect.bottom });
  };

  const handleTouchStart = (e: React.TouchEvent, tabId: string) => {
    if (editingTabId) commitRename();
    const rect = e.currentTarget.getBoundingClientRect();
    longPressTimerRef.current = setTimeout(() => {
      setContextMenu({ tabId, left: rect.left, top: rect.bottom });
    }, 500);
  };

  const handleTouchEnd = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleTouchMove = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  return (
    <>
      <div
        className={`border-b flex items-center justify-between px-2 py-0.5 select-none transition-colors ${
          isLight ? 'bg-slate-100 border-slate-200' : 'bg-slate-900/90 border-slate-800'
        }`}
      >
        <div className="flex items-center gap-0.5 overflow-x-auto scrollbar-none py-0 max-w-[58%] sm:max-w-[70%]">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const isEditing = editingTabId === tab.id;
            return (
              <div
                key={tab.id}
                onClick={() => { if (!isEditing) onSelectTab(tab.id); }}
                onContextMenu={(e) => handleContextMenu(e, tab.id)}
                onTouchStart={(e) => handleTouchStart(e, tab.id)}
                onTouchEnd={handleTouchEnd}
                onTouchMove={handleTouchMove}
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
                    tab.connected
                      ? 'bg-emerald-500 animate-pulse'
                      : offlineHoldEnabled
                      ? 'bg-amber-500'
                      : 'bg-rose-500'
                  }`}
                />
                {isEditing ? (
                  <input
                    ref={inputRef}
                    value={editValue}
                    onChange={(e) => {
                      setEditValue(e.target.value);
                      editingValueRef.current = e.target.value;
                    }}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setEditingTabId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className={`w-20 sm:w-32 bg-transparent border-b outline-none px-0.5 ${
                      isLight ? 'border-slate-400 text-slate-900' : 'border-slate-500 text-slate-100'
                    }`}
                  />
                ) : (
                  <span className="truncate max-w-[68px] sm:max-w-[130px] font-medium">{tab.title}</span>
                )}

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

      {contextMenu && (
        <div
          ref={menuRef}
          onMouseLeave={() => setContextMenu(null)}
          className={`fixed z-[9999] rounded-lg border py-0.5 text-[10px] sm:text-[11px] font-normal leading-none whitespace-nowrap flex flex-col min-w-[80px] ${
            isLight
              ? 'bg-white/10 backdrop-blur-sm border-slate-200/20 text-slate-500'
              : 'bg-slate-900/10 backdrop-blur-sm border-slate-700/20 text-slate-400'
          }`}
        >
          <button
            onClick={() => {
              const title = tabs.find((t) => t.id === contextMenu.tabId)?.title || '';
              setEditingTabId(contextMenu.tabId);
              setEditValue(title);
              editingValueRef.current = title;
              setContextMenu(null);
            }}
            className={`text-left px-1.5 py-1 transition cursor-pointer ${
              isLight ? 'hover:bg-slate-100/70' : 'hover:bg-slate-800/60'
            }`}
          >
            rename
          </button>
          <button
            onClick={() => {
              onDuplicateTab?.(contextMenu.tabId);
              setContextMenu(null);
            }}
            className={`text-left px-1.5 py-1 transition cursor-pointer ${
              isLight ? 'hover:bg-slate-100/70' : 'hover:bg-slate-800/60'
            }`}
          >
            copy
          </button>
          <button
            onClick={() => {
              onCloseOtherTabs?.(contextMenu.tabId);
              setContextMenu(null);
            }}
            className={`text-left px-1.5 py-1 transition cursor-pointer ${
              isLight ? 'hover:bg-slate-100/70' : 'hover:bg-slate-800/60'
            }`}
          >
            close others
          </button>
          <button
            onClick={() => {
              onCloseAllTabs?.();
              setContextMenu(null);
            }}
            className={`text-left px-1.5 py-1 transition cursor-pointer ${
              isLight ? 'hover:bg-slate-100/70' : 'hover:bg-slate-800/60'
            }`}
          >
            close all
          </button>
        </div>
      )}
    </>
  );
};
