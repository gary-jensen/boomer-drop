import { randomUUID } from "crypto";
import { set } from "@/lib/kv";
import { getJoinOrigin } from "@/lib/network";
import { getRoomCode } from "@/lib/room-code";
import { ROOM_TTL, roomMetaKey } from "@/lib/signaling";

export async function POST(request: Request) {
  const roomId = randomUUID();
  const origin = getJoinOrigin(request);
  const joinUrl = `${origin}/join/${roomId}`;
  const code = getRoomCode(roomId);

  await set(
    roomMetaKey(roomId),
    JSON.stringify({ createdAt: Date.now(), code }),
    { ex: ROOM_TTL }
  );

  return Response.json({ roomId, joinUrl, code });
}
