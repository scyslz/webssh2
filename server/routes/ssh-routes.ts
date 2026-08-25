import crypto from 'crypto';
import express from 'express';
import {
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
      const body = req.body?.sshInfo || req.body || {};
      // Saved hosts returned by /ssh/list have credentials stripped. When the
      // frontend tests a saved connection it still carries the credential id, so
      // resolve the stored credential here (merging any freshly typed fields) or
      // the test would always fail with "All configured authentication methods failed".
      const credentialId = body.id || body.credentialId;
      const saved = credentialId ? readSavedHosts().find((host) => host.id === credentialId) : undefined;
      const merged = {
        ...(saved || {}),
        ...body,
        password:
          typeof body.password === 'string' && body.password.length > 0
            ? body.password
            : saved?.password || '',
        privateKey:
          typeof body.privateKey === 'string' && body.privateKey.trim().length > 0
            ? body.privateKey
            : saved?.privateKey,
        passphrase:
          typeof body.passphrase === 'string' && body.passphrase.length > 0
            ? body.passphrase
            : saved?.passphrase,
      };
      const config = parseSSHInfo(JSON.stringify(merged));
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

  // Session creation is now handled inline by the /term WebSocket handler
  // via sshInfo or credentialId URL parameters.

  app.post('/ssh/sessions/kill', (req, res) => {
    const { sessionId, sessionIds, force, clientId } = req.body || {};
    const ids = sessionIds || (sessionId ? [sessionId] : []);
    if (ids.length === 0) {
      return res.status(400).json({ error: 'Missing sessionId or sessionIds' });
    }
    const result = sessionManager.killSession({ sessionIds: ids, force, clientId });
    return res.status(result.status).json(result.body);
  });

  app.post('/ssh/sessions/rename', (req, res) => {
    const { sessionId, title } = req.body || {};
    if (!sessionId || !title) {
      return res.status(400).json({ error: 'Missing sessionId or title' });
    }
    const result = sessionManager.renameSession(sessionId, title);
    return res.status(result.status).json(result.body);
  });
}
