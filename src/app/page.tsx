"use client";

import { useEffect, useState } from "react";
import { ensureDesktopLocalhost } from "@/lib/client-network";
import { PageShell } from "@/components/PageShell";
import { TransferPanel } from "@/components/TransferPanel";

interface RoomInfo {
  roomId: string;
  joinUrl: string;
  code: string;
}

export default function Home() {
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ensureDesktopLocalhost()) return;

    let cancelled = false;

    async function createRoom() {
      try {
        const response = await fetch("/api/room", { method: "POST" });
        if (!response.ok) throw new Error("Could not create room");
        const data = (await response.json()) as RoomInfo;
        if (!cancelled) setRoom(data);
      } catch {
        if (!cancelled) {
          setError("Could not start a session. Refresh the page.");
        }
      }
    }

    void createRoom();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PageShell variant="host">
      {error ? (
        <p className="panel !border-error/20 bg-error/5 px-5 py-4 text-center text-sm font-medium text-error">
          {error}
        </p>
      ) : null}

      {!room && !error ? (
        <div className="panel flex flex-col items-center gap-4 px-6 py-20">
          <div
            className="spin-slow h-8 w-8 rounded-full border-2 border-line border-t-ink"
            aria-hidden
          />
          <p className="text-sm text-ink-soft">Setting things up…</p>
        </div>
      ) : null}

      {room ? (
        <TransferPanel
          role="host"
          roomId={room.roomId}
          code={room.code}
          joinUrl={room.joinUrl}
        />
      ) : null}
    </PageShell>
  );
}
