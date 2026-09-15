import { randomUUID } from "crypto";
import { createRoom } from "@/lib/room-store";
import { getJoinOrigin } from "@/lib/network";
import { getRoomCode } from "@/lib/room-code";

export async function POST(request: Request) {
  const roomId = randomUUID();
  const origin = getJoinOrigin(request);
  const joinUrl = `${origin}/join/${roomId}`;
  const code = getRoomCode(roomId);

  await createRoom(roomId, code);

  return Response.json({ roomId, joinUrl, code });
}
