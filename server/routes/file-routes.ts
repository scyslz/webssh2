import express from 'express';
import path from 'path';
import { ParsedSSHInfo, safeJson, safeSend, upload } from '../lib.ts';
import { SessionManager } from '../session-manager.ts';
import { connectSSH, resolveSSHInfo } from './shared.ts';

/**
 * 这里是 SFTP 的 HTTP 通道，只保留二进制传输（下载 / 上传）。
 *
 * 文本类操作（list / read / write / mkdir / delete）已经全部走 WebSocket `/sftp`，
 * 见 `server/session-manager.ts` 的 handleSftpConnection。那部分不再提供 HTTP 版本，
 * 以免维护两条协议实现。
 *
 * 这两个端点不迁移到 WS 的原因：
 * - 下载依赖 `res.pipe()` 做流式传输，不占 WS 连接，也保留浏览器 `window.open` 的原生下载体验；
 * - WS 协议现有的 `write` 只接受 UTF-8 字符串，承载二进制需要新增控制帧 + 二进制分片帧，
 *   且纯 WS 化后大文件必须全量驻留前端内存，移动端反而更差。
 */

function withSftp<T>(
  sessionManager: SessionManager,
  sessionId: string | undefined,
  config: ParsedSSHInfo,
  action: (sftp: any, reuse: boolean) => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const existingClient = sessionId ? sessionManager.getSessionClient(sessionId) : undefined;
    if (existingClient) {
      const fallback = () => connectSftp(config, action).then(resolve, reject);
      existingClient.sftp((err, sftp) => {
        if (err) return fallback();
        try {
          resolve(action(sftp, true));
        } catch (actionErr) {
          reject(actionErr as Error);
        }
      });
      return;
    }
    connectSftp(config, action).then(resolve, reject);
  });
}

function connectSftp<T>(config: ParsedSSHInfo, action: (sftp: any, reuse: boolean) => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    connectSSH(
      config,
      (conn) => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          const result = action(sftp, false);
          resolve(result);
        });
      },
      reject,
    );
  });
}

function endSftp(sftp: any) {
  try { sftp.end?.(); } catch {}
}

export function registerFileRoutes(app: express.Express, sessionManager: SessionManager) {
  app.get('/file/download', async (req, res) => {
    const sshInfoStr = (req.query.sshInfo as string) || '';
    const sessionId = (req.query.sessionId as string) || '';
    const filePath = (req.query.path as string) || '';
    try {
      const config = resolveSSHInfo(sessionManager, sessionId, sshInfoStr);
      await withSftp(sessionManager, sessionId, config, (sftp, reuse) => {
        const fileName = path.basename(filePath);
        if (!res.headersSent) {
          res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
          res.setHeader('Content-Type', 'application/octet-stream');
        }
        const readStream = sftp.createReadStream(filePath);
        readStream.pipe(res);
        readStream.on('close', () => {
          if (!reuse) endSftp(sftp);
        });
        readStream.on('error', (streamErr) => {
          if (!reuse) endSftp(sftp);
          safeSend(res, streamErr.message, 500);
        });
      });
    } catch (err: any) {
      safeSend(res, err.message, 400);
    }
  });

  app.post('/file/upload', upload.single('file'), async (req, res) => {
    const sshInfoStr = (req.body.sshInfo as string) || '';
    const sessionId = (req.body.sessionId as string) || '';
    const dir = (req.body.dir as string) || '';
    const targetDir = (req.body.path as string) || '/root';
    if (!req.file) return safeJson(res, { msg: 'No file uploaded' });
    try {
      const config = resolveSSHInfo(sessionManager, sessionId, sshInfoStr);
      await withSftp(sessionManager, sessionId, config, (sftp, reuse) => {
        let fullDirPath = targetDir.replace(/\/$/, '');
        if (dir) fullDirPath += `/${dir.replace(/^\//, '')}`;
        const remoteFilePath = `${fullDirPath}/${req.file!.originalname}`;
        const writeStream = sftp.createWriteStream(remoteFilePath);
        writeStream.end(req.file!.buffer, () => {
          if (!reuse) endSftp(sftp);
          safeJson(res, { msg: 'success', data: { path: remoteFilePath } });
        });
        writeStream.on('error', (streamErr) => {
          if (!reuse) endSftp(sftp);
          safeJson(res, { msg: streamErr.message });
        });
      });
    } catch (err: any) {
      safeJson(res, { msg: err.message });
    }
  });
}
