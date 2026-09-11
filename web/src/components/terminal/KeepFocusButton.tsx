import React, { useRef, useState } from 'react';
import { primeHaptic, triggerHaptic } from '../../haptic';

interface KeepFocusButtonProps {
  onPress: () => void;
  className?: string;
  pressedClassName?: string;
  style?: React.CSSProperties;
  title?: string;
  disabled?: boolean;
  haptic?: boolean;
  momentary?: boolean;
  children?: React.ReactNode;
}

const MOVE_THRESHOLD = 10;

function refocusTerminal() {
  const textarea = document.querySelector('.xterm textarea') as HTMLTextAreaElement | null;
  textarea?.focus({ preventScroll: true });
}

export const KeepFocusButton: React.FC<KeepFocusButtonProps> = ({
  onPress,
  className,
  pressedClassName = '!bg-sky-600 !text-white !border-sky-500',
  style,
  title,
  disabled,
  haptic,
  momentary = true,
  children,
}) => {
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const scrollingRef = useRef(false);
  const hapticDoneRef = useRef(false);
  const [pressed, setPressed] = useState(false);

  const clearPressed = () => setPressed(false);

  return (
    <button
      type="button"
      tabIndex={-1}
      disabled={disabled}
      title={title}
      className={`${className || ''} ${pressed ? pressedClassName : ''}`.trim()}
      style={{ WebkitTapHighlightColor: 'transparent', ...style }}
      onPointerDown={(e) => {
        if (disabled) return;
        if (e.pointerType === 'mouse') e.preventDefault();
        startXRef.current = e.clientX;
        startYRef.current = e.clientY;
        scrollingRef.current = false;
        hapticDoneRef.current = false;
        primeHaptic();
        if (e.pointerType !== 'mouse') {
          triggerHaptic(Boolean(haptic));
          hapticDoneRef.current = true;
        }
        if (momentary) setPressed(true);
      }}
      onPointerMove={(e) => {
        if (!pressed && !scrollingRef.current) return;
        const dx = e.clientX - startXRef.current;
        const dy = e.clientY - startYRef.current;
        if (Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD) {
          scrollingRef.current = true;
          clearPressed();
        }
      }}
      onPointerUp={clearPressed}
      onPointerCancel={clearPressed}
      onPointerLeave={clearPressed}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (disabled || scrollingRef.current) return;
        if (!hapticDoneRef.current) triggerHaptic(Boolean(haptic));
        onPress();
        refocusTerminal();
      }}
    >
      {children}
    </button>
  );
};
