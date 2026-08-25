import React, { useEffect, useRef, useState, useLayoutEffect } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { SSHInfo, WebSSHConfig } from '../../types';
import { wsUrl } from '../../api';
import { sysClient, SessionHealth } from '../../sysClient';
import { sessionGet, sessionSet, globalGet, globalSet } from '../../storage';
import {
  Copy,
  Clipboard,
  X,
  Send,
  Check,
} from 'lucide-react';
import { DisconnectedOverlay } from './DisconnectedOverlay';
import { QuickKeyBar } from './QuickKeyBar';
import { TerminalToolbar } from './TerminalToolbar';
import { getXTermTheme, isLightTheme } from '../../theme';
import { QuickCommandBar } from './QuickCommandBar';

interface TerminalViewProps {
  tabId: string;
  sshInfo: SSHInfo;
  config: WebSSHConfig;
  sessionId?: string;
  reconnectMode?: 'restore' | 'force';
  isTabActive?: boolean;
  tabConnected?: boolean;
  onConnectionChange?: (connected: boolean) => void;
  onSessionInfo?: (sessionId: string, reattached: boolean) => void;
  onSessionTitle?: (sessionId: string, title: string) => void;
  onRecoverSession?: (force?: boolean) => void;
  onNewSession?: () => void;
  initialError?: string;
  onQuickCommandsChange?: (cmds: WebSSHConfig['quickCommands']) => void;
}

export const TerminalView: React.FC<TerminalViewProps> = ({
  tabId,
  sshInfo,
  config,
  sessionId,
  reconnectMode = 'restore',
  isTabActive = true,
  tabConnected,
  onConnectionChange,
  onSessionInfo,
  onSessionTitle,
  onRecoverSession,
  onNewSession,
  initialError,
  onQuickCommandsChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const decoderRef = useRef<TextDecoder | null>(null);
  const connectionCleanupRef = useRef<(() => void) | null>(null);
  const connectionAttemptRef = useRef<number>(0);
  const closeReasonRef = useRef<string>('');
  const suppressAutoRecoverRef = useRef<boolean>(false);
  const reconnectModeOverrideRef = useRef<'restore' | 'force' | null>(null);
  const deferredPayloadsRef = useRef<Array<string | ArrayBuffer>>([]);
  const localEchoBufferRef = useRef<number[]>([]);
  const pendingTriggerPayloadRef = useRef<string | ArrayBuffer | null>(null);
  const isReconnectCycleRef = useRef<boolean>(false);
  const reconnectCycleActiveRef = useRef<boolean>(false);
  const retryCountRef = useRef<number>(0);
  const cycleSuppressOutputRef = useRef<boolean>(false);
  const countdownTimerRef = useRef<number | null>(null);
  const silentReconnectRef = useRef<boolean>(false);
  const sysUnsubscribeRef = useRef<() => void>(null);
  const lastHeartbeatPingAtRef = useRef<number | null>(null);
  const heartbeatTimeoutRef = useRef<number | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const touchScrollStateRef = useRef<{ startY: number; lastY: number; accumulated: number } | null>(null);
  const momentumRef = useRef<{ velocity: number; animationFrame: number | null } | null>(null);
  const suppressTerminalInputRef = useRef<boolean>(false);
  const isCoarsePointerRef = useRef<boolean>(false);
  const lastTouchTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const suppressNextDblClickRef = useRef<boolean>(false);
  const sshInfoRef = useRef<SSHInfo>(sshInfo);
  const configRef = useRef<WebSSHConfig>(config);
  const sessionIdRef = useRef<string | undefined>(sessionId);
  useEffect(() => { sshInfoRef.current = sshInfo; }, [sshInfo]);
  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  const WS_META_PREFIX = '__WEBSSH_META__:';
  const RECONNECT_COUNTDOWN_SECONDS = 5;
  const MAX_RECONNECT_ATTEMPTS = 3;
  const RECONNECT_TRIGGER_RE = /[\r\n\x03]/;

  const [connected, setConnected] = useState<boolean>(false);
  const [sharedSession, setSharedSession] = useState<boolean>(false);
  const [connecting, setConnecting] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState<number>(config.fontSize || 14);
  const [clientLatencyMs, setClientLatencyMs] = useState<number | null>(null);
  const [sshLatencyMs, setSshLatencyMs] = useState<number | null>(null);
  const [offlineHoldEnabled, setOfflineHoldEnabled] = useState<boolean>(() => {
    try {
      return sessionGet('webssh_offline_hold') === '1';
    } catch {
      return false;
    }
  });
  const offlineHoldEnabledRef = useRef<boolean>(offlineHoldEnabled);
  useEffect(() => { offlineHoldEnabledRef.current = offlineHoldEnabled; }, [offlineHoldEnabled]);
  const [offlineSuspended, setOfflineSuspended] = useState<boolean>(false);
  const [reconnectSending, setReconnectSending] = useState<boolean>(false);
  const [countdownLeft, setCountdownLeft] = useState<number | null>(null);
  const [retryAttempt, setRetryAttempt] = useState<number>(1);
  const [debugEnabled, setDebugEnabled] = useState<boolean>(() => {
    try {
      return globalGet('webssh_terminal_debug') === '1';
    } catch {
      return false;
    }
  });
  const [debugEvents, setDebugEvents] = useState<string[]>([]);
  const isInvalidSessionError = Boolean(
    errorMsg && errorMsg.includes('Session not found or expired')
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
  const [showKeyBar, setShowKeyBar] = useState<boolean>(config.showKeyBar);
  const [showQuickCmds, setShowQuickCmds] = useState<boolean>(config.showQuickCmds);

  // Modifiers
  const [ctrlActive, setCtrlActive] = useState<boolean>(false);
  const [altActive, setAltActive] = useState<boolean>(false);
  const [shiftActive, setShiftActive] = useState<boolean>(false);

  const ctrlActiveRef = useRef<boolean>(false);
  const altActiveRef = useRef<boolean>(false);
  const shiftActiveRef = useRef<boolean>(false);

  useEffect(() => {
    ctrlActiveRef.current = ctrlActive;
    altActiveRef.current = altActive;
    shiftActiveRef.current = shiftActive;
  }, [ctrlActive, altActive, shiftActive]);

  useEffect(() => {
    suppressTerminalInputRef.current = pasteModalOpen;
  }, [pasteModalOpen]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    isCoarsePointerRef.current = window.matchMedia('(pointer: coarse)').matches;
  }, []);

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
      ctrlActiveRef.current = false;
    } else if (altActiveRef.current) {
      if (data.length === 1) {
        finalData = `\x1b${data}`;
      }
      setAltActive(false);
      altActiveRef.current = false;
    } else if (shiftActiveRef.current) {
      if (data.length === 1) {
        finalData = data.toUpperCase();
      }
      setShiftActive(false);
      shiftActiveRef.current = false;
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
      globalSet('webssh_terminal_debug', enabled ? '1' : '0');
    } catch {
      // ignore
    }
  };

  const persistOfflineHoldEnabled = (enabled: boolean) => {
    setOfflineHoldEnabled(enabled);
    try {
      sessionSet('webssh_offline_hold', enabled ? '1' : '0');
    } catch {
      // ignore
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

  const hasReconnectTrigger = (data: string): boolean => {
    return RECONNECT_TRIGGER_RE.test(data);
  };

  const clearCountdownTimer = () => {
    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  };

  const setCycleActive = (active: boolean) => {
    reconnectCycleActiveRef.current = active;
    setReconnectSending(active);
  };

  const setCountdown = (left: number | null) => {
    setCountdownLeft(left);
  };

  const performReconnect = () => {
    isReconnectCycleRef.current = true;
    cycleSuppressOutputRef.current = true;
    reconnectModeOverrideRef.current = closeReasonRef.current === 'session_busy' || closeReasonRef.current === 'taken_over' ? 'force' : 'restore';
    connectWebSocket(reconnectModeOverrideRef.current || undefined, true);
  };

  const startCountdown = () => {
    const attempt = retryCountRef.current + 1;
    setRetryAttempt(attempt);
    setCycleActive(true);
    clearCountdownTimer();
    let left = RECONNECT_COUNTDOWN_SECONDS;
    setCountdown(left);
    countdownTimerRef.current = window.setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearCountdownTimer();
        setCountdown(null);
        performReconnect();
        return;
      }
      setCountdown(left);
    }, 1000);
  };

  const beginReconnectCycle = (triggerPayload: string | ArrayBuffer) => {
    pendingTriggerPayloadRef.current = triggerPayload;
    if (reconnectCycleActiveRef.current) return;
    startCountdown();
  };

  const failReconnectCycle = () => {
    if (!isReconnectCycleRef.current) return;
    isReconnectCycleRef.current = false;
    cycleSuppressOutputRef.current = false;
    clearCountdownTimer();
    setCountdown(null);
    setOfflineSuspended(true);
    setErrorMsg(null);
    retryCountRef.current += 1;
    if (retryCountRef.current >= MAX_RECONNECT_ATTEMPTS) {
      pendingTriggerPayloadRef.current = null;
      retryCountRef.current = 0;
      setCycleActive(false);
      window.setTimeout(() => terminalRef.current?.focus(), 50);
    } else {
      startCountdown();
    }
  };

  const completeReconnectCycle = () => {
    isReconnectCycleRef.current = false;
    cycleSuppressOutputRef.current = false;
    pendingTriggerPayloadRef.current = null;
    clearCountdownTimer();
    setCountdown(null);
    setCycleActive(false);
    retryCountRef.current = 0;
  };

  const cancelReconnectCycle = () => {
    isReconnectCycleRef.current = false;
    cycleSuppressOutputRef.current = false;
    pendingTriggerPayloadRef.current = null;
    clearCountdownTimer();
    setCountdown(null);
    setCycleActive(false);
    retryCountRef.current = 0;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    window.setTimeout(() => terminalRef.current?.focus(), 50);
  };

  const sendOfflineInput = (payload: string | ArrayBuffer, echo: boolean) => {
    if (hasReconnectTrigger(payload as string)) {
      if (echo) localEcho(payload as string);
      beginReconnectCycle(payload);
      return;
    }
    enqueueDeferredPayload(payload);
    if (echo) localEcho(payload as string);
  };

  const sendResize = () => {
    if (!terminalRef.current) return;
    try {
      fitAddonRef.current?.fit();
      terminalRef.current.refresh(0, terminalRef.current.rows - 1);
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        pushDebugEvent(`resize cols=${terminalRef.current.cols} rows=${terminalRef.current.rows}`);
        ws.send(JSON.stringify({
          type: 'resize',
          cols: terminalRef.current.cols,
          rows: terminalRef.current.rows,
        }));
      }
    } catch {
      // ignore
    }
  };

  const cellWidth = (ch: string): number => {
    const c = ch.codePointAt(0);
    if (c === undefined) return 1;
    if (
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd)
    ) {
      return 2;
    }
    return 1;
  };

  const localEcho = (data: string) => {
    const term = terminalRef.current;
    if (!term) return;
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      const code = ch.codePointAt(0)!;
      if (ch === '\x1b') {
        // Escape sequence (arrow keys, etc.): pass through raw, do not track.
        term.write(data.slice(i));
        break;
      }
      if (ch === '\r' || ch === '\n') {
        // Offline trigger (Enter): do not echo the newline so the cursor
        // doesn't wrap, and keep the buffer so backspace still works.
        i += 1;
        continue;
      }
      if (ch === '\x7f' || ch === '\x08') {
        const buf = localEchoBufferRef.current;
        if (buf.length > 0) {
          const cells = buf.pop()!;
          term.write(`\x08${' '.repeat(cells)}\x08`);
        }
        i += 1;
        continue;
      }
      if (code >= 0x20) {
        localEchoBufferRef.current.push(cellWidth(ch));
        term.write(ch);
        i += ch.length;
        continue;
      }
      term.write(ch);
      i += 1;
    }
  };

  const sendRawToTerminal = (data: string, focusTerminal = true) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
      if (focusTerminal) terminalRef.current?.focus();
      return;
    }
    if (offlineHoldEnabledRef.current) {
      sendOfflineInput(data, true);
      if (focusTerminal) terminalRef.current?.focus();
    }
  };

  const sendKeyToTerminal = (data: string) => {
    sendRawToTerminal(processInputData(data));
  };

  const sendPasteToTerminal = (text: string, focusTerminal = true) => {
    const bracketedPasteActive = Boolean(terminalRef.current?.modes.bracketedPasteMode);
    let payload = bracketedPasteActive ? `\x1b[200~${text}\x1b[201~` : text;

    const CHUNK_SIZE = 4096;
    const CHUNK_DELAY_MS = 20;
    if (payload.length <= CHUNK_SIZE) {
      sendRawToTerminal(payload, focusTerminal);
      return;
    }

    let offset = 0;
    const flush = () => {
      if (offset >= payload.length) {
        if (focusTerminal) terminalRef.current?.focus();
        return;
      }
      const piece = payload.slice(offset, offset + CHUNK_SIZE);
      offset += CHUNK_SIZE;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(piece);
        window.setTimeout(flush, CHUNK_DELAY_MS);
      } else {
        sendRawToTerminal(piece, false);
      }
    };
    flush();
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
    if (sysUnsubscribeRef.current) sysUnsubscribeRef.current();
    lastHeartbeatPingAtRef.current = null;
    if (heartbeatTimeoutRef.current !== null) {
      window.clearTimeout(heartbeatTimeoutRef.current);
      heartbeatTimeoutRef.current = null;
    }
    if (heartbeatIntervalRef.current !== null) {
      window.clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
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
          sendPasteToTerminal(text);
          suppressTerminalInputRef.current = false;
          window.setTimeout(() => terminalRef.current?.focus(), 50);
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
      sendPasteToTerminal(pasteInputText, false);
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
    clearCountdownTimer();
    setCountdown(null);

    setConnecting(true);
    setConnected(false);
    setClientLatencyMs(null);
    setSshLatencyMs(null);
    setErrorMsg(null);
    setOfflineSuspended(false);
    silentReconnectRef.current = silentReconnect;

    // Initialize xterm
    if (!terminalRef.current) {
      const term = new XTerminal({
        cursorBlink: true,
        fontSize: fontSize,
        fontFamily: config.fontFamily || 'Consolas, Monaco, "Courier New", monospace',
        theme: getXTermTheme(config.theme),
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
      terminalRef.current.options.theme = getXTermTheme(config.theme);
      terminalRef.current.options.fontSize = fontSize;
    } else {
      terminalRef.current.options.theme = getXTermTheme(config.theme);
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

    const curSshInfo = sshInfoRef.current;
    const curConfig = configRef.current;
    const curSessionId = sessionIdRef.current;
    if (!silentReconnect) {
      term.writeln(`\r\n\x1b[32m[WebSSH]\x1b[0m Connecting to \x1b[36m${curSshInfo.username}@${curSshInfo.host}:${curSshInfo.port}\x1b[0m...`);
    }

    // Determine WebSocket protocol (ws or wss)
    const cols = term.cols || 120;
    const rows = term.rows || 30;
    const clientId = tabId;
    const timeout = curConfig.timeout || 120;
    const effectiveReconnectMode = modeOverride || reconnectModeOverrideRef.current || reconnectMode;
    reconnectModeOverrideRef.current = null;
    let preparedSessionId = curSessionId || '';
    // Build WS URL with inline session creation params (no HTTP POST needed)
    const params = new URLSearchParams();
    params.set('clientId', clientId);
    params.set('cols', String(cols));
    params.set('rows', String(rows));
    params.set('timeout', String(timeout));
    params.set('forceAttach', effectiveReconnectMode === 'force' ? '1' : '0');
    if (curSessionId) {
      params.set('sessionId', curSessionId);
    } else {
      if (curSshInfo.id) {
        params.set('credentialId', curSshInfo.id);
      } else {
        params.set('sshInfo', JSON.stringify(curSshInfo));
      }
      params.set('title', curSshInfo.name || `${curSshInfo.username}@${curSshInfo.host}`);
    }
    const wsConnectUrl = wsUrl('/term', params.toString());
    pushDebugEvent(`ws url ${wsConnectUrl}`);

    const ws = new WebSocket(wsConnectUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    decoderRef.current = new TextDecoder('utf-8');

    ws.onopen = () => {
      if (!isCurrentConnection()) return;
      pushDebugEvent(`ws open attempt=${attemptId} cols=${cols} rows=${rows}`);
      // 不在这里显示 "Connection established"，等收到 session_info 后再显示
      fitAddon?.fit();
    };

    ws.onmessage = (event) => {
      if (!isCurrentConnection()) return;
      if (typeof event.data === 'string' && event.data.startsWith(WS_META_PREFIX)) {
        try {
          const meta = JSON.parse(event.data.slice(WS_META_PREFIX.length));
          pushDebugEvent(`ws meta ${JSON.stringify(meta)}`);
          if (meta.type === 'session_info') {
            if (typeof meta.shared === 'boolean') setSharedSession(meta.shared);
            if (typeof meta.sessionId === 'string') {
              onSessionInfo?.(meta.sessionId, Boolean(meta.reattached));
            }
            // SSH 会话真正就绪后显示连接成功
            setConnecting(false);
            setConnected(true);
            setOfflineSuspended(false);
            onConnectionChange?.(true);
            if (!silentReconnectRef.current) {
              term.writeln('\x1b[32m[WebSSH]\x1b[0m Connection established.\r\n');
            }
            fitAddon?.fit();
            // 启动 /term 心跳，避免反向代理/空闲超时断开（240s 常见，需 <60s）
            if (heartbeatIntervalRef.current !== null) {
              window.clearInterval(heartbeatIntervalRef.current);
            }
            // 立即发一次，随后 20s 间隔
            sendHeartbeatPing(ws);
            heartbeatIntervalRef.current = window.setInterval(() => {
              sendHeartbeatPing(ws);
            }, 20000);
            // 终端重连成功时，如果 /sys 处于断开状态，也触发重连
            if (isReconnectCycleRef.current && sysClient.getConnectionState() !== 'open') {
              sysClient.reconnect();
            }
            if (!isReconnectCycleRef.current) {
              completeReconnectCycle();
            }
            if (isReconnectCycleRef.current) {
              cycleSuppressOutputRef.current = false;
              if (localEchoBufferRef.current.length > 0) {
                localEchoBufferRef.current = [];
                terminalRef.current?.write('\x1b[K');
              }
              flushDeferredPayloads(ws);
              if (pendingTriggerPayloadRef.current !== null) {
                const trigger = pendingTriggerPayloadRef.current;
                pendingTriggerPayloadRef.current = null;
                try {
                  ws.send(trigger);
                } catch {
                  // ignore
                }
              }
              completeReconnectCycle();
            }
            return;
          }
          if (meta.type === 'shared_state') {
            if (typeof meta.shared === 'boolean') setSharedSession(meta.shared);
            return;
          }
          if (meta.type === 'pong') {
            if (heartbeatTimeoutRef.current !== null) {
              window.clearTimeout(heartbeatTimeoutRef.current);
              heartbeatTimeoutRef.current = null;
            }
            return;
          }
          if (meta.type === 'session_busy') {
            closeReasonRef.current = 'session_busy';
            setErrorMsg('This session is already attached by another browser tab or device.');
            setConnecting(false);
            setConnected(false);
            setClientLatencyMs(null);
            setSshLatencyMs(null);
            onConnectionChange?.(false);
            return;
          }
          if (meta.type === 'session_taken_over') {
            closeReasonRef.current = 'taken_over';
            setErrorMsg('This session was taken over by another browser tab or device.');
            setConnecting(false);
            setConnected(false);
            setClientLatencyMs(null);
            setSshLatencyMs(null);
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
            setClientLatencyMs(null);
            setSshLatencyMs(null);
            onConnectionChange?.(false);
            return;
          }
          if (meta.type === 'session_title') {
            if (typeof meta.sessionId === 'string' && typeof meta.title === 'string') {
              onSessionTitle?.(meta.sessionId, meta.title);
            }
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
        if (!cycleSuppressOutputRef.current) {
          term.write(event.data);
        }
        return;
      }

      if (event.data instanceof ArrayBuffer) {
        const decoded = decoderRef.current?.decode(new Uint8Array(event.data), { stream: true }) || '';
        const controls = extractControlSequences(decoded);
        if (controls.length > 0) {
          pushDebugEvent(`ws binary controls ${controls.join(' | ')}`);
        }
        if (!cycleSuppressOutputRef.current) {
          term.write(decoded);
        }
        return;
      }

      if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((buffer) => {
          const decoded = decoderRef.current?.decode(new Uint8Array(buffer), { stream: true }) || '';
          const controls = extractControlSequences(decoded);
          if (controls.length > 0) {
            pushDebugEvent(`ws blob controls ${controls.join(' | ')}`);
          }
          if (!cycleSuppressOutputRef.current) {
            term.write(decoded);
          }
        });
      }
    };

    ws.onerror = () => {
      if (!isCurrentConnection()) return;
      pushDebugEvent(`ws error attempt=${attemptId}`);
      closeReasonRef.current = 'websocket_error';
      if (isReconnectCycleRef.current) {
        // onclose always follows onerror per spec; guard in case it does not fire.
        window.setTimeout(() => {
          if (connectionAttemptRef.current === attemptId && isReconnectCycleRef.current) {
            failReconnectCycle();
          }
        }, 3000);
        return;
      }
      setReconnectSending(false);
      if (offlineHoldEnabledRef.current) {
        setConnected(false);
        onConnectionChange?.(false);
        return;
      }
      setConnecting(false);
      setConnected(false);
      setClientLatencyMs(null);
      setSshLatencyMs(null);
      setErrorMsg('WebSocket connection failed.');
      onConnectionChange?.(false);
    };

    ws.onclose = (event) => {
      if (!isCurrentConnection()) return;
      pushDebugEvent(`ws close attempt=${attemptId} code=${event.code} reason=${event.reason || '(none)'} clean=${event.wasClean}`);
      const wasReconnectCycle = isReconnectCycleRef.current;
      const wasSuppressingOutput = cycleSuppressOutputRef.current;
      cycleSuppressOutputRef.current = false;
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
      if (sysUnsubscribeRef.current) sysUnsubscribeRef.current();
      lastHeartbeatPingAtRef.current = null;
      if (heartbeatTimeoutRef.current !== null) {
        window.clearTimeout(heartbeatTimeoutRef.current);
        heartbeatTimeoutRef.current = null;
      }
      if (heartbeatIntervalRef.current !== null) {
        window.clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      const remaining = decoderRef.current?.decode();
      if (remaining && !wasSuppressingOutput) {
        term.write(remaining);
      }
      setConnecting(false);
      setConnected(false);
      setClientLatencyMs(null);
      setSshLatencyMs(null);
      onConnectionChange?.(false);

      if (wasReconnectCycle) {
        failReconnectCycle();
        return;
      }

      setReconnectSending(false);

      if (offlineHoldEnabledRef.current) {
        if (closeReasonRef.current === 'ssh_connect_error' || closeReasonRef.current === 'session_busy' || closeReasonRef.current === 'taken_over' || closeReasonRef.current === 'ssh_shell_error') {
          // Fatal errors: show the error overlay (do NOT set offlineSuspended)
          return;
        }
        setOfflineSuspended(true);
        setErrorMsg(null);
        window.setTimeout(() => terminalRef.current?.focus(), 50);
        return;
      }

      // Normal mode (cloud off disabled): show error overlay with Restore Session button
      if (closeReasonRef.current === '' || closeReasonRef.current === 'heartbeat_timeout') {
        if (!errorMsg) {
          setErrorMsg('Connection lost. Click "Restore Session" to reconnect.');
        }
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
      if (offlineHoldEnabledRef.current) {
        sendOfflineInput(finalData, true);
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
      if (offlineHoldEnabledRef.current) {
        const hasTrigger = bytes.some((b) => b === 0x0d || b === 0x0a || b === 0x03);
        if (hasTrigger) {
          beginReconnectCycle(bytes.buffer);
        } else {
          enqueueDeferredPayload(bytes.buffer);
        }
      }
    });

    // Resize listener with ResizeObserver to adapt to keybar visibility changes
    const handleResize = () => sendResize();

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(handleResize);
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    window.addEventListener('resize', handleResize);
    const handleVisualViewportResize = () => requestAnimationFrame(handleResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleVisualViewportResize);
    }

    const SCROLL_SENSITIVITY = 1.5;
    const SCROLL_LINE_HEIGHT = 18;
    const MOMENTUM_VELOCITY_THRESHOLD = 0.15;
    const MOMENTUM_FRICTION = 0.97;
    const MOMENTUM_MIN_VELOCITY = 0.02;
    const TAP_THRESHOLD = 8;

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || !containerRef.current) return;
      if (momentumRef.current?.animationFrame != null) {
        cancelAnimationFrame(momentumRef.current.animationFrame);
        momentumRef.current = null;
      }
      touchScrollStateRef.current = {
        startY: event.touches[0].clientY,
        lastY: event.touches[0].clientY,
        accumulated: 0,
      };
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1 || !touchScrollStateRef.current) return;
      event.preventDefault();
      const state = touchScrollStateRef.current;
      const dy = event.touches[0].clientY - state.lastY;
      state.lastY = event.touches[0].clientY;
      state.accumulated += dy;
      const lineDelta = Math.round(state.accumulated / SCROLL_LINE_HEIGHT * SCROLL_SENSITIVITY);
      if (lineDelta !== 0) {
        terminalRef.current?.scrollLines(-lineDelta);
        state.accumulated -= lineDelta * SCROLL_LINE_HEIGHT / SCROLL_SENSITIVITY;
      }
    };
    const handleTouchEnd = (event: TouchEvent) => {
      const state = touchScrollStateRef.current;
      if (!state) return;
      const totalDy = state.lastY - state.startY;
      if (Math.abs(totalDy) > TAP_THRESHOLD) {
        const vel = totalDy / 100;
        if (Math.abs(vel) > MOMENTUM_VELOCITY_THRESHOLD) {
          const anim = { velocity: vel, animationFrame: null };
          momentumRef.current = anim;
          const step = () => {
            const cur = momentumRef.current;
            if (!cur) return;
            cur.velocity *= MOMENTUM_FRICTION;
            if (Math.abs(cur.velocity) < MOMENTUM_MIN_VELOCITY) {
              momentumRef.current = null;
              return;
            }
            const lines = Math.round(cur.velocity * SCROLL_SENSITIVITY);
            if (lines !== 0) terminalRef.current?.scrollLines(-lines);
            cur.animationFrame = requestAnimationFrame(step);
          };
          anim.animationFrame = requestAnimationFrame(step);
        }
      } else {
        const t = event.changedTouches[0];
        if (t) {
          const now = Date.now();
          const prev = lastTouchTapRef.current;
          lastTouchTapRef.current = { time: now, x: t.clientX, y: t.clientY };
          if (
            prev &&
            now - prev.time < 350 &&
            Math.abs(t.clientX - prev.x) < 24 &&
            Math.abs(t.clientY - prev.y) < 24
          ) {
            lastTouchTapRef.current = null;
            suppressNextDblClickRef.current = true;
            window.setTimeout(() => { suppressNextDblClickRef.current = false; }, 600);
            sendRawToTerminal('\t\t');
            terminalRef.current?.focus();
          }
        }
      }
      touchScrollStateRef.current = null;
    };

    if (containerRef.current) {
      containerRef.current.addEventListener('touchstart', handleTouchStart, { passive: false });
      containerRef.current.addEventListener('touchmove', handleTouchMove, { passive: false });
      containerRef.current.addEventListener('touchend', handleTouchEnd, { passive: true });
      containerRef.current.addEventListener('touchcancel', () => { touchScrollStateRef.current = null; }, { passive: true });
    }

    const cleanupArtifacts = () => {
      if (momentumRef.current?.animationFrame != null) {
        cancelAnimationFrame(momentumRef.current.animationFrame);
      }
      selectionDisposable.dispose();
      ansiRequestModeDisposable.dispose();
      decRequestModeDisposable.dispose();
      onDataDisposable.dispose();
      onBinaryDisposable.dispose();
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleVisualViewportResize);
      }
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
    if (initialError) {
      setErrorMsg(initialError);
      setConnecting(false);
      setConnected(false);
      setClientLatencyMs(null);
      setSshLatencyMs(null);
      onConnectionChange?.(false);
      return;
    }
    connectWebSocket();
    return () => {
      cleanupConnection();
    };
    // 仅在关键重连参数变化时重建，sshInfo/config 通过 ref 读取避免对象引用抖动导致双 /term
  }, [reconnectMode, initialError]);

  // 延迟显示：始终同步更新两个值，保证同时显示/不显示
  useEffect(() => {
    const unsub = sysClient.subscribe((snapshot) => {
      if (snapshot.clientRttMs !== null && snapshot.clientRttMs !== undefined) {
        let sshLatency: number | null = null;
        if (sessionId) {
          const session = snapshot.sessions.find((s) => s.sessionId === sessionId);
          if (session) sshLatency = session.sshLatencyMs;
        }
        setSshLatencyMs(sshLatency);
        setClientLatencyMs(snapshot.clientRttMs);
      }
    });
    const unsubState = sysClient.subscribeState((state) => {
      if (state !== 'open') {
        setClientLatencyMs(null);
        setSshLatencyMs(null);
      }
    });
    return () => {
      unsub();
      unsubState();
    };
  }, [sessionId]);

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
      terminalRef.current.options.theme = getXTermTheme(config.theme);
      terminalRef.current.options.fontFamily = config.fontFamily || 'Consolas, Monaco, "Courier New", monospace';
    }
  }, [config.theme, config.fontFamily]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !fitAddonRef.current || !terminalRef.current) return;

    sendResize();
    const raf = requestAnimationFrame(sendResize);
    const timer = setTimeout(sendResize, 50);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [showKeyBar, connected]);

  const handleClearTerminal = () => {
    terminalRef.current?.clear();
  };

  const isLight = isLightTheme(config.theme);

  return (
    <div
      className={`flex flex-col h-full relative overflow-hidden select-none transition-colors ${
        isLight ? 'bg-white text-slate-800' : 'bg-slate-950 text-slate-100'
      }`}
    >
      <TerminalToolbar
        isLight={isLight}
        connected={connected}
        tabConnected={tabConnected}
        offlineSuspended={offlineSuspended}
        connecting={connecting}
        selectedText={selectedText}
        disableCopy={!selectedText && !terminalRef.current?.getSelection()}
        showKeyBar={showKeyBar}
        showQuickCmds={showQuickCmds}
        offlineHoldEnabled={offlineHoldEnabled}
        sharedSession={sharedSession}
        clientLatencyMs={clientLatencyMs}
        sshLatencyMs={sshLatencyMs}
        onSelectMode={handleOpenSelectionModal}
        onCopySelection={handleCopySelection}
        onPaste={handlePaste}
        onToggleKeyBar={() => setShowKeyBar(!showKeyBar)}
        onToggleQuickCmds={() => setShowQuickCmds(!showQuickCmds)}
        onToggleOfflineHold={() => persistOfflineHoldEnabled(!offlineHoldEnabled)}
        onToggleSharedSession={toggleSharedSession}
        onFontSizeIncrease={() => setFontSize((f) => Math.min(24, f + 1))}
        onFontSizeDecrease={() => setFontSize((f) => Math.max(10, f - 1))}
        onClearTerminal={handleClearTerminal}
        onRecoverSession={() => onRecoverSession?.()}
      />

      {showQuickCmds && (
      <QuickCommandBar
        isLight={isLight}
        connected={connected}
        offlineSuspended={offlineSuspended}
        sendKeyToTerminal={sendKeyToTerminal}
        commands={config.quickCommands}
        onSave={onQuickCommandsChange}
      />
      )}

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
        className="flex-1 min-h-0 w-full overflow-hidden pl-[8px] transition-colors duration-200"
        style={{
          backgroundColor: getXTermTheme(config.theme).background || (isLight ? '#ffffff' : '#0a0f1d'),
        }}
        onClick={() => terminalRef.current?.focus()}
        onDoubleClickCapture={(e) => {
          if (suppressNextDblClickRef.current) {
            suppressNextDblClickRef.current = false;
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          sendRawToTerminal('\t\t');
          terminalRef.current?.focus();
        }}
      />

      {showKeyBar && (connected || offlineSuspended) && (
        <QuickKeyBar
          isLight={isLight}
          ctrlActive={ctrlActive}
          altActive={altActive}
          shiftActive={shiftActive}
          onCtrlToggle={() => setCtrlActive(!ctrlActive)}
          onAltToggle={() => setAltActive(!altActive)}
          onShiftToggle={() => setShiftActive(!shiftActive)}
          sendKeyToTerminal={sendKeyToTerminal}
        />
      )}

      {/* Reconnect Modal (offline mode: auto retry with countdown + attempt number, closeable) */}
      {reconnectSending && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4 z-50 select-none">
          <div className={`rounded-xl w-full max-w-sm p-3 shadow-2xl flex flex-col gap-3 border ${
            isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800'
          }`}>
            <div className="flex items-center justify-between shrink-0">
              <h3 className={`font-bold text-xs sm:text-sm ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>
                {countdownLeft !== null && countdownLeft > 0
                  ? `Reconnect attempt ${retryAttempt} of ${MAX_RECONNECT_ATTEMPTS}`
                  : 'Reconnecting...'}
              </h3>
              <button
                onClick={cancelReconnectCycle}
                className={`p-1 rounded ${isLight ? 'text-slate-400 hover:text-slate-600' : 'text-slate-400 hover:text-slate-200'}`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex flex-col items-center gap-2.5 py-2">
              {countdownLeft !== null && countdownLeft > 0 ? (
                <div className={`text-xs font-mono text-center ${isLight ? 'text-slate-600' : 'text-slate-300'}`}>
                  Reconnecting in {countdownLeft}s...
                  <br />
                  Command will be sent automatically
                </div>
              ) : (
                <>
                  <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                  <div className={`text-xs font-mono text-center ${isLight ? 'text-slate-600' : 'text-slate-300'}`}>
                    Reconnecting... (attempt {retryAttempt} of {MAX_RECONNECT_ATTEMPTS})
                    <br />
                    Command will be sent automatically
                  </div>
                </>
              )}
            </div>

            <div className="flex justify-end">
              <button
                onClick={cancelReconnectCycle}
                className={`px-3.5 py-1 rounded-lg text-xs font-medium transition cursor-pointer ${
                  isLight ? 'bg-slate-200 text-slate-600 hover:bg-slate-300' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Terminal Text Selection Modal (Mobile Friendly) */}
      {selectionModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4 z-50 select-none">
          <div className={`rounded-xl w-full max-w-3xl h-[88vh] p-3 shadow-2xl flex flex-col gap-2 ${
            isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800'
          } border`}>
            <div className="flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <Copy className="w-4 h-4 text-indigo-400" />
                <h3 className={`font-bold text-xs sm:text-sm ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>Select Output</h3>
              </div>
              <button
                onClick={() => setSelectionModalOpen(false)}
                className={`p-1 rounded ${isLight ? 'text-slate-400 hover:text-slate-600' : 'text-slate-400 hover:text-slate-200'}`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <textarea
              readOnly
              value={selectionBufferText}
              className={`flex-1 w-full border rounded-lg p-2.5 text-xs font-mono focus:outline-none leading-relaxed overflow-y-auto select-text resize-none ${
                isLight
                  ? 'bg-slate-50 border-slate-200 text-slate-700 focus:border-slate-400'
                  : 'bg-slate-950 border-slate-800 text-slate-200 focus:border-slate-700'
              }`}
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
                className={`px-3.5 py-1 rounded-lg text-xs font-medium transition cursor-pointer ${
                  isLight
                    ? 'bg-slate-200 text-slate-600 hover:bg-slate-300'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Paste Content Modal / Fallback for Mobile Privacy */}
      {pasteModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4 z-50 select-none">
          <div className={`rounded-xl w-full max-w-3xl h-[88vh] p-3 shadow-2xl flex flex-col gap-2 ${
            isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800'
          } border`}>
            <div className="flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <Clipboard className="w-4 h-4 text-emerald-400" />
                <h3 className={`font-bold text-xs sm:text-sm ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>Paste to Terminal</h3>
              </div>
              <button
                onClick={() => setPasteModalOpen(false)}
                className={`p-1 rounded ${isLight ? 'text-slate-400 hover:text-slate-600' : 'text-slate-400 hover:text-slate-200'}`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <textarea
              value={pasteInputText}
              onChange={(e) => setPasteInputText(e.target.value)}
              placeholder="Paste text here or long-press to paste..."
              autoFocus
              className={`flex-1 w-full border rounded-lg p-2.5 text-[16px] sm:text-xs font-mono focus:outline-none leading-relaxed overflow-y-auto resize-none ${
                isLight
                  ? 'bg-slate-50 border-slate-200 text-slate-700 focus:border-slate-400 placeholder-slate-400'
                  : 'bg-slate-950 border-slate-800 text-slate-200 focus:border-slate-700 placeholder-slate-500'
              }`}
              onFocus={() => terminalRef.current?.textarea?.blur()}
            />

            <div className="flex items-center justify-end gap-2 shrink-0 pt-0.5">
              <button
                onClick={() => setPasteModalOpen(false)}
                className={`px-3.5 py-1 rounded-lg text-xs font-medium transition cursor-pointer ${
                  isLight
                    ? 'bg-slate-200 text-slate-600 hover:bg-slate-300'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
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

      {!connected && !connecting && !offlineSuspended && (
        <DisconnectedOverlay
          isLight={isLight}
          errorMsg={errorMsg}
          sessionId={sessionId}
          isInvalidSessionError={isInvalidSessionError}
          canForceRestore={canForceRestore}
          onRecoverSession={onRecoverSession}
          onNewSession={onNewSession}
        />
      )}
    </div>
  );
};
