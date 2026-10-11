import { db } from "@/db";
import { sql } from "drizzle-orm";
import { binaries } from "@/lib/ffmpeg";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return Response.json({
      ok: true,
      db: true,
      ffmpeg: Boolean(binaries()),
      time: new Date().toISOString(),
    });
  } catch {
    return Response.json({ ok: false }, { status: 500 });
  }
}
