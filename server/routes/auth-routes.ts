import express from 'express';
import {
  checkLoginRateLimit,
  clearAuthCookie,
  clearLoginFailures,
  createAuthToken,
  getClientIp,
  isAuthConfigured,
  isHttpsRequest,
  recordLoginFailure,
  readAppConfig,
  requireAuth,
  requireOrigin,
  setAuthCookie,
  verifyPassword,
} from '../lib.ts';

export function registerAuthRoutes(app: express.Express) {
  app.get('/auth/status', (_req, res) => {
    const config = readAppConfig();
    res.json({
      enabled: isAuthConfigured(config),
      theme: config.theme || 'dark',
      httpsEnforced: config.httpsEnforced ?? (process.env.WEBSSH_REQUIRE_HTTPS === 'true'),
      originCheckEnabled: config.originCheckEnabled ?? true,
    });
  });

  app.post('/auth/login', requireOrigin, (req, res) => {
    const ip = getClientIp(req);
    const rate = checkLoginRateLimit(ip);
    if (rate.blockedUntil > Date.now()) {
      const retryAfter = Math.ceil((rate.blockedUntil - Date.now()) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({ error: 'Too many login attempts', retryAfter });
    }

    const config = readAppConfig();
    if (!isAuthConfigured(config)) {
      return res.json({ success: true, enabled: false });
    }

    const { username, password } = req.body || {};
    if (username !== config.authUsername || typeof password !== 'string' || !config.authPasswordHash || !verifyPassword(password, config.authPasswordHash)) {
      recordLoginFailure(ip);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    clearLoginFailures(ip);
    const token = createAuthToken(config.authUsername || '', config.authPasswordHash);
    setAuthCookie(res, token, isHttpsRequest(req));
    return res.json({ success: true, enabled: true });
  });

  app.post('/auth/logout', requireOrigin, (_req, res) => {
    clearAuthCookie(res, process.env.WEBSSH_REQUIRE_HTTPS === 'true');
    return res.json({ success: true });
  });

  app.get('/auth/session', requireAuth, (_req, res) => {
    res.json({ authenticated: true });
  });
}
