import type { ConnectionState } from "@/lib/webrtc/transfer";

const STATUS: Record<
  ConnectionState,
  { label: string; className: string; blink: boolean }
> = {
  idle: {
    label: "Starting up",
    className: "bg-ink/5 text-ink-soft",
    blink: true,
  },
  waiting: {
    label: "Waiting for other device",
    className: "bg-warn/10 text-warn",
    blink: true,
  },
  connecting: {
    label: "Connecting",
    className: "bg-accent/10 text-accent",
    blink: true,
  },
  connected: {
    label: "Connected",
    className: "bg-ok/10 text-ok",
    blink: false,
  },
  reconnecting: {
    label: "Reconnecting",
    className: "bg-warn/10 text-warn",
    blink: true,
  },
  failed: {
    label: "Connection failed",
    className: "bg-error/10 text-error",
    blink: false,
  },
  closed: {
    label: "Disconnected",
    className: "bg-ink/5 text-ink-soft",
    blink: false,
  },
};

interface ConnectionStatusProps {
  status: ConnectionState;
}

export function ConnectionStatus({ status }: ConnectionStatusProps) {
  const config = STATUS[status];

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold sm:text-[13px] ${config.className}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full bg-current ${
          config.blink ? "lamp-blink" : ""
        }`}
        aria-hidden
      />
      {config.label}
    </span>
  );
}
