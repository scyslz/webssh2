import express from 'express';
import path from 'path';
import { formatByteSize, safeJson, safeSend, upload } from '../lib.ts';
import { SessionManager } from '../session-manager.ts';
import { connectSSH, resolveSSHInfo } from './shared.ts';

export function registerFileRoutes(app: express.Express, sessionManager: SessionManager) {
  app.get('/file/list', (req, res) => {
    const sshInfoStr = (req.query.sshInfo as string) || '';
    const sessionId = (req.query.sessionId as string) || '';
    const requestedPath = (req.query.path as string) || '';
    try {
      const config = resolveSSHInfo(sessionManager, sessionId, sshInfoStr);
      connectSSH(config, (conn) => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return safeJson(res, { msg: err.message });
          }
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
              conn.end();
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
      }, (err) => safeJson(res, { msg: err.message }));
    } catch (err: any) {
      safeJson(res, { msg: err.message });
    }
  });

  app.get('/file/download', (req, res) => {
    const sshInfoStr = (req.query.sshInfo as string) || '';
    const sessionId = (req.query.sessionId as string) || '';
    const filePath = (req.query.path as string) || '';
    try {
      const config = resolveSSHInfo(sessionManager, sessionId, sshInfoStr);
      connectSSH(config, (conn) => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return safeSend(res, err.message, 500);
          }
          const fileName = path.basename(filePath);
          if (!res.headersSent) {
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
            res.setHeader('Content-Type', 'application/octet-stream');
          }
          const readStream = sftp.createReadStream(filePath);
          readStream.pipe(res);
          readStream.on('close', () => conn.end());
          readStream.on('error', (streamErr) => {
            conn.end();
            safeSend(res, streamErr.message, 500);
          });
        });
      }, (err) => safeSend(res, err.message, 500));
    } catch (err: any) {
      safeSend(res, err.message, 400);
    }
  });

  app.get('/file/read', (req, res) => {
    const sshInfoStr = (req.query.sshInfo as string) || '';
    const sessionId = (req.query.sessionId as string) || '';
    const filePath = (req.query.path as string) || '';
    try {
      const config = resolveSSHInfo(sessionManager, sessionId, sshInfoStr);
      connectSSH(config, (conn) => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return safeJson(res, { msg: err.message });
          }
          const readStream = sftp.createReadStream(filePath);
          let content = '';
          readStream.on('data', (chunk) => {
            content += chunk.toString('utf-8');
          });
          readStream.on('end', () => {
            conn.end();
            safeJson(res, { msg: 'success', data: { content, path: filePath } });
          });
          readStream.on('error', (streamErr) => {
            conn.end();
            safeJson(res, { msg: streamErr.message });
          });
        });
      }, (err) => safeJson(res, { msg: err.message }));
    } catch (err: any) {
      safeJson(res, { msg: err.message });
    }
  });

  app.post('/file/write', (req, res) => {
    const { sshInfo: sshInfoStr, sessionId, path: filePath, content } = req.body;
    try {
      const config = resolveSSHInfo(sessionManager, sessionId, sshInfoStr);
      connectSSH(config, (conn) => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return safeJson(res, { msg: err.message });
          }
          const writeStream = sftp.createWriteStream(filePath);
          writeStream.end(Buffer.from(content || '', 'utf-8'), () => {
            conn.end();
            safeJson(res, { msg: 'success' });
          });
          writeStream.on('error', (streamErr) => {
            conn.end();
            safeJson(res, { msg: streamErr.message });
          });
        });
      }, (err) => safeJson(res, { msg: err.message }));
    } catch (err: any) {
      safeJson(res, { msg: err.message });
    }
  });

  app.post('/file/upload', upload.single('file'), (req, res) => {
    const sshInfoStr = (req.body.sshInfo as string) || '';
    const sessionId = (req.body.sessionId as string) || '';
    const dir = (req.body.dir as string) || '';
    const targetDir = (req.body.path as string) || '/root';
    if (!req.file) return safeJson(res, { msg: 'No file uploaded' });
    try {
      const config = resolveSSHInfo(sessionManager, sessionId, sshInfoStr);
      connectSSH(config, (conn) => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return safeJson(res, { msg: err.message });
          }
          let fullDirPath = targetDir.replace(/\/$/, '');
          if (dir) fullDirPath += `/${dir.replace(/^\//, '')}`;
          const remoteFilePath = `${fullDirPath}/${req.file!.originalname}`;
          const writeStream = sftp.createWriteStream(remoteFilePath);
          writeStream.end(req.file!.buffer, () => {
            conn.end();
            safeJson(res, { msg: 'success', data: { path: remoteFilePath } });
          });
          writeStream.on('error', (streamErr) => {
            conn.end();
            safeJson(res, { msg: streamErr.message });
          });
        });
      }, (err) => safeJson(res, { msg: err.message }));
    } catch (err: any) {
      safeJson(res, { msg: err.message });
    }
  });

  app.post('/file/delete', (req, res) => {
    const { sshInfo: sshInfoStr, sessionId, path: itemPath, isDir } = req.body;
    try {
      const config = resolveSSHInfo(sessionManager, sessionId, sshInfoStr);
      connectSSH(config, (conn) => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return safeJson(res, { msg: err.message });
          }
          if (isDir) {
            sftp.rmdir(itemPath, (removeErr) => {
              conn.end();
              if (removeErr) return safeJson(res, { msg: removeErr.message });
              safeJson(res, { msg: 'success' });
            });
          } else {
            sftp.unlink(itemPath, (unlinkErr) => {
              conn.end();
              if (unlinkErr) return safeJson(res, { msg: unlinkErr.message });
              safeJson(res, { msg: 'success' });
            });
          }
        });
      }, (err) => safeJson(res, { msg: err.message }));
    } catch (err: any) {
      safeJson(res, { msg: err.message });
    }
  });

  app.post('/file/mkdir', (req, res) => {
    const { sshInfo: sshInfoStr, sessionId, path: dirPath } = req.body;
    try {
      const config = resolveSSHInfo(sessionManager, sessionId, sshInfoStr);
      connectSSH(config, (conn) => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return safeJson(res, { msg: err.message });
          }
          sftp.mkdir(dirPath, (mkdirErr) => {
            conn.end();
            if (mkdirErr) return safeJson(res, { msg: mkdirErr.message });
            safeJson(res, { msg: 'success' });
          });
        });
      }, (err) => safeJson(res, { msg: err.message }));
    } catch (err: any) {
      safeJson(res, { msg: err.message });
    }
  });
}
