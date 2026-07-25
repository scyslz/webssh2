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
  error?: string;
  reconnectToken?: number;
  reconnectMode?: 'restore' | 'force';
}

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
}
