import { Pool } from "pg";
import { ROOM_TTL, otherRole, type SignalMessage, type SignalRole } from "./signaling";

const shared = globalThis as typeof globalThis & { boomerPool?: Pool };
export function database(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (!shared.boomerPool) {
    shared.boomerPool = new Pool({ connectionString: process.env.DATABASE_URL,
      max: 10, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    shared.boomerPool.on("error", () => console.error("PostgreSQL connection error"));
  }
  return shared.boomerPool;
}
export async function createRoom(id: string, code: string): Promise<void> {
  await database().query(
    "INSERT INTO rooms (id, code, expires_at) VALUES ($1, $2, now() + $3 * interval '1 second')",
    [id, code, ROOM_TTL]);
}
export async function roomExists(id: string): Promise<boolean> {
  const result = await database().query("SELECT 1 FROM rooms WHERE id = $1 AND expires_at > now()", [id]);
  return result.rowCount === 1;
}
export async function readSignals(id: string, role: SignalRole, since: number) {
  const pool = database();
  const alive = await pool.query(
    "UPDATE rooms SET expires_at = now() + $2 * interval '1 second' WHERE id = $1 AND expires_at > now() RETURNING id",
    [id, ROOM_TTL]);
  if (!alive.rowCount) return null;
  const result = await pool.query<{ id: string; message: SignalMessage }>(
    "SELECT id, message FROM signals WHERE room_id = $1 AND recipient = $2 AND id > $3 ORDER BY id LIMIT 256",
    [id, role, since]);
  return { messages: result.rows.map((row) => row.message),
    nextIndex: result.rows.length ? Number(result.rows[result.rows.length - 1].id) : since };
}
export async function writeSignal(id: string, role: SignalRole, message: SignalMessage): Promise<boolean> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    // Serialize room writers before assigning sequence IDs, preventing readers
    // from advancing past an earlier message whose transaction is uncommitted.
    const room = await client.query(
      "UPDATE rooms SET expires_at = now() + $2 * interval '1 second' WHERE id = $1 AND expires_at > now() RETURNING id",
      [id, ROOM_TTL]);
    if (!room.rowCount) { await client.query("ROLLBACK"); return false; }
    const count = await client.query("SELECT count(*)::int AS count FROM signals WHERE room_id = $1", [id]);
    if (count.rows[0].count >= 4096) throw new Error("Room signaling limit reached");
    await client.query("INSERT INTO signals (room_id, recipient, message) VALUES ($1, $2, $3)",
      [id, otherRole(role), JSON.stringify(message)]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
export async function purgeExpiredRooms(): Promise<void> {
  await database().query("DELETE FROM rooms WHERE expires_at <= now()");
}
