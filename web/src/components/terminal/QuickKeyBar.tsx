import React from 'react';
import { CornerDownLeft } from 'lucide-react';
import { KeepFocusButton } from './KeepFocusButton';

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
  const keyClass = `px-1.5 py-0.5 h-5.5 rounded text-[10px] font-mono font-semibold border transition cursor-pointer flex items-center justify-center shrink-0 ${btnBg}`;

  return (
    <div
      className={`border-t px-1.5 py-0.5 w-full shadow-lg select-none transition-colors overflow-x-auto flex items-center gap-1 whitespace-nowrap no-scrollbar ${
        isLight ? 'bg-slate-100 border-slate-200 text-slate-800' : 'bg-slate-900 border-slate-800 text-slate-100'
      }`}
      style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
    >
      <KeepFocusButton onPress={() => sendKeyToTerminal('\x1b')} className={keyClass}>
        Esc
      </KeepFocusButton>
      <KeepFocusButton onPress={() => sendKeyToTerminal('\t')} className={keyClass}>
        Tab
      </KeepFocusButton>

      <div className={`h-2.5 w-[1px] shrink-0 my-auto ${isLight ? 'bg-slate-300' : 'bg-slate-800'}`} />

      <KeepFocusButton
        onPress={onCtrlToggle}
        className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-bold font-mono border transition cursor-pointer flex items-center justify-center shrink-0 ${
          ctrlActive ? 'bg-rose-600 text-white border-rose-500 shadow-xs' : btnBg
        }`}
      >
        Ctrl
      </KeepFocusButton>

      <KeepFocusButton
        onPress={onAltToggle}
        className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-bold font-mono border transition cursor-pointer flex items-center justify-center shrink-0 ${
          altActive ? 'bg-amber-600 text-white border-amber-500 shadow-xs' : btnBg
        }`}
      >
        Alt
      </KeepFocusButton>

      <KeepFocusButton
        onPress={onShiftToggle}
        className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-bold font-mono border transition cursor-pointer flex items-center justify-center shrink-0 ${
          shiftActive ? 'bg-purple-600 text-white border-purple-500 shadow-xs' : btnBg
        }`}
      >
        Shift
      </KeepFocusButton>

      <div className={`h-2.5 w-[1px] shrink-0 my-auto ${isLight ? 'bg-slate-300' : 'bg-slate-800'}`} />

      <KeepFocusButton onPress={() => sendKeyToTerminal('\x1b[A')} className={keyClass} title="Arrow Up">
        ▲
      </KeepFocusButton>
      <KeepFocusButton onPress={() => sendKeyToTerminal('\x1b[B')} className={keyClass} title="Arrow Down">
        ▼
      </KeepFocusButton>
      <KeepFocusButton onPress={() => sendKeyToTerminal('\x1b[D')} className={keyClass} title="Arrow Left">
        ◀
      </KeepFocusButton>
      <KeepFocusButton onPress={() => sendKeyToTerminal('\x1b[C')} className={keyClass} title="Arrow Right">
        ▶
      </KeepFocusButton>

      <div className={`h-2.5 w-[1px] shrink-0 my-auto ${isLight ? 'bg-slate-300' : 'bg-slate-800'}`} />

      <KeepFocusButton onPress={() => sendKeyToTerminal('\x7f')} className={keyClass}>
        Del
      </KeepFocusButton>
      <KeepFocusButton onPress={() => sendKeyToTerminal('\r')} className={keyClass}>
        <CornerDownLeft className="w-3 h-3" />
      </KeepFocusButton>
    </div>
  );
};
