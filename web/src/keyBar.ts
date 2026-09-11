export const KEY_BAR_SIZE_MIN = 20;
export const KEY_BAR_SIZE_MAX = 44;
export const KEY_BAR_SIZE_DEFAULT = 24;

export function clampKeyBarSize(size?: number): number {
  const n = Number(size);
  if (!Number.isFinite(n)) return KEY_BAR_SIZE_DEFAULT;
  return Math.min(KEY_BAR_SIZE_MAX, Math.max(KEY_BAR_SIZE_MIN, Math.round(n)));
}

export function keyBarMetrics(size?: number) {
  const s = clampKeyBarSize(size);
  return {
    size: s,
    height: s,
    padX: Math.max(6, Math.round(s * 0.28)),
    fontSize: Math.max(10, Math.round(s * 0.42)),
    icon: Math.max(12, Math.round(s * 0.5)),
    gap: Math.max(4, Math.round(s * 0.16)),
    barPadY: Math.max(2, Math.round(s * 0.1)),
    barPadX: Math.max(6, Math.round(s * 0.25)),
    dividerH: Math.max(10, Math.round(s * 0.45)),
  };
}
