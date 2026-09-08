import React, { useEffect, useRef } from 'react';

interface KeepFocusButtonProps {
  onPress: () => void;
  className?: string;
  title?: string;
  disabled?: boolean;
  children?: React.ReactNode;
}

export const KeepFocusButton: React.FC<KeepFocusButtonProps> = ({
  onPress,
  className,
  title,
  disabled,
  children,
}) => {
  const ref = useRef<HTMLButtonElement>(null);
  const onPressRef = useRef(onPress);
  const ignoreClickRef = useRef(false);
  onPressRef.current = onPress;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      ignoreClickRef.current = true;
      if (el.disabled) return;
      onPressRef.current();
    };
    el.addEventListener('touchstart', handleTouchStart, { passive: false });
    return () => el.removeEventListener('touchstart', handleTouchStart);
  }, []);

  return (
    <button
      ref={ref}
      type="button"
      tabIndex={-1}
      disabled={disabled}
      title={title}
      className={className}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (ignoreClickRef.current) {
          ignoreClickRef.current = false;
          return;
        }
        onPressRef.current();
      }}
    >
      {children}
    </button>
  );
};
