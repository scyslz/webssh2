import React from 'react';
import { CornerDownLeft } from 'lucide-react';
import { KeepFocusButton } from './KeepFocusButton';
import { keyBarMetrics } from '../../keyBar';

interface QuickKeyBarProps {
  isLight: boolean;
  ctrlActive: boolean;
  altActive: boolean;
  shiftActive: boolean;
  onCtrlToggle: () => void;
  onAltToggle: () => void;
  onShiftToggle: () => void;
  sendKeyToTerminal: (key: string) => void;
  buttonSize?: number;
  haptic?: boolean;
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
  buttonSize,
  haptic,
}) => {
  const m = keyBarMetrics(buttonSize);
  const btnBg = isLight
    ? 'bg-white hover:bg-slate-200 text-slate-700 border-slate-300'
    : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700';
  const keyClass = `rounded font-mono font-semibold border transition cursor-pointer flex items-center justify-center shrink-0 ${btnBg}`;
  const keyStyle: React.CSSProperties = {
    height: m.height,
    minWidth: m.height,
    paddingLeft: m.padX,
    paddingRight: m.padX,
    fontSize: m.fontSize,
    lineHeight: 1,
  };

  return (
    <div
      className={`keybar-scroll border-t w-full shadow-lg select-none transition-colors overflow-x-auto flex items-center whitespace-nowrap no-scrollbar ${
        isLight ? 'bg-slate-100 border-slate-200 text-slate-800' : 'bg-slate-900 border-slate-800 text-slate-100'
      }`}
      style={{
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
        gap: m.gap,
        paddingLeft: m.barPadX,
        paddingRight: m.barPadX,
        paddingTop: m.barPadY,
        paddingBottom: m.barPadY,
      }}
    >
      <KeepFocusButton haptic={haptic} onPress={() => sendKeyToTerminal('\x1b')} className={keyClass} style={keyStyle}>
        Esc
      </KeepFocusButton>
      <KeepFocusButton haptic={haptic} onPress={() => sendKeyToTerminal('\t')} className={keyClass} style={keyStyle}>
        Tab
      </KeepFocusButton>

      <div
        className={`shrink-0 my-auto ${isLight ? 'bg-slate-300' : 'bg-slate-800'}`}
        style={{ width: 1, height: m.dividerH }}
      />

      <KeepFocusButton
        haptic={haptic}
        momentary={false}
        onPress={onCtrlToggle}
        className={`rounded font-bold font-mono border transition cursor-pointer flex items-center justify-center shrink-0 ${
          ctrlActive ? 'bg-rose-600 text-white border-rose-500 shadow-xs' : btnBg
        }`}
        style={keyStyle}
      >
        Ctrl
      </KeepFocusButton>

      <KeepFocusButton
        haptic={haptic}
        momentary={false}
        onPress={onAltToggle}
        className={`rounded font-bold font-mono border transition cursor-pointer flex items-center justify-center shrink-0 ${
          altActive ? 'bg-amber-600 text-white border-amber-500 shadow-xs' : btnBg
        }`}
        style={keyStyle}
      >
        Alt
      </KeepFocusButton>

      <KeepFocusButton
        haptic={haptic}
        momentary={false}
        onPress={onShiftToggle}
        className={`rounded font-bold font-mono border transition cursor-pointer flex items-center justify-center shrink-0 ${
          shiftActive ? 'bg-purple-600 text-white border-purple-500 shadow-xs' : btnBg
        }`}
        style={keyStyle}
      >
        Shift
      </KeepFocusButton>

      <div
        className={`shrink-0 my-auto ${isLight ? 'bg-slate-300' : 'bg-slate-800'}`}
        style={{ width: 1, height: m.dividerH }}
      />

      <KeepFocusButton haptic={haptic} onPress={() => sendKeyToTerminal('\x1b[A')} className={keyClass} style={keyStyle} title="Arrow Up">
        ▲
      </KeepFocusButton>
      <KeepFocusButton haptic={haptic} onPress={() => sendKeyToTerminal('\x1b[B')} className={keyClass} style={keyStyle} title="Arrow Down">
        ▼
      </KeepFocusButton>
      <KeepFocusButton haptic={haptic} onPress={() => sendKeyToTerminal('\x1b[D')} className={keyClass} style={keyStyle} title="Arrow Left">
        ◀
      </KeepFocusButton>
      <KeepFocusButton haptic={haptic} onPress={() => sendKeyToTerminal('\x1b[C')} className={keyClass} style={keyStyle} title="Arrow Right">
        ▶
      </KeepFocusButton>

      <div
        className={`shrink-0 my-auto ${isLight ? 'bg-slate-300' : 'bg-slate-800'}`}
        style={{ width: 1, height: m.dividerH }}
      />

      <KeepFocusButton haptic={haptic} onPress={() => sendKeyToTerminal('\x7f')} className={keyClass} style={keyStyle}>
        Del
      </KeepFocusButton>
      <KeepFocusButton haptic={haptic} onPress={() => sendKeyToTerminal('\r')} className={keyClass} style={keyStyle}>
        <CornerDownLeft style={{ width: m.icon, height: m.icon }} />
      </KeepFocusButton>
    </div>
  );
};
