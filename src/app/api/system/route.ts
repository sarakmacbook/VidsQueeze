import { NextResponse } from "next/server";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { count, eq, sql } from "drizzle-orm";
import { binaries, codecAvailable, ffmpegVersion } from "@/lib/ffmpeg";
import { getSettingsRow, toPublicSettings } from "@/lib/settings";
import { pollerSnapshot } from "@/lib/poller";
import { queueSnapshot } from "@/lib/queue";
import { autoResume } from "@/lib/poller";
import { cleanupOldFiles, workDir } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type SystemStatus = Awaited<ReturnType<typeof buildStatus>>;

export async function buildStatus() {
  await cleanupOldFiles();
  void autoResume();

  const settings = await getSettingsRow();
  const bins = binaries();
  const [version, h264, h265] = await Promise.all([
    ffmpegVersion(),
    codecAvailable("libx264"),
    codecAvailable("libx265"),
  ]);

  let stats = {
    total: 0,
    done: 0,
    failed: 0,
    active: 0,
    queued: 0,
    bytesIn: 0,
    bytesOut: 0,
  };
  const totals = await db
    .select({
      status: jobs.status,
      c: count(),
      bytesIn: sql<number>`coalesce(sum(${jobs.sourceBytes}), 0)`,
      bytesOut: sql<number>`coalesce(sum(${jobs.outputBytes}), 0)`,
    })
    .from(jobs)
    .groupBy(jobs.status);

  for (const row of totals) {
    stats.total += Number(row.c);
    if (row.status === "done") stats.done += Number(row.c);
    if (row.status === "error") stats.failed += Number(row.c);
    if (["processing", "uploading", "downloading"].includes(row.status)) stats.active += Number(row.c);
    if (row.status === "queued") stats.queued += Number(row.c);
    stats.bytesIn += Number(row.bytesIn);
    stats.bytesOut += Number(row.bytesOut);
  }

  const runningNow = await db
    .select({ c: count() })
    .from(jobs)
    .where(eq(jobs.status, "processing"));

  return {
    ffmpeg: {
      available: Boolean(bins),
      ffmpegPath: bins?.ffmpeg ?? null,
      ffprobePath: bins?.ffprobe ?? null,
      version,
      codecs: { libx264: h264, libx265: h265 },
    },
    storage: { dir: workDir() },
    queue: { ...queueSnapshot(), dbActive: Number(runningNow[0]?.c ?? 0), queued: stats.queued },
    poller: pollerSnapshot(),
    stats,
    settings: toPublicSettings(settings),
    serverTime: new Date().toISOString(),
  };
}

export async function GET() {
  try {
    const status = await buildStatus();
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "status unavailable" },
      { status: 500 },
    );
  }
}
