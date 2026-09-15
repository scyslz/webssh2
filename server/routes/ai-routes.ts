import express from 'express';
import { safeJson } from '../lib.ts';
import { publicAiConfig, resolveAiConfig, saveAiSettings } from '../ai/config.ts';
import { verifyAiConfig } from '../ai/provider.ts';
import type { AiSettings } from '../lib.ts';

/**
 * AI 配置的读写入口（挂在 requireAuth + requireOrigin 后面，见 register-routes.ts）。
 *
 * GET  /ai/config  读当前配置（**永不返回 apiKey 本身**，只回 hasKey 布尔）
 * POST /ai/config  写配置；apiKey 三态：字符串=设置、null=清除、不传=不动
 * POST /ai/test    用一次最小调用验通
 */
export function registerAiRoutes(app: express.Express) {
  app.get('/ai/config', (_req, res) => {
    safeJson(res, publicAiConfig());
  });

  app.post('/ai/config', (req, res) => {
    const body: any = req.body || {};
    const patch: Partial<AiSettings> = {};

    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    if (body.baseUrl !== undefined) patch.baseUrl = String(body.baseUrl);
    if (body.model !== undefined) patch.model = String(body.model);
    if (body.redactPrivateIp !== undefined) patch.redactPrivateIp = Boolean(body.redactPrivateIp);
    if (body.maxInputTokens !== undefined) patch.maxInputTokens = Number(body.maxInputTokens);
    if (body.maxOutputTokens !== undefined) patch.maxOutputTokens = Number(body.maxOutputTokens);
    // 白名单走 config.ts 里的 normalizeWhitelist 清洗，这里只做形状检查
    if (body.commandWhitelist !== undefined) {
      patch.commandWhitelist = Array.isArray(body.commandWhitelist)
        ? body.commandWhitelist.map((item: unknown) => String(item))
        : String(body.commandWhitelist).split(/[\n,]/);
    }

    // 只有显式出现 apiKey 这个键才动密钥，避免前端「保存其它字段」时把 key 抹掉
    let apiKey: string | null | undefined;
    if ('apiKey' in body) apiKey = body.apiKey === null ? null : String(body.apiKey ?? '');

    safeJson(res, saveAiSettings(patch, apiKey));
  });

  app.post('/ai/test', async (_req, res) => {
    const result = await verifyAiConfig(resolveAiConfig());
    safeJson(res, result);
  });
}
