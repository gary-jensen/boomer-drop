import { database } from "@/lib/room-store";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await database().query("SELECT 1 FROM rooms LIMIT 1");
    return Response.json({ ok: true });
  } catch { return Response.json({ ok: false }, { status: 503 }); }
}
