import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { createJob, enqueue, logEvent, TELEGRAM_DOWNLOAD_LIMIT, updateJob } from "@/lib/queue";
import { getSettingsRow } from "@/lib/settings";
import { ensureWorkDir, jobInputPath, jobOutputPath, safeUnlink } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

/**
 * Web test bench: accept a browser upload, queue it with the saved profile and
 * return the job id so the UI can stream progress.
 */
export async function POST(request: Request) {
  let tempPath: string | null = null;
  try {
    const settings = await getSettingsRow();
    const form = await request.formData();
    const file = form.get("file");
    const overrides = form.get("targetSizeMb");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Attach a video file in the `file` field" }, { status: 400 });
    }
    if (file.size === 0) return NextResponse.json({ error: "Empty file" }, { status: 400 });
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: "File is larger than the 300 MB web test limit" }, { status: 413 });
    }

    await ensureWorkDir();
    const job = await createJob({
      source: "web",
      status: "queued",
      stage: "Queued",
      fileName: file.name || "iphone-video.mov",
      sourceBytes: file.size,
      targetBytes: Math.round(Number(overrides || settings.targetSizeMb) * 1024 * 1024),
    });

    tempPath = jobInputPath(job.id, job.fileName);
    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(tempPath, buffer);

    await updateJob(job.id, {
      inputPath: tempPath,
      outputPath: jobOutputPath(job.id, job.fileName),
    });
    await enqueue(job.id);
    await logEvent("info", "web", `Queued web job #${job.id} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);

    return NextResponse.json({ ok: true, jobId: job.id, telegramLimit: TELEGRAM_DOWNLOAD_LIMIT });
  } catch (err) {
    await safeUnlink(tempPath);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload failed" },
      { status: 500 },
    );
  }
}
