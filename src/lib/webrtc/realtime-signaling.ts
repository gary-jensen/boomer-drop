import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { SignalMessage, SignalRole } from "@/lib/signaling";

const BROADCAST_EVENT = "signal";

interface SignalEnvelope {
  role: SignalRole;
  message: SignalMessage;
}

export interface RealtimeSignalingOptions {
  roomId: string;
  role: SignalRole;
  onMessage: (message: SignalMessage) => void;
  onDebug?: (message: string) => void;
}

export class RealtimeSignaling {
  private readonly options: RealtimeSignalingOptions;
  private channel: RealtimeChannel | null = null;
  private subscribed = false;
  private destroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RealtimeSignalingOptions) {
    this.options = options;

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.scheduleReconnect);
    }
  }

  private debug(message: string): void {
    this.options.onDebug?.(message);
  }

  private onVisibilityChange = (): void => {
    if (document.visibilityState === "visible") {
      void this.ensureConnected();
    }
  };

  private scheduleReconnect = (): void => {
    if (this.destroyed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected();
    }, 500);
  };

  async connect(): Promise<boolean> {
    if (this.destroyed) return false;

    const supabase = getSupabaseClient();
    if (!supabase) {
      this.debug("Supabase Realtime not configured");
      return false;
    }

    if (this.channel && this.subscribed) return true;

    this.teardownChannel();

    const channelName = `signal:${this.options.roomId}`;
    this.debug(`realtime: joining ${channelName}`);

    this.channel = supabase.channel(channelName, {
      config: { broadcast: { self: false } },
    });

    this.channel.on(
      "broadcast",
      { event: BROADCAST_EVENT },
      ({ payload }) => {
        const envelope = payload as SignalEnvelope;
        if (!envelope?.message || envelope.role === this.options.role) return;
        void this.options.onMessage(envelope.message);
      }
    );

    return new Promise((resolve) => {
      this.channel!.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          this.subscribed = true;
          this.debug("realtime: connected");
          resolve(true);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          this.debug(`realtime: ${status}`);
          this.subscribed = false;
          this.scheduleReconnect();
          resolve(false);
        } else if (status === "CLOSED") {
          this.subscribed = false;
          if (!this.destroyed) this.scheduleReconnect();
          resolve(false);
        }
      });
    });
  }

  async ensureConnected(): Promise<void> {
    if (this.destroyed) return;
    if (this.channel && this.subscribed) return;
    await this.connect();
  }

  async send(message: SignalMessage): Promise<boolean> {
    if (this.destroyed) return false;

    if (!this.channel || !this.subscribed) {
      const ok = await this.connect();
      if (!ok) return false;
    }

    const envelope: SignalEnvelope = {
      role: this.options.role,
      message,
    };

    const result = await this.channel!.send({
      type: "broadcast",
      event: BROADCAST_EVENT,
      payload: envelope,
    });

    if (result !== "ok") {
      this.debug(`realtime send failed: ${result}`);
      this.subscribed = false;
      this.scheduleReconnect();
      return false;
    }

    return true;
  }

  private teardownChannel(): void {
    if (this.channel) {
      void this.channel.unsubscribe();
      this.channel = null;
    }
    this.subscribed = false;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("online", this.scheduleReconnect);
    this.teardownChannel();
  }
}
