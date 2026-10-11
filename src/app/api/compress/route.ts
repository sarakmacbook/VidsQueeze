import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { createJob, logEvent, scheduleDrain, TELEGRAM_DOWNLOAD_LIMIT, updateJob } from "@/lib/queue";
import { getSettingsRow } from "@/lib/settings";
import { ensureWorkDir, jobInputPath, jobOutputPath, safeUnlink } from "@/lib/storage";
import { maxUploadBytes, platformInfo } from "@/lib/platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Vercel Hobby allows at most 300s. The upload itself is quick; the encode runs
 * afterwards inside `after()`, sharing this same budget.
 */
export const maxDuration = 300;

/**
 * Lets the browser learn this host's upload ceiling *before* it starts sending
 * bytes. On Vercel an oversized body is rejected at the edge with a bare
 * `413 FUNCTION_PAYLOAD_TOO_LARGE`, so checking up front is the difference
 * between a helpful message and a confusing one.
 */
export async function GET() {
  const platform = platformInfo();
  return NextResponse.json({
    maxUploadBytes: maxUploadBytes(),
    platform: platform.name,
    serverless: platform.serverless,
    maxFunctionDurationSec: platform.maxFunctionDurationSec,
    note: platform.serverless
      ? "Serverless hosts cap the request body at 4.5 MB. The Telegram bot is unaffected."
      : null,
  });
}

/**
 * Web test bench: accept a browser upload, queue it with the saved profile and
 * return the job id so the UI can stream progress.
 */
export async function POST(request: Request) {
  const invocationStartedAt = Date.now();
  const platform = platformInfo();
  const limit = maxUploadBytes();
  let tempPath: string | null = null;

  try {
    const settings = await getSettingsRow();

    // Vercel rejects an oversized body at the edge with 413 before we get here,
    // so this check mainly catches files between our limit and the hard cap and
    // gives a message that explains *why* instead of a bare platform error.
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > limit) return tooLarge(declared, limit, platform.name);

    const form = await request.formData();
    const file = form.get("file");
    const overrides = form.get("targetSizeMb");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Attach a video file in the `file` field" }, { status: 400 });
    }
    if (file.size === 0) return NextResponse.json({ error: "Empty file" }, { status: 400 });
    if (file.size > limit) return tooLarge(file.size, limit, platform.name);

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

    scheduleDrain(`web job #${job.id}`, { invocationStartedAt });
    await logEvent("info", "web", `Queued web job #${job.id} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);

    return NextResponse.json({
      ok: true,
      jobId: job.id,
      telegramLimit: TELEGRAM_DOWNLOAD_LIMIT,
      maxUploadBytes: limit,
      platform: platform.name,
    });
  } catch (err) {
    await safeUnlink(tempPath);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload failed" },
      { status: 500 },
    );
  }
}

function tooLarge(size: number, limit: number, host: string) {
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  const serverless = limit < 100 * 1024 * 1024;
  return NextResponse.json(
    {
      error: serverless
        ? `${host} caps a function's request body at 4.5 MB, so the browser test bench can only accept clips up to ${mb(limit)} (this one is ${mb(size)}). The Telegram bot is unaffected – it streams files straight from Telegram's API. For large browser uploads, run VidSqueeze on a long-lived host (Docker, VPS, Fly.io).`
        : `File is larger than the ${mb(limit)} web test limit (this one is ${mb(size)}).`,
      limitBytes: limit,
      sizeBytes: size,
      host,
    },
    { status: 413 },
  );
}
