import express from 'express';
import path from 'path';
import { ParsedSSHInfo, formatByteSize, safeJson, safeSend, upload } from '../lib.ts';
import { SessionManager } from '../session-manager.ts';
import { connectSSH, resolveSSHInfo } from './shared.ts';

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
  app.get('/file/list', async (req, res) => {
    const sshInfoStr = (req.query.sshInfo as string) || '';
    const sessionId = (req.query.sessionId as string) || '';
    const requestedPath = (req.query.path as string) || '';
    try {
      const config = resolveSSHInfo(sessionManager, sessionId, sshInfoStr);
      await withSftp(sessionManager, sessionId, config, (sftp, reuse) => {
        const resolveTarget = (cb: (targetPath: string) => void) => {
          if (!requestedPath || requestedPath === '.' || requestedPath === '~') {
            sftp.realpath('.', (realpathErr, absPath) => {
              if (!realpathErr && absPath) cb(absPath);
              else cb(config.username === 'root' ? '/root' : `/home/${config.username}`);
            });
          } else {
            cb(requestedPath);
          }
        };
        resolveTarget((dirPath) => {
          sftp.readdir(dirPath, (readErr, list) => {
            if (!reuse) endSftp(sftp);
            if (readErr) return safeJson(res, { msg: readErr.message });
            const fileList = list.map((item) => ({
              name: item.filename,
              isDir: item.attrs.isDirectory(),
              size: item.attrs.isDirectory() ? String(item.attrs.size) : formatByteSize(item.attrs.size),
              rawSize: item.attrs.size,
              modifyTime: new Date(item.attrs.mtime * 1000).toISOString().replace('T', ' ').substring(0, 19),
            }));
            fileList.sort((a, b) => {
              if (a.isDir && !b.isDir) return -1;
              if (!a.isDir && b.isDir) return 1;
              return a.name.localeCompare(b.name);
            });
            safeJson(res, { msg: 'success', duration: '0ms', data: { path: dirPath, list: fileList } });
          });
        });
      });
    } catch (err: any) {
      safeJson(res, { msg: err.message });
    }
  });

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

  app.get('/file/read', async (req, res) => {
    const sshInfoStr = (req.query.sshInfo as string) || '';
    const sessionId = (req.query.sessionId as string) || '';
    const filePath = (req.query.path as string) || '';
    try {
      const config = resolveSSHInfo(sessionManager, sessionId, sshInfoStr);
      await withSftp(sessionManager, sessionId, config, (sftp, reuse) => {
        const readStream = sftp.createReadStream(filePath);
        let content = '';
        readStream.on('data', (chunk) => {
          content += chunk.toString('utf-8');
        });
        readStream.on('end', () => {
          if (!reuse) endSftp(sftp);
          safeJson(res, { msg: 'success', data: { content, path: filePath } });
        });
        readStream.on('error', (streamErr) => {
          if (!reuse) endSftp(sftp);
          safeJson(res, { msg: streamErr.message });
        });
      });
    } catch (err: any) {
      safeJson(res, { msg: err.message });
    }
  });

  app.post('/file/write', async (req, res) => {
    const { sshInfo: sshInfoStr, sessionId, path: filePath, content } = req.body;
    try {
      const config = resolveSSHInfo(sessionManager, sessionId, sshInfoStr);
      await withSftp(sessionManager, sessionId, config, (sftp, reuse) => {
        const writeStream = sftp.createWriteStream(filePath);
        writeStream.end(Buffer.from(content || '', 'utf-8'), () => {
          if (!reuse) endSftp(sftp);
          safeJson(res, { msg: 'success' });
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

  app.post('/file/delete', async (req, res) => {
    const { sshInfo: sshInfoStr, sessionId, path: itemPath, isDir } = req.body;
    try {
      const config = resolveSSHInfo(sessionManager, sessionId, sshInfoStr);
      await withSftp(sessionManager, sessionId, config, (sftp, reuse) => {
        if (isDir) {
          sftp.rmdir(itemPath, (removeErr) => {
            if (!reuse) endSftp(sftp);
            if (removeErr) return safeJson(res, { msg: removeErr.message });
            safeJson(res, { msg: 'success' });
          });
        } else {
          sftp.unlink(itemPath, (unlinkErr) => {
            if (!reuse) endSftp(sftp);
            if (unlinkErr) return safeJson(res, { msg: unlinkErr.message });
            safeJson(res, { msg: 'success' });
          });
        }
      });
    } catch (err: any) {
      safeJson(res, { msg: err.message });
    }
  });

  app.post('/file/mkdir', async (req, res) => {
    const { sshInfo: sshInfoStr, sessionId, path: dirPath } = req.body;
    try {
      const config = resolveSSHInfo(sessionManager, sessionId, sshInfoStr);
      await withSftp(sessionManager, sessionId, config, (sftp, reuse) => {
        sftp.mkdir(dirPath, (mkdirErr) => {
          if (!reuse) endSftp(sftp);
          if (mkdirErr) return safeJson(res, { msg: mkdirErr.message });
          safeJson(res, { msg: 'success' });
        });
      });
    } catch (err: any) {
      safeJson(res, { msg: err.message });
    }
  });
}
