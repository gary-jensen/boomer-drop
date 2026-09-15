import { loadEnvConfig } from "@next/env";
import { readFile } from "node:fs/promises";
import { database } from "../src/lib/room-store";
async function main() {
  loadEnvConfig(process.cwd());
  const pool = database();
  try {
    await pool.query(await readFile("migrations/001_rooms.sql", "utf8"));
    console.log("Database schema ready");
  } finally { await pool.end(); }
}
main().catch(() => { console.error("Database migration failed"); process.exitCode = 1; });
