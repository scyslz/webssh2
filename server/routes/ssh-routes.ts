import crypto from 'crypto';
import express from 'express';
import {
  createSessionId,
  parseSSHInfo,
  publicHost,
  readSavedHosts,
  safeJson,
  sshErrorText,
  sshLog,
  sshSummary,
  writeSavedHosts,
} from '../lib.ts';
import { SessionManager } from '../session-manager.ts';
import { connectSSH } from './shared.ts';

export function registerSshRoutes(app: express.Express, sessionManager: SessionManager) {
  app.post('/check', (req, res) => {
    try {
      const config = parseSSHInfo(JSON.stringify(req.body?.sshInfo || req.body || {}));
      const timeoutMs = 10000;
      let handled = false;
      const timer = setTimeout(() => {
        if (!handled) {
          handled = true;
          res.json({ msg: 'Connection timed out', data: { savePass: true } });
        }
      }, timeoutMs);
      connectSSH(
        config,
        (conn) => {
          if (!handled) {
            handled = true;
            clearTimeout(timer);
            conn.end();
            res.json({ msg: 'success', data: { savePass: true } });
          }
        },
        (err) => {
          if (!handled) {
            handled = true;
            clearTimeout(timer);
            res.json({ msg: err.message || 'SSH connection failed', data: { savePass: true } });
          }
        },
        timeoutMs
      );
    } catch (err: any) {
      res.json({ msg: err.message || 'Invalid SSH connection parameters', data: { savePass: true } });
    }
  });

  app.get('/ssh/list', (_req, res) => {
    try {
      return res.json(readSavedHosts().map(publicHost));
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to read saved hosts' });
    }
  });

  app.post('/ssh/save', (req, res) => {
    try {
      const hosts = Array.isArray(req.body) ? req.body : [];
      const existingHosts = readSavedHosts();
      const normalized = hosts.map((host) => {
        const id = host.id || crypto.randomUUID();
        const existing = existingHosts.find((saved) =>
          (saved.id && saved.id === id) ||
          (saved.host === host.host &&
            Number(saved.port) === (Number(host.port) || 22) &&
            saved.username === host.username)
        );
        const loginType = Number(host.logintype) || 0;
        const hasNewPrivateKey = typeof host.privateKey === 'string' && host.privateKey.trim().length > 0;
        const hasNewPassword = typeof host.password === 'string' && host.password.length > 0;

        return {
          ...host,
          id,
          port: Number(host.port) || 22,
          password: loginType === 0 ? (hasNewPassword ? host.password : existing?.password) : undefined,
          privateKey: loginType === 1 ? (hasNewPrivateKey ? host.privateKey : existing?.privateKey) : undefined,
          passphrase: loginType === 1
            ? (typeof host.passphrase === 'string' && host.passphrase.length > 0 ? host.passphrase : existing?.passphrase)
            : undefined,
        };
      });
      writeSavedHosts(normalized);
      res.json({ message: 'SSH configuration saved successfully', hosts: normalized.map(publicHost) });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to save configuration' });
    }
  });

  app.get('/ssh/sessions', (_req, res) => {
    res.json(sessionManager.listSessions());
  });

  app.get('/ssh/session/:sessionId/status', (req, res) => {
    const status = sessionManager.getSessionStatus(req.params.sessionId);
    if (!status.exists) {
      return res.status(404).json({ exists: false, error: 'Session not found' });
    }
    return res.json(status);
  });

  app.post('/ssh/session/create', async (req, res) => {
    try {
      const requestedId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
      const cols = Math.max(20, parseInt(String(req.body?.cols || '120'), 10) || 120);
      const rows = Math.max(5, parseInt(String(req.body?.rows || '30'), 10) || 30);
      const timeoutMins = Math.max(1, parseInt(String(req.body?.timeout || '120'), 10) || 120);
      const keepAliveMs = timeoutMins * 60 * 1000;
      const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId : '';

      let sshConfig;
      if (req.body?.credentialId) {
        sshLog('session create: resolving saved credential', {
          sessionId: requestedId || '(new)',
          credentialId: req.body.credentialId,
        });
        const saved = readSavedHosts().find((host) => host.id === req.body.credentialId);
        if (!saved) return res.status(404).json({ error: 'Saved credential not found' });
        sshConfig = parseSSHInfo(JSON.stringify(saved));
      } else {
        sshConfig = parseSSHInfo(JSON.stringify(req.body?.sshInfo || req.body || {}));
      }

      const sessionId = requestedId || createSessionId();
      if (sessionManager.getSessionConfig(sessionId)) {
        return res.json({ sessionId, created: false });
      }

      sshLog('session create: establishing live SSH session', {
        sessionId,
        source: req.body?.credentialId ? 'saved-credential' : 'inline',
        cols,
        rows,
        ...sshSummary(sshConfig),
      });
      await sessionManager.createLiveSession(sessionId, sshConfig, { cols, rows, ownerClientId: clientId, keepAliveMs });
      return res.json({ sessionId, created: true });
    } catch (err: any) {
      sshLog('session create: failed', { error: err.message || String(err) });
      return res.status(400).json({ error: sshErrorText(err) || err.message || 'Invalid SSH connection parameters' });
    }
  });

  app.post('/ssh/sessions/kill', (req, res) => {
    const result = sessionManager.killSession(req.body || {});
    return res.status(result.status).json(result.body);
  });
}
