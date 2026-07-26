import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import multer from 'multer';
import path from 'path';

export const upload = multer({ storage: multer.memoryStorage() });
export const PORT = Number(process.env.PORT) || 3000;
export const HOST = '0.0.0.0';

const DATA_DIR = process.env.WEBSSH_DATA_DIR || process.cwd();
const CONFIG_DIR = process.env.WEBSSH_CONFIG_DIR || path.join(process.cwd(), 'conf');
const SSH_LIST_PATH = path.join(DATA_DIR, 'ssh_list.json');
const SSH_SECRET_PATH = path.join(DATA_DIR, 'ssh_secrets.json');
const MASTER_KEY_PATH = path.join(DATA_DIR, '.webssh_master_key');
const CONFIG_PATH = path.join(CONFIG_DIR, 'webssh_config.json');
const AUTH_COOKIE_NAME = 'webssh_auth';
const AUTH_TOKEN_SECRET = process.env.WEBSSH_AUTH_SECRET || crypto.randomBytes(32).toString('hex');
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const loginAttempts = new Map<string, { failures: number; windowStartedAt: number; blockedUntil: number }>();

export interface QuickCommandConfig {
  id: string;
  label: string;
  cmd: string;
  enabled: boolean;
}

export interface AppConfig {
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
  quickCommands?: QuickCommandConfig[];
}

export interface StoredSSHHost {
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

export interface ParsedSSHInfo {
  id?: string;
  host: string;
  port: number;
  username: string;
  password: string;
  privateKey?: string;
  passphrase?: string;
  logintype: number;
}

export function sshLog(message: string, details?: Record<string, unknown>) {
  const suffix = details ? ` ${JSON.stringify(details)}` : '';
  console.log(`[webssh-ssh] ${new Date().toISOString()} ${message}${suffix}`);
}

export function sshSummary(config: ParsedSSHInfo | StoredSSHHost | undefined) {
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

export function sshErrorDetails(err: any) {
  return {
    name: err?.name,
    message: err?.message || String(err),
    code: err?.code,
    level: err?.level,
    description: err?.description,
    stack: err?.stack,
  };
}

export function sshErrorText(err: any) {
  const details = sshErrorDetails(err);
  const fields = [
    details.message,
    details.code ? `code=${details.code}` : '',
    details.level ? `level=${details.level}` : '',
    details.description ? `description=${details.description}` : '',
  ].filter(Boolean);
  return fields.join(' | ');
}

function padNumber(value: number, length = 2) {
  return value.toString().padStart(length, '0');
}

export function createSessionId() {
  const now = new Date();
  return `sid-${padNumber(now.getMonth() + 1)}${padNumber(now.getDate())}-${padNumber(now.getHours())}${padNumber(now.getMinutes())}${padNumber(now.getSeconds())}-${padNumber(now.getMilliseconds(), 3)}`;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
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

export function readAppConfig(): AppConfig {
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

export function writeAppConfig(config: AppConfig) {
  const tempPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, CONFIG_PATH);
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
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

export function readSavedHosts(): StoredSSHHost[] {
  if (fs.existsSync(SSH_SECRET_PATH)) {
    const store = JSON.parse(fs.readFileSync(SSH_SECRET_PATH, 'utf8')) as EncryptedStore;
    const hosts = decryptStore(store);
    return Array.isArray(hosts) ? hosts : [];
  }

  if (fs.existsSync(SSH_LIST_PATH)) {
    const legacy = JSON.parse(fs.readFileSync(SSH_LIST_PATH, 'utf8') || '[]');
    const hosts = Array.isArray(legacy) ? legacy : [];
    writeSavedHosts(hosts);
    try { fs.renameSync(SSH_LIST_PATH, `${SSH_LIST_PATH}.migrated`); } catch {}
    return hosts;
  }
  return [];
}

export function writeSavedHosts(hosts: StoredSSHHost[]) {
  const tempPath = `${SSH_SECRET_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(encryptStore(hosts), null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, SSH_SECRET_PATH);
  try { fs.chmodSync(SSH_SECRET_PATH, 0o600); } catch {}
}

export function publicHost(host: StoredSSHHost) {
  const { password, privateKey, passphrase, ...safe } = host;
  return {
    ...safe,
    hasCredential: Boolean(password || privateKey),
  };
}

export function getPublicConfig(config: AppConfig): AppConfig {
  const { authPassword, authPasswordHash, ...rest } = config;
  return { ...rest, authPassword: '' };
}

export function isAuthConfigured(config: AppConfig) {
  return Boolean(config.authEnabled && config.authUsername && config.authPasswordHash);
}

export function parseCookies(cookieHeader?: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const chunk of cookieHeader.split(';')) {
    const [rawName, ...rest] = chunk.trim().split('=');
    if (!rawName) continue;
    cookies[rawName] = decodeURIComponent(rest.join('=') || '');
  }
  return cookies;
}

export function createAuthToken(username: string, passwordHash: string) {
  const payload = Buffer.from(JSON.stringify({
    u: username,
    p: passwordHash,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyAuthToken(token: string | undefined, config: AppConfig) {
  if (!token || !isAuthConfigured(config) || !config.authUsername || !config.authPasswordHash) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(payload).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    if (decoded.exp < Date.now()) return false;
    return decoded.u === config.authUsername && decoded.p === config.authPasswordHash;
  } catch {
    return false;
  }
}

export function isAuthenticated(req: http.IncomingMessage | express.Request, config: AppConfig) {
  if (!isAuthConfigured(config)) return true;
  const cookies = parseCookies('headers' in req ? req.headers.cookie : undefined);
  return verifyAuthToken(cookies[AUTH_COOKIE_NAME], config);
}

export function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const config = readAppConfig();
  if (!isAuthConfigured(config)) return next();
  if (isAuthenticated(req, config)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

export function parseSSHInfo(sshInfoStr: string): ParsedSSHInfo {
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
    throw new Error(`Invalid sshInfo parameter format: ${err.message}`);
  }
}

export function formatByteSize(bytes: number): string {
  if (bytes === 0) return '0B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i === 0) return `${bytes}B`;
  return `${(bytes / Math.pow(k, i)).toFixed(2).replace(/\.00$/, '')}${sizes[i]}`;
}

export function safeJson(res: express.Response, data: any, statusCode = 200) {
  if (!res.headersSent) res.status(statusCode).json(data);
}

export function safeSend(res: express.Response, data: any, statusCode = 200) {
  if (!res.headersSent) res.status(statusCode).send(data);
}

export function isHttpsRequest(req: express.Request | http.IncomingMessage) {
  const forwardedProto = 'headers' in req ? req.headers['x-forwarded-proto'] : undefined;
  const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return protocol === 'https' || ('secure' in req && Boolean((req as express.Request).secure));
}

export function requireHttps(req: express.Request, res: express.Response, next: express.NextFunction) {
  const config = readAppConfig();
  const httpsEnforced = config.httpsEnforced ?? (process.env.WEBSSH_REQUIRE_HTTPS === 'true');
  if (httpsEnforced && !isHttpsRequest(req)) {
    return res.status(426).json({ error: 'HTTPS is required' });
  }
  return next();
}

export function isAllowedOrigin(req: express.Request | http.IncomingMessage, origin?: string) {
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

export function requireOrigin(req: express.Request, res: express.Response, next: express.NextFunction) {
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

export function getClientIp(req: express.Request) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export function checkLoginRateLimit(ip: string) {
  const now = Date.now();
  const current = loginAttempts.get(ip);
  if (!current || now - current.windowStartedAt >= LOGIN_WINDOW_MS) {
    const fresh = { failures: 0, windowStartedAt: now, blockedUntil: 0 };
    loginAttempts.set(ip, fresh);
    return fresh;
  }
  return current;
}

export function recordLoginFailure(ip: string) {
  const state = checkLoginRateLimit(ip);
  state.failures += 1;
  if (state.failures >= LOGIN_MAX_FAILURES) state.blockedUntil = Date.now() + LOGIN_BLOCK_MS;
}

export function clearLoginFailures(ip: string) {
  loginAttempts.delete(ip);
}

export function setAuthCookie(res: express.Response, token: string, secure: boolean) {
  const secureFlag = secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=${7 * 24 * 60 * 60}`);
}

export function clearAuthCookie(res: express.Response, secure: boolean) {
  const secureFlag = secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=0`);
}
