import { createServer } from "node:http";
import next from "next";
import { loadEnvConfig } from "@next/env";
import { database, purgeExpiredRooms } from "./src/lib/room-store";
import { attachSignaling } from "./src/server/websocket";

async function main() {
  const dev = process.env.NODE_ENV !== "production";
  loadEnvConfig(process.cwd(), dev);
  const port = Number(process.env.PORT ?? 3000);
  const hostname = process.env.HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  await database().query("SELECT 1 FROM rooms LIMIT 1");
  await purgeExpiredRooms();
  const app = next({ dev, hostname, port });
  await app.prepare();
  const handle = app.getRequestHandler();
  const upgrade = app.getUpgradeHandler();
  const server = createServer((req, res) => { void handle(req, res); });
  const closeSignaling = attachSignaling(server);
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") void upgrade(req, socket, head);
  });
  const cleanup = setInterval(() => {
    void purgeExpiredRooms().catch(() => console.error("Room cleanup failed"));
  }, 60000);
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(cleanup);
    closeSignaling();
    server.close(() => { void database().end().then(() => app.close()).then(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  server.listen(port, hostname, () => console.log(`BoomerDrop listening on http://${hostname}:${port}`));
}
main().catch(() => {
  console.error("BoomerDrop startup failed. Check DATABASE_URL, migrations, and PORT.");
  process.exit(1);
});
