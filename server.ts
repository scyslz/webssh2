import express from 'express';
import http from 'http';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { HOST, PORT, sshLog } from './server/lib.ts';
import { registerRoutes } from './server/register-routes.ts';
import { createSessionManager } from './server/session-manager.ts';

/**
 * 前端会用 fetch 请求的接口前缀（见 server/routes/）。
 *
 * 存在的意义：这些路径下**没匹配到路由**时，必须回 JSON，绝不能落到 SPA fallback 上。
 * 否则 GET 会拿回 index.html（200 + text/html），前端 `res.json()` 抛
 * `Unexpected token '<', "<!doctype "...` —— 把「这个路由不存在」伪装成一个看不懂的
 * 解析错误。这个坑真实发生过：服务端跑的是旧进程、缺 /ai/config，
 * 界面上只报 JSON 解析失败，完全指不到「该重启服务」这个真正的原因。
 *
 * /term 与 /sftp 是 WebSocket 升级路径，不经过 Express 路由，故不在此列。
 */
const API_PREFIXES = ['/auth', '/check', '/ssh', '/config', '/file', '/ai'];

function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

const app = express();
const server = http.createServer(app);
const sessionManager = createSessionManager();

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS: allow all origins when accessed via reverse proxy or different origin
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

registerRoutes(app, sessionManager);

// 未匹配的接口路径 → JSON 404。放在 vite / static 之前，dev 与 production 两种模式都生效。
app.use((req, res, next) => {
  if (!isApiPath(req.path)) return next();
  res.status(404).json({ error: 'Not found', path: req.path });
});

// 接口内部抛错 → JSON 500。Express 的默认错误页是 HTML（大写 <!DOCTYPE html>），
// 前端同样会炸成「Unexpected token '<'」，把真正的报错盖掉。
// 带 err.status 的（如 body-parser 的 400）沿用原状态码。
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!isApiPath(req.path)) return next(err);
  if (res.headersSent) return next(err);
  const status = typeof err?.status === 'number' ? err.status : 500;
  sshLog('api error', { method: req.method, path: req.originalUrl, status, message: err?.message });
  res.status(status).json({ error: err?.message || 'Internal server error' });
});

sessionManager.attachServer(server);

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, HOST, () => {
    console.log(`WebSSH Server running at http://${HOST}:${PORT}`);
  });
}

startServer();
