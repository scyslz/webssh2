import { useState, useEffect, useCallback } from 'react';
import { SSHInfo, SSHTab, WebSSHConfig, defaultQuickCommands } from './types';
import { apiFetch, apiUrl } from './api';
import { sessionGet, sessionSet, globalGet, globalSet } from './storage';
import { Header } from './components/Header';
import { Tabs } from './components/Tabs';
import { TerminalView } from './components/terminal/TerminalView';
import { SFTPView } from './components/SFTPView';
import { ConnectionModal } from './components/ConnectionModal';
import { SavedHostsModal } from './components/SavedHostsModal';
import { SettingsModal } from './components/SettingsModal';
import { SessionsModal, BackendSession } from './components/SessionsModal';
import { LoginPage } from './components/LoginPage';
import { Terminal, Server } from 'lucide-react';

let _sessionsCache: { data: BackendSession[]; expireAt: number } = { data: [], expireAt: 0 };

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

  const fetchServerSessions = useCallback(async (forceRefresh = false): Promise<BackendSession[]> => {
    if (!forceRefresh && Date.now() < _sessionsCache.expireAt) return _sessionsCache.data;
    try {
      const res = await apiFetch(apiUrl('/ssh/sessions'));
      if (res.ok) {
        const list = await res.json();
        if (Array.isArray(list)) {
          _sessionsCache = { data: list, expireAt: Date.now() + 5000 };
          setActiveSessionCount(list.length);
          return list;
        }
      }
    } catch {
      // ignore
    }
    return [];
  }, []);

  const reconcileTabsWithServer = useCallback((sessions: BackendSession[]) => {
    setTabs((prev) =>
      prev.map((tab) => {
        const matchingSession = tab.sessionId ? sessions.find((session) => session.id === tab.sessionId) : undefined;
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
  }, [tabs]);

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
    fetchServerSessions(true).then(reconcileTabsWithServer);

    const interval = setInterval(() => {
      fetchServerSessions(true).then(reconcileTabsWithServer);
    }, 5000);

    return () => clearInterval(interval);
  }, [authChecking, authEnabled, authenticated, loadSavedHosts, loadAppConfig, fetchServerSessions, reconcileTabsWithServer]);

  useEffect(() => {
    const syncHeight = () => {
      const vh = window.visualViewport?.height || window.innerHeight;
      setViewportHeight(vh);
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

  const handleRecoverSession = useCallback(async (id: string, force = false) => {
    const sessions = await fetchServerSessions();
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== id) return tab;
        const matchingSession = tab.sessionId ? sessions.find((session) => session.id === tab.sessionId) : undefined;
        const restorable =
          matchingSession &&
          (matchingSession.attachedClients === 0 ||
            !matchingSession.ownerClientId ||
            matchingSession.ownerClientId === tab.id);

        if (tab.sessionId && !matchingSession) {
          return {
            ...tab,
            connected: false,
            reconnectToken: (tab.reconnectToken || 0) + 1,
            error: 'Session not found or expired.',
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
  }, [fetchServerSessions]);

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

  const handleAttachBackendSession = useCallback((sess: BackendSession, force = false) => {
    const existing = tabs.find((t) => t.sessionId === sess.id || t.id === sess.id);
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
      sessionId: sess.id,
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
  }, [tabs, handleRecoverSession, generateTabId]);

  const handleSessionKilled = useCallback((sessionId: string) => {
    setTabs((prev) => {
      const next = prev.filter((tab) => tab.sessionId !== sessionId && tab.id !== sessionId);
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
      style={viewportHeight > 0 ? { height: `${viewportHeight}px`, width: '100vw' } : { width: '100vw' }}
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
              <div key={tab.id} className={`h-full w-full ${isTabActive ? 'flex' : 'hidden'}`}>
                {/* Terminal View */}
                <div
                  className={`${
                    tab.activeView === 'split'
                      ? `w-1/2 border-r ${isLight ? 'border-slate-200' : 'border-slate-800'}`
                      : 'w-full'
                  } h-full ${showTerminal ? 'block' : 'hidden'}`}
                >
                   <TerminalView
                      key={`${tab.id}:${tab.sessionId || 'no-session'}:${tab.reconnectToken || 0}`}
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
                  />
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
        onRefresh={(force) => fetchServerSessions(force)}
        onAttachSession={handleAttachBackendSession}
        onKillSession={handleSessionKilled}
        tabs={tabs}
        theme={config.theme}
      />
    </div>
  );
}
