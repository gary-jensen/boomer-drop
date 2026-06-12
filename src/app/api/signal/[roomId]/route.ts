import { expire, get, lrange, rpush } from "@/lib/kv";
import type { SignalMessage, SignalRole } from "@/lib/signaling";
import {
  ROOM_TTL,
  otherRole,
  queueKey,
  roomMetaKey,
} from "@/lib/signaling";

interface RouteContext {
  params: Promise<{ roomId: string }>;
}

async function roomExists(roomId: string): Promise<boolean> {
  const meta = await get(roomMetaKey(roomId));
  return meta !== null;
}

async function touchRoom(roomId: string): Promise<void> {
  await expire(roomMetaKey(roomId), ROOM_TTL);
  await expire(queueKey(roomId, "host"), ROOM_TTL);
  await expire(queueKey(roomId, "guest"), ROOM_TTL);
}

export async function GET(request: Request, context: RouteContext) {
  const { roomId } = await context.params;
  const url = new URL(request.url);
  const role = url.searchParams.get("role") as SignalRole | null;
  const since = Number(url.searchParams.get("since") ?? "0");

  if (!role || (role !== "host" && role !== "guest")) {
    return Response.json({ error: "Invalid role" }, { status: 400 });
  }

  if (!(await roomExists(roomId))) {
    return Response.json({ error: "Room not found" }, { status: 404 });
  }

  const rawMessages = await lrange(queueKey(roomId, role), since, -1);
  const messages = rawMessages.map(
    (raw) => JSON.parse(raw) as SignalMessage
  );
  const nextIndex = since + messages.length;

  await touchRoom(roomId);

  return Response.json({ messages, nextIndex });
}

// SDP + ICE candidates are small; 64 KB is generous headroom.
const MAX_SIGNAL_BODY_BYTES = 64 * 1024;

export async function POST(request: Request, context: RouteContext) {
  const { roomId } = await context.params;

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_SIGNAL_BODY_BYTES) {
    return Response.json({ error: "Payload too large" }, { status: 413 });
  }

  if (!(await roomExists(roomId))) {
    return Response.json({ error: "Room not found" }, { status: 404 });
  }

  let body: { role?: SignalRole; message?: SignalMessage };
  try {
    const text = await request.text();
    if (text.length > MAX_SIGNAL_BODY_BYTES) {
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }
    body = JSON.parse(text) as { role?: SignalRole; message?: SignalMessage };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    !body.role ||
    (body.role !== "host" && body.role !== "guest") ||
    !body.message
  ) {
    return Response.json({ error: "Invalid payload" }, { status: 400 });
  }

  const targetKey = queueKey(roomId, otherRole(body.role));
  await rpush(targetKey, JSON.stringify(body.message));
  await touchRoom(roomId);

  return Response.json({ ok: true });
}
