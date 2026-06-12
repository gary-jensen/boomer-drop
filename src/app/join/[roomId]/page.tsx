"use client";

import { use } from "react";
import { getRoomCode } from "@/lib/room-code";
import { PageShell } from "@/components/PageShell";
import { TransferPanel } from "@/components/TransferPanel";

interface JoinPageProps {
  params: Promise<{ roomId: string }>;
}

export default function JoinPage({ params }: JoinPageProps) {
  const { roomId } = use(params);
  const code = getRoomCode(roomId);

  return (
    <PageShell variant="guest">
      <TransferPanel role="guest" roomId={roomId} code={code} />
    </PageShell>
  );
}
