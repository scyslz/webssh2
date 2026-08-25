import { wsUrl } from './api';

type SftpRequest = { id: string; type: 'list'|'read'|'write'|'mkdir'|'delete'|'ping'; path?: string; content?: string; isDir?: boolean; ts?: number };
type SftpResponse = { id?: string; type: string; data?: any; msg?: string; ts?: number };

export class SftpWSClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (v:any)=>void; reject: (e:any)=>void; timer: number }>();
  private pingTimer: number | null = null;
  private seq = 0;

  constructor(private sessionId: string) {}

  connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const url = wsUrl('/sftp', `sessionId=${encodeURIComponent(this.sessionId)}`);
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        this.startPing();
        resolve();
      };
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as SftpResponse & { id?: string };
          if (data.type === 'pong') return;
          if (data.id && this.pending.has(data.id)) {
            const h = this.pending.get(data.id)!;
            clearTimeout(h.timer);
            this.pending.delete(data.id);
            if (data.type === 'error') h.reject(new Error(data.msg || 'sftp error'));
            else h.resolve(data.data ?? data);
          }
        } catch {}
      };
      ws.onclose = () => { this.cleanupPending('SFTP WS closed'); this.stopPing(); };
      ws.onerror = () => { this.cleanupPending('SFTP WS error'); };
      setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) reject(new Error('SFTP WS connect timeout')); }, 8000);
    });
  }

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    }, 20000);
  }
  private stopPing() { if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; } }

  private cleanupPending(msg: string) {
    for (const [,h] of this.pending) { clearTimeout(h.timer); h.reject(new Error(msg)); }
    this.pending.clear();
  }

  request(type: SftpRequest['type'], payload: any = {}): Promise<any> {
    const id = `${Date.now()}-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => { this.pending.delete(id); reject(new Error('SFTP timeout')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      const msg = JSON.stringify({ id, type, ...payload });
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(msg);
      else { clearTimeout(timer); this.pending.delete(id); reject(new Error('SFTP WS not open')); }
    });
  }

  close() {
    this.stopPing();
    this.cleanupPending('closed');
    if (this.ws) { try { this.ws.close(1000); } catch {} this.ws = null; }
  }
}
