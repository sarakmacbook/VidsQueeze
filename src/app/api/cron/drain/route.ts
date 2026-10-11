import { NextResponse } from "next/server";
import { drainQueue, logEvent, queueCounts } from "@/lib/queue";
import { cleanupOldFiles, workDirUsage } from "@/lib/storage";
import { platformInfo } from "@/lib/platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Vercel Cron safety net.
 *
 * Normal jobs are picked up immediately by `after()` inside the webhook
 * invocation. This endpoint exists for the cases that fall through the cracks:
 * a function killed mid-encode, a job queued while nothing was running, or a
 * leftover file eating `/tmp`.
 *
 * Hobby plans may only schedule this once per day (`0 0 * * *`); Pro can run it
 * every minute. It is also safe to call by hand from the dashboard.
 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // nothing to check against – see README
  const header = request.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  const url = new URL(request.url);
  return url.searchParams.get("secret") === secret;
}

async function tick(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Invalid CRON_SECRET" }, { status: 401 });
  }

  const invocationStartedAt = Date.now();
  const platform = platformInfo();

  const before = await queueCounts().catch(() => ({ queued: 0, active: 0 }));
  const result = await drainQueue({ invocationStartedAt, reason: "cron tick" });
  const usage = await workDirUsage().catch(() => 0);
  await cleanupOldFiles().catch(() => undefined);
  const after = await queueCounts().catch(() => ({ queued: 0, active: 0 }));

  if (result.processed > 0 || before.queued > 0) {
    await logEvent(
      "info",
      "cron",
      `Queue tick: processed ${result.processed}, ${after.queued} still queued` +
        (result.reason ? ` (${result.reason})` : ""),
    );
  }

  return NextResponse.json({
    ok: true,
    processed: result.processed,
    reason: result.reason ?? null,
    skipped: result.skipped,
    queue: { before, after },
    scratchBytes: usage,
    platform: { name: platform.name, region: platform.region },
    tookMs: Date.now() - invocationStartedAt,
  });
}

/** Vercel Cron always issues a GET. */
export async function GET(request: Request) {
  return tick(request);
}

/** The dashboard's "run queue now" button. */
export async function POST(request: Request) {
  return tick(request);
}
