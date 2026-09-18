# WebSSH

A browser-based SSH terminal and SFTP client with a built-in AI agent. Open one page and get an interactive shell, file management, session recovery, and an AI assistant that can read context and — with your approval — run commands on the remote host.

## Highlights

- **Terminal in the browser.** WebSocket + `ssh2` + `xterm.js` for a real interactive shell, not a command runner.
- **Terminal and SFTP in one connection.** Browse directories, upload/download files, and edit text files online without switching tools. Split view shows both side by side.
- **Recoverable sessions.** SSH sessions are kept alive server-side and can be reattached from the same tab, another tab, or another device (with optional force takeover). Network blips or accidental tab closes do not lose the session.
- **AI agent, scoped to a session.** An AI panel answers questions about the terminal and, when a live session exists, can run tools (`ssh_exec` / `ssh_read` / `ssh_write` / `ssh_list`) with server-side risk grading and human approval for anything risky.
- **Mobile-friendly.** Dedicated handling for soft keyboards, paste, a quick-key bar, and selection/copy on phones and tablets.
- **Password and private-key auth.** Covers the common SSH login setups.
- **Built-in access protection.** Application-level login, HTTPS enforcement, origin checks, and login rate limiting.
- **Configurable.** Theme, terminal font size, session keep-alive timeout, and more.

## Snapshot

<img width="196" height="341" alt="image" src="https://github.com/user-attachments/assets/3de17455-4ed6-4d70-9a2e-7e2f99f8ecf8" />
<img width="948" height="413" alt="image" src="https://github.com/user-attachments/assets/41a54ade-9c05-49f4-9a09-f8c6c3308ec9" />

## Features

- Web terminal (multi-tab, rename, duplicate, split view)
- SFTP file browsing, upload, download
- In-browser text editing
- Saved hosts management
- Session recovery and takeover
- AI panel: read-only diagnosis, command drafting, and an agent loop with approvals
- Login protection and access controls
- Light/dark themes

## Architecture

Three WebSocket channels with clearly separated responsibilities:

| Channel | Role | Holds SSH credentials? |
| --- | --- | --- |
| `/term` | Terminal session: PTY bytes, resize, heartbeat, session lifecycle | Yes (server-side only) |
| `/sftp` | File operations on an existing session | No — reuses the session |
| `/ai` | AI requests and the agent loop | No — borrows an existing session by `sessionId` |

Key design points:

- **The `/ai` channel never owns an SSH connection.** It borrows an existing session from the session manager via `sessionId` and runs tools as new channels on that already-authenticated connection. If the session is gone, the agent refuses to start rather than fail step by step.
- **AI state is session-scoped.** An `AiSession` (conversation history, approval memory, in-flight run, event buffer) lives alongside the SSH session. A dropped `/ai` connection only detaches — the run continues. On reconnect or takeover the server replays a **full conversation snapshot** (`ai_history`) plus the resumed-run marker; the client rebuilds from that and follows subsequent events live. A device that never sent a request attaches as a passive follower, so it keeps receiving output instead of waiting for a refresh.
- **Risk grading is server-side.** The model proposes tool calls; the server grades each command (`safe` / `caution` / `dangerous`) and decides whether human approval is required. The model's self-assessment is shown only for comparison.
- **AI credentials are separate.** The provider API key is stored encrypted, never in the plain config file, and never returned to the client.

## Tech Stack

- **Frontend:** React 19, Vite, Tailwind CSS 4
- **Terminal:** `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`
- **Backend:** Express, WebSocket (`ws`), `ssh2`, `multer`
- **Runtime:** Node.js

## Project Structure

```
web/          Frontend (index.html + src/)
server/       Backend routes, SSH session manager, AI module
  ai/         Provider client, agent loop, tools, grading, config
  routes/     HTTP routes (auth, ssh, config, file, ai)
conf/         Default config and example env
dist/         Production build output
Dockerfile / docker-compose.yaml
```

## Getting Started

### Requirements

- Node.js 18+
- A reachable SSH server

### Install

```bash
npm install
```

### Development

```bash
npm run dev
```

Listens on `http://0.0.0.0:3000` by default.

### Production Build

```bash
npm run build
npm run start
```

### Docker Compose

```yaml
services:
  webssh2:
    build:
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
      WEBSSH_MASTER_KEY: "${WEBSSH_MASTER_KEY:-replace-with-a-high-entropy-secret}"
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

For custom secrets and ports, copy `conf/.env.example` to `.env` and adjust.

## Configuration

Source defaults:

- `conf/webssh_config.json` — application defaults (theme, font size, session keep-alive, login protection)
- `conf/.env.example` — example environment variables

Runtime data locations:

- **Local run:**
  - Config: `conf/webssh_config.json`
  - SSH credentials: `ssh_secrets.json` (project root)
  - AI provider key: `ai_secrets.json` (encrypted)
  - Master key: `.webssh_master_key` (project root)
- **Docker Compose:**
  - Config, credentials, and master key all live under the `/app/data` volume, controlled by `WEBSSH_DATA_DIR` and `WEBSSH_CONFIG_DIR`.

Commonly configurable options:

- `theme`, `fontSize`, `timeout`, `savePass`
- `httpsEnforced`, `originCheckEnabled`
- `authEnabled`, `authUsername`, `authPassword`

### AI Provider

AI configuration is split in two places:

- Non-secret settings (`enabled`, `baseUrl`, `model`, token budgets, `redactPrivateIp`, `commandWhitelist`) go into `conf/webssh_config.json`.
- The API key goes into an encrypted `<data dir>/ai_secrets.json`.

Environment variables override the stored config, so you can avoid persisting secrets in containers:

- `WEBSSH_AI_BASE_URL`
- `WEBSSH_AI_MODEL`
- `WEBSSH_AI_API_KEY`

Agent behavior is bounded: a configurable max step count per request (hard-capped server-side), output truncation limits per tool, and an optional command allowlist for skipping approval on known-safe binaries.

## Use Cases

- Internal ops panels
- Lightweight bastion / jump-host frontends
- Remote access to dev and test environments
- Handling server issues from a phone
- Teams that want terminal and file operations in one web tool
- Assisted diagnosis and command drafting with an AI that still asks before doing anything destructive

## Security Notes

- SSH host credentials are encrypted with AES-256-GCM. The master key is read from `WEBSSH_MASTER_KEY`; in development, a local `.webssh_master_key` (mode `0600`) is generated if unset.
- `/ssh/list` returns only host metadata and `hasCredential` — never passwords, private keys, or passphrases.
- New SSH connections create a backend session over HTTP; the WebSocket URL does not carry SSH credentials.
- The AI provider key is stored separately from normal config and is never returned to the client (`hasKey` boolean only).
- **The agent cannot bypass approval on its own.** Risk levels come from server-side grading, not the model. `dangerous` actions always require explicit confirmation.
- Production must set `WEBSSH_MASTER_KEY` and use HTTPS/WSS. Do not rely on an auto-generated local key for multi-instance deployments.
- Do not commit `ssh_secrets.json` / `ai_secrets.json`; they are runtime secrets, not source config.
- The application login password is stored as a `scrypt` hash; `/config` never returns the password or its hash. Set `WEBSSH_AUTH_SECRET` in production.
- When `httpsEnforced` is on, HTTP and `ws://` requests are rejected; reverse proxies must pass `X-Forwarded-Proto: https` correctly. `WEBSSH_REQUIRE_HTTPS=true` is the fallback when the config value is unset.
- Login attempts are rate-limited to 5 failures per source IP per 15 minutes, with a 15-minute lockout.
- When `originCheckEnabled` is on, HTTP writes and WebSocket upgrades validate the browser `Origin`; configure allowed origins via `WEBSSH_ALLOWED_ORIGINS`.
- Application-level login is a first layer of access control, not a substitute for network isolation, reverse-proxy auth, or enterprise auditing.

## Scripts

```bash
npm run dev     # start dev server
npm run build   # build frontend + bundle server
npm run start   # run production build
npm run lint    # type-check (tsc --noEmit)
```
