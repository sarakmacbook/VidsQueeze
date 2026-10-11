import { NextResponse } from "next/server";
import { db } from "@/db";
import { eventLog } from "@/db/schema";
import { desc } from "drizzle-orm";
import { listJobs, queueSnapshot } from "@/lib/queue";
import { pollerSnapshot } from "@/lib/poller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25)));
  const [rows, events] = await Promise.all([
    listJobs(limit),
    db.select().from(eventLog).orderBy(desc(eventLog.id)).limit(12),
  ]);
  return NextResponse.json({ jobs: rows, events, queue: queueSnapshot(), poller: pollerSnapshot() });
}
