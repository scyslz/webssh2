import { wsUrl } from './api';

export interface SessionHealth {
  sessionId: string;
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

type HealthListener = (snapshot: HealthSnapshot) => void;
type ConnectionState = 'connecting' | 'open' | 'closed';
type StateListener = (state: ConnectionState) => void;

function createSysClient() {
  let ws: WebSocket | null = null;
  let windowId: string = '';
  let pingTimer: number | null = null;
  let reconnectTimer: number | null = null;
  const listeners: Set<HealthListener> = new Set();
  const stateListeners: Set<StateListener> = new Set();
  let lastSnapshot: HealthSnapshot | null = null;
  let started = false;
  let reconnectAttempts = 0;
  let connectionState: ConnectionState = 'closed';

  function setState(state: ConnectionState) {
    if (connectionState === state) return;
    connectionState = state;
    stateListeners.forEach((l) => l(state));
  }

  function cleanup() {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      ws = null;
    }
  }

  function startPing() {
    if (pingTimer !== null) clearInterval(pingTimer);
    pingTimer = window.setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      }
    }, 5000);
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    const baseDelay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    const jitter = Math.random() * 1000;
    const delay = baseDelay + jitter;
    reconnectAttempts += 1;
    reconnectTimer = window.setTimeout(() => {
      connect();
    }, delay);
  }

  function connect() {
    if (!started) return;
    cleanup();
    setState('connecting');

    const url = wsUrl('/sys', `windowId=${encodeURIComponent(windowId)}`);
    const socket = new WebSocket(url);
    ws = socket;

    socket.onopen = () => {
      reconnectAttempts = 0;
      setState('open');
      startPing();
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        // 兼容旧 health_snapshot 与新 pong+snapshot
        if (data.type === 'health_snapshot') {
          lastSnapshot = data as HealthSnapshot;
          listeners.forEach((l) => l(lastSnapshot!));
        } else if (data.type === 'pong' && data.snapshot) {
          const snap = data.snapshot as HealthSnapshot;
          // 用 pong 携带的 clientRttMs / ts 更新
          if (typeof data.clientRttMs === 'number') snap.clientRttMs = data.clientRttMs;
          lastSnapshot = snap;
          listeners.forEach((l) => l(lastSnapshot!));
        } else if (data.type === 'pong' && Array.isArray(data.sessions)) {
          // 兼容 pong 直接带 sessions 的情况
          lastSnapshot = data as unknown as HealthSnapshot;
          listeners.forEach((l) => l(lastSnapshot!));
        }
      } catch {
        // ignore
      }
    };

    socket.onclose = () => {
      lastSnapshot = null;
      setState('closed');
      scheduleReconnect();
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  function start(wid: string) {
    windowId = wid;
    started = true;
    connect();
  }

  function stop() {
    started = false;
    cleanup();
  }

  function reconnect() {
    if (!started) return;
    reconnectAttempts = 0;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connect();
  }

  function subscribe(listener: HealthListener): () => void {
    listeners.add(listener);
    if (lastSnapshot) {
      listener(lastSnapshot);
    }
    return () => {
      listeners.delete(listener);
    };
  }

  function subscribeState(listener: StateListener): () => void {
    stateListeners.add(listener);
    listener(connectionState);
    return () => {
      stateListeners.delete(listener);
    };
  }

  function getSnapshot(): HealthSnapshot | null {
    return lastSnapshot;
  }

  function getConnectionState(): ConnectionState {
    return connectionState;
  }

  return {
    start,
    stop,
    reconnect,
    subscribe,
    subscribeState,
    getSnapshot,
    getConnectionState,
  };
}

// Singleton
export const sysClient = createSysClient();
