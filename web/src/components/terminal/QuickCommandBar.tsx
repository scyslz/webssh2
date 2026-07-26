import React, { useState } from 'react';
import { Pencil } from 'lucide-react';
import { QuickCommandItem, defaultQuickCommands } from '../../types';
import { QuickCommandEditor } from './QuickCommandEditor';

interface QuickCommandBarProps {
  isLight: boolean;
  connected: boolean;
  offlineSuspended: boolean;
  sendKeyToTerminal: (key: string) => void;
  commands?: QuickCommandItem[];
  onSave?: (cmds: QuickCommandItem[]) => void;
}

const parseCommand = (raw: string): string => {
  if (!raw.startsWith('@')) return raw;
  return raw.slice(1)
    .replace(/ctrl\+([a-z])|\^([a-z])/gi, (_, ctrl, caret) => {
      const ch = (ctrl || caret).toLowerCase();
      return String.fromCharCode(ch.charCodeAt(0) - 96);
    })
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\e/g, '\x1b')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
};

export const QuickCommandBar: React.FC<QuickCommandBarProps> = ({
  isLight,
  connected,
  offlineSuspended,
  sendKeyToTerminal,
  commands = defaultQuickCommands,
  onSave,
}) => {
  const [editorOpen, setEditorOpen] = useState(false);

  const visibleCommands = commands.filter((c) => c.enabled);

  const btnBg = isLight
    ? 'bg-white hover:bg-slate-200 text-slate-700 border-slate-300'
    : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700';

  return (
    <>
      <div
        className={`border-b px-2 py-1 flex items-center gap-1 overflow-x-auto no-scrollbar transition-colors ${
          isLight ? 'bg-slate-50 border-slate-200' : 'bg-slate-900/80 border-slate-800'
        }`}
      >
        {visibleCommands.map((cmd) => (
          <button
            key={cmd.id}
            onClick={() => sendKeyToTerminal(parseCommand(cmd.cmd))}
            disabled={!(connected || offlineSuspended)}
            className={`px-2 py-0.5 rounded text-[10px] font-mono border transition cursor-pointer shrink-0 whitespace-nowrap disabled:opacity-40 ${btnBg}`}
          >
            {cmd.label}
          </button>
        ))}

        <button
          onClick={() => setEditorOpen(true)}
          className={`ml-auto p-1 rounded transition cursor-pointer shrink-0 ${
            isLight ? 'text-slate-400 hover:text-slate-600 hover:bg-slate-200' : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
          }`}
          title="Edit Quick Commands"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
      </div>

      {editorOpen && (
        <QuickCommandEditor
          isLight={isLight}
          commands={commands}
          onSave={(cmds) => {
            onSave?.(cmds);
            setEditorOpen(false);
          }}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </>
  );
};