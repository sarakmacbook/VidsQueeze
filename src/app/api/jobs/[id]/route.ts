import { NextResponse } from "next/server";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getJob, logEvent } from "@/lib/queue";
import { safeUnlink } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const job = await getJob(Number(id));
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  return NextResponse.json({ job });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const jobId = Number(id);
  const job = await getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (["downloading", "processing", "uploading"].includes(job.status)) {
    return NextResponse.json({ error: "Job is still running" }, { status: 409 });
  }
  await safeUnlink(job.inputPath);
  await safeUnlink(job.outputPath);
  await db.delete(jobs).where(eq(jobs.id, jobId));
  await logEvent("info", "web", `Job #${jobId} deleted from the dashboard`);
  return NextResponse.json({ ok: true });
}
