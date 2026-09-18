import { wsUrl } from './api';

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
  /** 该会话 AI 面板是否开着（会话级状态，接管/重连方据此自动打开面板） */
  aiPanelOpen?: boolean;
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
  let pingSentAt = 0;
  let smoothedRtt: number | null = null;

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
    pingSentAt = 0;
  }

  function sendPing() {
    if (ws?.readyState !== WebSocket.OPEN) return;
    pingSentAt = performance.now();
    ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
  }

  function startPing() {
    if (pingTimer !== null) clearInterval(pingTimer);
    sendPing();
    pingTimer = window.setInterval(sendPing, 5000);
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
      pingSentAt = 0;
      setState('open');
      startPing();
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'pong' && data.snapshot) {
          const snap = data.snapshot as HealthSnapshot;
          if (pingSentAt > 0) {
            const sample = Math.max(0, performance.now() - pingSentAt);
            pingSentAt = 0;
            smoothedRtt = smoothedRtt === null ? sample : smoothedRtt * 0.7 + sample * 0.3;
            snap.clientRttMs = Math.round(smoothedRtt);
          } else if (smoothedRtt !== null) {
            snap.clientRttMs = Math.round(smoothedRtt);
          } else {
            snap.clientRttMs = null;
          }
          lastSnapshot = snap;
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
