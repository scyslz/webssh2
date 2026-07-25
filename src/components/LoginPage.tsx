import React, { useState } from 'react';
import { Shield, LogIn, AlertCircle } from 'lucide-react';
import { apiFetch, apiUrl } from '../api';
import { WebSSHConfig } from '../types';

interface LoginPageProps {
  theme: WebSSHConfig['theme'];
  onLogin: () => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({ theme, onLogin }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isLight = theme === 'light';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(apiUrl('/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || 'Login failed');
      }
      onLogin();
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className={`min-h-screen w-full flex items-center justify-center p-4 ${
        isLight
          ? 'bg-[radial-gradient(circle_at_top,_#f8fafc,_#e2e8f0_55%,_#cbd5e1)]'
          : 'bg-[radial-gradient(circle_at_top,_#172033,_#0f172a_45%,_#020617)]'
      }`}
    >
      <form
        onSubmit={handleSubmit}
        className={`w-full max-w-sm rounded-2xl border shadow-2xl p-5 sm:p-6 ${
          isLight ? 'bg-white/95 border-slate-200 text-slate-900' : 'bg-slate-900/95 border-slate-800 text-slate-100'
        }`}
      >
        <div className="flex items-center gap-3 mb-5">
          <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${isLight ? 'bg-emerald-50 text-emerald-600' : 'bg-emerald-500/10 text-emerald-400'}`}>
            <Shield className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-base font-bold">WebSSH Login</h1>
            <p className="text-xs text-slate-400">Authentication required before continuing</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1.5">Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className={`w-full rounded-xl border px-3 py-3 text-[16px] sm:text-sm focus:outline-none ${
                isLight ? 'bg-white border-slate-300 focus:border-slate-500' : 'bg-slate-950 border-slate-800 text-slate-100 focus:border-slate-700'
              }`}
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className={`w-full rounded-xl border px-3 py-3 text-[16px] sm:text-sm focus:outline-none ${
                isLight ? 'bg-white border-slate-300 focus:border-slate-500' : 'bg-slate-950 border-slate-800 text-slate-100 focus:border-slate-700'
              }`}
            />
          </div>
        </div>

        {error && (
          <div className={`mt-4 rounded-xl border px-3 py-2 text-xs flex items-center gap-2 ${isLight ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-rose-500/10 text-rose-300 border-rose-500/20'}`}>
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || !username || !password}
          className="mt-5 w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white py-3 text-sm font-semibold transition flex items-center justify-center gap-2"
        >
          <LogIn className="w-4 h-4" />
          <span>{submitting ? 'Signing In...' : 'Sign In'}</span>
        </button>
      </form>
    </div>
  );
};
