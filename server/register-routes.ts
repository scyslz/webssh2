import express from 'express';
import { requireAuth, requireHttps, requireOrigin } from './lib.ts';
import { registerAuthRoutes } from './routes/auth-routes.ts';
import { registerConfigRoutes } from './routes/config-routes.ts';
import { registerFileRoutes } from './routes/file-routes.ts';
import { registerSshRoutes } from './routes/ssh-routes.ts';
import { SessionManager } from './session-manager.ts';

export function registerRoutes(app: express.Express, sessionManager: SessionManager) {
  app.use(requireHttps);

  registerAuthRoutes(app);

  app.use(['/check', '/ssh', '/config', '/file'], requireAuth);
  app.use(['/ssh', '/config', '/file'], requireOrigin);

  registerSshRoutes(app, sessionManager);
  registerConfigRoutes(app);
  registerFileRoutes(app, sessionManager);
}
