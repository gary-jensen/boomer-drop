import type { SignalMessage, SignalRole } from "@/lib/signaling";
import { isRealtimeConfigured } from "@/lib/supabase/client";
import { RealtimeSignaling } from "./realtime-signaling";

const POLL_INTERVAL_MS = 300;
const REALTIME_CONNECT_TIMEOUT_MS = 10_000;

export interface SignalingTransportOptions {
  roomId: string;
  role: SignalRole;
  onMessage: (message: SignalMessage) => void;
  onDebug?: (message: string) => void;
}

export interface SignalingTransport {
  connect(): Promise<boolean>;
  send(message: SignalMessage): Promise<boolean>;
  destroy(): void;
  mode: "realtime" | "poll";
}

class PollingSignaling implements SignalingTransport {
  readonly mode = "poll" as const;
  private readonly options: SignalingTransportOptions;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private messageIndex = 0;
  private destroyed = false;

  constructor(options: SignalingTransportOptions) {
    this.options = options;
  }

  private debug(message: string): void {
    this.options.onDebug?.(message);
  }

  async connect(): Promise<boolean> {
    if (this.destroyed) return false;
    this.debug("signaling: HTTP poll");
    this.startPolling();
    return true;
  }

  async send(message: SignalMessage): Promise<boolean> {
    if (this.destroyed) return false;
    try {
      const response = await fetch(`/api/signal/${this.options.roomId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: this.options.role, message }),
      });
      if (!response.ok) {
        this.debug(`signal POST failed (${response.status})`);
      }
      return response.ok;
    } catch {
      this.debug("signal POST error");
      return false;
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.destroyed) return;
    try {
      const response = await fetch(
        `/api/signal/${this.options.roomId}?role=${this.options.role}&since=${this.messageIndex}`
      );
      if (!response.ok) {
        if (response.status === 404) {
          this.debug("room expired — rescan QR on host");
        }
        return;
      }

      const data = (await response.json()) as {
        messages: SignalMessage[];
        nextIndex: number;
      };

      for (const message of data.messages) {
        await this.options.onMessage(message);
      }
      this.messageIndex = data.nextIndex;
    } catch {
      this.debug("poll error");
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

class RealtimeSignalingTransport implements SignalingTransport {
  readonly mode = "realtime" as const;
  private readonly inner: RealtimeSignaling;

  constructor(options: SignalingTransportOptions) {
    this.inner = new RealtimeSignaling(options);
  }

  connect(): Promise<boolean> {
    return this.inner.connect();
  }

  send(message: SignalMessage): Promise<boolean> {
    return this.inner.send(message);
  }

  destroy(): void {
    this.inner.destroy();
  }
}

function withTimeout(promise: Promise<boolean>, ms: number): Promise<boolean> {
  return Promise.race([
    promise,
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), ms);
    }),
  ]);
}

/** Prefer Supabase Realtime; fall back to HTTP polling if unavailable. */
export async function createSignalingTransport(
  options: SignalingTransportOptions
): Promise<SignalingTransport> {
  if (isRealtimeConfigured()) {
    const realtime = new RealtimeSignalingTransport(options);
    const ok = await withTimeout(realtime.connect(), REALTIME_CONNECT_TIMEOUT_MS);
    if (ok) {
      options.onDebug?.("signaling: Supabase Realtime");
      return realtime;
    }
    realtime.destroy();
    options.onDebug?.("signaling: Realtime failed — falling back to HTTP poll");
  } else {
    options.onDebug?.("signaling: Supabase not configured — using HTTP poll");
  }

  const polling = new PollingSignaling(options);
  await polling.connect();
  return polling;
}
