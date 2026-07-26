export interface XTermTheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  selectionBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
}

const themes: Record<string, XTermTheme> = {
  dracula: {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    selectionBackground: '#44475a',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
  },
  matrix: {
    background: '#050b07',
    foreground: '#00ff66',
    cursor: '#00ff66',
    selectionBackground: '#003b15',
    black: '#000000',
    green: '#00ff66',
    white: '#aaffcc',
  },
  light: {
    background: '#ffffff',
    foreground: '#1e293b',
    cursor: '#0f172a',
    selectionBackground: '#cbd5e1',
    black: '#0f172a',
    red: '#dc2626',
    green: '#16a34a',
    yellow: '#d97706',
    blue: '#2563eb',
    magenta: '#9333ea',
    cyan: '#0891b2',
    white: '#f8fafc',
  },
  dark: {
    background: '#0a0f1d',
    foreground: '#e2e8f0',
    cursor: '#38bdf8',
    selectionBackground: '#334155',
    black: '#0f172a',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#facc15',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#38bdf8',
    white: '#f8f8f2',
  },
};

const defaultTheme: XTermTheme = themes.dark;

export function getXTermTheme(themeName: string): XTermTheme {
  return themes[themeName] || defaultTheme;
}

export function isLightTheme(themeName: string): boolean {
  return themeName === 'light';
}

export interface ThemeOption {
  id: string;
  label: string;
  bg: string;
}

export const themeOptions: ThemeOption[] = [
  { id: 'dark', label: 'Slate Dark', bg: 'bg-slate-900 border-slate-700 text-slate-200' },
  { id: 'dracula', label: 'Dracula', bg: 'bg-[#282a36] border-[#44475a] text-slate-200' },
  { id: 'matrix', label: 'Matrix', bg: 'bg-[#050b07] border-emerald-900 text-emerald-400' },
  { id: 'light', label: 'Light', bg: 'bg-white border-slate-300 text-slate-800' },
];
