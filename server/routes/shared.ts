import { Client as SSHClient } from 'ssh2';
import { ParsedSSHInfo, parseSSHInfo } from '../lib.ts';
import { SessionManager } from '../session-manager.ts';

export function resolveSSHInfo(sessionManager: SessionManager, sessionId: string | undefined, encodedInfo: string | undefined) {
  if (sessionId) {
    const sessionConfig = sessionManager.getSessionConfig(sessionId);
    if (sessionConfig) return sessionConfig;
  }
  if (!encodedInfo) throw new Error('Missing SSH session');
  return parseSSHInfo(encodedInfo);
}

export function connectSSH(
  config: ParsedSSHInfo,
  ready: (conn: SSHClient) => void,
  onError: (err: Error) => void,
  readyTimeout?: number
) {
  const conn = new SSHClient();
  conn.on('ready', () => ready(conn));
  conn.on('error', onError);
  conn.connect({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    privateKey: config.privateKey,
    passphrase: config.passphrase,
    readyTimeout,
  });
}
