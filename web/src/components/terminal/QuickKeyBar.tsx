import React from 'react';
import { CornerDownLeft } from 'lucide-react';

interface QuickKeyBarProps {
  isLight: boolean;
  ctrlActive: boolean;
  altActive: boolean;
  shiftActive: boolean;
  onCtrlToggle: () => void;
  onAltToggle: () => void;
  onShiftToggle: () => void;
  sendKeyToTerminal: (key: string) => void;
}

export const QuickKeyBar: React.FC<QuickKeyBarProps> = ({
  isLight,
  ctrlActive,
  altActive,
  shiftActive,
  onCtrlToggle,
  onAltToggle,
  onShiftToggle,
  sendKeyToTerminal,
}) => {
  const btnBg = isLight
    ? 'bg-white hover:bg-slate-200 text-slate-700 border-slate-300'
    : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700';

  return (
    <div
      className={`border-t px-1.5 py-0.5 w-full shadow-lg select-none transition-colors overflow-x-auto flex items-center gap-1 whitespace-nowrap no-scrollbar ${
        isLight ? 'bg-slate-100 border-slate-200 text-slate-800' : 'bg-slate-900 border-slate-800 text-slate-100'
      }`}
      style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
    >
      <button
        onClick={() => sendKeyToTerminal('\x1b')}
        className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-mono font-semibold border transition cursor-pointer flex items-center justify-center shrink-0 ${btnBg}`}
      >
        Esc
      </button>
      <button
        onClick={() => sendKeyToTerminal('\t')}
        className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-mono font-semibold border transition cursor-pointer flex items-center justify-center shrink-0 ${btnBg}`}
      >
        Tab
      </button>

      <div className={`h-2.5 w-[1px] shrink-0 my-auto ${isLight ? 'bg-slate-300' : 'bg-slate-800'}`} />

      <button
        onClick={onCtrlToggle}
        className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-bold font-mono border transition cursor-pointer flex items-center justify-center shrink-0 ${
          ctrlActive ? 'bg-rose-600 text-white border-rose-500 shadow-xs' : btnBg
        }`}
      >
        Ctrl
      </button>

      <button
        onClick={onAltToggle}
        className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-bold font-mono border transition cursor-pointer flex items-center justify-center shrink-0 ${
          altActive ? 'bg-amber-600 text-white border-amber-500 shadow-xs' : btnBg
        }`}
      >
        Alt
      </button>

      <button
        onClick={onShiftToggle}
        className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-bold font-mono border transition cursor-pointer flex items-center justify-center shrink-0 ${
          shiftActive ? 'bg-purple-600 text-white border-purple-500 shadow-xs' : btnBg
        }`}
      >
        Shift
      </button>

      <div className={`h-2.5 w-[1px] shrink-0 my-auto ${isLight ? 'bg-slate-300' : 'bg-slate-800'}`} />

      <button
        onClick={() => sendKeyToTerminal('\x1b[A')}
        className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-semibold border transition cursor-pointer flex items-center justify-center shrink-0 ${btnBg}`}
        title="Arrow Up"
      >
        ▲
      </button>
      <button
        onClick={() => sendKeyToTerminal('\x1b[B')}
        className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-semibold border transition cursor-pointer flex items-center justify-center shrink-0 ${btnBg}`}
        title="Arrow Down"
      >
        ▼
      </button>
      <button
        onClick={() => sendKeyToTerminal('\x1b[D')}
        className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-semibold border transition cursor-pointer flex items-center justify-center shrink-0 ${btnBg}`}
        title="Arrow Left"
      >
        ◀
      </button>
      <button
        onClick={() => sendKeyToTerminal('\x1b[C')}
        className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-semibold border transition cursor-pointer flex items-center justify-center shrink-0 ${btnBg}`}
        title="Arrow Right"
      >
        ▶
      </button>

      <div className={`h-2.5 w-[1px] shrink-0 my-auto ${isLight ? 'bg-slate-300' : 'bg-slate-800'}`} />

      <button
        onClick={() => sendKeyToTerminal('\x7f')}
        className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-mono font-semibold border transition cursor-pointer flex items-center justify-center shrink-0 ${btnBg}`}
      >
        Del
      </button>
      <button
        onClick={() => sendKeyToTerminal('\r')}
        className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-mono font-semibold border transition cursor-pointer flex items-center justify-center shrink-0 ${btnBg}`}
      >
        <CornerDownLeft className="w-3 h-3" />
      </button>
    </div>
  );
};
