import React, { useEffect, useState } from 'react';
import { SSHInfo } from '../types';
import { apiFetch, apiUrl } from '../api';
import { X, Server, Key, Lock, CheckCircle2, AlertCircle, RefreshCw, Save } from 'lucide-react';

interface ConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (sshInfo: SSHInfo, saveHost: boolean, releasingSessionId?: string) => void;
  onSaveHost?: (sshInfo: SSHInfo) => void;
  initialInfo?: Partial<SSHInfo>;
  mode?: 'create' | 'edit';
  theme?: string;
  releasingSessionId?: string;
}

export const ConnectionModal: React.FC<ConnectionModalProps> = ({
  isOpen,
  onClose,
  onConnect,
  onSaveHost,
  initialInfo,
  mode = 'create',
  theme,
  releasingSessionId,
}) => {
  const isLight = theme === 'light';
  const [name, setName] = useState<string>(initialInfo?.name || '');
  const [host, setHost] = useState<string>(initialInfo?.host || '');
  const [port, setPort] = useState<number>(initialInfo?.port || 22);
  const [username, setUsername] = useState<string>(initialInfo?.username || 'root');
  const [loginType, setLoginType] = useState<number>(initialInfo?.logintype || 0); // 0 password, 1 privateKey
  const [password, setPassword] = useState<string>(initialInfo?.password || '');
  const [privateKey, setPrivateKey] = useState<string>(initialInfo?.privateKey || '');
  const [passphrase, setPassphrase] = useState<string>(initialInfo?.passphrase || '');
  const [saveHost, setSaveHost] = useState<boolean>(true);

  const [testing, setTesting] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<{ success: boolean; msg: string } | null>(null);

  useEffect(() => {
    setName(initialInfo?.name || '');
    setHost(initialInfo?.host || '');
    setPort(initialInfo?.port || 22);
    setUsername(initialInfo?.username || 'root');
    setLoginType(initialInfo?.logintype || 0);
    setPassword(initialInfo?.password || '');
    setPrivateKey(initialInfo?.privateKey || '');
    setPassphrase(initialInfo?.passphrase || '');
    setSaveHost(mode === 'edit' ? true : true);
    setTestResult(null);
  }, [initialInfo, isOpen, mode]);

  if (!isOpen) return null;

  const getSSHInfoObj = (): SSHInfo => ({
    id: initialInfo?.id,
    name: name.trim() || `${username}@${host}`,
    host: host.trim(),
    port: Number(port) || 22,
    username: username.trim() || 'root',
    password: password,
    privateKey: privateKey,
    passphrase: passphrase,
    logintype: loginType,
  });

  const handleTestConnection = async () => {
    if (!host.trim()) {
      setTestResult({ success: false, msg: 'Host / IP address is required' });
      return;
    }

    setTesting(true);
    setTestResult(null);

    const sshInfo = getSSHInfoObj();
    try {
      const res = await apiFetch(apiUrl('/check'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sshInfo }),
      });
      const json = await res.json();

      if (json.msg === 'success') {
        setTestResult({ success: true, msg: 'Connection test successful!' });
      } else {
        setTestResult({ success: false, msg: json.msg || 'Connection failed' });
      }
    } catch (err: any) {
      setTestResult({ success: false, msg: err.message || 'Network error during test' });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!host.trim()) return;
    onConnect(getSSHInfoObj(), saveHost, releasingSessionId);
    onClose();
  };

  const handleSaveOnly = () => {
    if (!host.trim() || !onSaveHost) return;
    onSaveHost(getSSHInfoObj());
    onClose();
  };

  const inputBg = isLight
    ? 'bg-white border-slate-300 text-slate-800 focus:border-slate-500'
    : 'bg-slate-950 border-slate-800 text-slate-200 focus:border-slate-700';

  const labelColor = isLight ? 'text-slate-700' : 'text-slate-300';

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 select-none">
      <div
        className={`border rounded-xl w-full max-w-md shadow-2xl overflow-hidden transition-colors ${
          isLight ? 'bg-white border-slate-200 text-slate-800' : 'bg-slate-900 border-slate-800 text-slate-100'
        }`}
      >
        {/* Header */}
        <div
          className={`px-5 py-3 border-b flex items-center justify-between ${
            isLight ? 'bg-slate-100 border-slate-200' : 'bg-slate-950 border-slate-800'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <div
              className={`p-1.5 rounded-lg border ${
                isLight
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-600'
                  : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
              }`}
            >
              <Server className="w-4 h-4" />
            </div>
            <h2 className={`font-bold text-sm ${isLight ? 'text-slate-900' : 'text-slate-100'}`}>
              {mode === 'edit' ? 'Edit Saved SSH Connection' : 'New SSH Connection'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className={`transition p-1 ${isLight ? 'text-slate-400 hover:text-slate-700' : 'text-slate-400 hover:text-slate-200'}`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className={`block text-xs font-medium mb-1 ${labelColor}`}>
              Connection Label / Name (Optional)
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Production Web Server"
              className={`w-full border rounded-lg px-3 py-2 text-xs focus:outline-none font-mono ${inputBg}`}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className={`block text-xs font-medium mb-1 ${labelColor}`}>
                Host / IP Address <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.100 or domain.com"
                className={`w-full border rounded-lg px-3 py-2 text-xs focus:outline-none font-mono ${inputBg}`}
              />
            </div>
            <div>
              <label className={`block text-xs font-medium mb-1 ${labelColor}`}>Port</label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                className={`w-full border rounded-lg px-3 py-2 text-xs focus:outline-none font-mono ${inputBg}`}
              />
            </div>
          </div>

          <div>
            <label className={`block text-xs font-medium mb-1 ${labelColor}`}>
              Username <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="root"
              className={`w-full border rounded-lg px-3 py-2 text-xs focus:outline-none font-mono ${inputBg}`}
            />
          </div>

          <div>
            <label className={`block text-xs font-medium mb-1 ${labelColor}`}>
              Authentication Method
            </label>
            <div
              className={`grid grid-cols-2 gap-2 p-1 rounded-lg border ${
                isLight ? 'bg-slate-100 border-slate-300' : 'bg-slate-950 border-slate-800'
              }`}
            >
              <button
                type="button"
                onClick={() => setLoginType(0)}
                className={`flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium transition cursor-pointer ${
                  loginType === 0
                    ? isLight
                      ? 'bg-white text-emerald-700 border border-slate-300 shadow-2xs font-semibold'
                      : 'bg-slate-800 text-emerald-400 border border-slate-700'
                    : isLight
                    ? 'text-slate-600 hover:text-slate-900'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Password</span>
              </button>
              <button
                type="button"
                onClick={() => setLoginType(1)}
                className={`flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium transition cursor-pointer ${
                  loginType === 1
                    ? isLight
                      ? 'bg-white text-emerald-700 border border-slate-300 shadow-2xs font-semibold'
                      : 'bg-slate-800 text-emerald-400 border border-slate-700'
                    : isLight
                    ? 'text-slate-600 hover:text-slate-900'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Key className="w-3.5 h-3.5" />
                <span>Private Key</span>
              </button>
            </div>
          </div>

          {loginType === 0 ? (
            <div>
              <label className={`block text-xs font-medium mb-1 ${labelColor}`}>SSH Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className={`w-full border rounded-lg px-3 py-2 text-xs focus:outline-none font-mono ${inputBg}`}
              />
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className={`block text-xs font-medium mb-1 ${labelColor}`}>
                  Private Key (OpenSSH format)
                </label>
                <textarea
                  rows={4}
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----..."
                  className={`w-full border rounded-lg px-3 py-2 text-xs focus:outline-none font-mono leading-relaxed ${inputBg}`}
                />
              </div>
              <div>
                <label className={`block text-xs font-medium mb-1 ${labelColor}`}>
                  Passphrase (If encrypted)
                </label>
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Passphrase"
                  className={`w-full border rounded-lg px-3 py-2 text-xs focus:outline-none font-mono ${inputBg}`}
                />
              </div>
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            <label className={`flex items-center gap-2 text-xs cursor-pointer ${labelColor}`}>
              <input
                type="checkbox"
                checked={saveHost}
                onChange={(e) => setSaveHost(e.target.checked)}
                className="rounded border-slate-400 bg-white text-emerald-600 focus:ring-0"
              />
              <span>{mode === 'edit' ? 'Keep in saved connections' : 'Save connection for future sessions'}</span>
            </label>
          </div>

          {/* Test connection result banner */}
          {testResult && (
            <div
              className={`p-3 rounded-lg border text-xs font-mono flex items-center gap-2 ${
                testResult.success
                  ? isLight
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                    : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                  : isLight
                  ? 'bg-rose-50 border-rose-300 text-rose-800'
                  : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
              }`}
            >
              {testResult.success ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
              )}
              <span>{testResult.msg}</span>
            </div>
          )}

          {/* Buttons */}
          <div className={`pt-2 flex items-center justify-between gap-2 border-t ${isLight ? 'border-slate-200' : 'border-slate-800'}`}>
            <button
              type="button"
              onClick={handleTestConnection}
              disabled={testing}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition cursor-pointer border disabled:opacity-50 ${
                isLight
                  ? 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
              }`}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${testing ? 'animate-spin' : ''}`} />
              <span>{testing ? 'Testing...' : 'Test'}</span>
            </button>

            <div className="flex items-center gap-2">
              {mode === 'edit' && onSaveHost && (
                <button
                  type="button"
                  onClick={handleSaveOnly}
                  className="flex items-center justify-center gap-1.5 min-w-[72px] px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shadow-md transition cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Save</span>
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className={`min-w-[72px] px-3 py-2 rounded-lg text-xs font-medium transition cursor-pointer ${
                  isLight ? 'bg-slate-100 hover:bg-slate-200 text-slate-700' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                }`}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="min-w-[72px] px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-md transition cursor-pointer"
              >
                {mode === 'edit' ? 'Open' : 'Connect'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
