import type { SignalMessage, SignalRole } from "@/lib/signaling";

export interface SignalingTransportOptions {
  roomId: string;
  role: SignalRole;
  onMessage: (message: SignalMessage) => void | Promise<void>;
  onDebug?: (message: string) => void;
}
export interface SignalingTransport {
  connect(): Promise<boolean>;
  send(message: SignalMessage): Promise<boolean>;
  destroy(): void;
  mode: "websocket" | "poll";
}

class VpsSignaling implements SignalingTransport {
  mode: "websocket" | "poll" = "websocket";
  private socket: WebSocket | null = null;
  private cursor = 0;
  private destroyed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;
  private incoming = Promise.resolve();
  private pending = new Map<number, (ok: boolean) => void>();
  private controller = new AbortController();
  constructor(private readonly options: SignalingTransportOptions) {}

  async connect(): Promise<boolean> {
    if (this.destroyed) return false;
    const url = new URL("/ws", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("roomId", this.options.roomId);
    url.searchParams.set("role", this.options.role);
    url.searchParams.set("since", String(this.cursor));
    const connected = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url);
      this.socket = ws;
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(ok);
      };
      const timeout = setTimeout(() => { finish(false); ws.close(); }, 5000);
      ws.onmessage = (event) => {
        if (this.destroyed) return;
        try {
          const data = JSON.parse(event.data);
          if (data.type === "ready") finish(true);
          else if (data.type === "ack") this.pending.get(data.id)?.(true);
          else if (data.type === "batch") {
            this.incoming = this.incoming.then(() => this.deliver(data)).catch(() => {
              this.options.onDebug?.("Could not handle signaling message");
            });
          }
        } catch { this.options.onDebug?.("Invalid signaling response"); }
      };
      ws.onerror = () => finish(false);
      ws.onclose = (event) => {
        finish(false);
        for (const done of this.pending.values()) done(false);
        if (event.code === 4004) {
          this.options.onDebug?.("Room expired — create a new room");
          this.destroy();
        } else if (!this.destroyed) this.startPolling();
      };
    });
    if (this.destroyed) return false;
    if (!connected) {
      this.socket?.close();
      this.startPolling();
    } else this.options.onDebug?.("signaling: VPS WebSocket");
    return true;
  }

  private async deliver(data: { messages: SignalMessage[]; nextIndex: number }) {
    if (this.destroyed || data.nextIndex <= this.cursor) return;
    for (const message of data.messages) {
      if (this.destroyed) return;
      await this.options.onMessage(message);
    }
    this.cursor = data.nextIndex;
  }

  private startPolling() {
    if (this.destroyed || this.mode === "poll") return;
    this.mode = "poll";
    this.options.onDebug?.("signaling: HTTP fallback");
    // Wait for queued WebSocket batches before reading the same durable queue.
    this.incoming = this.incoming.then(() => this.poll());
  }
  private async poll(): Promise<void> {
    if (this.destroyed) return;
    try {
      const response = await fetch(`/api/signal/${this.options.roomId}?role=${this.options.role}&since=${this.cursor}`,
        { cache: "no-store", signal: this.controller.signal });
      if (response.status === 404) {
        this.options.onDebug?.("Room expired — create a new room");
        this.destroy();
        return;
      }
      if (response.ok) await this.deliver(await response.json());
    } catch { if (!this.destroyed) this.options.onDebug?.("Signaling reconnecting"); }
    if (!this.destroyed) this.timer = setTimeout(() => { void this.poll(); }, 500);
  }

  async send(message: SignalMessage): Promise<boolean> {
    if (this.destroyed) return false;
    if (this.mode === "websocket" && this.socket?.readyState === WebSocket.OPEN) {
      const ws = this.socket;
      const id = ++this.sequence;
      return new Promise((resolve) => {
        const timeout = setTimeout(() => { done(false); ws.close(); }, 5000);
        const done = (ok: boolean) => {
          clearTimeout(timeout);
          this.pending.delete(id);
          resolve(ok);
        };
        this.pending.set(id, done);
        try { ws.send(JSON.stringify({ type: "send", id, message })); }
        catch { done(false); ws.close(); }
      });
    }
    try {
      const response = await fetch(`/api/signal/${this.options.roomId}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: this.options.role, message }), signal: this.controller.signal,
      });
      return response.ok;
    } catch { return false; }
  }
  destroy(): void {
    this.destroyed = true;
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    for (const done of this.pending.values()) done(false);
    this.socket?.close();
  }
}
export async function createSignalingTransport(options: SignalingTransportOptions): Promise<SignalingTransport> {
  const transport = new VpsSignaling(options);
  await transport.connect();
  return transport;
}
