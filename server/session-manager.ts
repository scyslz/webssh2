import http from 'http';
import net from 'net';
import { Client as SSHClient } from 'ssh2';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import {
  isAllowedOrigin,
  isAuthenticated,
  isAuthConfigured,
  isHttpsRequest,
  parseSSHInfo,
  ParsedSSHInfo,
  readAppConfig,
  readSavedHosts,
  createSessionId,
  sshErrorDetails,
  sshErrorText,
  sshLog,
  sshSummary,
} from './lib.ts';

interface SSHSession {
  id: string;
  sshConfig: ParsedSSHInfo;
  client: SSHClient;
  stream: any;
  history: Buffer[];
  historySize: number;
  cols: number;
  rows: number;
  attachedSockets: Set<WebSocket>;
  createdAt: number;
  lastActivity: number;
  hasAttachedOnce?: boolean;
  shared: boolean;
  ownerClientId?: string;
  title?: string;
  disconnectTimer?: NodeJS.Timeout;
  sshLatencyMs?: number;
  latencyProbeTimer?: NodeJS.Timeout;
  latencyProbeInFlight?: boolean;
}

interface SysClient {
  windowId: string;
  ws: WebSocket;
  lastPingTs: number | null;
  clientRttMs: number | null;
  snapshotTimer: NodeJS.Timeout | null;
}

export interface SessionHealth {
  sessionId: string;
  ownerClientId: string;
  host: string;
  port: number;
  username: string;
  sshLatencyMs: number | null;
  connectedAt: number;
  lastActivity: number;
  attachedClients: number;
  shared: boolean;
  title?: string;
  credentialId?: string;
}

export interface HealthSnapshot {
  type: 'health_snapshot';
  ts: number;
  clientRttMs: number | null;
  sessions: SessionHealth[];
  server: {
    uptimeSec: number;
    activeSessions: number;
    memRssMb: number;
  };
}

const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const WS_META_PREFIX = '__WEBSSH_META__:';
const SESSION_ATTACH_GRACE_MS = 30000;
const SYS_SNAPSHOT_INTERVAL_MS = 5000;
const SYS_PONG_TIMEOUT_MS = 15000;
// OpenSSH-style keepalive: send `keepalive@openssh.com` global requests over the
// real SSH transport. There is no dedicated RFC keepalive message; this is the
// de-facto standard. If `SSH_KEEPALIVE_COUNT_MAX` consecutive requests go
// unanswered (dead but TCP-open channel), ssh2 tears the connection down so the
// wedged session is cleaned up instead of silently swallowing all input.
const SSH_KEEPALIVE_INTERVAL_MS = 25000;
const SSH_KEEPALIVE_COUNT_MAX = 3;

function sendTerminalMessage(ws: WebSocket, message: string | Buffer) {
  if (ws.readyState === WebSocket.OPEN) ws.send(message);
}

function sendMetaMessage(ws: WebSocket, payload: Record<string, unknown>) {
  sendTerminalMessage(ws, `${WS_META_PREFIX}${JSON.stringify(payload)}`);
}

function decodeIncomingMessage(msg: Buffer | string) {
  return typeof msg === 'string' ? msg : msg.toString('utf-8');
}

function normalizeIncomingData(msg: RawData, isBinary: boolean): Buffer | string {
  if (!isBinary && typeof msg === 'string') return msg;
  if (Buffer.isBuffer(msg)) return msg;
  if (msg instanceof ArrayBuffer) return Buffer.from(msg);
  if (Array.isArray(msg)) return Buffer.concat(msg.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  return Buffer.from(msg as ArrayBufferLike);
}

export interface SessionManager {
  attachServer(server: http.Server): void;
  getSessionConfig(sessionId: string): ParsedSSHInfo | undefined;
  getSessionClient(sessionId: string): SSHClient | undefined;
  listSessions(): Array<{
    id: string;
    host: string;
    port: number;
    username: string;
    createdAt: number;
    lastActivity: number;
    attachedClients: number;
    ownerClientId: string;
    shared: boolean;
    credentialId: string;
    title?: string;
  }>;
  getSessionStatus(sessionId: string): {
    exists: boolean;
    attachedClients?: number;
    hasAttachedOnce?: boolean;
    ownerClientId?: string;
    createdAt?: number;
    lastActivity?: number;
    host?: string;
    username?: string;
  };
  createLiveSession(
    sessionId: string,
    sshConfig: ParsedSSHInfo,
    options: { cols: number; rows: number; ownerClientId?: string; keepAliveMs: number; title?: string }
  ): Promise<unknown>;
  killSession(args: { sessionId?: string; sessionIds?: string[]; force?: boolean; clientId?: string }): { status: number; body: Record<string, unknown> };
  renameSession(sessionId: string, title: string): { status: number; body: Record<string, unknown> };
}

export function createSessionManager(): SessionManager {
  const sshSessions = new Map<string, SSHSession>();
  const wss = new WebSocketServer({ noServer: true });
  const sysClients = new Map<string, SysClient>();
  const startTime = Date.now();

  function broadcastSessionSharedState(session: SSHSession) {
    for (const clientWs of session.attachedSockets) {
      if (clientWs.readyState === WebSocket.OPEN) {
        sendMetaMessage(clientWs, { type: 'shared_state', sessionId: session.id, shared: session.shared });
      }
    }
  }

  function broadcastSessionTitle(session: SSHSession) {
    for (const clientWs of session.attachedSockets) {
      if (clientWs.readyState === WebSocket.OPEN) {
        sendMetaMessage(clientWs, { type: 'session_title', sessionId: session.id, title: session.title });
      }
    }
  }

  function closeAttachedSession(session: SSHSession) {
    if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
    if (session.latencyProbeTimer) clearInterval(session.latencyProbeTimer);
    session.latencyProbeTimer = undefined;
    session.latencyProbeInFlight = false;
    for (const ws of session.attachedSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        sendTerminalMessage(ws, '\r\n\x1b[33m[WebSSH] Session terminated by user.\x1b[0m\r\n');
        ws.close();
      }
    }
    try { session.stream?.end(); session.client?.end(); } catch {}
    sshSessions.delete(session.id);
    broadcastHealthSnapshots();
  }

  function scheduleSessionDisconnect(session: SSHSession, delayMs: number) {
    if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
    session.disconnectTimer = setTimeout(() => {
      if (session.attachedSockets.size === 0) {
        try { session.stream?.end(); session.client?.end(); } catch {}
        sshSessions.delete(session.id);
        sshLog('session removed after detach timeout', { sessionId: session.id, delayMs });
      }
    }, delayMs);
  }

  function attachToSession(session: SSHSession, ws: WebSocket, clientId: string, force = false) {
    if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer);
      session.disconnectTimer = undefined;
    }

    if (!session.shared && session.ownerClientId && session.ownerClientId !== clientId && session.attachedSockets.size > 0) {
      if (force) {
        for (const clientWs of session.attachedSockets) {
          if (clientWs.readyState === WebSocket.OPEN) {
            sendMetaMessage(clientWs, { type: 'session_taken_over', sessionId: session.id });
            sendTerminalMessage(clientWs, '\r\n\x1b[33m[WebSSH] Session taken over by another browser tab or device.\x1b[0m\r\n');
            clientWs.close(4001, 'Session taken over');
          }
        }
        session.attachedSockets.clear();
      } else {
        sendMetaMessage(ws, { type: 'session_busy', sessionId: session.id });
        sendTerminalMessage(ws, '\r\n\x1b[31m[WebSSH] Session is already attached from another browser tab or device.\x1b[0m\r\n');
        ws.close(1008, 'Session already attached');
        return false;
      }
    }

    session.ownerClientId = clientId || session.ownerClientId;

    if (!session.shared) {
      for (const clientWs of session.attachedSockets) {
        if (clientWs !== ws) {
          if (clientWs.readyState === WebSocket.OPEN) {
            sendTerminalMessage(clientWs, '\r\n\x1b[33m[WebSSH] Session reattached by the same browser tab.\x1b[0m\r\n');
            clientWs.close();
          }
          session.attachedSockets.delete(clientWs);
        }
      }
    }

    session.attachedSockets.add(ws);
    session.hasAttachedOnce = true;
    session.lastActivity = Date.now();
    return true;
  }

  function broadcastSshLatency(session: SSHSession, latencyMs: number) {
    session.sshLatencyMs = latencyMs;
    broadcastHealthSnapshots();
  }

  function buildHealthSnapshot(sys: SysClient): HealthSnapshot {
    const sessions: SessionHealth[] = [];
    for (const session of sshSessions.values()) {
      sessions.push({
        sessionId: session.id,
        ownerClientId: session.ownerClientId || '',
        host: session.sshConfig.host,
        port: session.sshConfig.port,
        username: session.sshConfig.username,
        sshLatencyMs: session.sshLatencyMs ?? null,
        connectedAt: session.createdAt,
        lastActivity: session.lastActivity,
        attachedClients: session.attachedSockets.size,
        shared: session.shared,
        title: session.title,
        credentialId: session.sshConfig.id || undefined,
      });
    }
    return {
      type: 'health_snapshot',
      ts: Date.now(),
      clientRttMs: sys.clientRttMs,
      sessions,
      server: {
        uptimeSec: Math.round((Date.now() - startTime) / 1000),
        activeSessions: sshSessions.size,
        memRssMb: Math.round((process.memoryUsage().rss || 0) / 1024 / 1024),
      },
    };
  }

  function sendHealthSnapshot(sys: SysClient) {
    if (sys.ws.readyState !== WebSocket.OPEN) return;
    const snapshot = buildHealthSnapshot(sys);
    sys.ws.send(JSON.stringify(snapshot));
  }

  // Broadcast to all /sys clients immediately (event-driven)
  function broadcastHealthSnapshots() {
    for (const sys of sysClients.values()) {
      sendHealthSnapshot(sys);
    }
  }

  function startSysSnapshotTimer(sys: SysClient) {
    if (sys.snapshotTimer) clearInterval(sys.snapshotTimer);
    sys.snapshotTimer = setInterval(() => {
      sendHealthSnapshot(sys);
    }, SYS_SNAPSHOT_INTERVAL_MS);
  }

  function handleSysConnection(ws: WebSocket, windowId: string) {
    const sys: SysClient = {
      windowId,
      ws,
      lastPingTs: null,
      clientRttMs: null,
      snapshotTimer: null,
    };
    sysClients.set(windowId, sys);
    sshLog('sys connected', { windowId });

    // Send immediate snapshot on connect
    sendHealthSnapshot(sys);
    startSysSnapshotTimer(sys);

    ws.on('message', (msg: RawData) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'ping') {
          sys.lastPingTs = Date.now();
          const rtt = typeof data.ts === 'number' ? Date.now() - data.ts : null;
          if (rtt !== null) {
            sys.clientRttMs = rtt;
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong', ts: data.ts, clientRttMs: sys.clientRttMs }));
          }
        }
      } catch {
        // ignore
      }
    });

    ws.on('close', () => {
      sshLog('sys disconnected', { windowId });
      if (sys.snapshotTimer) clearInterval(sys.snapshotTimer);
      sysClients.delete(windowId);
    });

    ws.on('error', () => {
      if (sys.snapshotTimer) clearInterval(sys.snapshotTimer);
      sysClients.delete(windowId);
    });
  }

  function probeSessionLatency(session: SSHSession) {
    if (session.latencyProbeInFlight) return;
    session.latencyProbeInFlight = true;

    const host = session.sshConfig.host;
    const port = session.sshConfig.port || 22;
    const startedAt = Date.now();
    const socket = new net.Socket();

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
      session.latencyProbeInFlight = false;
    };

    socket.setTimeout(5000);
    socket.on('connect', () => {
      const latency = Date.now() - startedAt;
      broadcastSshLatency(session, latency);
      cleanup();
    });
    socket.on('error', cleanup);
    socket.on('timeout', cleanup);
    socket.connect(port, host);
  }

  function startSessionLatencyProbe(session: SSHSession) {
    if (session.latencyProbeTimer) clearInterval(session.latencyProbeTimer);
    probeSessionLatency(session);
    session.latencyProbeTimer = setInterval(() => {
      probeSessionLatency(session);
    }, 10000);
  }

  async function createLiveSession(
    sessionId: string,
    sshConfig: ParsedSSHInfo,
    options: { cols: number; rows: number; ownerClientId?: string; keepAliveMs: number; title?: string }
  ) {
    return new Promise<SSHSession>((resolve, reject) => {
      const conn = new SSHClient();
      let settled = false;
      let sshReady = false;
      let currentSession: SSHSession | null = null;

      function teardownSession(session: SSHSession, message: string) {
        if (!sshSessions.has(session.id)) return;
        sshLog('session teardown via keepalive guard', { sessionId: session.id, message });
        if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
        session.disconnectTimer = undefined;
        if (session.latencyProbeTimer) clearInterval(session.latencyProbeTimer);
        session.latencyProbeTimer = undefined;
        session.latencyProbeInFlight = false;
        for (const clientWs of session.attachedSockets) {
          if (clientWs.readyState === WebSocket.OPEN) {
            sendTerminalMessage(clientWs, `\r\n\x1b[33m[WebSSH] ${message}. A fresh session will be created automatically.\x1b[0m\r\n`);
            clientWs.close(1011, message);
          }
        }
        session.attachedSockets.clear();
        try { session.stream?.end(); } catch {}
        try { conn.end(); } catch {}
        sshSessions.delete(session.id);
      }

      const sshWatchdog = setTimeout(() => {
        if (settled) return;
        settled = true;
        const err = new Error('SSH handshake timed out');
        sshLog('SSH connection watchdog timeout', { sessionId, ...sshSummary(sshConfig) });
        try { conn.end(); } catch {}
        reject(err);
      }, 20000);

      conn.on('ready', () => {
        sshReady = true;
        clearTimeout(sshWatchdog);
        sshLog('SSH ready', { sessionId, ...sshSummary(sshConfig) });
        conn.shell({ term: 'xterm-256color', cols: options.cols, rows: options.rows }, (err, stream) => {
          if (settled) {
            try { conn.end(); } catch {}
            return;
          }
          if (err) {
            settled = true;
            sshLog('SSH shell failed', { sessionId, error: err.message });
            try { conn.end(); } catch {}
            reject(err);
            return;
          }
          sshLog('SSH shell opened', { sessionId });

          const session: SSHSession = {
            id: sessionId,
            sshConfig,
            client: conn,
            stream,
            history: [],
            historySize: 0,
            cols: options.cols,
            rows: options.rows,
            attachedSockets: new Set(),
            createdAt: Date.now(),
            lastActivity: Date.now(),
            shared: false,
            ownerClientId: options.ownerClientId || undefined,
            title: options.title,
          };
          currentSession = session;
          sshSessions.set(sessionId, session);
          startSessionLatencyProbe(session);
          scheduleSessionDisconnect(session, SESSION_ATTACH_GRACE_MS);
          broadcastHealthSnapshots();

          stream.on('data', (data: Buffer) => {
            session.history.push(data);
            session.historySize += data.length;
            session.lastActivity = Date.now();
            while (session.historySize > MAX_HISTORY_BYTES && session.history.length > 1) {
              const removed = session.history.shift();
              if (removed) session.historySize -= removed.length;
            }
            for (const clientWs of session.attachedSockets) {
              if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
            }
          });

          stream.on('close', () => {
            sshLog('SSH shell closed', { sessionId });
            if (session.latencyProbeTimer) clearInterval(session.latencyProbeTimer);
            session.latencyProbeTimer = undefined;
            session.latencyProbeInFlight = false;
            for (const clientWs of session.attachedSockets) {
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send('\r\n\x1b[33mConnection closed by remote host.\x1b[0m\r\n');
                clientWs.close();
              }
            }
            if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
            sshSessions.delete(sessionId);
            conn.end();
          });

          conn.on('close', () => {
            clearTimeout(sshWatchdog);
            sshLog('SSH client closed', { sessionId, sshReady });
            if (currentSession && sshSessions.has(currentSession.id)) {
              teardownSession(currentSession, 'SSH connection closed');
            }
          });

          settled = true;
          resolve(session);
        });
      });

      conn.on('error', (err) => {
        clearTimeout(sshWatchdog);
        const errorDetails = sshErrorDetails(err);
        sshLog('SSH connection error', {
          sessionId,
          error: errorDetails,
          ...sshSummary(sshConfig),
        });
        console.error(`[webssh-ssh] raw SSH error for session ${sessionId}`, err);
        // On 'error' ssh2 is already closing the underlying socket; make sure any
        // established session (e.g. keepalive timeout on a half-dead channel) is
        // torn down so clients can't keep typing into it.
        if (currentSession && sshSessions.has(currentSession.id)) {
          teardownSession(currentSession, 'SSH connection error');
          return;
        }
        if (!settled) {
          settled = true;
          reject(err);
        }
        try { conn.end(); } catch {}
      });

      sshLog('SSH connect started', { sessionId, ...sshSummary(sshConfig) });
      conn.connect({
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        password: sshConfig.password,
        privateKey: sshConfig.privateKey,
        passphrase: sshConfig.passphrase,
        readyTimeout: 15000,
        // OpenSSH-style keepalive (keepalive@openssh.com). Guard the real SSH
        // channel: if `SSH_KEEPALIVE_COUNT_MAX` consecutive requests go
        // unanswered, ssh2 emits 'error' and destroys the socket, which triggers
        // teardownSession above instead of silently dropping user input.
        keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
      });
    });
  }

  function attachServer(server: http.Server) {
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '', `http://${request.headers.host}`);

      // Handle /sys WebSocket
      if (url.pathname === '/sys') {
        const config = readAppConfig();
        const httpsEnforced = config.httpsEnforced ?? (process.env.WEBSSH_REQUIRE_HTTPS === 'true');
        if (httpsEnforced && !isHttpsRequest(request)) {
          socket.write('HTTP/1.1 426 Upgrade Required\r\n\r\n');
          socket.destroy();
          return;
        }
        if (isAuthConfigured(config) && !isAuthenticated(request, config)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        const windowId = url.searchParams.get('windowId') || 'default';
        wss.handleUpgrade(request, socket, head, (ws) => {
          handleSysConnection(ws, windowId);
        });
        return;
      }

      if (url.pathname !== '/term' && url.pathname !== '/terminal') {
        socket.destroy();
        return;
      }

      sshLog('websocket upgrade requested', {
        path: url.pathname,
        sessionId: url.searchParams.get('sessionId') || url.searchParams.get('id') || '',
        origin: request.headers.origin || '(none)',
      });

      const config = readAppConfig();
      const httpsEnforced = config.httpsEnforced ?? (process.env.WEBSSH_REQUIRE_HTTPS === 'true');
      if (httpsEnforced && !isHttpsRequest(request)) {
        sshLog('websocket upgrade rejected: HTTPS required');
        socket.write('HTTP/1.1 426 Upgrade Required\r\n\r\n');
        socket.destroy();
        return;
      }

      const originCheckEnabled = config.originCheckEnabled ?? true;
      if (originCheckEnabled && !isAllowedOrigin(request, request.headers.origin)) {
        sshLog('websocket upgrade rejected: invalid origin', { origin: request.headers.origin || '(none)' });
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      if (isAuthConfigured(config) && !isAuthenticated(request, config)) {
        sshLog('websocket upgrade rejected: unauthorized');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      sshLog('websocket upgrade accepted');
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, url);
      });
    });

    wss.on('connection', (ws: WebSocket, _request: http.IncomingMessage, url: URL) => {
      const sessionId = url.searchParams.get('sessionId') || url.searchParams.get('id') || '';
      const clientId = url.searchParams.get('clientId') || '';
      const sshInfoParam = url.searchParams.get('sshInfo') || '';
      const credentialId = url.searchParams.get('credentialId') || '';
      const title = url.searchParams.get('title') || '';
      const forceAttach = url.searchParams.get('forceAttach') === '1';
      const cols = parseInt(url.searchParams.get('cols') || '120', 10);
      const rows = parseInt(url.searchParams.get('rows') || '30', 10);
      const timeoutMins = parseInt(url.searchParams.get('timeout') || '120', 10);
      const keepAliveMs = (timeoutMins > 0 ? timeoutMins : 120) * 60 * 1000;

      let existingSession: SSHSession | undefined = sessionId ? sshSessions.get(sessionId) : undefined;
      // ws 绑定后新创建的会话需要更新引用，否则 message/close 无法关联
      const bindSession = (s: SSHSession) => { existingSession = s; };
      sshLog('websocket connected', {
        sessionId: sessionId || '(none)',
        clientId: clientId || '(none)',
        hasSshInfo: !!sshInfoParam,
        credentialId: credentialId || '(none)',
        forceAttach,
        existingSession: Boolean(existingSession),
      });

      const fail = (code: string, message: string) => {
        sshLog('websocket closed: ' + message, { sessionId });
        if (ws.readyState === WebSocket.OPEN) {
          sendMetaMessage(ws, { type: 'ssh_connection_error', code, message, sessionId });
          ws.send(`\r\n\x1b[31mError: ${message}\x1b[0m\r\n`);
          ws.close(1011, message);
        }
      };

      const attach = (session: SSHSession) => {
        if (!attachToSession(session, ws, clientId, forceAttach)) {
          sshLog('session attach rejected', { sessionId: session.id, reason: 'busy-after-create' });
          return;
        }
        bindSession(session);
        sshLog('session attached', {
          sessionId: session.id,
          clientId: clientId || '(none)',
          forceAttach,
          historyBytes: session.historySize,
        });
        session.cols = cols;
        session.rows = rows;
        try { session.stream.setWindow(rows, cols, 0, 0); } catch {}
        if (ws.readyState === WebSocket.OPEN) {
          sendMetaMessage(ws, {
            type: 'session_info',
            sessionId: session.id,
            reattached: session.history.length > 0,
            shared: session.shared,
          });
          for (const chunk of session.history) ws.send(chunk);
        }
      };

      const createAndAttach = async () => {
        try {
          const resolvedSessionId = sessionId || createSessionId();
          if (sshSessions.has(resolvedSessionId)) {
            attach(sshSessions.get(resolvedSessionId)!);
            return;
          }
          let sshConfig: ParsedSSHInfo;
          if (credentialId) {
            const saved = readSavedHosts().find((h) => h.id === credentialId);
            if (!saved) { fail('CREDENTIAL_NOT_FOUND', 'Saved credential not found'); return; }
            sshConfig = parseSSHInfo(JSON.stringify(saved));
          } else if (sshInfoParam) {
            sshLog('parseSSHInfo input', { firstChar: sshInfoParam[0], length: sshInfoParam.length, preview: sshInfoParam.substring(0, 80) });
            sshConfig = parseSSHInfo(sshInfoParam);
          } else {
            fail('SESSION_NOT_FOUND', 'Session not found or expired');
            return;
          }
          const session = await createLiveSession(resolvedSessionId, sshConfig, {
            cols, rows, ownerClientId: clientId, keepAliveMs,
            title: title || `${sshConfig.username}@${sshConfig.host}`,
          });
          attach(session as SSHSession);
        } catch (err: any) {
          fail('SSH_CREATE_ERROR', sshErrorText(err) || err.message || 'Failed to create SSH session');
        }
      };

      if (existingSession) {
        attach(existingSession);
      } else if (sshInfoParam || credentialId) {
        createAndAttach();
      } else {
        fail('SESSION_NOT_FOUND', 'Session not found or expired');
        return;
      }

      ws.on('message', (msg: RawData, isBinary: boolean) => {
        const payload = normalizeIncomingData(msg, isBinary);
        const raw = typeof payload === 'string' ? payload : decodeIncomingMessage(payload);
        // ping 需在未绑定会话前也可响应，避免心跳超时
        if (!isBinary && raw.startsWith('{') && raw.endsWith('}')) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.type === 'ping') {
              sendMetaMessage(ws, { type: 'pong', ts: parsed.ts ?? Date.now(), serverTs: Date.now() });
              return;
            }
          } catch {}
        }
        if (!existingSession) return;
        if (!isBinary && raw.startsWith('{') && raw.endsWith('}')) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
              existingSession.cols = parsed.cols;
              existingSession.rows = parsed.rows;
              existingSession.stream.setWindow(parsed.rows, parsed.cols, 0, 0);
              return;
            }
            if (parsed.type === 'kill_session') {
              closeAttachedSession(existingSession);
              return;
            }
            if (parsed.type === 'set_shared' && typeof parsed.shared === 'boolean') {
              existingSession.shared = parsed.shared;
              sshLog('session sharing changed', { sessionId: existingSession.id, shared: existingSession.shared, clientId });
              broadcastSessionSharedState(existingSession);
              return;
            }
            if (parsed.type === 'rename_session' && typeof parsed.title === 'string') {
              existingSession.title = parsed.title;
              broadcastSessionTitle(existingSession);
              return;
            }
          } catch {}
        }
        try { existingSession.stream.write(payload); } catch {}
      });

      ws.on('close', () => {
        if (!existingSession) {
          sshLog('websocket closed: no session attached', { sessionId: sessionId || '(none)' });
          return;
        }
        sshLog('websocket closed', { sessionId: existingSession.id, readyState: ws.readyState });
        existingSession.attachedSockets.delete(ws);
        if (existingSession.attachedSockets.size === 0) {
          scheduleSessionDisconnect(existingSession, keepAliveMs);
        }
        broadcastHealthSnapshots();
      });

      ws.on('error', () => {
        if (existingSession) {
          existingSession.attachedSockets.delete(ws);
        }
      });
    });
  }

  return {
    attachServer,
    getSessionConfig(sessionId: string) {
      return sshSessions.get(sessionId)?.sshConfig;
    },
    getSessionClient(sessionId: string) {
      return sshSessions.get(sessionId)?.client;
    },
    listSessions() {
      return Array.from(sshSessions.values())
        .filter((session) => session.hasAttachedOnce)
        .map((session) => ({
          id: session.id,
          host: session.sshConfig.host,
          port: session.sshConfig.port,
          username: session.sshConfig.username,
          createdAt: session.createdAt,
          lastActivity: session.lastActivity,
          attachedClients: session.attachedSockets.size,
          ownerClientId: session.ownerClientId || '',
          shared: session.shared,
          credentialId: session.sshConfig.id || '',
          title: session.title,
        }));
    },
    getSessionStatus(sessionId: string) {
      const session = sshSessions.get(sessionId);
      if (!session) return { exists: false };
      return {
        exists: true,
        attachedClients: session.attachedSockets.size,
        hasAttachedOnce: Boolean(session.hasAttachedOnce),
        ownerClientId: session.ownerClientId || '',
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        host: session.sshConfig.host,
        username: session.sshConfig.username,
      };
    },
    createLiveSession,
    killSession({ sessionId, sessionIds, force, clientId }) {
      const ids = sessionIds || (sessionId ? [sessionId] : []);
      if (ids.length === 0) {
        return { status: 400, body: { error: 'Missing sessionId or sessionIds' } };
      }
      const results: Array<{ sessionId: string; status: string; error?: string }> = [];
      for (const sid of ids) {
        const session = sshSessions.get(sid);
        if (!session) {
          results.push({ sessionId: sid, status: 'not_found' });
          continue;
        }
        if (!force && clientId && session.ownerClientId && session.ownerClientId !== clientId) {
          results.push({ sessionId: sid, status: 'conflict', error: 'Owned by another client' });
          continue;
        }
        if (!force && session.attachedSockets.size > 1) {
          results.push({ sessionId: sid, status: 'conflict', error: 'Attached by other clients' });
          continue;
        }
        closeAttachedSession(session);
        results.push({ sessionId: sid, status: 'killed' });
      }
      const allOk = results.every((r) => r.status === 'killed' || r.status === 'not_found');
      return {
        status: allOk ? 200 : 207,
        body: { results },
      };
    },
    renameSession(sessionId: string, title: string) {
      if (!sessionId || !title) {
        return { status: 400, body: { error: 'Missing sessionId or title' } };
      }
      const session = sshSessions.get(sessionId);
      if (!session) {
        return { status: 404, body: { error: 'Session not found' } };
      }
      session.title = title;
      broadcastSessionTitle(session);
      return { status: 200, body: { message: 'Session renamed successfully' } };
    },
  };
}
