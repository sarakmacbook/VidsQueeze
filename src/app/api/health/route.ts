import { db } from "@/db";
import { sql } from "drizzle-orm";
import { binaries } from "@/lib/ffmpeg";
import { ensureSchema } from "@/db/migrate";
import { platformInfo } from "@/lib/platform";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Cheap liveness probe. Also creates any missing tables, so hitting it once
 * right after a deploy is enough to bootstrap a brand-new database.
 */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    const platform = platformInfo();
    const bins = binaries();
    await ensureSchema();
    return Response.json({
      ok: true,
      db: true,
      schema: true,
      ffmpeg: Boolean(bins),
      ffmpegPath: bins?.ffmpeg ?? null,
      platform: platform.name,
      region: platform.region,
      serverless: platform.serverless,
      time: new Date().toISOString(),
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "healthcheck failed" },
      { status: 500 },
    );
  }
}
