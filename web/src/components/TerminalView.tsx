import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { SSHInfo, WebSSHConfig } from '../types';
import { apiFetch, apiUrl, wsUrl } from '../api';
import {
  RefreshCw,
  Trash2,
  ZoomIn,
  ZoomOut,
  ShieldAlert,
  Copy,
  Clipboard,
  Keyboard,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Check,
  X,
  Send,
  CornerDownLeft,
  CloudOff,
  Share2,
} from 'lucide-react';

interface TerminalViewProps {
  sshInfo: SSHInfo;
  config: WebSSHConfig;
  sessionId?: string;
  reconnectMode?: 'restore' | 'force';
  isTabActive?: boolean;
  onConnectionChange?: (connected: boolean) => void;
  onSessionInfo?: (sessionId: string, reattached: boolean) => void;
  onRecoverSession?: (force?: boolean) => void;
  onNewSession?: () => void;
}

export const TerminalView: React.FC<TerminalViewProps> = ({
  sshInfo,
  config,
  sessionId,
  reconnectMode = 'restore',
  isTabActive = true,
  onConnectionChange,
  onSessionInfo,
  onRecoverSession,
  onNewSession,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const decoderRef = useRef<TextDecoder | null>(null);
  const clientIdRef = useRef<string | null>(null);
  const connectionCleanupRef = useRef<(() => void) | null>(null);
  const connectionAttemptRef = useRef<number>(0);
  const closeReasonRef = useRef<string>('');
  const suppressAutoRecoverRef = useRef<boolean>(false);
  const reconnectModeOverrideRef = useRef<'restore' | 'force' | null>(null);
  const deferredPayloadsRef = useRef<Array<string | ArrayBuffer>>([]);
  const silentReconnectRef = useRef<boolean>(false);
  const heartbeatTimerRef = useRef<number | null>(null);
  const heartbeatTimeoutRef = useRef<number | null>(null);
  const lastHeartbeatPingAtRef = useRef<number | null>(null);
  const touchScrollStateRef = useRef<{ startY: number; startScrollTop: number; viewportEl: HTMLElement } | null>(null);
  const suppressTerminalInputRef = useRef<boolean>(false);
  const isCoarsePointerRef = useRef<boolean>(false);
  const WS_META_PREFIX = '__WEBSSH_META__:';

  const [connected, setConnected] = useState<boolean>(false);
  const [sharedSession, setSharedSession] = useState<boolean>(false);
  const [connecting, setConnecting] = useState<boolean>(true);
  const [isAttached, setIsAttached] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState<number>(config.fontSize || 14);
  const [clientLatencyMs, setClientLatencyMs] = useState<number | null>(null);
  const [sshLatencyMs, setSshLatencyMs] = useState<number | null>(null);
  const [offlineHoldEnabled, setOfflineHoldEnabled] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('webssh_offline_hold') === '1';
    } catch {
      return false;
    }
  });
  const [offlineSuspended, setOfflineSuspended] = useState<boolean>(false);
  const [debugEnabled, setDebugEnabled] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('webssh_terminal_debug') === '1';
    } catch {
      return false;
    }
  });
  const [debugEvents, setDebugEvents] = useState<string[]>([]);
  const isInvalidSessionError = Boolean(
    errorMsg && (
      errorMsg.includes('Missing or expired SSH session') ||
      errorMsg.includes('SESSION_NOT_FOUND')
    )
  );
  const canForceRestore = Boolean(
    sessionId &&
    errorMsg &&
    !isInvalidSessionError &&
    (
      errorMsg.includes('already attached') ||
      errorMsg.includes('taken over')
    )
  );

  // Mobile & Keyboard state
  const [selectedText, setSelectedText] = useState<string>('');
  const [copiedNotification, setCopiedNotification] = useState<boolean>(false);
  const [pasteModalOpen, setPasteModalOpen] = useState<boolean>(false);
  const [pasteInputText, setPasteInputText] = useState<string>('');
  const [selectionModalOpen, setSelectionModalOpen] = useState<boolean>(false);
  const [selectionBufferText, setSelectionBufferText] = useState<string>('');
  const [showKeyBar, setShowKeyBar] = useState<boolean>(true);

  // Modifiers
  const [ctrlActive, setCtrlActive] = useState<boolean>(false);
  const [altActive, setAltActive] = useState<boolean>(false);
  const [shiftActive, setShiftActive] = useState<boolean>(false);

  const ctrlActiveRef = useRef<boolean>(false);
  const altActiveRef = useRef<boolean>(false);
  const shiftActiveRef = useRef<boolean>(false);

  useEffect(() => {
    ctrlActiveRef.current = ctrlActive;
  }, [ctrlActive]);

  useEffect(() => {
    altActiveRef.current = altActive;
  }, [altActive]);

  useEffect(() => {
    shiftActiveRef.current = shiftActive;
  }, [shiftActive]);

  useEffect(() => {
    suppressTerminalInputRef.current = pasteModalOpen;
  }, [pasteModalOpen]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    isCoarsePointerRef.current = window.matchMedia('(pointer: coarse)').matches;
  }, []);

  const getTerminalClientId = (): string => {
    if (clientIdRef.current) return clientIdRef.current;

    const storageKey = `webssh_terminal_client:${sessionId || sshInfo.id || `${sshInfo.username}@${sshInfo.host}:${sshInfo.port}`}`;
    let clientId = null;
    try {
      clientId = window.localStorage.getItem(storageKey) || window.sessionStorage.getItem(storageKey);
    } catch {
      clientId = window.sessionStorage.getItem(storageKey);
    }
    if (!clientId) {
      clientId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      try {
        window.localStorage.setItem(storageKey, clientId);
      } catch {
        // ignore
      }
      window.sessionStorage.setItem(storageKey, clientId);
    }

    clientIdRef.current = clientId;
    return clientId;
  };

  const processInputData = (data: string): string => {
    let finalData = data;
    if (ctrlActiveRef.current) {
      if (data.length === 1) {
        const lower = data.toLowerCase();
        if (lower >= 'a' && lower <= 'z') {
          finalData = String.fromCharCode(lower.charCodeAt(0) - 96);
        } else if (data === '[') {
          finalData = '\x1b';
        } else if (data === '\\') {
          finalData = '\x1c';
        } else if (data === ']') {
          finalData = '\x1d';
        } else if (data === '^') {
          finalData = '\x1e';
        } else if (data === '_') {
          finalData = '\x1f';
        }
      }
      setCtrlActive(false);
    } else if (altActiveRef.current) {
      if (data.length === 1) {
        finalData = `\x1b${data}`;
      }
      setAltActive(false);
    } else if (shiftActiveRef.current) {
      if (data.length === 1) {
        finalData = data.toUpperCase();
      }
      setShiftActive(false);
    }
    return finalData;
  };

  const summarizeTerminalData = (data: string) => {
    const normalized = data
      .replace(/\x1b/g, '<ESC>')
      .replace(/\r/g, '<CR>')
      .replace(/\n/g, '<LF>')
      .replace(/\t/g, '<TAB>');
    const compact = normalized.replace(/[^\x20-\x7e<>]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
    return compact.length > 180 ? `${compact.slice(0, 180)}...` : compact;
  };

  const extractControlSequences = (data: string) => {
    const matches = data.match(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g) || [];
    return matches.slice(0, 6).map(summarizeTerminalData);
  };

  const pushDebugEvent = (message: string) => {
    if (!debugEnabled) return;
    const line = `${new Date().toISOString().slice(11, 23)} ${message}`;
    setDebugEvents((prev) => [...prev.slice(-79), line]);
    console.debug('[webssh-term]', line);
  };

  const sendTerminalResponse = (payload: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      pushDebugEvent(`term response ${summarizeTerminalData(payload)}`);
      wsRef.current.send(payload);
    }
  };

  const persistDebugEnabled = (enabled: boolean) => {
    setDebugEnabled(enabled);
    try {
      window.localStorage.setItem('webssh_terminal_debug', enabled ? '1' : '0');
    } catch {
      // ignore
    }
  };

  const persistOfflineHoldEnabled = (enabled: boolean) => {
    setOfflineHoldEnabled(enabled);
    try {
      window.localStorage.setItem('webssh_offline_hold', enabled ? '1' : '0');
    } catch {
      // ignore
    }
  };

  // Quick Command Bar items
  const quickCmds = [
    { label: 'ls -la', cmd: 'ls -la\n' },
    { label: 'top', cmd: 'top\n' },
    { label: 'htop', cmd: 'htop\n' },
    { label: 'df -h', cmd: 'df -h\n' },
    { label: 'free -m', cmd: 'free -m\n' },
    { label: 'Ctrl+C', cmd: '\x03' },
    { label: 'Clear', cmd: 'clear\n' },
  ];

  // Function Keys Mapping
  const functionKeys = {
    ctrl: [
      { label: 'Esc', send: '\x1b' },
      { label: 'Tab', send: '\t' },
      { label: 'Ctrl+C', send: '\x03' },
      { label: 'Ctrl+D', send: '\x04' },
      { label: 'Ctrl+Z', send: '\x1a' },
      { label: 'Ctrl+L', send: '\x0c' },
      { label: 'Ctrl+A', send: '\x01' },
      { label: 'Ctrl+E', send: '\x05' },
      { label: 'Ctrl+U', send: '\x15' },
      { label: 'Ctrl+K', send: '\x0b' },
    ],
    nav: [
      { label: '▲', send: '\x1b[A' },
      { label: '▼', send: '\x1b[B' },
      { label: '◀', send: '\x1b[D' },
      { label: '▶', send: '\x1b[C' },
      { label: 'Home', send: '\x1b[H' },
      { label: 'End', send: '\x1b[F' },
      { label: 'PgUp', send: '\x1b[5~' },
      { label: 'PgDn', send: '\x1b[6~' },
    ],
    fkeys: [
      { label: 'F1', send: '\x1bOP' },
      { label: 'F2', send: '\x1bOQ' },
      { label: 'F3', send: '\x1bOR' },
      { label: 'F4', send: '\x1bOS' },
      { label: 'F5', send: '\x1b[15~' },
      { label: 'F6', send: '\x1b[17~' },
      { label: 'F7', send: '\x1b[18~' },
      { label: 'F8', send: '\x1b[19~' },
      { label: 'F9', send: '\x1b[20~' },
      { label: 'F10', send: '\x1b[21~' },
      { label: 'F11', send: '\x1b[23~' },
      { label: 'F12', send: '\x1b[24~' },
    ],
    symbols: [
      { label: '/', send: '/' },
      { label: '~', send: '~' },
      { label: '|', send: '|' },
      { label: '-', send: '-' },
      { label: ':', send: ':' },
      { label: '_', send: '_' },
      { label: '$', send: '$' },
      { label: '>', send: '>' },
      { label: '<', send: '<' },
      { label: '\\', send: '\\' },
    ],
  };

  const getTheme = () => {
    switch (config.theme) {
      case 'dracula':
        return {
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
        };
      case 'matrix':
        return {
          background: '#050b07',
          foreground: '#00ff66',
          cursor: '#00ff66',
          selectionBackground: '#003b15',
          black: '#000000',
          green: '#00ff66',
          white: '#aaffcc',
        };
      case 'light':
        return {
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
        };
      default: // dark
        return {
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
        };
    }
  };

  const enqueueDeferredPayload = (payload: string | ArrayBuffer) => {
    deferredPayloadsRef.current.push(payload);
  };

  const flushDeferredPayloads = (ws: WebSocket) => {
    if (ws.readyState !== WebSocket.OPEN || deferredPayloadsRef.current.length === 0) return;
    for (const payload of deferredPayloadsRef.current) {
      ws.send(payload);
    }
    deferredPayloadsRef.current = [];
  };

  const sendKeyToTerminal = (data: string) => {
    const finalData = processInputData(data);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(finalData);
      terminalRef.current?.focus();
      return;
    }
    if (offlineHoldEnabled) {
      enqueueDeferredPayload(finalData);
      reconnectModeOverrideRef.current = closeReasonRef.current === 'session_busy' || closeReasonRef.current === 'taken_over' ? 'force' : 'restore';
      setOfflineSuspended(false);
      if (!connecting) connectWebSocket(reconnectModeOverrideRef.current || undefined, true);
      terminalRef.current?.focus();
    }
  };

  const sendRawToTerminal = (data: string, focusTerminal = true) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
      if (focusTerminal) {
        terminalRef.current?.focus();
      }
      return;
    }
    if (offlineHoldEnabled) {
      enqueueDeferredPayload(data);
      reconnectModeOverrideRef.current = closeReasonRef.current === 'session_busy' || closeReasonRef.current === 'taken_over' ? 'force' : 'restore';
      setOfflineSuspended(false);
      if (!connecting) connectWebSocket(reconnectModeOverrideRef.current || undefined, true);
      if (focusTerminal) {
        terminalRef.current?.focus();
      }
    }
  };

  const toggleSharedSession = () => {
    const nextShared = !sharedSession;
    setSharedSession(nextShared);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      pushDebugEvent(`session sharing ${nextShared ? 'enabled' : 'disabled'}`);
      wsRef.current.send(JSON.stringify({ type: 'set_shared', shared: nextShared }));
    }
  };

  const sendHeartbeatPing = (ws: WebSocket) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    pushDebugEvent('heartbeat ping');
    const pingAt = Date.now();
    lastHeartbeatPingAtRef.current = pingAt;
    ws.send(JSON.stringify({ type: 'ping', ts: pingAt }));
    if (heartbeatTimeoutRef.current !== null) window.clearTimeout(heartbeatTimeoutRef.current);
    heartbeatTimeoutRef.current = window.setTimeout(() => {
      pushDebugEvent('heartbeat timeout');
      closeReasonRef.current = 'heartbeat_timeout';
      ws.close();
    }, 15000);
  };

  const cleanupConnection = () => {
    pushDebugEvent('cleanup connection');
    suppressAutoRecoverRef.current = true;
    connectionCleanupRef.current?.();
    connectionCleanupRef.current = null;

    const ws = wsRef.current;
    wsRef.current = null;
    decoderRef.current = null;

    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    if (heartbeatTimerRef.current !== null) window.clearInterval(heartbeatTimerRef.current);
    if (heartbeatTimeoutRef.current !== null) window.clearTimeout(heartbeatTimeoutRef.current);
    heartbeatTimerRef.current = null;
    heartbeatTimeoutRef.current = null;
    lastHeartbeatPingAtRef.current = null;
  };

  const handleOpenSelectionModal = () => {
    if (!terminalRef.current) return;
    const buffer = terminalRef.current.buffer.active;
    const lines: string[] = [];
    const lineCount = 200;
    const start = Math.max(0, buffer.length - lineCount);
    for (let i = start; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    setSelectionBufferText(lines.join('\n'));
    setSelectionModalOpen(true);
  };

  const handleCopySelection = () => {
    const selection = terminalRef.current?.getSelection() || selectedText;
    if (!selection) return;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(selection).then(() => {
        setCopiedNotification(true);
        setTimeout(() => setCopiedNotification(false), 2000);
      }).catch(() => {
        fallbackCopyTextToClipboard(selection);
      });
    } else {
      fallbackCopyTextToClipboard(selection);
    }
  };

  const fallbackCopyTextToClipboard = (text: string) => {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
      setCopiedNotification(true);
      setTimeout(() => setCopiedNotification(false), 2000);
    } catch {
      alert('Failed to copy');
    }
    document.body.removeChild(textArea);
  };

  const handlePaste = async () => {
    suppressTerminalInputRef.current = true;
    terminalRef.current?.textarea?.blur();
    setCtrlActive(false);
    setAltActive(false);
    setShiftActive(false);
    if (navigator.clipboard && navigator.clipboard.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          sendRawToTerminal(text);
          return;
        }
      } catch {
        // Fallback to paste modal prompt
      }
    }
    setPasteInputText('');
    setPasteModalOpen(true);
  };

  const handleSendPastedText = () => {
    if (pasteInputText) {
      sendRawToTerminal(pasteInputText, false);
      setPasteModalOpen(false);
      setPasteInputText('');
      suppressTerminalInputRef.current = false;
      window.setTimeout(() => terminalRef.current?.focus(), 120);
    }
  };

  const connectWebSocket = async (modeOverride?: 'restore' | 'force', silentReconnect = false) => {
    if (!containerRef.current) return;

    cleanupConnection();
    const attemptId = ++connectionAttemptRef.current;
    const isCurrentConnection = () => connectionAttemptRef.current === attemptId && wsRef.current === ws;
    pushDebugEvent(`connect start attempt=${attemptId}`);
    suppressAutoRecoverRef.current = false;
    closeReasonRef.current = '';

    setConnecting(true);
    setConnected(false);
    setErrorMsg(null);
    setIsAttached(false);
    if (!silentReconnect) {
      setOfflineSuspended(false);
    }
    setClientLatencyMs((prev) => prev);
    setSshLatencyMs((prev) => prev);
    silentReconnectRef.current = silentReconnect;

    // Initialize xterm
    if (!terminalRef.current) {
      const term = new XTerminal({
        cursorBlink: true,
        fontSize: fontSize,
        fontFamily: config.fontFamily || 'Consolas, Monaco, "Courier New", monospace',
        theme: getTheme(),
        allowProposedApi: true,
        windowOptions: {
          getWinSizePixels: true,
          getCellSizePixels: true,
          getWinSizeChars: true,
          getScreenSizePixels: true,
          getScreenSizeChars: true,
        },
      });

      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();

      term.loadAddon(fitAddon);
      term.loadAddon(webLinksAddon);

      term.open(containerRef.current);
      fitAddon.fit();

      terminalRef.current = term;
      fitAddonRef.current = fitAddon;
    } else if (!silentReconnect) {
      terminalRef.current.clear();
      terminalRef.current.options.theme = getTheme();
      terminalRef.current.options.fontSize = fontSize;
    } else {
      terminalRef.current.options.theme = getTheme();
      terminalRef.current.options.fontSize = fontSize;
    }

    const term = terminalRef.current;
    const fitAddon = fitAddonRef.current;

    // Track text selection for mobile copy button
    const selectionDisposable = term.onSelectionChange(() => {
      if (isCoarsePointerRef.current) {
        setSelectedText('');
        return;
      }
      setSelectedText(term.getSelection());
    });

    const respondToModeQuery = (mode: number, isAnsi: boolean) => {
      const currentModes = term.modes;
      const mouseTracking = currentModes.mouseTrackingMode;
      const mouseSgr = mouseTracking !== 'none';
      const report = (value: number) => {
        sendTerminalResponse(`\x1b[${isAnsi ? '' : '?'}${mode};${value}$y`);
        return true;
      };

      if (isAnsi) {
        if (mode === 2) return report(4);
        if (mode === 4) return report(currentModes.insertMode ? 1 : 2);
        if (mode === 12) return report(3);
        return report(0);
      }

      switch (mode) {
        case 1:
          return report(currentModes.applicationCursorKeysMode ? 1 : 2);
        case 6:
          return report(currentModes.originMode ? 1 : 2);
        case 7:
          return report(currentModes.wraparoundMode ? 1 : 2);
        case 8:
          return report(3);
        case 9:
          return report(mouseTracking === 'x10' ? 1 : 2);
        case 12:
          return report(term.options.cursorBlink ? 1 : 2);
        case 45:
          return report(currentModes.reverseWraparoundMode ? 1 : 2);
        case 66:
          return report(currentModes.applicationKeypadMode ? 1 : 2);
        case 67:
          return report(4);
        case 1000:
          return report(mouseTracking === 'vt200' ? 1 : 2);
        case 1002:
          return report(mouseTracking === 'drag' ? 1 : 2);
        case 1003:
          return report(mouseTracking === 'any' ? 1 : 2);
        case 1004:
          return report(currentModes.sendFocusMode ? 1 : 2);
        case 1005:
        case 1015:
          return report(4);
        case 1006:
        case 1016:
          return report(mouseSgr ? 1 : 2);
        case 1048:
          return report(1);
        case 1047:
        case 1049:
          return report(2);
        case 2004:
          return report(currentModes.bracketedPasteMode ? 1 : 2);
        case 2026:
          return report(currentModes.synchronizedOutputMode ? 1 : 2);
        default:
          return report(0);
      }
    };

    const ansiRequestModeDisposable = term.parser.registerCsiHandler({ intermediates: '$', final: 'p' }, (params) => {
      const mode = Array.isArray(params[0]) ? params[0][0] : params[0];
      if (typeof mode !== 'number') return false;
      pushDebugEvent(`term query ansi mode=${mode}`);
      return respondToModeQuery(mode, true);
    });

    const decRequestModeDisposable = term.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, (params) => {
      const mode = Array.isArray(params[0]) ? params[0][0] : params[0];
      if (typeof mode !== 'number') return false;
      pushDebugEvent(`term query dec mode=${mode}`);
      return respondToModeQuery(mode, false);
    });

    if (!silentReconnect) {
      term.writeln(`\r\n\x1b[32m[WebSSH]\x1b[0m Connecting to \x1b[36m${sshInfo.username}@${sshInfo.host}:${sshInfo.port}\x1b[0m...`);
    }

    // Determine WebSocket protocol (ws or wss)
    const cols = term.cols || 120;
    const rows = term.rows || 30;
    const clientId = getTerminalClientId();
    const timeout = config.timeout || 120;
    const effectiveReconnectMode = modeOverride || reconnectModeOverrideRef.current || reconnectMode;
    reconnectModeOverrideRef.current = null;
    let preparedSessionId = sessionId || '';
    if (!sessionId) {
      try {
        pushDebugEvent(`session create start credential=${sshInfo.id ? 'saved' : 'inline'} cols=${cols} rows=${rows}`);
        const sessionRes = await apiFetch(apiUrl('/ssh/session/create'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            sshInfo.id
              ? { credentialId: sshInfo.id, cols, rows, timeout, clientId }
              : { sshInfo, cols, rows, timeout, clientId }
          ),
        });
        const sessionData = await sessionRes.json();
        if (!sessionRes.ok) throw new Error(sessionData.error || 'Failed to create SSH session');
        preparedSessionId = sessionData.sessionId;
        pushDebugEvent(`session create ok session=${preparedSessionId}`);
      } catch (err: any) {
        pushDebugEvent(`session create failed error=${err.message || 'unknown'}`);
        setConnecting(false);
        setErrorMsg(err.message || 'Failed to create SSH session');
        onConnectionChange?.(false);
        return;
      }
    }
    const wsConnectUrl = wsUrl('/term',
      `sessionId=${encodeURIComponent(preparedSessionId)}&clientId=${encodeURIComponent(clientId)}&cols=${cols}&rows=${rows}&timeout=${timeout}&forceAttach=${effectiveReconnectMode === 'force' ? '1' : '0'}`
    );
    pushDebugEvent(`ws url ${wsConnectUrl}`);

    const ws = new WebSocket(wsConnectUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    decoderRef.current = new TextDecoder('utf-8');

    ws.onopen = () => {
      if (!isCurrentConnection()) return;
      pushDebugEvent(`ws open attempt=${attemptId} cols=${cols} rows=${rows}`);
      setConnecting(false);
      setConnected(true);
      setOfflineSuspended(false);
      onConnectionChange?.(true);
      if (!silentReconnectRef.current) {
        term.writeln('\x1b[32m[WebSSH]\x1b[0m Connection established.\r\n');
      }
      fitAddon?.fit();
      sendHeartbeatPing(ws);
      flushDeferredPayloads(ws);
      heartbeatTimerRef.current = window.setInterval(() => {
        sendHeartbeatPing(ws);
      }, 20000);
    };

    ws.onmessage = (event) => {
      if (!isCurrentConnection()) return;
      if (typeof event.data === 'string' && event.data.startsWith(WS_META_PREFIX)) {
        try {
          const meta = JSON.parse(event.data.slice(WS_META_PREFIX.length));
          pushDebugEvent(`ws meta ${JSON.stringify(meta)}`);
          if (meta.type === 'session_info') {
            setIsAttached(true);
            if (typeof meta.shared === 'boolean') setSharedSession(meta.shared);
            if (typeof meta.sessionId === 'string') {
              onSessionInfo?.(meta.sessionId, Boolean(meta.reattached));
            }
            return;
          }
          if (meta.type === 'shared_state') {
            if (typeof meta.shared === 'boolean') setSharedSession(meta.shared);
            return;
          }
          if (meta.type === 'pong') {
            if (heartbeatTimeoutRef.current !== null) window.clearTimeout(heartbeatTimeoutRef.current);
            heartbeatTimeoutRef.current = null;
            const echoedTs = typeof meta.ts === 'number' ? meta.ts : lastHeartbeatPingAtRef.current;
            if (typeof echoedTs === 'number') {
              setClientLatencyMs(Math.max(0, Date.now() - echoedTs));
            }
            lastHeartbeatPingAtRef.current = null;
            return;
          }
          if (meta.type === 'ssh_latency') {
            if (typeof meta.latencyMs === 'number') {
              setSshLatencyMs(Math.max(0, Math.round(meta.latencyMs)));
            }
            return;
          }
          if (meta.type === 'session_busy') {
            closeReasonRef.current = 'session_busy';
            setErrorMsg('This session is already attached by another browser tab or device.');
            setConnecting(false);
            setConnected(false);
            onConnectionChange?.(false);
            return;
          }
          if (meta.type === 'session_taken_over') {
            closeReasonRef.current = 'taken_over';
            setErrorMsg('This session was taken over by another browser tab or device.');
            setConnecting(false);
            setConnected(false);
            onConnectionChange?.(false);
            return;
          }
          if (meta.type === 'ssh_connection_error') {
            closeReasonRef.current = 'ssh_connect_error';
            const message = typeof meta.message === 'string' ? meta.message : 'SSH connection failed.';
            const code = typeof meta.code === 'string' ? ` [${meta.code}]` : '';
            setErrorMsg(`${message}${code}`);
            setConnecting(false);
            setConnected(false);
            onConnectionChange?.(false);
            return;
          }
        } catch {
          // ignore
        }
      }

      if (typeof event.data === 'string') {
        const controls = extractControlSequences(event.data);
        if (controls.length > 0) {
          pushDebugEvent(`ws text controls ${controls.join(' | ')}`);
        }
        if (event.data.includes('SSH Connection Error:')) {
          closeReasonRef.current = 'ssh_connect_error';
          setErrorMsg(event.data.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r?\n/g, ' ').trim());
        } else if (event.data.includes('SSH Shell Error:')) {
          closeReasonRef.current = 'ssh_shell_error';
          setErrorMsg(event.data.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r?\n/g, ' ').trim());
        }
        term.write(event.data);
        return;
      }

      if (event.data instanceof ArrayBuffer) {
        const decoded = decoderRef.current?.decode(new Uint8Array(event.data), { stream: true }) || '';
        const controls = extractControlSequences(decoded);
        if (controls.length > 0) {
          pushDebugEvent(`ws binary controls ${controls.join(' | ')}`);
        }
        term.write(decoded);
        return;
      }

      if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((buffer) => {
          const decoded = decoderRef.current?.decode(new Uint8Array(buffer), { stream: true }) || '';
          const controls = extractControlSequences(decoded);
          if (controls.length > 0) {
            pushDebugEvent(`ws blob controls ${controls.join(' | ')}`);
          }
          term.write(decoded);
        });
      }
    };

    ws.onerror = () => {
      if (!isCurrentConnection()) return;
      pushDebugEvent(`ws error attempt=${attemptId}`);
      closeReasonRef.current = 'websocket_error';
      if (offlineHoldEnabled) {
        return;
      }
      setConnecting(false);
      setConnected(false);
      setErrorMsg('WebSocket connection failed.');
      onConnectionChange?.(false);
    };

    ws.onclose = (event) => {
      if (!isCurrentConnection()) return;
      pushDebugEvent(`ws close attempt=${attemptId} code=${event.code} reason=${event.reason || '(none)'} clean=${event.wasClean}`);
      const closeDetails = `${event.reason || ''}`.toLowerCase();
      const isServerFailure =
        event.code === 1011 ||
        event.code === 1008 ||
        closeDetails.includes('ssh') ||
        closeDetails.includes('session') ||
        closeDetails.includes('handshake');
      if (isServerFailure && !closeReasonRef.current) {
        closeReasonRef.current = event.code === 1008 ? 'session_busy' : 'ssh_connect_error';
        if (event.reason) setErrorMsg(event.reason);
      }
      if (heartbeatTimerRef.current !== null) window.clearInterval(heartbeatTimerRef.current);
      if (heartbeatTimeoutRef.current !== null) window.clearTimeout(heartbeatTimeoutRef.current);
      heartbeatTimerRef.current = null;
      heartbeatTimeoutRef.current = null;
      lastHeartbeatPingAtRef.current = null;
      const remaining = decoderRef.current?.decode();
      if (remaining) {
        term.write(remaining);
      }
      setConnecting(false);
      setConnected(false);
      onConnectionChange?.(false);
      if (offlineHoldEnabled) {
        setOfflineSuspended(true);
        setErrorMsg(null);
        return;
      }
      if (
        !suppressAutoRecoverRef.current &&
        isTabActive &&
        (closeReasonRef.current === '' || closeReasonRef.current === 'heartbeat_timeout')
      ) {
        window.setTimeout(() => onRecoverSession?.(false), 600);
      }
    };

    // Terminal data input -> WS
    const onDataDisposable = term.onData((data) => {
      if (suppressTerminalInputRef.current) return;
      const finalData = processInputData(data);
      pushDebugEvent(`term data ${summarizeTerminalData(finalData)}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(finalData);
        return;
      }
      if (offlineHoldEnabled) {
        enqueueDeferredPayload(finalData);
        reconnectModeOverrideRef.current = closeReasonRef.current === 'session_busy' || closeReasonRef.current === 'taken_over' ? 'force' : 'restore';
        if (!connecting) connectWebSocket(reconnectModeOverrideRef.current || undefined, true);
      }
    });

    const onBinaryDisposable = term.onBinary((data) => {
      if (suppressTerminalInputRef.current) return;
      pushDebugEvent(`term binary ${summarizeTerminalData(data)}`);
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) {
        bytes[i] = data.charCodeAt(i) & 0xff;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(bytes.buffer);
        return;
      }
      if (offlineHoldEnabled) {
        enqueueDeferredPayload(bytes.buffer);
        reconnectModeOverrideRef.current = closeReasonRef.current === 'session_busy' || closeReasonRef.current === 'taken_over' ? 'force' : 'restore';
        if (!connecting) connectWebSocket(reconnectModeOverrideRef.current || undefined, true);
      }
    });

    // Resize listener with ResizeObserver to adapt to keybar visibility changes
    const handleResize = () => {
      if (fitAddon && terminalRef.current) {
        try {
          fitAddon.fit();
          if (ws.readyState === WebSocket.OPEN) {
            pushDebugEvent(`resize cols=${terminalRef.current.cols} rows=${terminalRef.current.rows}`);
            ws.send(
              JSON.stringify({
                type: 'resize',
                cols: terminalRef.current.cols,
                rows: terminalRef.current.rows,
              })
            );
          }
        } catch {
          // ignore fit errors if element not attached
        }
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(handleResize);
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    window.addEventListener('resize', handleResize);

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || !containerRef.current) return;
      const viewportEl = containerRef.current.querySelector('.xterm-viewport') as HTMLElement | null;
      if (!viewportEl) return;
      terminalRef.current?.clearSelection();
      setSelectedText('');
      touchScrollStateRef.current = {
        startY: event.touches[0].clientY,
        startScrollTop: viewportEl.scrollTop,
        viewportEl,
      };
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1 || !touchScrollStateRef.current) return;
      const { viewportEl, startScrollTop, startY } = touchScrollStateRef.current;
      const deltaY = event.touches[0].clientY - touchScrollStateRef.current.startY;
      viewportEl.scrollTop = startScrollTop - (event.touches[0].clientY - startY);
      event.preventDefault();
    };
    const handleTouchEnd = () => {
      touchScrollStateRef.current = null;
    };

    if (containerRef.current) {
      containerRef.current.addEventListener('touchstart', handleTouchStart, { passive: true });
      containerRef.current.addEventListener('touchmove', handleTouchMove, { passive: false });
      containerRef.current.addEventListener('touchend', handleTouchEnd, { passive: true });
      containerRef.current.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    }

    const cleanupArtifacts = () => {
      selectionDisposable.dispose();
      ansiRequestModeDisposable.dispose();
      decRequestModeDisposable.dispose();
      onDataDisposable.dispose();
      onBinaryDisposable.dispose();
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
      if (containerRef.current) {
        containerRef.current.removeEventListener('touchstart', handleTouchStart);
        containerRef.current.removeEventListener('touchmove', handleTouchMove);
        containerRef.current.removeEventListener('touchend', handleTouchEnd);
        containerRef.current.removeEventListener('touchcancel', handleTouchEnd);
      }
    };

    connectionCleanupRef.current = cleanupArtifacts;
    return cleanupArtifacts;
  };

  useEffect(() => {
    connectWebSocket();
    return () => {
      cleanupConnection();
    };
  }, [sshInfo, sessionId, reconnectMode, config.timeout]);

  useEffect(() => {
    if (isTabActive && fitAddonRef.current && terminalRef.current) {
      const timer = setTimeout(() => {
        try {
          fitAddonRef.current?.fit();
          terminalRef.current?.focus();
        } catch {
          // ignore
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isTabActive]);

  useEffect(() => {
    if (config.fontSize && config.fontSize !== fontSize) {
      setFontSize(config.fontSize);
    }
  }, [config.fontSize]);

  useEffect(() => {
    if (debugEnabled) {
      pushDebugEvent('debug enabled');
    }
  }, [debugEnabled]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.fontSize = fontSize;
      fitAddonRef.current?.fit();
    }
  }, [fontSize]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = getTheme();
      terminalRef.current.options.fontFamily = config.fontFamily || 'Consolas, Monaco, "Courier New", monospace';
    }
  }, [config.theme, config.fontFamily]);

  useEffect(() => {
    if (fitAddonRef.current && terminalRef.current) {
      const doFit = () => {
        try {
          fitAddonRef.current?.fit();
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && terminalRef.current) {
            wsRef.current.send(
              JSON.stringify({
                type: 'resize',
                cols: terminalRef.current.cols,
                rows: terminalRef.current.rows,
              })
            );
          }
        } catch {
          // ignore
        }
      };

      doFit();
      const raf = requestAnimationFrame(doFit);
      const timer1 = setTimeout(doFit, 50);
      const timer2 = setTimeout(doFit, 150);
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(timer1);
        clearTimeout(timer2);
      };
    }
  }, [showKeyBar, connected]);

  const handleClearTerminal = () => {
    terminalRef.current?.clear();
  };

  const isLight = config.theme === 'light';

  const btnBg = isLight
    ? 'bg-white hover:bg-slate-200 text-slate-700 border-slate-300'
    : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700';

  const latencyBadgeClass = isLight
    ? 'bg-white text-slate-700 border-slate-300'
    : 'bg-slate-800 text-slate-300 border-slate-700';

  const formatLatency = (value: number | null) => (typeof value === 'number' ? `${Math.round(value)}` : '--');
  const getLatencyToneClass = (value: number | null) => {
    if (typeof value !== 'number') {
      return isLight ? 'text-slate-500' : 'text-slate-400';
    }
    if (value >= 200) {
      return isLight ? 'text-rose-600' : 'text-rose-400';
    }
    if (value >= 100) {
      return isLight ? 'text-amber-600' : 'text-amber-400';
    }
    return isLight ? 'text-emerald-600' : 'text-emerald-400';
  };

  return (
    <div
      className={`flex flex-col h-full relative overflow-hidden select-none transition-colors ${
        isLight ? 'bg-white text-slate-800' : 'bg-slate-950 text-slate-100'
      }`}
    >
      {/* Terminal Sub-header / Toolbar */}
      <div
        className={`border-b px-2 py-0.5 flex items-center justify-between text-[11px] gap-1.5 transition-colors ${
          isLight ? 'bg-slate-100 border-slate-200 text-slate-800' : 'bg-slate-900 border-slate-800 text-slate-100'
        }`}
      >
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
          {/* Select Mode Button */}
          <button
            onClick={handleOpenSelectionModal}
            disabled={!(connected || offlineSuspended)}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border transition cursor-pointer shrink-0 disabled:opacity-40 ${
              isLight
                ? 'bg-white hover:bg-slate-200 text-indigo-600 border-slate-300'
                : 'bg-slate-800 hover:bg-slate-700 text-indigo-300 border-slate-700'
            }`}
            title="Select Text"
          >
            <Copy className="w-3 h-3 text-indigo-500" />
          </button>

          {/* Copy Selection Button */}
          <button
            onClick={handleCopySelection}
            disabled={!selectedText && !terminalRef.current?.getSelection()}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border transition cursor-pointer shrink-0 ${
              selectedText
                ? 'bg-amber-500/20 text-amber-600 border-amber-500/40 shadow-xs animate-pulse'
                : `${btnBg} disabled:opacity-40`
            }`}
            title="Copy Selection"
          >
            <Copy className="w-3 h-3 text-amber-500" />
            {selectedText && <span className="text-[9px] font-mono">({selectedText.length})</span>}
          </button>

          {/* Paste Button */}
          <button
            onClick={handlePaste}
            disabled={!(connected || offlineSuspended)}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border transition cursor-pointer shrink-0 disabled:opacity-40 ${btnBg}`}
            title="Paste Clipboard Content"
          >
            <Clipboard className="w-3 h-3 text-emerald-500" />
          </button>

          <button
            onClick={() => setShowKeyBar(!showKeyBar)}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border transition cursor-pointer shrink-0 ${
              showKeyBar
                ? isLight
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                  : 'bg-slate-800 text-emerald-400 border-emerald-500/40'
                : btnBg
            }`}
            title="Toggle Quick Keys Bar"
          >
            <Keyboard className="w-3 h-3" />
            {showKeyBar ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>

          <button
            onClick={() => persistOfflineHoldEnabled(!offlineHoldEnabled)}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border transition cursor-pointer shrink-0 ${
              offlineHoldEnabled
                ? isLight
                  ? offlineSuspended
                    ? 'bg-amber-100 text-amber-800 border-amber-300'
                    : 'bg-sky-100 text-sky-800 border-sky-300'
                  : offlineSuspended
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                  : 'bg-sky-500/15 text-sky-300 border-sky-500/30'
                : btnBg
            }`}
            title={offlineHoldEnabled ? (offlineSuspended ? 'Offline hold enabled: reconnect on next input' : 'Offline hold enabled') : 'Enable offline hold mode'}
          >
            <CloudOff className="w-3 h-3" />
          </button>

          <button
            onClick={toggleSharedSession}
            disabled={!connected}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border transition cursor-pointer shrink-0 disabled:opacity-40 ${
              sharedSession
                ? isLight
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                  : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                : btnBg
            }`}
            title={sharedSession ? 'Session sharing enabled' : 'Enable session sharing'}
          >
            <Share2 className="w-3 h-3" />
          </button>

          {(connected || offlineSuspended) && (
            <div
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0 border ${latencyBadgeClass}`}
              title={`Browser to WebSSH: ${formatLatency(clientLatencyMs)} | WebSSH to SSH host: ${formatLatency(sshLatencyMs)}`}
            >
              <span className={getLatencyToneClass(clientLatencyMs)}>{formatLatency(clientLatencyMs)}</span>
              <span className="opacity-50">|</span>
              <span className={getLatencyToneClass(sshLatencyMs)}>{formatLatency(sshLatencyMs)}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => setFontSize((f) => Math.min(24, f + 1))}
            className={`p-0.5 rounded transition ${
              isLight ? 'hover:bg-slate-200 text-slate-600 hover:text-slate-900' : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'
            }`}
            title="Increase Font Size"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setFontSize((f) => Math.max(10, f - 1))}
            className={`p-0.5 rounded transition ${
              isLight ? 'hover:bg-slate-200 text-slate-600 hover:text-slate-900' : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'
            }`}
            title="Decrease Font Size"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleClearTerminal}
            className={`p-0.5 rounded transition ${
              isLight ? 'hover:bg-slate-200 text-slate-600 hover:text-slate-900' : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'
            }`}
            title="Clear Screen"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onRecoverSession?.()}
            className={`p-0.5 rounded transition ${
              isLight ? 'hover:bg-slate-200 text-slate-600 hover:text-slate-900' : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'
            } ${connecting ? 'animate-spin' : ''}`}
            title="Restore Session Or Reconnect"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Copied Notification Banner */}
      {copiedNotification && (
        <div className="absolute top-8 left-1/2 -translate-x-1/2 z-30 bg-emerald-600 text-white text-[11px] font-mono px-2.5 py-0.5 rounded-full shadow-lg flex items-center gap-1 animate-bounce">
          <Check className="w-3 h-3" />
          <span>Copied!</span>
        </div>
      )}

      {/* Terminal Canvas Container */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 w-full p-1 overflow-hidden transition-colors duration-200"
        style={{
          backgroundColor: getTheme().background || (isLight ? '#ffffff' : '#0a0f1d'),
        }}
        onClick={() => terminalRef.current?.focus()}
      />

      {false && debugEnabled && (
        <div
          className={`border-t px-2 py-1 font-mono text-[10px] max-h-32 overflow-y-auto ${
            isLight ? 'bg-slate-50 border-slate-200 text-slate-700' : 'bg-slate-950 border-slate-800 text-slate-300'
          }`}
        >
          <div className="flex items-center justify-between gap-2 pb-1">
            <span>Terminal Debug</span>
            <button
              onClick={() => setDebugEvents([])}
              className={`px-1.5 py-0.5 rounded border ${btnBg}`}
            >
              Clear
            </button>
          </div>
          <div className="space-y-0.5">
            {debugEvents.length === 0 && <div className="opacity-70">No events yet.</div>}
            {debugEvents.map((line, idx) => (
              <div key={`${idx}-${line}`} className="break-all">
                {line}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Mobile Streamlined Compact Key Bar (Left-to-Right Row, Matching Top Toolbar Proportion) */}
      {showKeyBar && connected && (
        <div
          className={`border-t px-1.5 py-0.5 w-full shadow-lg select-none transition-colors overflow-x-auto scrollbar-none flex items-center gap-1 whitespace-nowrap ${
            isLight ? 'bg-slate-100 border-slate-200 text-slate-800' : 'bg-slate-900 border-slate-800 text-slate-100'
          }`}
        >
          {/* Esc & Tab */}
          <button
            onClick={() => sendKeyToTerminal('\x1b')}
            className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-mono font-semibold border transition cursor-pointer flex items-center justify-center shrink-0 ${btnBg}`}
          >
            Esc
          </button>
          <button
            onClick={() => sendKeyToTerminal('\t')}
            className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-mono font-semibold border transition cursor-pointer flex items-center justify-center shrink-0 ${btnBg}`}
          >
            Tab
          </button>

          <div className={`h-2.5 w-[1px] shrink-0 my-auto ${isLight ? 'bg-slate-300' : 'bg-slate-800'}`} />

          {/* Ctrl Modifier Button */}
          <button
            onClick={() => setCtrlActive(!ctrlActive)}
            className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-bold font-mono border transition cursor-pointer flex items-center justify-center shrink-0 ${
              ctrlActive
                ? 'bg-rose-600 text-white border-rose-500 shadow-xs'
                : btnBg
            }`}
          >
            Ctrl
          </button>

          {/* Alt Modifier Button */}
          <button
            onClick={() => setAltActive(!altActive)}
            className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-bold font-mono border transition cursor-pointer flex items-center justify-center shrink-0 ${
              altActive
                ? 'bg-amber-600 text-white border-amber-500 shadow-xs'
                : btnBg
            }`}
          >
            Alt
          </button>

          {/* Shift Modifier Button */}
          <button
            onClick={() => setShiftActive(!shiftActive)}
            className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-bold font-mono border transition cursor-pointer flex items-center justify-center shrink-0 ${
              shiftActive
                ? 'bg-purple-600 text-white border-purple-500 shadow-xs'
                : btnBg
            }`}
          >
            Shift
          </button>

          <div className={`h-2.5 w-[1px] shrink-0 my-auto ${isLight ? 'bg-slate-300' : 'bg-slate-800'}`} />

          {/* Arrow Keys */}
          <button
            onClick={() => sendKeyToTerminal('\x1b[A')}
            className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-semibold border transition cursor-pointer flex items-center justify-center shrink-0 ${btnBg}`}
            title="Arrow Up"
          >
            ▲
          </button>
          <button
            onClick={() => sendKeyToTerminal('\x1b[B')}
            className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-semibold border transition cursor-pointer flex items-center justify-center shrink-0 ${btnBg}`}
            title="Arrow Down"
          >
            ▼
          </button>
          <button
            onClick={() => sendKeyToTerminal('\x1b[D')}
            className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-semibold border transition cursor-pointer flex items-center justify-center shrink-0 ${btnBg}`}
            title="Arrow Left"
          >
            ◀
          </button>
          <button
            onClick={() => sendKeyToTerminal('\x1b[C')}
            className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-semibold border transition cursor-pointer flex items-center justify-center shrink-0 ${btnBg}`}
            title="Arrow Right"
          >
            ▶
          </button>

          <div className={`h-2.5 w-[1px] shrink-0 my-auto ${isLight ? 'bg-slate-300' : 'bg-slate-800'}`} />

          <button
            onClick={() => sendKeyToTerminal('\x7f')}
            className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-mono font-semibold border transition cursor-pointer flex items-center justify-center shrink-0 ${btnBg}`}
          >
            Del
          </button>
          <button
            onClick={() => sendKeyToTerminal('\r')}
            className={`px-1.5 py-0.5 h-5.5 rounded text-[10px] font-mono font-semibold border transition cursor-pointer flex items-center justify-center shrink-0 ${btnBg}`}
          >
            <CornerDownLeft className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Terminal Text Selection Modal (Mobile Friendly) */}
      {selectionModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4 z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-3xl h-[88vh] p-3 shadow-2xl flex flex-col gap-2">
            <div className="flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <Copy className="w-4 h-4 text-indigo-400" />
                <h3 className="font-bold text-slate-200 text-xs sm:text-sm">Select Output</h3>
              </div>
              <button
                onClick={() => setSelectionModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 p-1 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <textarea
              readOnly
              value={selectionBufferText}
              className="flex-1 w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-slate-700 leading-relaxed overflow-y-auto select-text resize-none"
              onClick={(e) => (e.target as HTMLTextAreaElement).select()}
            />

            <div className="flex items-center justify-between gap-2 shrink-0 pt-0.5">
              <button
                onClick={() => {
                  if (navigator.clipboard) {
                    navigator.clipboard.writeText(selectionBufferText);
                    setCopiedNotification(true);
                    setTimeout(() => setCopiedNotification(false), 2000);
                  }
                }}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-500 transition cursor-pointer"
              >
                <Copy className="w-3.5 h-3.5" />
                <span>Copy All</span>
              </button>

              <button
                onClick={() => setSelectionModalOpen(false)}
                className="px-3.5 py-1 rounded-lg bg-slate-800 text-slate-300 text-xs font-medium hover:bg-slate-700 transition cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Paste Content Modal / Fallback for Mobile Privacy */}
      {pasteModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4 z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-3xl h-[88vh] p-3 shadow-2xl flex flex-col gap-2">
            <div className="flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <Clipboard className="w-4 h-4 text-emerald-400" />
                <h3 className="font-bold text-slate-200 text-xs sm:text-sm">Paste to Terminal</h3>
              </div>
              <button
                onClick={() => setPasteModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 p-1 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <textarea
              value={pasteInputText}
              onChange={(e) => setPasteInputText(e.target.value)}
              placeholder="Paste text here or long-press to paste..."
              autoFocus
              className="flex-1 w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-[16px] sm:text-xs font-mono text-slate-200 focus:outline-none focus:border-slate-700 leading-relaxed overflow-y-auto resize-none"
              onFocus={() => terminalRef.current?.textarea?.blur()}
            />

            <div className="flex items-center justify-end gap-2 shrink-0 pt-0.5">
              <button
                onClick={() => setPasteModalOpen(false)}
                className="px-3.5 py-1 rounded-lg bg-slate-800 text-slate-300 text-xs font-medium hover:bg-slate-700 transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleSendPastedText}
                disabled={!pasteInputText}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-500 transition cursor-pointer disabled:opacity-40"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Send to Terminal</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Connection Status Overlay if disconnected / error */}
      {!connected && !connecting && !offlineSuspended && (
        <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-xs flex flex-col items-center justify-center gap-3 p-4 z-10">
          <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-full text-rose-400">
            <ShieldAlert className="w-8 h-8" />
          </div>
          <div className="text-center max-w-md">
            <h3 className="font-bold text-slate-200 text-base">Terminal Disconnected</h3>
            <p className="text-xs text-slate-400 font-mono mt-1">{errorMsg || 'SSH connection was closed or timed out.'}</p>
          </div>
          {(errorMsg?.includes('already attached') || errorMsg?.includes('taken over')) && (
            <p className="text-[11px] text-slate-500 font-mono text-center max-w-md">
              Session is attached elsewhere. Start a new session here or use the session manager to restore it explicitly.
            </p>
          )}
          <button
            onClick={() => onNewSession?.()}
            className="w-40 flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium shadow-md transition cursor-pointer"
          >
            <RefreshCw className="w-4 h-4" />
            <span>New Session</span>
          </button>
          {canForceRestore && (
            <button
              onClick={() => onRecoverSession?.(true)}
              className="w-40 flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-rose-700 hover:bg-rose-600 text-white text-xs font-medium shadow-md transition cursor-pointer"
            >
              <ShieldAlert className="w-4 h-4" />
              <span>Force Restore</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
