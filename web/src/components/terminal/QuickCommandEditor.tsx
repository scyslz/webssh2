import React, { useState } from 'react';
import { X, Plus, ChevronUp, ChevronDown, Trash2, ToggleLeft, ToggleRight } from 'lucide-react';
import { QuickCommandItem, defaultQuickCommands } from '../../types';

const defaultIds = new Set(defaultQuickCommands.map((d) => d.id));

const parsePreview = (raw: string): string => {
  if (!raw.startsWith('@')) return raw;
  return raw.slice(1)
    .replace(/ctrl\+([a-z])|\^([a-z])/gi, (_, ctrl, caret) => `^${(ctrl || caret).toUpperCase()}`)
    .replace(/\\n/g, '⏎')
    .replace(/\\r/g, '⇠')
    .replace(/\\t/g, '⇥')
    .replace(/\\e/g, '⎋')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => `\\x${h}`);
};

interface QuickCommandEditorProps {
  isLight: boolean;
  commands: QuickCommandItem[];
  onSave: (commands: QuickCommandItem[]) => void;
  onClose: () => void;
}

let idCounter = Date.now();
const newId = () => `qc-${++idCounter}`;

export const QuickCommandEditor: React.FC<QuickCommandEditorProps> = ({
  isLight,
  commands: initialCommands,
  onSave,
  onClose,
}) => {
  const [items, setItems] = useState<QuickCommandItem[]>(initialCommands);

  const updateItem = (id: string, patch: Partial<QuickCommandItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const removeItem = (id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  };

  const toggleEnabled = (id: string) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, enabled: !item.enabled } : item)));
  };

  const moveItem = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    setItems((prev) => {
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const addItem = () => {
    setItems((prev) => [...prev, { id: newId(), label: '', cmd: '', enabled: true }]);
  };

  const bgClass = isLight ? 'bg-white text-slate-800' : 'bg-slate-900 text-slate-100';
  const inputClass = `w-full bg-transparent border rounded px-2 py-1 text-xs font-mono outline-none ${
    isLight ? 'border-slate-300 focus:border-slate-500' : 'border-slate-700 focus:border-slate-500'
  } disabled:opacity-50 disabled:cursor-not-allowed`;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4 z-50 select-none">
      <div className={`border rounded-xl w-full max-w-lg max-h-[90vh] shadow-2xl flex flex-col ${bgClass} ${isLight ? 'border-slate-200' : 'border-slate-800'}`}>
        <div className={`flex items-center justify-between px-4 py-3 border-b ${isLight ? 'border-slate-200' : 'border-slate-800'}`}>
          <h3 className="font-bold text-sm">Edit Quick Commands</h3>
          <button onClick={onClose} className={`p-1 rounded transition ${isLight ? 'hover:bg-slate-200' : 'hover:bg-slate-800'}`}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5 min-h-0">
          {items.map((item, index) => {
            const isDefault = defaultIds.has(item.id);
            return (
              <div
                key={item.id}
                className={`flex items-center gap-1.5 p-1.5 rounded-lg border ${
                  isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-950/60 border-slate-800'
                } ${!item.enabled ? (isLight ? 'opacity-60' : 'opacity-50') : ''}`}
              >
                <div className="flex flex-col gap-0.5 shrink-0">
                  <button
                    onClick={() => moveItem(index, -1)}
                    disabled={index === 0}
                    className="p-0.5 rounded disabled:opacity-20 hover:bg-slate-700/30 transition cursor-pointer"
                  >
                    <ChevronUp className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => moveItem(index, 1)}
                    disabled={index === items.length - 1}
                    className="p-0.5 rounded disabled:opacity-20 hover:bg-slate-700/30 transition cursor-pointer"
                  >
                    <ChevronDown className="w-3 h-3" />
                  </button>
                </div>

                <div className="flex-1 flex flex-col gap-1 min-w-0">
                  <input
                    value={item.label}
                    onChange={(e) => updateItem(item.id, { label: e.target.value })}
                    placeholder="Label"
                    disabled={isDefault}
                    className={inputClass}
                  />
                  <input
                    value={item.cmd}
                    onChange={(e) => updateItem(item.id, { cmd: e.target.value })}
                    placeholder='e.g. ls -la\n, @Ctrl+C, @\x1b[A'
                    disabled={isDefault}
                    className={inputClass}
                  />
                  {item.cmd && (
                    <div className={`text-[10px] font-mono truncate ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>
                      {'\u2192'} {parsePreview(item.cmd)}
                    </div>
                  )}
                </div>

                {isDefault ? (
                  <button
                    onClick={() => toggleEnabled(item.id)}
                    className={`p-1 rounded transition cursor-pointer shrink-0 ${
                      item.enabled
                        ? (isLight ? 'text-emerald-600 hover:bg-emerald-100' : 'text-emerald-400 hover:bg-emerald-500/20')
                        : (isLight ? 'text-slate-400 hover:bg-slate-200' : 'text-slate-500 hover:bg-slate-800')
                    }`}
                    title={item.enabled ? 'Disable' : 'Enable'}
                  >
                    {item.enabled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                  </button>
                ) : (
                  <button
                    onClick={() => removeItem(item.id)}
                    className="p-1 rounded text-rose-400 hover:bg-rose-500/20 transition cursor-pointer shrink-0"
                    title="Remove"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className={`px-3 py-2 border-t flex items-center justify-between gap-2 ${isLight ? 'border-slate-200' : 'border-slate-800'}`}>
          <button
            onClick={addItem}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-lg border text-xs font-medium transition cursor-pointer ${
              isLight ? 'bg-white hover:bg-slate-100 border-slate-300 text-slate-700' : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Command</span>
          </button>

          <button
            onClick={() => onSave(items)}
            className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};