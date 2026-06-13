"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTransferSession,
  type ConnectionState,
  type ReceivedFile,
  type TransferProgress,
} from "@/lib/webrtc/transfer";
import {
  notifyFileReceived,
  notificationsSupported,
  requestNotificationPermission,
} from "@/lib/notifications";
import {
  getAutoDownloadEnabled,
  setAutoDownloadEnabled,
} from "@/lib/transfer-preferences";
import { acquireWakeLock, releaseWakeLock } from "@/lib/wake-lock";
import { ConnectionStatus } from "./ConnectionStatus";
import { FilePicker } from "./FilePicker";
import { QRDisplay } from "./QRDisplay";
import { VerificationBadge } from "./VerificationBadge";

const SHOW_TRANSFER_LOG = false;

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

interface TransferPanelProps {
  role: "host" | "guest";
  roomId: string;
  code: string;
  joinUrl?: string;
}

function hintText(
  status: ConnectionState,
  role: "host" | "guest"
): string | null {
  if (status === "failed") {
    return "Could not connect. Check your network, refresh, and scan the QR code again.";
  }
  if (status === "reconnecting") {
    return "Connection dropped — reconnecting…";
  }
  if (status === "connected") return null;
  if (role === "host") {
    return "Confirm the code on the other device matches the one shown here.";
  }
  return "Linking to the other device…";
}

export function TransferPanel({
  role,
  roomId,
  code,
  joinUrl,
}: TransferPanelProps) {
  const [status, setStatus] = useState<ConnectionState>("idle");
  const [sessionKey, setSessionKey] = useState(0);
  const [sending, setSending] = useState(false);
  const [transferActive, setTransferActive] = useState(false);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [received, setReceived] = useState<ReceivedFile[]>([]);
  const [sent, setSent] = useState<{ name: string; size: number }[]>([]);
  const [receiveError, setReceiveError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [autoDownload, setAutoDownload] = useState(() => getAutoDownloadEnabled());
  const sessionRef = useRef<ReturnType<typeof createTransferSession> | null>(
    null
  );

  const addDebug = useCallback((message: string) => {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    setDebugLog((prev) => [...prev.slice(-19), `${ts}  ${message}`]);
  }, []);

  const handleFileReceived = useCallback(
    (file: ReceivedFile) => {
      setReceived((prev) => [...prev, file]);
      setProgress(null);
      setReceiveError(null);

      if (autoDownload) {
        triggerDownload(file.blob, file.name);
      }
      notifyFileReceived(file.name);
    },
    [autoDownload]
  );

  useEffect(() => {
    let active = true;

    const session = createTransferSession({
      roomId,
      role,
      onStatus: (next) => {
        if (active) setStatus(next);
      },
      onProgress: (value) => {
        if (active) setProgress(value);
      },
      onFileReceived: (file) => {
        if (!active) return;
        handleFileReceived(file);
      },
      onReceiveError: (message) => {
        if (!active) return;
        setReceiveError(message);
        setProgress(null);
      },
      onFileSent: (file) => {
        if (!active) return;
        setSent((prev) => [...prev, file]);
      },
      onTransferActive: (activeTransfer) => {
        if (active) setTransferActive(activeTransfer);
      },
      onDebug: (message) => {
        if (active) addDebug(message);
      },
    });

    sessionRef.current = session;
    void session.init();

    return () => {
      active = false;
      session.destroy();
      sessionRef.current = null;
    };
  }, [roomId, role, sessionKey, addDebug, handleFileReceived]);

  useEffect(() => {
    if (sending || transferActive || progress) {
      void acquireWakeLock();
      return () => {
        void releaseWakeLock();
      };
    }
    void releaseWakeLock();
  }, [sending, transferActive, progress]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (sending || transferActive) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [sending, transferActive]);

  const handleSend = useCallback(async (files: File[]) => {
    if (!sessionRef.current) return;
    setSending(true);
    setSendError(null);
    try {
      await sessionRef.current.sendFiles(files);
    } catch (error) {
      setSendError(
        error instanceof Error
          ? error.message
          : "Something went wrong while sending. Please try again."
      );
    } finally {
      setSending(false);
      setProgress(null);
    }
  }, []);

  const handleRetry = useCallback(() => {
    setDebugLog([]);
    setSent([]);
    setReceiveError(null);
    setSendError(null);
    setStatus("idle");
    setSessionKey((key) => key + 1);
  }, []);

  const toggleAutoDownload = useCallback(async (enabled: boolean) => {
    setAutoDownload(enabled);
    setAutoDownloadEnabled(enabled);
    if (enabled && notificationsSupported()) {
      await requestNotificationPermission();
    }
  }, []);

  const showTransferUi =
    status === "connected" || status === "reconnecting" || transferActive;
  const hint = hintText(status, role);

  return (
    <div className="flex flex-col gap-4">
      {!showTransferUi ? (
        <section className="panel relative">
          <div className="absolute top-4 right-4 z-10">
            <ConnectionStatus status={status} />
          </div>

          {role === "host" && joinUrl ? (
            <div className="grid md:grid-cols-2">
              <div className="border-b border-line md:border-b-0 md:border-r">
                <QRDisplay joinUrl={joinUrl} />
              </div>
              <VerificationBadge code={code} layout="side" />
            </div>
          ) : (
            <VerificationBadge code={code} layout="center" />
          )}

          {hint || status === "failed" ? (
            <div className="flex flex-col items-start gap-3 border-t border-line bg-[#fafbfc] px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              {hint ? <p className="text-sm text-ink-soft">{hint}</p> : null}
              {status === "failed" ? (
                <button
                  type="button"
                  onClick={handleRetry}
                  className="btn btn-secondary !min-h-[2.5rem] !w-auto shrink-0 px-5"
                >
                  Try again
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {showTransferUi ? (
        <section className="panel relative">
          <div className="absolute top-4 right-4 z-10">
            <ConnectionStatus status={status} />
          </div>
          <div className="p-4 sm:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xl font-semibold text-ink">
                Choose files to send
              </p>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  checked={autoDownload}
                  onChange={(e) => void toggleAutoDownload(e.target.checked)}
                  className="h-4 w-4 rounded border-line accent-accent"
                />
                Auto-download received files
              </label>
            </div>
            <FilePicker onSend={handleSend} sending={sending} />
          </div>
        </section>
      ) : null}

      {receiveError ? (
        <section className="panel border-error/20 bg-error/5 px-4 py-4 sm:px-6 sm:py-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-error">
            Receive failed
          </p>
          <p className="mt-1.5 text-sm text-ink-soft">{receiveError}</p>
        </section>
      ) : null}

      {sendError ? (
        <section className="panel border-error/20 bg-error/5 px-4 py-4 sm:px-6 sm:py-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-error">
            Send failed
          </p>
          <p className="mt-1.5 text-sm text-ink-soft">{sendError}</p>
        </section>
      ) : null}

      {progress ? (
        <section className="panel px-4 py-4 sm:px-6 sm:py-5">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate text-sm font-medium text-ink">
              {progress.fileName}
            </p>
            <p className="shrink-0 text-sm font-semibold text-accent">
              {Math.round((progress.sent / progress.total) * 100)}%
            </p>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-ink/8">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{
                width: `${Math.min(100, (progress.sent / progress.total) * 100)}%`,
              }}
            />
          </div>
        </section>
      ) : null}

      {sent.length > 0 ? (
        <section className="panel px-4 py-4 sm:px-6 sm:py-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-ok">
            Sent
          </p>
          <ul className="mt-3 space-y-2.5">
            {sent.map((file) => (
              <li
                key={`${file.name}-${file.size}`}
                className="flex items-center gap-2.5 text-sm"
              >
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ok/10 text-[10px] font-bold text-ok"
                  aria-hidden
                >
                  ✓
                </span>
                <span className="truncate font-medium text-ink">
                  {file.name}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {received.length > 0 ? (
        <section className="panel px-4 py-4 sm:px-6 sm:py-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-ok">
              Received
            </p>
            {received.length > 1 ? (
              <button
                type="button"
                onClick={() =>
                  received.forEach((f) => triggerDownload(f.blob, f.name))
                }
                className="text-xs font-semibold text-accent hover:underline"
              >
                Download all
              </button>
            ) : null}
          </div>
          <ul className="mt-3 divide-y divide-line">
            {received.map((file) => (
              <li
                key={`${file.name}-${file.size}`}
                className="flex items-center gap-3 py-2.5 text-sm"
              >
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ok/10 text-[10px] font-bold text-ok"
                  aria-hidden
                >
                  ✓
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-ink">
                  {file.name}
                </span>
                <span className="shrink-0 text-xs text-ink-faint">
                  {formatFileSize(file.size)}
                </span>
                <button
                  type="button"
                  onClick={() => triggerDownload(file.blob, file.name)}
                  className="shrink-0 text-xs font-semibold text-accent hover:underline"
                >
                  Download
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {SHOW_TRANSFER_LOG && debugLog.length > 0 ? (
        <section className="panel overflow-hidden">
          <p className="border-b border-line px-4 py-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">
            Transfer log
          </p>
          <pre className="max-h-48 overflow-y-auto px-4 py-3 font-mono text-[11px] leading-relaxed text-ink-soft">
            {debugLog.join("\n")}
          </pre>
        </section>
      ) : null}
    </div>
  );
}
