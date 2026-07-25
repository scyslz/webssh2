import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import { Client as SSHClient } from 'ssh2';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';

const upload = multer({ storage: multer.memoryStorage() });
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SSH_LIST_PATH = path.join(process.cwd(), 'ssh_list.json');
const SSH_SECRET_PATH = path.join(process.cwd(), 'ssh_secrets.json');
const MASTER_KEY_PATH = path.join(process.cwd(), '.webssh_master_key');
const CONFIG_PATH = path.join(process.cwd(), 'webssh_config.json');
const AUTH_COOKIE_NAME = 'webssh_auth';
const AUTH_TOKEN_SECRET = process.env.WEBSSH_AUTH_SECRET || crypto.randomBytes(32).toString('hex');
const loginAttempts = new Map<string, { failures: number; windowStartedAt: number; blockedUntil: number }>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

function sshLog(message: string, details?: Record<string, unknown>) {
  const suffix = details ? ` ${JSON.stringify(details)}` : '';
  console.log(`[webssh-ssh] ${new Date().toISOString()} ${message}${suffix}`);
}

function sshSummary(config: any) {
  return {
    host: config?.host,
    port: config?.port,
    username: config?.username,
    loginType: config?.logintype,
    hasPassword: Boolean(config?.password),
    hasPrivateKey: Boolean(config?.privateKey),
    hasPassphrase: Boolean(config?.passphrase),
  };
}

function sshErrorDetails(err: any) {
  return {
    name: err?.name,
    message: err?.message || String(err),
    code: err?.code,
    level: err?.level,
    description: err?.description,
    stack: err?.stack,
  };
}

function sshErrorText(err: any) {
  const details = sshErrorDetails(err);
  const fields = [
    details.message,
    details.code ? `code=${details.code}` : '',
    details.level ? `level=${details.level}` : '',
    details.description ? `description=${details.description}` : '',
  ].filter(Boolean);
  return fields.join(' | ');
}

interface AppConfig {
  savePass?: boolean;
  timeout?: number;
  fontSize?: number;
  fontFamily?: string;
  theme?: 'dark' | 'dracula' | 'matrix' | 'light';
  httpsEnforced?: boolean;
  originCheckEnabled?: boolean;
  authEnabled?: boolean;
  authUsername?: string;
  authPassword?: string;
  authPasswordHash?: string;
}

interface StoredSSHHost {
  id?: string;
  name?: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  logintype?: number;
}

interface EncryptedStore {
  version: 1;
  iv: string;
  authTag: string;
  data: string;
}

function padNumber(value: number, length = 2) {
  return value.toString().padStart(length, '0');
}

function createSessionId() {
  const now = new Date();
  return `s-${padNumber(now.getMonth() + 1)}${padNumber(now.getDate())}-${padNumber(now.getHours())}${padNumber(now.getMinutes())}${padNumber(now.getSeconds())}-${padNumber(now.getMilliseconds(), 3)}`;
}

function readAppConfig(): AppConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(content || '{}') as AppConfig;
    if (config.authPassword && !config.authPasswordHash) {
      const migrated = { ...config, authPasswordHash: hashPassword(config.authPassword) };
      delete migrated.authPassword;
      writeAppConfig(migrated);
      return migrated;
    }
    return config;
  } catch {
    return {};
  }
}

function writeAppConfig(config: AppConfig) {
  const tempPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, CONFIG_PATH);
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  try {
    const [algorithm, nText, rText, pText, saltText, hashText] = encoded.split('$');
    if (algorithm !== 'scrypt' || !nText || !rText || !pText || !saltText || !hashText) return false;
    const expected = Buffer.from(hashText, 'base64url');
    const actual = crypto.scryptSync(password, Buffer.from(saltText, 'base64url'), expected.length, {
      N: Number(nText), r: Number(rText), p: Number(pText), maxmem: 32 * 1024 * 1024,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function getMasterKey(): Buffer {
  const configured = process.env.WEBSSH_MASTER_KEY;
  if (configured) {
    return crypto.createHash('sha256').update(configured).digest();
  }

  if (!fs.existsSync(MASTER_KEY_PATH)) {
    fs.writeFileSync(MASTER_KEY_PATH, crypto.randomBytes(32).toString('base64url'), { encoding: 'utf8', mode: 0o600 });
  }
  try { fs.chmodSync(MASTER_KEY_PATH, 0o600); } catch {}
  return crypto.createHash('sha256').update(fs.readFileSync(MASTER_KEY_PATH, 'utf8').trim()).digest();
}

function encryptStore(value: unknown): EncryptedStore {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
    data: data.toString('base64url'),
  };
}

function decryptStore(store: EncryptedStore): any {
  if (store.version !== 1) throw new Error('Unsupported encrypted store version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterKey(), Buffer.from(store.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(store.authTag, 'base64url'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(store.data, 'base64url')),
    decipher.final(),
  ]).toString('utf8'));
}

function readSavedHosts(): StoredSSHHost[] {
  if (fs.existsSync(SSH_SECRET_PATH)) {
    const store = JSON.parse(fs.readFileSync(SSH_SECRET_PATH, 'utf8')) as EncryptedStore;
    const hosts = decryptStore(store);
    return Array.isArray(hosts) ? hosts : [];
  }

  // One-time migration from the legacy plaintext file.
  if (fs.existsSync(SSH_LIST_PATH)) {
    const legacy = JSON.parse(fs.readFileSync(SSH_LIST_PATH, 'utf8') || '[]');
    const hosts = Array.isArray(legacy) ? legacy : [];
    writeSavedHosts(hosts);
    try { fs.renameSync(SSH_LIST_PATH, `${SSH_LIST_PATH}.migrated`); } catch {}
    return hosts;
  }
  return [];
}

function writeSavedHosts(hosts: StoredSSHHost[]) {
  const tempPath = `${SSH_SECRET_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(encryptStore(hosts), null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, SSH_SECRET_PATH);
  try { fs.chmodSync(SSH_SECRET_PATH, 0o600); } catch {}
}

function publicHost(host: StoredSSHHost) {
  const { password, privateKey, passphrase, ...safe } = host;
  return {
    ...safe,
    hasCredential: Boolean(password || privateKey),
  };
}

function getPublicConfig(config: AppConfig): AppConfig {
  const { authPassword, authPasswordHash, ...rest } = config;
  return { ...rest, authPassword: '' };
}

function isAuthConfigured(config: AppConfig) {
  return Boolean(config.authEnabled && config.authUsername && config.authPasswordHash);
}

function parseCookies(cookieHeader?: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const chunk of cookieHeader.split(';')) {
    const [rawName, ...rest] = chunk.trim().split('=');
    if (!rawName) continue;
    cookies[rawName] = decodeURIComponent(rest.join('=') || '');
  }
  return cookies;
}

function createAuthToken(username: string, passwordHash: string) {
  const payload = Buffer.from(JSON.stringify({
    u: username,
    p: passwordHash,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyAuthToken(token: string | undefined, config: AppConfig) {
  if (!token || !isAuthConfigured(config) || !config.authUsername || !config.authPasswordHash) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(payload).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    if (decoded.exp < Date.now()) return false;
    return decoded.u === config.authUsername &&
      decoded.p === config.authPasswordHash;
  } catch {
    return false;
  }
}

function isAuthenticated(req: http.IncomingMessage | express.Request, config: AppConfig) {
  if (!isAuthConfigured(config)) return true;
  const cookies = parseCookies('headers' in req ? req.headers.cookie : undefined);
  return verifyAuthToken(cookies[AUTH_COOKIE_NAME], config);
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const config = readAppConfig();
  if (!isAuthConfigured(config)) return next();
  if (isAuthenticated(req, config)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

function parseSSHInfo(sshInfoStr: string) {
  if (!sshInfoStr) throw new Error('Missing sshInfo parameter');
  let decoded = sshInfoStr;
  try {
    if (!sshInfoStr.trim().startsWith('{')) {
      decoded = Buffer.from(sshInfoStr, 'base64').toString('utf-8');
    }
    if (decoded.includes('%')) {
      try { decoded = decodeURIComponent(decoded); } catch {}
    }
    const parsed = JSON.parse(decoded);
    return {
      id: parsed.id || undefined,
      host: parsed.host || 'localhost',
      port: Number(parsed.port) || 22,
      username: parsed.username || 'root',
      password: parsed.password || '',
      privateKey: parsed.privateKey || undefined,
      passphrase: parsed.passphrase || undefined,
      logintype: parsed.logintype ?? 0,
    };
  } catch (err: any) {
    throw new Error('Invalid sshInfo parameter format: ' + err.message);
  }
}

function resolveSSHInfo(sessionId: string | undefined, encodedInfo: string | undefined) {
  if (sessionId) {
    const session = sshSessions.get(sessionId);
    if (session) return session.sshConfig;
  }
  if (!encodedInfo) throw new Error('Missing SSH session');
  return parseSSHInfo(encodedInfo);
}

function formatByteSize(bytes: number): string {
  if (bytes === 0) return '0B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i === 0) return bytes + 'B';
  return (bytes / Math.pow(k, i)).toFixed(2).replace(/\.00$/, '') + sizes[i];
}

function safeJson(res: express.Response, data: any, statusCode = 200) {
  if (!res.headersSent) res.status(statusCode).json(data);
}

function safeSend(res: express.Response, data: any, statusCode = 200) {
  if (!res.headersSent) res.status(statusCode).send(data);
}

function isHttpsRequest(req: express.Request | http.IncomingMessage) {
  const forwardedProto = 'headers' in req ? req.headers['x-forwarded-proto'] : undefined;
  const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return protocol === 'https' || ('secure' in req && Boolean((req as express.Request).secure));
}

function requireHttps(req: express.Request, res: express.Response, next: express.NextFunction) {
  const config = readAppConfig();
  const httpsEnforced = config.httpsEnforced ?? (process.env.WEBSSH_REQUIRE_HTTPS === 'true');
  if (httpsEnforced && !isHttpsRequest(req)) {
    return res.status(426).json({ error: 'HTTPS is required' });
  }
  return next();
}

function isAllowedOrigin(req: express.Request | http.IncomingMessage, origin?: string) {
  if (!origin) return true;
  const configured = (process.env.WEBSSH_ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (configured.includes(origin)) return true;
  try {
    const originUrl = new URL(origin);
    const forwardedHost = req.headers['x-forwarded-host'];
    const hostHeader = Array.isArray(forwardedHost)
      ? forwardedHost[0]
      : forwardedHost || req.headers.host;
    const expectedHost = hostHeader?.split(',')[0]?.trim();
    if (!expectedHost || originUrl.host !== expectedHost) return false;

    const forwardedProto = req.headers['x-forwarded-proto'];
    const expectedProto = (Array.isArray(forwardedProto)
      ? forwardedProto[0]
      : forwardedProto || (req as express.Request).protocol || 'http'
    ).split(',')[0].trim();
    return originUrl.protocol === `${expectedProto}:`;
  } catch {
    return false;
  }
}

function requireOrigin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const config = readAppConfig();
  const originCheckEnabled = config.originCheckEnabled ?? true;
  if (originCheckEnabled && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !isAllowedOrigin(req, req.headers.origin)) {
    sshLog('request rejected: invalid origin', {
      method: req.method,
      path: req.originalUrl,
      origin: req.headers.origin || '(none)',
      host: req.headers.host || '(none)',
      forwardedHost: req.headers['x-forwarded-host'] || '(none)',
      forwardedProto: req.headers['x-forwarded-proto'] || '(none)',
    });
    return res.status(403).json({ error: 'Invalid request origin' });
  }
  return next();
}

function getClientIp(req: express.Request) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function checkLoginRateLimit(ip: string) {
  const now = Date.now();
  const current = loginAttempts.get(ip);
  if (!current || now - current.windowStartedAt >= LOGIN_WINDOW_MS) {
    const fresh = { failures: 0, windowStartedAt: now, blockedUntil: 0 };
    loginAttempts.set(ip, fresh);
    return fresh;
  }
  return current;
}

function recordLoginFailure(ip: string) {
  const state = checkLoginRateLimit(ip);
  state.failures += 1;
  if (state.failures >= LOGIN_MAX_FAILURES) state.blockedUntil = Date.now() + LOGIN_BLOCK_MS;
}

// ======================== REST API Routes ========================

app.use(requireHttps);

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
  loginAttempts.delete(ip);
  const token = createAuthToken(config.authUsername || '', config.authPasswordHash);
  const secure = isHttpsRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${7 * 24 * 60 * 60}`);
  return res.json({ success: true, enabled: true });
});

app.post('/auth/logout', requireOrigin, (_req, res) => {
  const secure = process.env.WEBSSH_REQUIRE_HTTPS === 'true' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`);
  return res.json({ success: true });
});

app.get('/auth/session', requireAuth, (_req, res) => {
  res.json({ authenticated: true });
});

app.use(['/check', '/ssh', '/config', '/file'], requireAuth);
app.use(['/ssh', '/config', '/file'], requireOrigin);

app.post('/check', (req, res) => {
  try {
    const config = parseSSHInfo(JSON.stringify(req.body?.sshInfo || req.body || {}));
    const conn = new SSHClient();
    const timeoutMs = 10000;
    let handled = false;
    const timer = setTimeout(() => {
      if (!handled) { handled = true; conn.end(); res.json({ msg: 'Connection timed out', data: { savePass: true } }); }
    }, timeoutMs);
    conn.on('ready', () => {
      if (!handled) { handled = true; clearTimeout(timer); conn.end(); res.json({ msg: 'success', data: { savePass: true } }); }
    });
    conn.on('error', (err) => {
      if (!handled) { handled = true; clearTimeout(timer); res.json({ msg: err.message || 'SSH connection failed', data: { savePass: true } }); }
    });
    conn.connect({ host: config.host, port: config.port, username: config.username, password: config.password, privateKey: config.privateKey, passphrase: config.passphrase, readyTimeout: timeoutMs });
  } catch (err: any) {
    res.json({ msg: err.message || 'Invalid SSH connection parameters', data: { savePass: true } });
  }
});

app.get('/ssh/list', (req, res) => {
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
        // The public host list intentionally omits secrets. Keep the encrypted
        // credential when an edit submits an unchanged, empty secret field.
        password: loginType === 0
          ? (hasNewPassword ? host.password : existing?.password)
          : undefined,
        privateKey: loginType === 1
          ? (hasNewPrivateKey ? host.privateKey : existing?.privateKey)
          : undefined,
        passphrase: loginType === 1
          ? (typeof host.passphrase === 'string' && host.passphrase.length > 0
            ? host.passphrase
            : existing?.passphrase)
          : undefined,
      };
    });
    writeSavedHosts(normalized);
    res.json({ message: 'SSH configuration saved successfully', hosts: normalized.map(publicHost) });
  } catch (err: any) { res.status(500).json({ error: err.message || 'Failed to save configuration' }); }
});

app.get('/config', (req, res) => {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
      return res.json(getPublicConfig(JSON.parse(content || '{}')));
    }
    return res.json({});
  } catch { return res.json({}); }
});

app.post('/config', (req, res) => {
  try {
    const incoming = req.body || {};
    const current = readAppConfig();
    const next: AppConfig = { ...current, ...incoming };
    delete next.authPasswordHash;
    if (typeof incoming.authPassword === 'string' && incoming.authPassword.length > 0) {
      next.authPasswordHash = hashPassword(incoming.authPassword);
    } else if (current.authPasswordHash) {
      next.authPasswordHash = current.authPasswordHash;
    }
    delete next.authPassword;
    writeAppConfig(next);
    res.json({ message: 'Configuration saved successfully' });
  } catch (err: any) { res.status(500).json({ error: err.message || 'Failed to save configuration' }); }
});

app.get('/file/list', (req, res) => {
  const sshInfoStr = (req.query.sshInfo as string) || '';
  const sessionId = (req.query.sessionId as string) || '';
  const requestedPath = (req.query.path as string) || '';
  try {
    const config = resolveSSHInfo(sessionId, sshInfoStr);
    const conn = new SSHClient();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return safeJson(res, { msg: err.message }); }
        const resolveTarget = (cb: (targetPath: string) => void) => {
          if (!requestedPath || requestedPath === '.' || requestedPath === '~') {
            sftp.realpath('.', (err, absPath) => {
              if (!err && absPath) cb(absPath);
              else cb(config.username === 'root' ? '/root' : `/home/${config.username}`);
            });
          } else { cb(requestedPath); }
        };
        resolveTarget((dirPath) => {
          sftp.readdir(dirPath, (err, list) => {
            conn.end();
            if (err) return safeJson(res, { msg: err.message });
            const fileList = list.map((item) => ({
              name: item.filename,
              isDir: item.attrs.isDirectory(),
              size: item.attrs.isDirectory() ? String(item.attrs.size) : formatByteSize(item.attrs.size),
              rawSize: item.attrs.size,
              modifyTime: new Date(item.attrs.mtime * 1000).toISOString().replace('T', ' ').substring(0, 19),
            }));
            fileList.sort((a, b) => { if (a.isDir && !b.isDir) return -1; if (!a.isDir && b.isDir) return 1; return a.name.localeCompare(b.name); });
            safeJson(res, { msg: 'success', duration: '0ms', data: { path: dirPath, list: fileList } });
          });
        });
      });
    });
    conn.on('error', (err) => safeJson(res, { msg: err.message }));
    conn.connect({ host: config.host, port: config.port, username: config.username, password: config.password, privateKey: config.privateKey, passphrase: config.passphrase });
  } catch (err: any) { safeJson(res, { msg: err.message }); }
});

app.get('/file/download', (req, res) => {
  const sshInfoStr = (req.query.sshInfo as string) || '';
  const sessionId = (req.query.sessionId as string) || '';
  const filePath = (req.query.path as string) || '';
  try {
    const config = resolveSSHInfo(sessionId, sshInfoStr);
    const conn = new SSHClient();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return safeSend(res, err.message, 500); }
        const fileName = path.basename(filePath);
        if (!res.headersSent) {
          res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
          res.setHeader('Content-Type', 'application/octet-stream');
        }
        const readStream = sftp.createReadStream(filePath);
        readStream.pipe(res);
        readStream.on('close', () => conn.end());
        readStream.on('error', (err) => { conn.end(); safeSend(res, err.message, 500); });
      });
    });
    conn.on('error', (err) => safeSend(res, err.message, 500));
    conn.connect({ host: config.host, port: config.port, username: config.username, password: config.password, privateKey: config.privateKey, passphrase: config.passphrase });
  } catch (err: any) { safeSend(res, err.message, 400); }
});

app.get('/file/read', (req, res) => {
  const sshInfoStr = (req.query.sshInfo as string) || '';
  const sessionId = (req.query.sessionId as string) || '';
  const filePath = (req.query.path as string) || '';
  try {
    const config = resolveSSHInfo(sessionId, sshInfoStr);
    const conn = new SSHClient();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return safeJson(res, { msg: err.message }); }
        const readStream = sftp.createReadStream(filePath);
        let content = '';
        readStream.on('data', (chunk) => { content += chunk.toString('utf-8'); });
        readStream.on('end', () => { conn.end(); safeJson(res, { msg: 'success', data: { content, path: filePath } }); });
        readStream.on('error', (err) => { conn.end(); safeJson(res, { msg: err.message }); });
      });
    });
    conn.on('error', (err) => safeJson(res, { msg: err.message }));
    conn.connect({ host: config.host, port: config.port, username: config.username, password: config.password, privateKey: config.privateKey, passphrase: config.passphrase });
  } catch (err: any) { safeJson(res, { msg: err.message }); }
});

app.post('/file/write', (req, res) => {
  const { sshInfo: sshInfoStr, sessionId, path: filePath, content } = req.body;
  try {
    const config = resolveSSHInfo(sessionId, sshInfoStr);
    const conn = new SSHClient();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return safeJson(res, { msg: err.message }); }
        const writeStream = sftp.createWriteStream(filePath);
        writeStream.end(Buffer.from(content || '', 'utf-8'), () => { conn.end(); safeJson(res, { msg: 'success' }); });
        writeStream.on('error', (err) => { conn.end(); safeJson(res, { msg: err.message }); });
      });
    });
    conn.on('error', (err) => safeJson(res, { msg: err.message }));
    conn.connect({ host: config.host, port: config.port, username: config.username, password: config.password, privateKey: config.privateKey, passphrase: config.passphrase });
  } catch (err: any) { safeJson(res, { msg: err.message }); }
});

app.post('/file/upload', upload.single('file'), (req, res) => {
  const sshInfoStr = (req.body.sshInfo as string) || '';
  const sessionId = (req.body.sessionId as string) || '';
  const dir = (req.body.dir as string) || '';
  const targetDir = (req.body.path as string) || '/root';
  if (!req.file) return safeJson(res, { msg: 'No file uploaded' });
  try {
    const config = resolveSSHInfo(sessionId, sshInfoStr);
    const conn = new SSHClient();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return safeJson(res, { msg: err.message }); }
        let fullDirPath = targetDir.replace(/\/$/, '');
        if (dir) fullDirPath += '/' + dir.replace(/^\//, '');
        const remoteFilePath = fullDirPath + '/' + req.file!.originalname;
        const writeStream = sftp.createWriteStream(remoteFilePath);
        writeStream.end(req.file!.buffer, () => { conn.end(); safeJson(res, { msg: 'success', data: { path: remoteFilePath } }); });
        writeStream.on('error', (err) => { conn.end(); safeJson(res, { msg: err.message }); });
      });
    });
    conn.on('error', (err) => safeJson(res, { msg: err.message }));
    conn.connect({ host: config.host, port: config.port, username: config.username, password: config.password, privateKey: config.privateKey, passphrase: config.passphrase });
  } catch (err: any) { safeJson(res, { msg: err.message }); }
});

app.post('/file/delete', (req, res) => {
  const { sshInfo: sshInfoStr, sessionId, path: itemPath, isDir } = req.body;
  try {
    const config = resolveSSHInfo(sessionId, sshInfoStr);
    const conn = new SSHClient();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return safeJson(res, { msg: err.message }); }
        if (isDir) {
          sftp.rmdir(itemPath, (err) => { conn.end(); if (err) return safeJson(res, { msg: err.message }); safeJson(res, { msg: 'success' }); });
        } else {
          sftp.unlink(itemPath, (err) => { conn.end(); if (err) return safeJson(res, { msg: err.message }); safeJson(res, { msg: 'success' }); });
        }
      });
    });
    conn.on('error', (err) => safeJson(res, { msg: err.message }));
    conn.connect({ host: config.host, port: config.port, username: config.username, password: config.password, privateKey: config.privateKey, passphrase: config.passphrase });
  } catch (err: any) { safeJson(res, { msg: err.message }); }
});

app.post('/file/mkdir', (req, res) => {
  const { sshInfo: sshInfoStr, sessionId, path: dirPath } = req.body;
  try {
    const config = resolveSSHInfo(sessionId, sshInfoStr);
    const conn = new SSHClient();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return safeJson(res, { msg: err.message }); }
        sftp.mkdir(dirPath, (err) => { conn.end(); if (err) return safeJson(res, { msg: err.message }); safeJson(res, { msg: 'success' }); });
      });
    });
    conn.on('error', (err) => safeJson(res, { msg: err.message }));
    conn.connect({ host: config.host, port: config.port, username: config.username, password: config.password, privateKey: config.privateKey, passphrase: config.passphrase });
  } catch (err: any) { safeJson(res, { msg: err.message }); }
});

// ======================== SSH Sessions ========================

interface SSHSession {
  id: string; sshConfig: any; client: SSHClient; stream: any;
  history: Buffer[]; historySize: number; cols: number; rows: number;
  attachedSockets: Set<WebSocket>; createdAt: number; lastActivity: number;
  hasAttachedOnce?: boolean;
  shared: boolean;
  ownerClientId?: string;
  disconnectTimer?: NodeJS.Timeout;
  sshLatencyMs?: number;
  latencyProbeTimer?: NodeJS.Timeout;
  latencyProbeInFlight?: boolean;
}

const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const sshSessions = new Map<string, SSHSession>();
const WS_META_PREFIX = '__WEBSSH_META__:';
const SESSION_ATTACH_GRACE_MS = 30000;

function sendTerminalMessage(ws: WebSocket, message: string | Buffer) {
  if (ws.readyState === WebSocket.OPEN) ws.send(message);
}

function sendMetaMessage(ws: WebSocket, payload: Record<string, unknown>) {
  sendTerminalMessage(ws, `${WS_META_PREFIX}${JSON.stringify(payload)}`);
}

function broadcastSessionSharedState(session: SSHSession) {
  for (const clientWs of session.attachedSockets) {
    if (clientWs.readyState === WebSocket.OPEN) {
      sendMetaMessage(clientWs, { type: 'shared_state', sessionId: session.id, shared: session.shared });
    }
  }
}

function closeAttachedSession(session: SSHSession) {
  if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
  if (session.latencyProbeTimer) clearInterval(session.latencyProbeTimer);
  session.latencyProbeTimer = undefined;
  session.latencyProbeInFlight = false;
  for (const ws of session.attachedSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      sendTerminalMessage(ws, '\r\n\x1b[33m[WebSSH] Session terminated by user.\x1b[0m\r\n');
      ws.close();
    }
  }
  try { session.stream?.end(); session.client?.end(); } catch {}
  sshSessions.delete(session.id);
}

function scheduleSessionDisconnect(session: SSHSession, delayMs: number) {
  if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
  session.disconnectTimer = setTimeout(() => {
    if (session.attachedSockets.size === 0) {
      try { session.stream?.end(); session.client?.end(); } catch {}
      sshSessions.delete(session.id);
      sshLog('session removed after detach timeout', { sessionId: session.id, delayMs });
    }
  }, delayMs);
}

function decodeIncomingMessage(msg: Buffer | string) {
  return typeof msg === 'string' ? msg : msg.toString('utf-8');
}

function normalizeIncomingData(msg: RawData, isBinary: boolean): Buffer | string {
  if (!isBinary && typeof msg === 'string') return msg;
  if (Buffer.isBuffer(msg)) return msg;
  if (msg instanceof ArrayBuffer) return Buffer.from(msg);
  if (Array.isArray(msg)) return Buffer.concat(msg.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  return Buffer.from(msg as ArrayBufferLike);
}

function attachToSession(session: SSHSession, ws: WebSocket, clientId: string, force = false) {
  if (session.disconnectTimer) {
    clearTimeout(session.disconnectTimer);
    session.disconnectTimer = undefined;
  }

  if (!session.shared && session.ownerClientId && session.ownerClientId !== clientId && session.attachedSockets.size > 0) {
    if (force) {
      for (const clientWs of session.attachedSockets) {
        if (clientWs.readyState === WebSocket.OPEN) {
          sendMetaMessage(clientWs, { type: 'session_taken_over', sessionId: session.id });
          sendTerminalMessage(clientWs, '\r\n\x1b[33m[WebSSH] Session taken over by another browser tab or device.\x1b[0m\r\n');
          clientWs.close(4001, 'Session taken over');
        }
      }
      session.attachedSockets.clear();
    } else {
      sendMetaMessage(ws, { type: 'session_busy', sessionId: session.id });
      sendTerminalMessage(ws, '\r\n\x1b[31m[WebSSH] Session is already attached from another browser tab or device.\x1b[0m\r\n');
      ws.close(1008, 'Session already attached');
      return false;
    }
  }

  session.ownerClientId = clientId || session.ownerClientId;

  if (!session.shared) {
    for (const clientWs of session.attachedSockets) {
      if (clientWs !== ws) {
        if (clientWs.readyState === WebSocket.OPEN) {
          sendTerminalMessage(clientWs, '\r\n\x1b[33m[WebSSH] Session reattached by the same browser tab.\x1b[0m\r\n');
          clientWs.close();
        }
        session.attachedSockets.delete(clientWs);
      }
    }
  }

  session.attachedSockets.add(ws);
  session.hasAttachedOnce = true;
  session.lastActivity = Date.now();
  if (typeof session.sshLatencyMs === 'number' && ws.readyState === WebSocket.OPEN) {
    sendMetaMessage(ws, { type: 'ssh_latency', latencyMs: session.sshLatencyMs, sessionId: session.id });
  }
  return true;
}

function createLiveSession(
  sessionId: string,
  sshConfig: ReturnType<typeof parseSSHInfo>,
  options: { cols: number; rows: number; ownerClientId?: string; keepAliveMs: number }
) {
  return new Promise<SSHSession>((resolve, reject) => {
    const conn = new SSHClient();
    let settled = false;
    let sshReady = false;
    const sshWatchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error('SSH handshake timed out');
      sshLog('SSH connection watchdog timeout', { sessionId, ...sshSummary(sshConfig) });
      try { conn.end(); } catch {}
      reject(err);
    }, 20000);

    conn.on('ready', () => {
      sshReady = true;
      clearTimeout(sshWatchdog);
      sshLog('SSH ready', { sessionId, ...sshSummary(sshConfig) });
      conn.shell({ term: 'xterm-256color', cols: options.cols, rows: options.rows }, (err, stream) => {
        if (settled) {
          try { conn.end(); } catch {}
          return;
        }
        if (err) {
          settled = true;
          sshLog('SSH shell failed', { sessionId, error: err.message });
          try { conn.end(); } catch {}
          reject(err);
          return;
        }
        sshLog('SSH shell opened', { sessionId });

        const session: SSHSession = {
          id: sessionId,
          sshConfig,
          client: conn,
          stream,
          history: [],
          historySize: 0,
          cols: options.cols,
          rows: options.rows,
          attachedSockets: new Set(),
          createdAt: Date.now(),
          lastActivity: Date.now(),
          shared: false,
          ownerClientId: options.ownerClientId || undefined,
        };
        sshSessions.set(sessionId, session);
        startSessionLatencyProbe(session);
        scheduleSessionDisconnect(session, SESSION_ATTACH_GRACE_MS);

        stream.on('data', (data: Buffer) => {
          session.history.push(data);
          session.historySize += data.length;
          session.lastActivity = Date.now();
          while (session.historySize > MAX_HISTORY_BYTES && session.history.length > 1) {
            const removed = session.history.shift();
            if (removed) session.historySize -= removed.length;
          }
          for (const clientWs of session.attachedSockets) {
            if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
          }
        });

        stream.on('close', () => {
          sshLog('SSH shell closed', { sessionId });
          if (session.latencyProbeTimer) clearInterval(session.latencyProbeTimer);
          session.latencyProbeTimer = undefined;
          session.latencyProbeInFlight = false;
          for (const clientWs of session.attachedSockets) {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send('\r\n\x1b[33mConnection closed by remote host.\x1b[0m\r\n');
              clientWs.close();
            }
          }
          if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
          sshSessions.delete(sessionId);
          conn.end();
        });

        conn.on('close', () => {
          clearTimeout(sshWatchdog);
          sshLog('SSH client closed', { sessionId, sshReady });
        });

        settled = true;
        resolve(session);
      });
    });

    conn.on('error', (err) => {
      clearTimeout(sshWatchdog);
      const errorDetails = sshErrorDetails(err);
      sshLog('SSH connection error', {
        sessionId,
        error: errorDetails,
        ...sshSummary(sshConfig),
      });
      console.error(`[webssh-ssh] raw SSH error for session ${sessionId}`, err);
      if (!settled) {
        settled = true;
        reject(err);
      }
      try { conn.end(); } catch {}
    });

    sshLog('SSH connect started', { sessionId, ...sshSummary(sshConfig) });
    conn.connect({
      host: sshConfig.host,
      port: sshConfig.port,
      username: sshConfig.username,
      password: sshConfig.password,
      privateKey: sshConfig.privateKey,
      passphrase: sshConfig.passphrase,
      readyTimeout: 15000,
    });
  });
}

function broadcastSshLatency(session: SSHSession, latencyMs: number) {
  session.sshLatencyMs = latencyMs;
  for (const clientWs of session.attachedSockets) {
    if (clientWs.readyState === WebSocket.OPEN) {
      sendMetaMessage(clientWs, { type: 'ssh_latency', latencyMs, sessionId: session.id });
    }
  }
}

function probeSessionLatency(session: SSHSession) {
  if (session.latencyProbeInFlight) return;
  if (!session.client) return;
  session.latencyProbeInFlight = true;
  const startedAt = Date.now();

  session.client.exec('printf "__WEBSSH_LATENCY__\\n"', (err, execStream) => {
    if (err) {
      session.latencyProbeInFlight = false;
      return;
    }

    let settled = false;
    let stdout = '';

    const finalize = () => {
      if (settled) return;
      settled = true;
      session.latencyProbeInFlight = false;
    };

    execStream.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.includes('__WEBSSH_LATENCY__')) {
        broadcastSshLatency(session, Date.now() - startedAt);
        finalize();
        try { execStream.close(); } catch {}
      }
    });

    execStream.on('close', () => {
      if (!settled && stdout.includes('__WEBSSH_LATENCY__')) {
        broadcastSshLatency(session, Date.now() - startedAt);
      }
      finalize();
    });

    execStream.on('error', () => {
      finalize();
    });

    execStream.stderr?.on('data', () => {
      // Ignore stderr noise from shell startup scripts while probing latency.
    });
  });
}

function startSessionLatencyProbe(session: SSHSession) {
  if (session.latencyProbeTimer) clearInterval(session.latencyProbeTimer);
  probeSessionLatency(session);
  session.latencyProbeTimer = setInterval(() => {
    probeSessionLatency(session);
  }, 30000);
}

app.get('/ssh/sessions', (_req, res) => {
  const list = Array.from(sshSessions.values())
    .filter((s) => s.hasAttachedOnce)
    .map((s) => ({
      id: s.id, host: s.sshConfig?.host, port: s.sshConfig?.port, username: s.sshConfig?.username,
      createdAt: s.createdAt, lastActivity: s.lastActivity, attachedClients: s.attachedSockets.size, ownerClientId: s.ownerClientId, shared: s.shared,
      credentialId: s.sshConfig?.id || '',
    }));
  res.json(list);
});

app.get('/ssh/session/:sessionId/status', (req, res) => {
  const session = sshSessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ exists: false, error: 'Session not found' });
  }
  return res.json({
    exists: true,
    attachedClients: session.attachedSockets.size,
    hasAttachedOnce: Boolean(session.hasAttachedOnce),
    ownerClientId: session.ownerClientId || '',
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    host: session.sshConfig?.host,
    username: session.sshConfig?.username,
  });
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
    const existing = sshSessions.get(sessionId);
    if (existing) {
      return res.json({ sessionId: existing.id, created: false });
    }
    sshLog('session create: establishing live SSH session', {
      sessionId,
      source: req.body?.credentialId ? 'saved-credential' : 'inline',
      cols,
      rows,
      ...sshSummary(sshConfig),
    });
    await createLiveSession(sessionId, sshConfig, { cols, rows, ownerClientId: clientId, keepAliveMs });
    return res.json({ sessionId, created: true });
  } catch (err: any) {
    sshLog('session create: failed', { error: err.message || String(err) });
    return res.status(400).json({ error: sshErrorText(err) || err.message || 'Invalid SSH connection parameters' });
  }
});

app.post('/ssh/sessions/kill', (req, res) => {
  const { sessionId, force, clientId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  const session = sshSessions.get(sessionId);
  if (session) {
    if (!force && clientId && session.ownerClientId && session.ownerClientId !== clientId) {
      return res.status(409).json({ error: 'Session is currently owned by another client', ownerClientId: session.ownerClientId });
    }
    if (!force && session.attachedSockets.size > 1) {
      return res.status(409).json({ error: 'Session is attached by other clients', attachedClients: session.attachedSockets.size });
    }
    closeAttachedSession(session);
    return res.json({ message: 'Session killed successfully' });
  }
  res.json({ message: 'Session not found or already closed' });
});

// ======================== HTTP Server & WebSocket ========================

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '', `http://${request.headers.host}`);
  if (url.pathname === '/term' || url.pathname === '/terminal') {
    sshLog('websocket upgrade requested', {
      path: url.pathname,
      sessionId: url.searchParams.get('sessionId') || url.searchParams.get('id') || '',
      origin: request.headers.origin || '(none)',
    });
    const config = readAppConfig();
    const httpsEnforced = config.httpsEnforced ?? (process.env.WEBSSH_REQUIRE_HTTPS === 'true');
    if (httpsEnforced && !isHttpsRequest(request)) {
      sshLog('websocket upgrade rejected: HTTPS required');
      socket.write('HTTP/1.1 426 Upgrade Required\r\n\r\n');
      socket.destroy();
      return;
    }
    const originCheckEnabled = config.originCheckEnabled ?? true;
    if (originCheckEnabled && !isAllowedOrigin(request, request.headers.origin)) {
      sshLog('websocket upgrade rejected: invalid origin', { origin: request.headers.origin || '(none)' });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (isAuthConfigured(config) && !isAuthenticated(request, config)) {
      sshLog('websocket upgrade rejected: unauthorized');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    sshLog('websocket upgrade accepted');
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, url);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws: WebSocket, _request: http.IncomingMessage, url: URL) => {
  const sessionId = url.searchParams.get('sessionId') || url.searchParams.get('id') || '';
  const clientId = url.searchParams.get('clientId') || '';
  const forceAttach = url.searchParams.get('forceAttach') === '1';
  const cols = parseInt(url.searchParams.get('cols') || '120', 10);
  const rows = parseInt(url.searchParams.get('rows') || '30', 10);
  const timeoutMins = parseInt(url.searchParams.get('timeout') || '120', 10);
  const keepAliveMs = (timeoutMins > 0 ? timeoutMins : 120) * 60 * 1000;

  let existingSession = sessionId ? sshSessions.get(sessionId) : undefined;
  sshLog('websocket connected', {
    sessionId: sessionId || '(none)',
    clientId: clientId || '(none)',
    forceAttach,
    existingSession: Boolean(existingSession),
  });

  if (!existingSession) {
    const message = 'Missing or expired SSH session';
    sshLog('websocket closed: missing or expired SSH session', { sessionId });
    if (ws.readyState === WebSocket.OPEN) {
      sendMetaMessage(ws, {
        type: 'ssh_connection_error',
        code: 'SESSION_NOT_FOUND',
        message,
        sessionId,
      });
      ws.send(`\r\n\x1b[31mError: ${message} (sessionId=${sessionId || '(none)'})\x1b[0m\r\n`);
      ws.close(1011, message);
    }
    return;
  }
  if (!attachToSession(existingSession, ws, clientId, forceAttach)) {
    sshLog('session attach rejected', { sessionId, reason: 'busy-after-create' });
    return;
  }
  sshLog('session attached', {
    sessionId: existingSession.id,
    clientId: clientId || '(none)',
    forceAttach,
    historyBytes: existingSession.historySize,
  });
  existingSession.cols = cols;
  existingSession.rows = rows;
  try { existingSession.stream.setWindow(rows, cols, 0, 0); } catch {}
  if (ws.readyState === WebSocket.OPEN) {
    sendMetaMessage(ws, { type: 'session_info', sessionId: existingSession.id, reattached: existingSession.history.length > 0, shared: existingSession.shared });
    for (const chunk of existingSession.history) ws.send(chunk);
  }
  ws.on('message', (msg: RawData, isBinary: boolean) => {
    const payload = normalizeIncomingData(msg, isBinary);
    const raw = typeof payload === 'string' ? payload : decodeIncomingMessage(payload);
    if (!isBinary && raw.startsWith('{') && raw.endsWith('}')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.type === 'resize' && parsed.cols && parsed.rows) { existingSession!.cols = parsed.cols; existingSession!.rows = parsed.rows; existingSession!.stream.setWindow(parsed.rows, parsed.cols, 0, 0); return; }
        if (parsed.type === 'kill_session') { closeAttachedSession(existingSession!); return; }
        if (parsed.type === 'set_shared' && typeof parsed.shared === 'boolean') {
          existingSession!.shared = parsed.shared;
          sshLog('session sharing changed', { sessionId: existingSession!.id, shared: existingSession!.shared, clientId });
          broadcastSessionSharedState(existingSession!);
          return;
        }
        if (parsed.type === 'ping') { sendMetaMessage(ws, { type: 'pong', ts: parsed.ts ?? Date.now(), serverTs: Date.now() }); return; }
      } catch {}
    }
    try { existingSession!.stream.write(payload); } catch {}
  });
  ws.on('close', () => {
    sshLog('websocket closed', { sessionId: existingSession!.id, readyState: ws.readyState });
    existingSession!.attachedSockets.delete(ws);
    if (existingSession!.attachedSockets.size === 0) {
      scheduleSessionDisconnect(existingSession!, keepAliveMs);
    }
  });
  ws.on('error', () => { existingSession!.attachedSockets.delete(ws); });
});

// ======================== Start Server ========================

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, HOST, () => {
    console.log(`WebSSH Server running at http://${HOST}:${PORT}`);
  });
}

startServer();
