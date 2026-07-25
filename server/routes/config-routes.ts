import express from 'express';
import fs from 'fs';
import path from 'path';
import { AppConfig, getPublicConfig, hashPassword, readAppConfig, writeAppConfig } from '../lib.ts';

export function registerConfigRoutes(app: express.Express) {
  app.get('/config', (_req, res) => {
    try {
      const configPath = path.join(
        process.env.WEBSSH_CONFIG_DIR || path.join(process.cwd(), 'conf'),
        'webssh_config.json',
      );
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf-8');
        return res.json(getPublicConfig(JSON.parse(content || '{}')));
      }
      return res.json({});
    } catch {
      return res.json({});
    }
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
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to save configuration' });
    }
  });
}
