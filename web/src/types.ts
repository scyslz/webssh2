export interface SSHInfo {
  id?: string;
  name?: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  logintype?: number; // 0 for password, 1 for privateKey
}

export interface FileItem {
  name: string;
  size: string;
  rawSize?: number;
  modifyTime: string;
  isDir: boolean;
}

export interface FileListResponse {
  path: string;
  list: FileItem[];
}

export interface ResponseBody<T = any> {
  duration?: string;
  data?: T;
  msg: string;
}

export interface SSHTab {
  id: string;
  sessionId?: string;
  title: string;
  sshInfo: SSHInfo;
  sftpPath?: string;
  activeView: 'terminal' | 'sftp' | 'split';
  connected: boolean;
  clientLatencyMs?: number | null;
  sshLatencyMs?: number | null;
  error?: string;
  reconnectToken?: number;
  reconnectMode?: 'restore' | 'force';
}

export interface QuickCommandItem {
  id: string;
  label: string;
  cmd: string;
  enabled: boolean;
}

export const defaultQuickCommands: QuickCommandItem[] = [
  { id: 'ls', label: 'ls -la', cmd: 'ls -la\n', enabled: true },
  { id: 'top', label: 'top', cmd: 'top\n', enabled: true },
  { id: 'htop', label: 'htop', cmd: 'htop\n', enabled: true },
  { id: 'df', label: 'df -h', cmd: 'df -h\n', enabled: true },
  { id: 'free', label: 'free -m', cmd: 'free -m\n', enabled: true },
  { id: 'sigint', label: 'Ctrl+C', cmd: '\x03', enabled: true },
  { id: 'clear', label: 'Clear', cmd: 'clear\n', enabled: true },
];

export interface WebSSHConfig {
  savePass: boolean;
  timeout: number;
  fontSize: number;
  fontFamily: string;
  theme: 'dark' | 'dracula' | 'matrix' | 'light';
  httpsEnforced: boolean;
  originCheckEnabled: boolean;
  authEnabled: boolean;
  authUsername: string;
  authPassword: string;
  showQuickCmds: boolean;
  showKeyBar: boolean;
  quickCommands?: QuickCommandItem[];
}
