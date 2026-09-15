import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { readSignals, roomExists, writeSignal } from "../lib/room-store";
import { validRole, validRoomId, validSignal, type SignalRole } from "../lib/signaling";

export function attachSignaling(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  const peers = new Map<WebSocket, { roomId: string; role: SignalRole; cursor: number; busy: boolean; alive: boolean }>();
  async function flush(ws: WebSocket) {
    const peer = peers.get(ws);
    if (!peer || peer.busy || ws.readyState !== WebSocket.OPEN) return;
    peer.busy = true;
    try {
      if (ws.bufferedAmount > 1024 * 1024) { ws.close(1013, "Slow receiver"); return; }
      const batch = await readSignals(peer.roomId, peer.role, peer.cursor);
      if (!batch) { ws.close(4004, "Room expired"); return; }
      if (batch.messages.length && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "batch", ...batch }));
        peer.cursor = batch.nextIndex;
      }
    } catch { ws.close(1011, "Signaling unavailable"); }
    finally { peer.busy = false; }
  }
  // Catches HTTP fallback writes and writes made by another process, too.
  const delivery = setInterval(() => { for (const ws of peers.keys()) void flush(ws); }, 1000);
  const heartbeat = setInterval(() => {
    for (const [ws, peer] of peers) {
      if (!peer.alive) { ws.terminate(); continue; }
      peer.alive = false;
      ws.ping();
    }
  }, 30000);
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") return; // Next.js owns its dev/HMR upgrades.
    socket.on("error", () => {});
    const reject = (status: number) => {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const roomId = url.searchParams.get("roomId") ?? "";
    const role = url.searchParams.get("role");
    const cursor = Number(url.searchParams.get("since") ?? "0");
    let originAllowed = false;
    try {
      const origin = new URL(request.headers.origin ?? "");
      originAllowed = process.env.BOOMER_DROP_PUBLIC_ORIGIN
        ? origin.origin === new URL(process.env.BOOMER_DROP_PUBLIC_ORIGIN).origin
        : origin.host === request.headers.host;
    } catch { /* Missing/invalid browser origin. */ }
    if (!originAllowed) { reject(403); return; }
    if (!validRoomId(roomId) || !validRole(role) || !Number.isSafeInteger(cursor) || cursor < 0) {
      reject(400); return;
    }
    void roomExists(roomId).then((exists) => {
      if (!exists) { reject(404); return; }
      if (socket.destroyed) return;
      wss.handleUpgrade(request, socket, head, (ws) => {
        peers.set(ws, { roomId, role, cursor, busy: false, alive: true });
        ws.on("error", () => {});
        ws.on("close", () => peers.delete(ws));
        ws.on("pong", () => { const peer = peers.get(ws); if (peer) peer.alive = true; });
        let chain = Promise.resolve();
        let pending = 0;
        ws.on("message", (raw, binary) => {
          if (binary || ++pending > 128) { ws.close(1008, "Invalid or excessive signals"); return; }
          chain = chain.then(async () => {
            let envelope;
            try { envelope = JSON.parse(raw.toString()); } catch { ws.close(1008, "Invalid JSON"); return; }
            if (!envelope || envelope.type !== "send" || !Number.isSafeInteger(envelope.id) || !validSignal(envelope.message)) {
              ws.close(1008, "Invalid signal"); return;
            }
            const ok = await writeSignal(roomId, role, envelope.message);
            if (!ok) { ws.close(4004, "Room expired"); return; }
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ack", id: envelope.id }));
            for (const [target, peer] of peers) {
              if (peer.roomId === roomId && peer.role !== role) void flush(target);
            }
          }).catch(() => ws.close(1011, "Signaling unavailable")).finally(() => { pending--; });
        });
        ws.send(JSON.stringify({ type: "ready" }));
        void flush(ws);
      });
    }).catch(() => reject(503));
  });
  return () => {
    clearInterval(delivery);
    clearInterval(heartbeat);
    for (const ws of peers.keys()) ws.close(1001, "Server restarting");
    wss.close();
  };
}
