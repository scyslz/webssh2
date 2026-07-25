# WebSSH

一个面向浏览器的 SSH Terminal + SFTP Client。无需本地安装终端工具，打开网页即可连接远程 Linux / Unix 服务器，完成命令行操作、文件管理和会话恢复。

## 核心功能优势

- 浏览器即终端。基于 WebSocket + `ssh2` + `xterm.js`，直接在网页里获得实时 SSH 交互体验。
- Terminal 和 SFTP 一体化。一个连接同时支持命令执行、目录浏览、文件上传下载、文本文件在线编辑，减少工具切换。
- 会话可恢复。支持后台 SSH 会话保活、同浏览器标签重连、强制接管，网络抖动或误关标签后更容易继续工作。
- 移动端可用。针对手机和平板做了输入、粘贴、快捷键栏、选择复制等适配，不只是桌面端可用。
- 支持密码和私钥登录。兼容常见 SSH 认证方式，覆盖多数运维场景。
- 内置基础访问保护。支持应用级登录保护，避免服务裸露后任何人都能直接进入连接页。
- 可配置体验。支持主题、终端字号、后台会话超时等设置。

## 功能清单

- Web Terminal
- SFTP 文件浏览
- 文件上传 / 下载
- 在线文本编辑
- Saved Hosts 管理
- Split View 终端 + 文件双栏操作
- 会话恢复与接管
- 登录鉴权保护
- 多主题切换

## Snapshot
<img width="196" height="341" alt="image" src="https://github.com/user-attachments/assets/3de17455-4ed6-4d70-9a2e-7e2f99f8ecf8" /> 

<img width="948" height="413" alt="image" src="https://github.com/user-attachments/assets/41a54ade-9c05-49f4-9a09-f8c6c3308ec9" />



## 技术栈

- Frontend: React 19, Vite, Tailwind CSS 4
- Terminal: `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`
- Backend: Express, WebSocket, `ssh2`, `multer`
- Runtime: Node.js

## 目录结构

- `web/`: 前端工程，包含 `index.html` 和 `src/`
- `server/`: 后端路由、SSH 会话管理和服务端工具函数
- `conf/`: 默认配置和示例环境变量
- `dist/`: 生产构建产物
- `Dockerfile` / `docker-compose.yaml`: 容器化部署配置

## 本地运行

### 前置要求

- Node.js 18+
- 可访问的 SSH 服务器

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

默认监听：

- `http://0.0.0.0:3000`

### 生产构建

```bash
npm run build
npm run start
```

### Docker Compose
```
services:
  webssh2:
      dockerfile: Dockerfile
    image: scyslz/webssh2:latest
    container_name: webssh2
    restart: unless-stopped
    ports:
      - "${PORT:-3000}:3000"
    environment:
      NODE_ENV: production
      PORT: 3000
      WEBSSH_DATA_DIR: /app/data
      WEBSSH_CONFIG_DIR: /app/data
      WEBSSH_MASTER_KEY: "${WEBSSH_MASTER_KEY:-replace-with-a-high-entroapy-secret}"
      WEBSSH_AUTH_SECRET: "${WEBSSH_AUTH_SECRET:-replace-with-a-different-high-entropy-secret}"
      WEBSSH_REQUIRE_HTTPS: "${WEBSSH_REQUIRE_HTTPS:-false}"
      WEBSSH_ALLOWED_ORIGINS: "${WEBSSH_ALLOWED_ORIGINS:-}"
    volumes:
      - webssh2-data:/app/data

volumes:
  webssh2-data:

```

```bash
docker compose up -d --build
```

如需自定义密钥和端口，可先基于 `conf/.env.example` 创建自己的 `.env`。

## 配置说明

源码仓库中的默认配置文件：

- `conf/webssh_config.json`: 应用默认配置，如主题、字号、会话保活时长、登录保护
- `conf/.env.example`: 环境变量示例

运行时数据默认行为：

- 本地直接运行时：
  - 配置文件读取 `conf/webssh_config.json`
  - SSH 凭据保存到根目录 `ssh_secrets.json`
  - 本地主密钥保存到根目录 `.webssh_master_key`
- Docker Compose 运行时：
  - 配置文件、SSH 凭据和主密钥都保存在卷 `/app/data`
  - 通过 `WEBSSH_DATA_DIR` 和 `WEBSSH_CONFIG_DIR` 控制路径

默认可配置项包括：

- `theme`
- `fontSize`
- `timeout`
- `savePass`
- `httpsEnforced`
- `originCheckEnabled`
- `authEnabled`
- `authUsername`
- `authPassword`

## 适用场景

- 内网运维面板
- 轻量级堡垒机 / 跳板机前端
- 开发测试环境远程访问
- 需要在移动端临时处理服务器问题的场景
- 希望把终端和文件操作收敛到一个 Web 工具中的团队

## 安全说明

- SSH 主机凭据使用 AES-256-GCM 加密保存，主密钥优先从 `WEBSSH_MASTER_KEY` 读取；未配置时开发环境会生成权限为 `0600` 的本地 `.webssh_master_key`。
- `/ssh/list` 只返回主机元数据和 `hasCredential`，不会返回密码、私钥或 passphrase。
- 新 SSH 连接通过 POST 创建后端会话，WebSocket URL 不携带 SSH 凭据。
- 生产环境必须配置 `WEBSSH_MASTER_KEY`，并使用 HTTPS/WSS；不要依赖自动生成的本地密钥做多实例部署。
- 不建议把 `ssh_secrets.json` 纳入仓库；它属于运行时敏感数据，不属于 `conf/` 里的源码配置。
- 应用登录密码使用 `scrypt` 哈希保存，`/config` 不会返回密码或密码哈希；生产环境应配置 `WEBSSH_AUTH_SECRET`。
- `httpsEnforced` 开启后，HTTP 和 `ws://` 请求会被拒绝；反向代理需要正确传递 `X-Forwarded-Proto: https`。如果配置里未设置，仍可回退使用 `WEBSSH_REQUIRE_HTTPS=true`。
- 登录接口按来源 IP 限制为 15 分钟最多 5 次失败，触发后临时锁定 15 分钟。
- `originCheckEnabled` 开启后，HTTP 写操作和 WebSocket 会校验浏览器 `Origin`；跨域部署时通过 `WEBSSH_ALLOWED_ORIGINS` 配置允许的来源。
- 应用级登录保护适合做第一层访问控制，但不应替代更完整的网络隔离、反向代理鉴权或企业级审计能力。

## 开发脚本

```bash
npm run dev
npm run build
npm run start
npm run lint
```
