import { readSignals, writeSignal } from "@/lib/room-store";
import { validRole, validRoomId, validSignal } from "@/lib/signaling";
interface RouteContext { params: Promise<{ roomId: string }> }
export async function GET(request: Request, context: RouteContext) {
  const { roomId } = await context.params;
  const url = new URL(request.url);
  const role = url.searchParams.get("role");
  const since = Number(url.searchParams.get("since") ?? "0");
  if (!validRoomId(roomId) || !validRole(role) || !Number.isSafeInteger(since) || since < 0) {
    return Response.json({ error: "Invalid room, role or cursor" }, { status: 400 });
  }
  const batch = await readSignals(roomId, role, since);
  return batch ? Response.json(batch, { headers: { "Cache-Control": "no-store" } })
    : Response.json({ error: "Room not found" }, { status: 404 });
}
export async function POST(request: Request, context: RouteContext) {
  const { roomId } = await context.params;
  if (!validRoomId(roomId)) return Response.json({ error: "Invalid room" }, { status: 400 });
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "Missing body" }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) {
      await reader.cancel();
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }
    chunks.push(value);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body || !validRole(body.role) || !validSignal(body.message)) {
    return Response.json({ error: "Invalid signal" }, { status: 400 });
  }
  const ok = await writeSignal(roomId, body.role, body.message);
  return Response.json(ok ? { ok } : { error: "Room not found" }, { status: ok ? 200 : 404 });
}
