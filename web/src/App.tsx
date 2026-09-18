import { useState, useEffect, useCallback, useRef } from 'react';
import { SSHInfo, SSHTab, WebSSHConfig, defaultQuickCommands } from './types';
import { apiFetch, apiUrl } from './api';
import { sessionGet, sessionSet, globalGet, globalSet } from './storage';
import { sysClient } from './sysClient';
import { Header } from './components/Header';
import { Tabs } from './components/Tabs';
import { TerminalView } from './components/terminal/TerminalView';
import { SFTPView } from './components/SFTPView';
import { AiPanel } from './components/AiPanel';
import type { TerminalBridge } from './aiClient';
import { ConnectionModal } from './components/ConnectionModal';
import { SavedHostsModal } from './components/SavedHostsModal';
import { SettingsModal } from './components/SettingsModal';
import { SessionsModal } from './components/SessionsModal';
import { SessionHealth } from './sysClient';
import { LoginPage } from './components/LoginPage';
import { Terminal, Server } from 'lucide-react';

export default function App() {
  const pad = (value: number, length = 2) => value.toString().padStart(length, '0');
  const buildTabTitle = useCallback((sshInfo: SSHInfo) => sshInfo.name || `${sshInfo.username}@${sshInfo.host}`, []);
  const redactTab = (tab: SSHTab): SSHTab => ({
    ...tab,
    sshInfo: (({ password, privateKey, passphrase, ...safe }) => safe)(tab.sshInfo),
  });

  const windowIdRaw = (() => {
    const stored = (() => {
      try { return sessionGet('webssh_window_id'); } catch { return null; }
    })();
    if (stored && window.name === stored) {
      return stored.replace('wid-', '');
    }
    // Duplicate tab or first load: clean stale state and generate fresh ID
    if (stored) {
      try {
        sessionStorage.removeItem(`webssh_active_tabs:${stored}`);
        sessionStorage.removeItem(`webssh_active_tab:${stored}`);
      } catch {}
    }
    const d = new Date();
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
    const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    const raw = `${ts}-${rand}`;
    window.name = `wid-${raw}`;
    return raw;
  })();
  const windowId = `wid-${windowIdRaw}`;
  sessionSet('webssh_window_id', windowId);
  const activeTabsStorageKey = `webssh_active_tabs:${windowId}`;
  const activeTabIdStorageKey = `webssh_active_tab:${windowId}`;

  // AI 面板：每个 tab 独立实例，X 只隐藏（hidden 保活，历史保留），
  // 只有 tab 关闭 / 会话被杀时才真正卸载。不放进 SSHTab 是因为 tab 会被
  // 序列化进 sessionStorage，而诊断文本可能几十 KB，不该进存储。
  const [aiMountedTabs, setAiMountedTabs] = useState<string[]>([]);
  const [aiOpenTabs, setAiOpenTabs] = useState<string[]>([]);
  /**
   * 用户对 AI 面板的**意图**（是否希望它开着），tabId → boolean。
   *
   * 与 aiOpenTabs 的区别：终端断开会被动卸载面板，但用户的意图仍是「开着」，
   * 重连成功后据此自动恢复。用 ref 是因为它只在连接状态回调里读，不该驱动渲染。
   */
  const aiIntentRef = useRef<Map<string, boolean>>(new Map());
  // 供只跑一次的 /sys 订阅 effect 读取最新值（避免闭包过期）
  const tabsRef = useRef<SSHTab[]>([]);
  const aiOpenRef = useRef<string[]>([]);
  const openAiPanelRef = useRef<(id: string) => void>(() => {});
  const openAiPanel = useCallback((id: string) => {
    aiIntentRef.current.set(id, true);
    setAiMountedTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setAiOpenTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);
  openAiPanelRef.current = openAiPanel;
  const closeAiPanel = useCallback((id: string) => {
    // 只有用户主动关（或对端同步关）才改意图；被动卸载走 removeAiPanel
    aiIntentRef.current.set(id, false);
    setAiOpenTabs((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : prev));
  }, []);
  const removeAiPanel = useCallback((id: string) => {
    // 被动卸载：保留意图，等重连恢复。
    // 注意每个 setter 在「无变化」时返回原引用 —— 否则值没变但引用变，
    // 会触发重渲染 → onBusyChange 再次触发 → 无限 setState 循环。
    setAiMountedTabs((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : prev));
    setAiOpenTabs((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : prev));
  }, []);

  /**
   * 终端不可用的 tab（重连中 / 已断开）。
   *
   * 语义按产品要求：**终端不能操作时，AI 面板收起**（隐藏），但面板本身保持挂载、
   * 开关状态（aiOpenTabs / 服务端 panelOpen）不变 —— 重连成功后自动重新显示。
   * 用隐藏而非卸载：卸载会 close() 掉 /ai 连接、丢掉卡片状态，且重连后又得重建。
   */
  const [busyTabs, setBusyTabs] = useState<string[]>([]);
  const handleBusyChange = useCallback((tabId: string, busy: boolean) => {
    setBusyTabs((prev) => {
      const has = prev.includes(tabId);
      if (busy) return has ? prev : [...prev, tabId];
      return has ? prev.filter((t) => t !== tabId) : prev;
    });
  }, []);

  // 终端上下文取源：tabId → 「取选区，没有就取末尾若干行」。
  // 与命令 sink / 执行桥同一个模式：能力由 TerminalView 注册，App 只当中转。
  const contextSourcesRef = useRef<Map<string, () => { text: string; source: 'selection' | 'tail' }>>(new Map());
  const registerContextSource = useCallback(
    (tabId: string) => (source: (() => { text: string; source: 'selection' | 'tail' }) | null) => {
      if (source) contextSourcesRef.current.set(tabId, source);
      else contextSourcesRef.current.delete(tabId);
    },
    [],
  );

  // 命令下发通道：tabId → 「把命令写进该 tab 终端输入行」的函数。
  // 用 ref 而不是 state：它只在事件回调里被读，进 state 会让整棵树白重渲染；
  // 「能不能执行」由 tab.connected 单独驱动 UI。
  const commandSinksRef = useRef<Map<string, (command: string, submit: boolean) => boolean>>(new Map());
  const registerCommandSink = useCallback(
    (tabId: string) => (sink: ((command: string, submit: boolean) => boolean) | null) => {
      if (sink) commandSinksRef.current.set(tabId, sink);
      else commandSinksRef.current.delete(tabId);
    },
    [],
  );

  // Agent 的执行桥：tabId → 该 tab 终端的「结构化采集 + 身份探测」能力。
  // 同样用 ref：Agent 循环是个异步状态机，回调里读到的必须是最新那一条连接。
  const execBridgesRef = useRef<Map<string, TerminalBridge>>(new Map());
  const registerExecBridge = useCallback(
    (tabId: string) => (bridge: TerminalBridge | null) => {
      if (bridge) execBridgesRef.current.set(tabId, bridge);
      else execBridgesRef.current.delete(tabId);
    },
    [],
  );
  const generateTabId = useCallback((existingTabs: SSHTab[]): string => {
    const usedIds = new Set(existingTabs.map((t) => t.id));
    let id: string;
    do {
      const rand = Math.random().toString(36).slice(2, 7);
      id = `tid-${windowIdRaw}-${rand}`;
    } while (usedIds.has(id));
    return id;
  }, []);

  const [tabs, setTabs] = useState<SSHTab[]>(() => {
    try {
      const saved = sessionGet(activeTabsStorageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          return parsed.map((tab) => ({
            ...tab,
            sshInfo: (({ password, privateKey, passphrase, ...safe }) => safe)(tab.sshInfo || {}),
          }));
        }
      }
    } catch {}
    return [];
  });
  const [activeTabId, setActiveTabId] = useState<string | null>(() => {
    try {
      const savedTabId = sessionGet(activeTabIdStorageKey);
      if (savedTabId) return savedTabId;
      const savedTabs = sessionGet(activeTabsStorageKey);
      if (savedTabs) {
        const parsed = JSON.parse(savedTabs);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed[parsed.length - 1].id;
      }
    } catch {}
    return null;
  });
  const [savedHosts, setSavedHosts] = useState<SSHInfo[]>([]);
  const [editingSavedHostIndex, setEditingSavedHostIndex] = useState<number | null>(null);
  const [connectionModalInitialInfo, setConnectionModalInitialInfo] = useState<Partial<SSHInfo> | undefined>(undefined);
  const [releasingSessionId, setReleasingSessionId] = useState<string | undefined>(undefined);
  const [activeSessionCount, setActiveSessionCount] = useState<number>(0);
  const [authChecking, setAuthChecking] = useState<boolean>(true);
  const [authEnabled, setAuthEnabled] = useState<boolean>(false);
  const [authenticated, setAuthenticated] = useState<boolean>(false);
  const [viewportHeight, setViewportHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    return window.visualViewport?.height || window.innerHeight;
  });
  /**
   * 视觉视口的滚动偏移 —— 手机软键盘「把整页顶上去」的真正来源。
   *
   * 键盘弹出时浏览器会把视觉视口往下滚，好让聚焦的输入框露出来。应用本身没动
   * （body 是 `position: fixed`），是被这个滚动带出屏幕的：顶栏没了、整页往上蹿。
   * 把这个偏移用 `marginTop` 补回来，应用就正好落在可见区域里 —— 不是被顶上去，
   * 而是老老实实缩到键盘上方那一块。
   */
  const [viewportTop, setViewportTop] = useState<number>(0);

  // Start/stop /sys WebSocket for health monitoring
  useEffect(() => {
    if (authChecking || (authEnabled && !authenticated)) return;
    sysClient.start(windowId);
    return () => sysClient.stop();
  }, [authChecking, authEnabled, authenticated, windowId]);

  const [sessions, setSessions] = useState<SessionHealth[]>([]);

  // Subscribe to /sys for session health data
  useEffect(() => {
    const unsubscribe = sysClient.subscribe((snapshot) => {
      setSessions(snapshot.sessions);
      setActiveSessionCount(snapshot.sessions.length);
      // 服务端（会话）是面板开关状态的权威来源：有会话开着面板、而本地对应 tab 没开，
      // 就补开 —— 覆盖「另一设备打开」「接管后恢复」两种情况。
      // 只补开、不主动关：关闭由 ai_panel_state 广播 / 用户操作处理，避免网络抖动时来回切。
      // 关键：**终端不可用的 tab 不补开**。被别的设备接管后，本机 tab 还挂着同一个
      // sessionId，若照常补开，面板会在刚被卸载后又被拉回来（表现为「接管后面板不收」）。
      for (const sess of snapshot.sessions) {
        if (!sess.aiPanelOpen) continue;
        const tab = tabsRef.current.find((t) => t.sessionId === sess.sessionId);
        if (!tab || aiOpenRef.current.includes(tab.id)) continue;
        // 只有「本机就是这个会话的 owner」才补开。被别的设备接管后 owner 变成对方，
        // 本机 tab 虽仍持同一 sessionId，也不该再把面板拉回来。
        const owned = !sess.ownerClientId || sess.ownerClientId === tab.id;
        if (tab.connected && owned) openAiPanelRef.current(tab.id);
      }
    });
    return unsubscribe;
  }, []);

  const reconcileTabsWithServer = useCallback((sessionList: SessionHealth[]) => {
    setTabs((prev) =>
      prev.map((tab) => {
        const matchingSession = tab.sessionId ? sessionList.find((s) => s.sessionId === tab.sessionId) : undefined;
        if (!matchingSession) return { ...tab, connected: false };

        const restorable =
          matchingSession.attachedClients === 0 ||
          !matchingSession.ownerClientId ||
          matchingSession.ownerClientId === tab.id;

        return { ...tab, connected: restorable };
      })
    );
  }, []);

  useEffect(() => {
    try {
      sessionSet(activeTabsStorageKey, JSON.stringify(tabs.map(redactTab)));
    } catch {
      // ignore
    }
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    aiOpenRef.current = aiOpenTabs;
  }, [aiOpenTabs]);

  useEffect(() => {
    try {
      sessionSet(activeTabIdStorageKey, activeTabId);
    } catch {
      // ignore
    }
  }, [activeTabId]);

  // Modals
  const [connModalOpen, setConnModalOpen] = useState<boolean>(false);
  const [savedHostsModalOpen, setSavedHostsModalOpen] = useState<boolean>(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState<boolean>(false);
  const [sessionsModalOpen, setSessionsModalOpen] = useState<boolean>(false);

  // App Configuration
  const [config, setConfig] = useState<WebSSHConfig>({
    savePass: true,
    timeout: 120,
    fontSize: 14,
    fontFamily: 'Consolas, Monaco, "Courier New", monospace',
    theme: 'dark',
    httpsEnforced: false,
    originCheckEnabled: true,
    authEnabled: false,
    authUsername: '',
    authPassword: '',
    showQuickCmds: true,
    showKeyBar: true,
    keyBarSize: 24,
    hapticFeedback: true,
    quickCommands: defaultQuickCommands,
  });

  // Load saved hosts and config from backend
  const loadSavedHosts = useCallback(async () => {
    try {
      const res = await apiFetch(apiUrl('/ssh/list'));
      const data = await res.json();
      if (Array.isArray(data)) {
        setSavedHosts(data);
      }
    } catch {
      // Ignore
    }
  }, []);

  const loadAppConfig = useCallback(async () => {
    try {
      const local = globalGet('webssh_config');
      if (local) {
        const parsed = JSON.parse(local);
        delete parsed.authPassword;
        parsed.authPassword = '';
        setConfig((prev) => ({ ...prev, ...parsed, quickCommands: parsed.quickCommands || defaultQuickCommands }));
      }
      const res = await apiFetch(apiUrl('/config'));
      const data = await res.json();
      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        setConfig((prev) => ({ ...prev, ...data, quickCommands: data.quickCommands || defaultQuickCommands }));
        globalSet('webssh_config', JSON.stringify({ ...data, quickCommands: data.quickCommands || defaultQuickCommands, authPassword: '' }));
      }
    } catch {
      // Ignore
    }
  }, []);

  useEffect(() => {
    const handleAuthRequired = () => {
      setAuthenticated(false);
      setAuthChecking(false);
    };

    window.addEventListener('webssh-auth-required', handleAuthRequired);

    const bootstrapAuth = async () => {
      try {
        const res = await apiFetch(apiUrl('/auth/status'));
        const status = await res.json();
        setAuthEnabled(Boolean(status.enabled));
        if (status.theme) {
          setConfig((prev) => ({ ...prev, theme: status.theme }));
        }
        if (!status.enabled) {
          setAuthenticated(true);
          return;
        }
        const sessionRes = await apiFetch(apiUrl('/auth/session'));
        setAuthenticated(sessionRes.ok);
      } catch {
        setAuthenticated(false);
      } finally {
        setAuthChecking(false);
      }
    };

    bootstrapAuth();

    return () => {
      window.removeEventListener('webssh-auth-required', handleAuthRequired);
    };
  }, []);

  useEffect(() => {
    if (authChecking || (authEnabled && !authenticated)) return;

    loadSavedHosts();
    loadAppConfig();
  }, [authChecking, authEnabled, authenticated, loadSavedHosts, loadAppConfig]);

  // Reconcile tabs when sessions update from /sys
  useEffect(() => {
    if (sessions.length > 0 || tabs.length > 0) {
      reconcileTabsWithServer(sessions);
    }
  }, [sessions, tabs.length, reconcileTabsWithServer]);

  useEffect(() => {
    const syncHeight = () => {
      const vv = window.visualViewport;
      // 捏合缩放时 visualViewport 同样会变小并位移，但那不是键盘 ——
      // 跟着改会让页面在缩放过程中乱跳，所以缩放到非 1 时一律不更新
      if (vv && vv.scale > 1.01) return;
      setViewportHeight(vv?.height || window.innerHeight);
      setViewportTop(Math.max(0, vv?.offsetTop || 0));
    };

    syncHeight();

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncHeight);
      window.visualViewport.addEventListener('scroll', syncHeight);
    }
    window.addEventListener('resize', syncHeight);

    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', syncHeight);
        window.visualViewport.removeEventListener('scroll', syncHeight);
      }
      window.removeEventListener('resize', syncHeight);
    };
  }, []);

  useEffect(() => {
    const bg = config.theme === 'light' ? '#ffffff' : '#020617';
    document.documentElement.style.backgroundColor = bg;
    document.body.style.backgroundColor = bg;
  }, [config.theme]);

  const handleSaveConfig = useCallback(async (newConfig: WebSSHConfig) => {
    setConfig(newConfig);
    try {
      globalSet('webssh_config', JSON.stringify({ ...newConfig, authPassword: '' }));
      await apiFetch(apiUrl('/config'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newConfig),
      });
    } catch {
      // Ignore
    }
  }, []);

  const handleQuickCommandsChange = useCallback((quickCommands: WebSSHConfig['quickCommands']) => {
    setConfig((prev) => {
      const next = { ...prev, quickCommands };
      globalSet('webssh_config', JSON.stringify({ ...next, authPassword: '' }));
      apiFetch(apiUrl('/config'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      }).catch(() => {});
      return next;
    });
  }, []);

  const saveHostToBackend = useCallback(async (newHosts: SSHInfo[]) => {
    try {
      const res = await apiFetch(apiUrl('/ssh/save'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newHosts),
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.hosts)) setSavedHosts(data.hosts);
    } catch {
      // Ignore
    }
  }, []);

  const upsertSavedHost = useCallback((sshInfo: SSHInfo, index?: number | null) => {
    const nextHosts = [...savedHosts];
    if (typeof index === 'number' && index >= 0 && index < nextHosts.length) {
      nextHosts[index] = sshInfo;
    } else {
      const exists = nextHosts.some(
        (h) => h.host === sshInfo.host && h.port === sshInfo.port && h.username === sshInfo.username
      );
      if (!exists) {
        nextHosts.push(sshInfo);
      }
    }
    saveHostToBackend(nextHosts);
  }, [savedHosts, saveHostToBackend]);

  const resetConnectionModalState = useCallback(() => {
    setConnectionModalInitialInfo(undefined);
    setEditingSavedHostIndex(null);
    setReleasingSessionId(undefined);
  }, []);

  const handleConnect = useCallback((sshInfo: SSHInfo, saveHost: boolean, releasingSessionId?: string) => {
    const newTabId = generateTabId(tabs);
    const title = buildTabTitle(sshInfo);

    // Release old session if idle (async, non-blocking)
    if (releasingSessionId) {
      apiFetch(apiUrl(`/ssh/session/${releasingSessionId}/status`))
        .then((res) => {
          if (res.ok) return res.json();
          return null;
        })
        .then((status) => {
          if (status && status.attachedClients === 0) {
            apiFetch(apiUrl('/ssh/sessions/kill'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionIds: [releasingSessionId], force: true }),
            }).catch(() => {});
          }
        })
        .catch(() => {});
    }

    const newTab: SSHTab = {
      id: newTabId,
      sessionId: undefined,
      title,
      sshInfo,
      sftpPath: sshInfo.username && sshInfo.username !== 'root' ? `/home/${sshInfo.username}` : '/root',
      activeView: 'terminal',
      connected: true,
      reconnectToken: 0,
      reconnectMode: 'restore',
    };

    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTabId);

    if (saveHost) {
      upsertSavedHost(sshInfo, editingSavedHostIndex);
    }

    resetConnectionModalState();
  }, [tabs, editingSavedHostIndex, saveHostToBackend, upsertSavedHost, resetConnectionModalState, generateTabId, buildTabTitle]);

  const handleCloseTab = useCallback((id: string) => {
    removeAiPanel(id);
    setTabs((prev) => {
      const tabToClose = prev.find((t) => t.id === id);
      if (tabToClose) {
        const sessId = tabToClose.sessionId || tabToClose.id;
        apiFetch(apiUrl('/ssh/sessions/kill'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionIds: [sessId], clientId: tabToClose.id }),
        }).catch(() => {});
      }

      const next = prev.filter((t) => t.id !== id);
      if (activeTabId === id) {
        setActiveTabId(next.length > 0 ? next[next.length - 1].id : null);
      }
      return next;
    });
  }, [activeTabId]);

  const handleCloseAllTabs = useCallback(() => {
    setAiMountedTabs([]);
    setAiOpenTabs([]);
    setTabs((prev) => {
      const ids = prev.map((tab) => tab.sessionId || tab.id);
      apiFetch(apiUrl('/ssh/sessions/kill'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: ids, clientId: '' }),
      }).catch(() => {});
      return [];
    });
    setActiveTabId(null);
  }, []);

  const handleCloseOtherTabs = useCallback((id: string) => {
    setAiMountedTabs((prev) => prev.filter((t) => t === id));
    setAiOpenTabs((prev) => prev.filter((t) => t === id));
    setTabs((prev) => {
      const others = prev.filter((t) => t.id !== id);
      const ids = others.map((tab) => tab.sessionId || tab.id);
      apiFetch(apiUrl('/ssh/sessions/kill'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: ids, clientId: '' }),
      }).catch(() => {});
      return prev.filter((t) => t.id === id);
    });
    setActiveTabId(id);
  }, []);

  const handleDuplicateTab = useCallback((id: string) => {
    const source = tabs.find((t) => t.id === id);
    if (!source) return;
    const newId = generateTabId(tabs);
    const newTab: SSHTab = {
      id: newId,
      title: source.title,
      sshInfo: { ...source.sshInfo },
      connected: false,
      activeView: 'terminal',
      reconnectMode: undefined,
      error: undefined,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
  }, [tabs, generateTabId]);

  const handleToggleView = useCallback((id: string, view: 'terminal' | 'sftp' | 'split') => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, activeView: view } : t))
    );
  }, []);

  const handleRenameTab = useCallback((id: string, title: string) => {
    setTabs((prev) => {
      const tab = prev.find((t) => t.id === id);
      if (tab?.sessionId) {
        apiFetch(apiUrl('/ssh/sessions/rename'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: tab.sessionId, title }),
        }).catch(() => {});
      }
      return prev.map((t) => (t.id === id ? { ...t, title } : t));
    });
  }, []);

  const handleConnectionChange = useCallback((id: string, connected: boolean) => {
    setTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, connected, error: connected ? undefined : tab.error } : tab)));
    // 重连成功：用户在断线前希望面板开着的话，这里自动恢复。
    // 恢复后面板连上服务端会收到 panelOpen 状态，与服务端保持一致。
    if (connected && aiIntentRef.current.get(id)) {
      setAiMountedTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setAiOpenTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
    }
  }, []);

  const handleSessionInfo = useCallback((id: string, sessionId: string) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === id && tab.sessionId !== sessionId ? { ...tab, sessionId } : tab
      )
    );
  }, []);

  const handleSessionTitle = useCallback((id: string, sessionId: string, title: string) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === id ? { ...tab, title } : tab
      )
    );
  }, []);

  const handleSftpPathChange = useCallback((id: string, sftpPath: string) => {
    setTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, sftpPath } : tab)));
  }, []);

  const handleRecoverSession = useCallback((id: string, force = false) => {
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== id) return tab;
        const matchingSession = tab.sessionId ? sessions.find((s) => s.sessionId === tab.sessionId) : undefined;
        const restorable =
          matchingSession &&
          (matchingSession.attachedClients === 0 ||
            !matchingSession.ownerClientId ||
            matchingSession.ownerClientId === tab.id);

        if (tab.sessionId && !matchingSession) {
          return {
            ...tab,
            connected: true,
            reconnectToken: (tab.reconnectToken || 0) + 1,
            error: undefined,
            sessionId: undefined,
          };
        }

        return {
          ...tab,
          connected: true,
          reconnectToken: (tab.reconnectToken || 0) + 1,
          reconnectMode: force ? 'force' : 'restore',
          sessionId: force && tab.sessionId ? tab.sessionId : restorable ? tab.sessionId : undefined,
        };
      })
    );
  }, [sessions]);

  const handleNewSession = useCallback((id: string) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === id
          ? {
              ...tab,
              // Let TerminalView create a fresh backend session.
              sessionId: undefined,
              error: undefined,
              connected: true,
              reconnectToken: (tab.reconnectToken || 0) + 1,
              reconnectMode: 'restore',
            }
          : tab
      )
    );
  }, []);

  const handleDeleteSavedHost = useCallback((index: number) => {
    const updated = savedHosts.filter((_, i) => i !== index);
    saveHostToBackend(updated);
  }, [savedHosts, saveHostToBackend]);

  const handleEditSavedHost = useCallback((host: SSHInfo, index: number) => {
    setEditingSavedHostIndex(index);
    setConnectionModalInitialInfo(host);
    setReleasingSessionId(undefined);
    setConnModalOpen(true);
  }, []);

  const handleSaveEditedHost = useCallback((sshInfo: SSHInfo) => {
    upsertSavedHost(sshInfo, editingSavedHostIndex);
    resetConnectionModalState();
  }, [editingSavedHostIndex, upsertSavedHost, resetConnectionModalState]);

  const handleLogout = useCallback(async () => {
    try {
      await apiFetch(apiUrl('/auth/logout'), { method: 'POST' });
    } catch {
      // ignore
    }
    setAuthenticated(false);
    setSettingsModalOpen(false);
  }, []);

  const handleAttachBackendSession = useCallback((sess: SessionHealth, force = false) => {
    const existing = tabs.find((t) => t.sessionId === sess.sessionId || t.id === sess.sessionId);
    if (existing) {
      setActiveTabId(existing.id);
      if (force) handleRecoverSession(existing.id, true);
      return;
    }

    const newTabId = generateTabId(tabs);
    const sshInfo: SSHInfo = {
      id: sess.credentialId || undefined,
      host: sess.host || 'unknown',
      port: sess.port || 22,
      username: sess.username || 'root',
      logintype: 0,
    };

    const newTab: SSHTab = {
      id: newTabId,
      sessionId: sess.sessionId,
      title: `${sess.username}@${sess.host}`,
      sshInfo,
      sftpPath: sshInfo.username && sshInfo.username !== 'root' ? `/home/${sshInfo.username}` : '/root',
      activeView: 'terminal',
      connected: true,
      reconnectToken: 0,
      reconnectMode: force ? 'force' : 'restore',
    };

    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTabId);
    // 与 term 同帧打开 AI 面板：不能等 /sys 快照的 aiPanelOpen —— 那是下一次推送，
    // 会让面板比终端晚半拍出现。先乐观打开，若服务端状态是关，随后的
    // ai_panel_state / /sys 校正会把它关掉。
    openAiPanel(newTabId);
  }, [tabs, handleRecoverSession, generateTabId, openAiPanel]);

  const handleSessionKilled = useCallback((sessionId: string) => {
    setTabs((prev) => {
      const next = prev.filter((tab) => tab.sessionId !== sessionId && tab.id !== sessionId);
      const removedIds = prev.filter((tab) => tab.sessionId === sessionId || tab.id === sessionId).map((tab) => tab.id);
      if (removedIds.length) {
        setAiMountedTabs((ids) => ids.filter((id) => !removedIds.includes(id)));
        setAiOpenTabs((ids) => ids.filter((id) => !removedIds.includes(id)));
      }
      if (activeTabId && !next.some((tab) => tab.id === activeTabId)) {
        setActiveTabId(next.length > 0 ? next[next.length - 1].id : null);
      }
      return next;
    });
    setActiveSessionCount((count) => Math.max(0, count - 1));
  }, [activeTabId]);

  const isLight = config.theme === 'light';

  if (authChecking) {
    return <div className={`min-h-screen w-full ${isLight ? 'bg-slate-50' : 'bg-slate-950'}`} />;
  }

  if (authEnabled && !authenticated) {
    return (
      <LoginPage
        theme={config.theme}
        onLogin={() => {
          setAuthenticated(true);
          setAuthChecking(false);
        }}
      />
    );
  }

  return (
    <div
      className={`fixed inset-0 flex flex-col overflow-hidden font-sans transition-colors ${
        isLight ? 'bg-white text-slate-800' : 'bg-slate-950 text-slate-100'
      }`}
      style={
        viewportHeight > 0
          ? {
              height: `calc(${viewportHeight}px + env(safe-area-inset-bottom))`,
              width: '100vw',
              // 补掉键盘弹出时视觉视口的滚动量，否则整页会被顶出屏幕顶部
              marginTop: `${viewportTop}px`,
              paddingTop: 'env(safe-area-inset-top)',
              paddingBottom: 'env(safe-area-inset-bottom)',
            }
          : { width: '100vw' }
      }
    >
      {/* Top Header */}
      <Header
          onNewConnection={() => {
            const activeTab = tabs.find((t) => t.id === activeTabId);
            if (activeTab && activeTab.sessionId && !activeTab.connected) {
              setReleasingSessionId(activeTab.sessionId);
            } else {
              setReleasingSessionId(undefined);
            }
            setConnModalOpen(true);
          }}
          onOpenSessions={() => {
            setSessionsModalOpen(true);
          }}
          onOpenSavedHosts={() => setSavedHostsModalOpen(true)}
          onOpenSettings={() => setSettingsModalOpen(true)}
          config={config}
          savedCount={savedHosts.length}
          activeSessionCount={activeSessionCount}
        />

      {/* Connection Tab Strip */}
       <Tabs
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTabId}
        onCloseTab={handleCloseTab}
        onCloseAllTabs={handleCloseAllTabs}
        onCloseOtherTabs={handleCloseOtherTabs}
        onDuplicateTab={handleDuplicateTab}
        onRenameTab={handleRenameTab}
        onToggleView={handleToggleView}
        theme={config.theme}
      />

      {/* Main Workspace Area */}
      <div className="flex-1 overflow-hidden relative">
        {tabs.length === 0 ? (
          /* Empty / Welcome Screen */
          <div
            className={`h-full w-full flex flex-col items-center justify-center p-6 text-center select-none ${
              isLight
                ? 'bg-slate-50 text-slate-800'
                : 'bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-slate-950'
            }`}
          >
            <div className="max-w-xl w-full flex flex-col items-center">
              <div
                className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-6 shadow-xl border ${
                  isLight
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-600'
                    : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                }`}
              >
                <Terminal className="w-8 h-8" />
              </div>

              <h2 className={`text-2xl font-bold mb-2 tracking-tight ${isLight ? 'text-slate-900' : 'text-slate-100'}`}>
                WebSSH Terminal & SFTP Client
              </h2>
              <p className={`text-sm mb-6 max-w-md leading-relaxed ${isLight ? 'text-slate-600' : 'text-slate-400'}`}>
                Connect to any remote Linux / Unix server directly from your browser. Enjoy real-time interactive terminal streaming and integrated SFTP file management.
              </p>

              {/* Saved Hosts Quick Launch Grid */}
              {savedHosts.length > 0 && (
                <div className="w-full text-left">
                  <h3 className={`text-xs font-mono uppercase tracking-wider mb-3 ${isLight ? 'text-slate-500' : 'text-slate-500'}`}>
                    Recent Connections
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {savedHosts.slice(0, 4).map((host, idx) => (
                      <div
                        key={idx}
                        onClick={() => handleConnect(host, false)}
                        className={`p-3 rounded-lg flex items-center justify-between cursor-pointer group transition border ${
                          isLight
                            ? 'bg-white border-slate-200 hover:border-emerald-500 hover:bg-emerald-50/50'
                            : 'bg-slate-900/60 border-slate-800 hover:border-emerald-500/50 hover:bg-slate-900'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Server className="w-4 h-4 text-emerald-500 shrink-0" />
                          <div className="truncate">
                            <div className={`text-xs font-bold truncate ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>
                              {host.name || `${host.username}@${host.host}`}
                            </div>
                            <div className={`text-[11px] font-mono truncate ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                              {host.username}@{host.host}:{host.port || 22}
                            </div>
                          </div>
                        </div>
                        <span className="text-xs text-emerald-500 font-mono opacity-0 group-hover:opacity-100 transition">
                          Connect &rarr;
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Active SSH Tab Sessions */
          tabs.map((tab) => {
            const isTabActive = tab.id === activeTabId;
            const showTerminal = tab.activeView === 'terminal' || tab.activeView === 'split';
            const showSFTP = tab.activeView === 'sftp' || tab.activeView === 'split';

            return (
              <div key={tab.id} className={`relative h-full w-full ${isTabActive ? 'flex' : 'hidden'}`}>
                {/* Terminal View：AI 面板挂在终端容器内，避免盖住 SFTP 操作区 */}
                <div
                  className={`relative ${
                    tab.activeView === 'split'
                      ? `w-1/2 border-r ${isLight ? 'border-slate-200' : 'border-slate-800'}`
                      : 'w-full'
                  } h-full ${showTerminal ? 'block' : 'hidden'}`}
                >
                   <TerminalView
                       key={`${tab.id}:${tab.reconnectToken || 0}`}
                      tabId={tab.id}
                      sshInfo={tab.sshInfo}
                      config={config}
                      sessionId={tab.sessionId}
                      isTabActive={isTabActive && showTerminal}
                      tabConnected={tab.connected}
                      onConnectionChange={(connected) => handleConnectionChange(tab.id, connected)}
                                            onSessionInfo={(sessionId) => handleSessionInfo(tab.id, sessionId)}
                     onSessionTitle={(sessionId, title) => handleSessionTitle(tab.id, sessionId, title)}
                     onRecoverSession={(force) => handleRecoverSession(tab.id, force)}
                     onNewSession={() => handleNewSession(tab.id)}
                     reconnectMode={tab.reconnectMode}
                     initialError={tab.error}
                     onQuickCommandsChange={handleQuickCommandsChange}
                      // 工具栏那颗按钮只负责把面板打开，不触发任何请求 ——
                      // 「分析」是面板里那个按钮的事，得用户再点一次
                      onOpenAi={() => openAiPanel(tab.id)}
                     onRegisterCommandSink={registerCommandSink(tab.id)}
                     onRegisterExecBridge={registerExecBridge(tab.id)}
                      onRegisterContextSource={registerContextSource(tab.id)}
                     onBusyChange={(b) => handleBusyChange(tab.id, b)}
                   />
                  {/* AI 面板：aiMounted 决定是否挂载（X 只隐藏保活），aiOpen 决定是否可见；
                      挂终端容器内不盖 SFTP；切 tab 用 hidden 保留历史与流式。
                      窄屏底部半屏抽屉，保留上面终端可见、能边看边问 */}
                  {aiMountedTabs.includes(tab.id) && (
                    <div className={`${aiOpenTabs.includes(tab.id) && showTerminal && !busyTabs.includes(tab.id) ? 'block' : 'hidden'} absolute z-30 overflow-hidden bg-transparent inset-x-0 bottom-0 top-[30%] rounded-t-xl border-t shadow-2xl sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[24rem] sm:max-w-[85%] sm:rounded-l-xl sm:rounded-tr-none sm:border-l sm:border-t-0`}>
                      <AiPanel
                        theme={config.theme}
                        target={{ host: tab.sshInfo?.host, username: tab.sshInfo?.username }}
                        sessionId={tab.sessionId}
                        getContext={() => contextSourcesRef.current.get(tab.id)?.() ?? null}
                        terminalConnected={Boolean(tab.connected)}
                        onRunCommand={(command, submit) =>
                          commandSinksRef.current.get(tab.id)?.(command, submit) ?? false}
                        getExecBridge={() => execBridgesRef.current.get(tab.id) ?? null}
                        onClose={() => closeAiPanel(tab.id)}
                        onPanelStateChange={(open) => {
                          // 服务端同步来的面板开关（另一设备的操作 / 重连回放）：
                          // 开则打开本地面板，关则关闭。幂等，不会和本地上报形成死循环。
                          if (open) openAiPanel(tab.id);
                          else closeAiPanel(tab.id);
                        }}
                      />
                    </div>
                  )}
                </div>

                {/* SFTP View */}
                <div
                  className={`${
                    tab.activeView === 'split' ? 'w-1/2' : 'w-full'
                  } h-full ${showSFTP ? 'block' : 'hidden'}`}
                >
                  <SFTPView
                    sshInfo={tab.sshInfo}
                    sessionId={tab.sessionId}
                    theme={config.theme}
                    initialPath={tab.sftpPath}
                    onPathChange={(path) => handleSftpPathChange(tab.id, path)}
                    isVisible={isTabActive && showSFTP}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Modals */}
      <ConnectionModal
        isOpen={connModalOpen}
        onClose={() => {
          setConnModalOpen(false);
          resetConnectionModalState();
        }}
        onConnect={handleConnect}
        onSaveHost={editingSavedHostIndex !== null ? handleSaveEditedHost : undefined}
        initialInfo={connectionModalInitialInfo}
        mode={editingSavedHostIndex !== null ? 'edit' : 'create'}
        theme={config.theme}
        releasingSessionId={releasingSessionId}
      />

      <SavedHostsModal
        isOpen={savedHostsModalOpen}
        onClose={() => setSavedHostsModalOpen(false)}
        savedHosts={savedHosts}
        onSelectHost={(host) => handleConnect(host, false)}
        onDeleteHost={handleDeleteSavedHost}
        onEditHost={handleEditSavedHost}
        theme={config.theme}
      />

      <SettingsModal
        isOpen={settingsModalOpen}
        onClose={() => setSettingsModalOpen(false)}
        config={config}
        onChangeConfig={handleSaveConfig}
        onLogout={config.authEnabled ? handleLogout : undefined}
      />

      <SessionsModal
        isOpen={sessionsModalOpen}
        onClose={() => setSessionsModalOpen(false)}
        sessions={sessions}
        onAttachSession={handleAttachBackendSession}
        onKillSession={handleSessionKilled}
        tabs={tabs}
        theme={config.theme}
      />
    </div>
  );
}
