import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { loadEnvConfig } from "@next/env";
import { WebSocket } from "ws";
import { attachSignaling } from "../src/server/websocket";
import { createRoom, database, readSignals, writeSignal, roomExists, purgeExpiredRooms } from "../src/lib/room-store";
import { validSignal, validRoomId } from "../src/lib/signaling";

loadEnvConfig(process.cwd());
const rooms: string[] = [];
const sockets: WebSocket[] = [];
const server = createServer();
let closeSignaling: () => void;
let origin: string;
let endpoint: string;
let previousOrigin: string | undefined;
async function room() {
  const id = randomUUID(); rooms.push(id); await createRoom(id, "TEST"); return id;
}
async function peer(id: string, role: string, since = 0) {
  const ws = new WebSocket(`${endpoint}?roomId=${id}&role=${role}&since=${since}`, { origin });
  sockets.push(ws);
  const inbox: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  ws.on("message", raw => inbox.push(JSON.parse(raw.toString())));
  await once(ws, "open");
  async function receive(type: string) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const index = inbox.findIndex(item => item.type === type);
      if (index >= 0) return inbox.splice(index, 1)[0];
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${type}`);
  }
  await receive("ready");
  return { ws, receive };
}
before(async () => {
  assert.ok(process.env.DATABASE_URL, "Run migrations and set DATABASE_URL before integration tests");
  previousOrigin = process.env.BOOMER_DROP_PUBLIC_ORIGIN;
  delete process.env.BOOMER_DROP_PUBLIC_ORIGIN;
  closeSignaling = attachSignaling(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  endpoint = origin.replace("http:", "ws:") + "/ws";
});
after(async () => {
  for (const ws of sockets) ws.terminate();
  closeSignaling?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (rooms.length) await database().query("DELETE FROM rooms WHERE id = ANY($1::uuid[])", [rooms]);
  await database().end();
  if (previousOrigin) process.env.BOOMER_DROP_PUBLIC_ORIGIN = previousOrigin;
});
test("validates room identifiers and signaling payloads", () => {
  assert.equal(validRoomId("bad-room"), false);
  assert.equal(validSignal({ type: "offer", sdp: { type: "answer", sdp: "x" } }), false);
  assert.equal(validSignal({ type: "ice", candidate: { candidate: "candidate:1" } }), true);
  assert.equal(validSignal(null), false);
});
test("WebSocket delivers and acknowledges messages, isolates rooms and resumes using a cursor", async () => {
  const id = await room();
  const other = await room();
  const host = await peer(id, "host");
  const guest = await peer(id, "guest");
  guest.ws.send(JSON.stringify({ type: "send", id: 1, message: { type: "guest-ready" } }));
  assert.equal((await guest.receive("ack")).id, 1);
  const first = await host.receive("batch");
  assert.deepEqual(first.messages, [{ type: "guest-ready" }]);
  assert.deepEqual((await readSignals(other, "host", 0))?.messages, []);
  assert.deepEqual((await readSignals(id, "guest", 0))?.messages, []);
  host.ws.close();
  await once(host.ws, "close");
  // The HTTP fallback uses this same writer, including while the peer is offline.
  await writeSignal(id, "guest", { type: "ice", candidate: { candidate: "candidate:resume" } });
  const resumed = await peer(id, "host", first.nextIndex);
  const next = await resumed.receive("batch");
  assert.equal(next.messages.length, 1);
  assert.equal(next.messages[0].candidate.candidate, "candidate:resume");
  assert.ok(next.nextIndex > first.nextIndex);
});
test("concurrent writes are retained in cursor order", async () => {
  const id = await room();
  await Promise.all(Array.from({ length: 20 }, (_, n) => writeSignal(id, "guest", {
    type: "ice", candidate: { candidate: `candidate:${n}` },
  })));
  const batch = await readSignals(id, "host", 0);
  assert.equal(batch?.messages.length, 20);
  assert.equal(new Set(batch?.messages.map(m => m.candidate?.candidate)).size, 20);
  assert.deepEqual((await readSignals(id, "host", batch!.nextIndex))?.messages, []);
});
test("expired rooms reject writes and reads, and cleanup cascades to signals", async () => {
  const id = await room();
  await writeSignal(id, "host", { type: "guest-ready" });
  await database().query("UPDATE rooms SET expires_at = now() - interval '1 second' WHERE id = $1", [id]);
  assert.equal(await roomExists(id), false);
  assert.equal(await readSignals(id, "guest", 0), null);
  assert.equal(await writeSignal(id, "host", { type: "guest-ready" }), false);
  await purgeExpiredRooms();
  assert.equal((await database().query("SELECT 1 FROM signals WHERE room_id = $1", [id])).rowCount, 0);
});
test("rejects foreign WebSocket origins and unknown rooms", async () => {
  const id = await room();
  for (const [url, requestOrigin, status] of [
    [`${endpoint}?roomId=${id}&role=host`, "https://unrelated.example", 403],
    [`${endpoint}?roomId=${randomUUID()}&role=host`, origin, 404],
  ] as const) {
    const ws = new WebSocket(url, { origin: requestOrigin });
    ws.on("error", () => {});
    const [, response] = await once(ws, "unexpected-response");
    assert.equal(response.statusCode, status);
    response.resume();
    ws.terminate();
  }
});
