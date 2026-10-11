import { after } from "next/server";
import { db, pool } from "@/db";
import { ensureSchema } from "@/db/migrate";
import { eventLog, jobs, type JobRow } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { promises as fs } from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { compressVideo } from "@/lib/compress";
import { jobInputPath, jobOutputPath, safeUnlink } from "@/lib/storage";
import { getRawToken, getSettingsRow, parseAllowList } from "@/lib/settings";
import {
  MAX_FUNCTION_DURATION_SEC,
  SHUTDOWN_RESERVE_SEC,
  STALE_LOCK_MINUTES,
  isServerless,
  tmpBudgetBytes,
} from "@/lib/platform";
import {
  downloadFile,
  getFile,
  pickIncomingVideo,
  sendChatAction,
  sendMessage,
  sendVideoFile,
  TelegramError,
  type TgMessage,
} from "@/lib/telegram";

export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

/**
 * Never start a new encode with less head-room than this – it would be killed
 * mid-write by the platform and leave a half-finished file behind.
 */
const MIN_JOB_WINDOW_MS = 45_000;

type QueueState = {
  active: number | null;
  running: boolean;
  startedAt: number;
  drained: number;
  lastRunAt: number | null;
  lastError: string | null;
};

const globalForQueue = globalThis as typeof globalThis & {
  __vidsqueezeQueue?: QueueState;
};

function state(): QueueState {
  if (!globalForQueue.__vidsqueezeQueue) {
    globalForQueue.__vidsqueezeQueue = {
      active: null,
      running: false,
      startedAt: 0,
      drained: 0,
      lastRunAt: null,
      lastError: null,
    };
  }
  return globalForQueue.__vidsqueezeQueue;
}

/**
 * What *this* instance is doing right now. The authoritative queue depth lives
 * in Postgres (`queueCounts()`), because on serverless every invocation has its
 * own empty in-memory view.
 */
export function queueSnapshot(): {
  active: number | null;
  running: boolean;
  drained: number;
  lastRunAt: number | null;
  lastError: string | null;
} {
  const s = state();
  return {
    active: s.active,
    running: s.running,
    drained: s.drained,
    lastRunAt: s.lastRunAt,
    lastError: s.lastError,
  };
}

export async function logEvent(level: "info" | "warn" | "error" | "success", scope: string, message: string) {
  try {
    await db.insert(eventLog).values({ level, scope, message: message.slice(0, 500) });
    // keep the feed small
    await db.execute(
      sql`delete from event_log where id not in (select id from event_log order by id desc limit 200)`,
    );
  } catch {
    /* logging must never break the pipeline */
  }
}

export async function createJob(values: Partial<JobRow>): Promise<JobRow> {
  const rows = await db.insert(jobs).values(values as never).returning();
  return rows[0];
}

export async function updateJob(id: number, patch: Partial<JobRow>): Promise<void> {
  await db.update(jobs).set(patch).where(eq(jobs.id, id));
}

export async function getJob(id: number): Promise<JobRow | null> {
  await ensureSchema();
  const rows = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listJobs(limit = 25): Promise<JobRow[]> {
  await ensureSchema();
  return db.select().from(jobs).orderBy(desc(jobs.id)).limit(limit);
}

export async function queueCounts(): Promise<{ queued: number; active: number }> {
  await ensureSchema();
  const rows = await pool.query<{ status: string; c: string }>(
    `select status, count(*)::text as c from jobs
      where status in ('queued','downloading','probing','processing','uploading')
      group by status`,
  );
  let queued = 0;
  let active = 0;
  for (const row of rows.rows) {
    if (row.status === "queued") queued += Number(row.c);
    else active += Number(row.c);
  }
  return { queued, active };
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

const INSTANCE_ID = `${process.env.VERCEL_DEPLOYMENT_ID ?? os.hostname()}-${process.pid}`;

function workerId(): string {
  return `${INSTANCE_ID}-${randomUUID().slice(0, 8)}`;
}

/**
 * Leases the next runnable job to this worker.
 *
 * `FOR UPDATE SKIP LOCKED` stops two *concurrent* transactions from grabbing the
 * same row, but that alone is not enough: the lease outlives the transaction
 * that created it. So the predicate also has to treat a leased job as invisible
 * until its lease goes stale — checking `locked_at is null` for fresh work.
 * Without it, the same job is handed out over and over and the rest of the queue
 * starves.
 *
 * A lease older than STALE_LOCK_MINUTES means the owning function was killed
 * mid-encode; those are reclaimed so a crash cannot strand a job forever.
 */
async function claimNextJob(worker: string): Promise<number | null> {
  const result = await pool.query<{ id: number }>(
    `with next_job as (
       select id from jobs
        where (status = 'queued' and locked_at is null)
           or (locked_at is not null
               and status in ('queued','downloading','probing','processing','uploading')
               and locked_at < now() - make_interval(mins => $1::int))
        order by id
        for update skip locked
        limit 1
     )
     update jobs
        set locked_at = now(),
            locked_by = $2::text,
            -- Reset to 'queued' so a reclaimed in-flight job passes the guard in
            -- processJob() and is retried from the top.
            status = 'queued',
            error = null
       from next_job
      where jobs.id = next_job.id
      returning jobs.id`,
    [STALE_LOCK_MINUTES, worker],
  );
  return result.rows[0]?.id ?? null;
}

async function releaseLease(id: number): Promise<void> {
  await pool
    .query(`update jobs set locked_at = null, locked_by = null where id = $1::int`, [id])
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Draining
// ---------------------------------------------------------------------------

export type DrainOptions = {
  /** Wall-clock ms at which this function invocation started. */
  invocationStartedAt?: number;
  /** Stop claiming new jobs after this timestamp. */
  deadlineMs?: number;
  maxJobs?: number;
  reason?: string;
};

export type DrainResult = { processed: number; skipped: boolean; reason?: string };

/**
 * Runs queued jobs until the queue is empty or the invocation is about to hit
 * its `maxDuration`. This is the single entry point used by the Telegram
 * webhook, the web upload route and the cron safety net.
 */
export async function drainQueue(options: DrainOptions = {}): Promise<DrainResult> {
  const s = state();
  if (s.running) return { processed: 0, skipped: true, reason: "another drain is already running here" };

  await ensureSchema();

  const startedAt = options.invocationStartedAt ?? Date.now();
  const budgetSec = Math.min(
    MAX_FUNCTION_DURATION_SEC,
    Number(process.env.MAX_FUNCTION_DURATION_SEC) || MAX_FUNCTION_DURATION_SEC,
  );
  const deadline =
    options.deadlineMs ?? startedAt + Math.max(30, budgetSec - SHUTDOWN_RESERVE_SEC) * 1000;
  const maxJobs = options.maxJobs ?? Number.POSITIVE_INFINITY;

  s.running = true;
  s.startedAt = startedAt;
  let processed = 0;
  const worker = workerId();

  try {
    while (processed < maxJobs) {
      const remaining = deadline - Date.now();
      if (remaining < MIN_JOB_WINDOW_MS) {
        const reason = `invocation budget exhausted after ${processed} job(s) – the rest stays queued`;
        s.lastError = null;
        await logEvent("warn", "queue", reason);
        return { processed, skipped: false, reason };
      }

      const id = await claimNextJob(worker);
      if (id === null) break;

      s.active = id;
      try {
        await processJob(id, { deadlineMs: deadline });
        processed += 1;
        s.drained += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        s.lastError = message;
        await updateJob(id, {
          status: "error",
          stage: "Failed",
          error: message,
          finishedAt: new Date(),
        }).catch(() => undefined);
        await logEvent("error", "queue", `Job #${id} failed: ${message}`);
      } finally {
        s.active = null;
        await releaseLease(id);
      }
    }
    s.lastRunAt = Date.now();
    s.lastError = null;
    return { processed, skipped: false };
  } finally {
    s.running = false;
  }
}

/**
 * Kicks the queue without blocking the caller.
 *
 * On Vercel the work runs inside `after()`, which keeps the *same* invocation
 * alive (and billed, up to `maxDuration`) once the HTTP response has been sent.
 * That is what lets a Telegram webhook answer in milliseconds and still encode
 * the clip. Outside a request scope – the poller, a CLI script – we simply
 * detach the promise.
 */
export function scheduleDrain(reason = "job enqueued", options: DrainOptions = {}): void {
  const invocationStartedAt = options.invocationStartedAt ?? Date.now();
  const task = () =>
    drainQueue({ ...options, invocationStartedAt, reason }).catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      state().lastError = message;
      await logEvent("error", "queue", `Drain failed (${reason}): ${message}`);
    });

  try {
    after(() => task());
  } catch {
    // `after()` is only available inside a request scope.
    void task();
  }
}

/** Kept for callers that only want the persistent-server behaviour. */
export function enqueue(id: number): void {
  scheduleDrain(`job #${id} enqueued`);
}

function buildCaption(template: string, sourceName: string, sourceBytes: number, outputBytes: number): string {
  const saved = sourceBytes > 0 ? Math.max(0, Math.round((1 - outputBytes / sourceBytes) * 100)) : 0;
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return template
    .replaceAll("{source}", sourceName)
    .replaceAll("{output}", mb(outputBytes))
    .replaceAll("{original}", mb(sourceBytes))
    .replaceAll("{saved}", String(saved));
}

/**
 * Invocation clock, threaded explicitly (never via module state) so that two
 * concurrent requests sharing one warm instance cannot inherit each other's
 * deadline.
 */
export type RequestContext = DrainOptions;

/** Full pipeline: download (telegram) → compress → upload / store result. */
export async function processJob(id: number, options: { deadlineMs?: number } = {}): Promise<void> {
  const job = await getJob(id);
  if (!job) return;
  // Only fresh (or previously failed) jobs are processed.
  if (!["queued", "error"].includes(job.status)) return;

  const settings = await getSettingsRow();
  const token = await getRawToken();
  const started = new Date();

  await updateJob(id, {
    status: "downloading",
    stage: job.source === "telegram" ? "Downloading from Telegram" : "Receiving upload",
    progress: 2,
    startedAt: started,
    attempts: job.attempts + 1,
    error: null,
  });

  const inputPath = job.inputPath || jobInputPath(id, job.fileName);
  const outputPath = job.outputPath || jobOutputPath(id, job.fileName);

  try {
    // Serverless scratch space is small and shared with the output file, so
    // refuse work that cannot possibly fit instead of filling the disk.
    const budget = tmpBudgetBytes();
    if (Number.isFinite(budget)) {
      const needed = job.sourceBytes + Math.max(job.targetBytes, job.sourceBytes * 0.5);
      if (needed > budget) {
        throw new Error(
          `This job needs roughly ${(needed / 1024 / 1024).toFixed(0)} MB of scratch space but only ` +
            `${(budget / 1024 / 1024).toFixed(0)} MB is available on ${isServerless() ? "this serverless host" : "this host"}. ` +
            `Lower the target size or run the encoder on a long-lived host.`,
        );
      }
    }

    if (job.source === "telegram") {
      if (!token) throw new Error("Bot token is not configured – finish setup first");
      if (!job.telegramFileId) throw new Error("Missing Telegram file id");

      if (job.sourceBytes > TELEGRAM_DOWNLOAD_LIMIT) {
        throw new Error(
          `Telegram bots can only download files up to 20 MB (this one is ${(job.sourceBytes / 1024 / 1024).toFixed(1)} MB).`,
        );
      }
      const info = await getFile(token, job.telegramFileId);
      if (!info.file_path) throw new Error("Telegram did not return a file path");
      await downloadFile(token, info.file_path, inputPath);
    } else {
      await fs.access(inputPath);
    }

    const profile = {
      qualityMode: settings.qualityMode,
      targetSizeMb: settings.targetSizeMb,
      maxHeight: settings.maxHeight,
      maxFps: settings.maxFps,
      keepAudio: settings.keepAudio,
      audioBitrateKbps: settings.audioBitrateKbps,
      videoCodec: settings.videoCodec,
      speedPreset: settings.speedPreset,
      twoPass: settings.twoPass,
      crf: settings.crf,
    };

    await updateJob(id, { status: "processing", stage: "Starting encoder", inputPath, outputPath, progress: 5 });

    let lastWrite = 0;
    const result = await compressVideo({
      inputPath,
      outputPath,
      profile,
      // The per-job budget wins so a job keeps the settings it was created with.
      targetBytes: job.targetBytes > 0 ? job.targetBytes : undefined,
      // Stop the encoder before the platform stops us, so the failure is a
      // readable message in the dashboard rather than a truncated invocation.
      deadlineMs: options.deadlineMs,
      onProgress: async (update) => {
        const now = Date.now();
        if (now - lastWrite < 700 && update.progress < 98) return;
        lastWrite = now;
        await updateJob(id, {
          progress: Math.min(99, Math.max(1, update.progress)),
          stage: update.stage,
          videoBitrate: update.bitrateKbps ? update.bitrateKbps * 1000 : undefined,
        });
      },
    });

    await updateJob(id, {
      status: job.source === "telegram" ? "uploading" : "done",
      stage: job.source === "telegram" ? "Uploading result to Telegram" : "Done",
      progress: job.source === "telegram" ? 99 : 100,
      outputBytes: result.outputBytes,
      outputWidth: result.width,
      outputHeight: result.height,
      outputDurationSec: result.durationSec,
      videoBitrate: result.videoBitrateKbps * 1000,
      log: result.log.slice(-8000),
    });

    if (job.source === "telegram") {
      if (!token || !job.telegramChatId) throw new Error("Missing chat to send the result to");
      await sendChatAction(token, job.telegramChatId, "upload_video");
      const caption = settings.captionTemplate
        ? buildCaption(settings.captionTemplate, job.fileName, job.sourceBytes, result.outputBytes)
        : undefined;
      await sendVideoFile(token, job.telegramChatId, outputPath, {
        caption,
        asDocument: settings.replyMode === "document",
        width: result.width,
        height: result.height,
        duration: Math.round(result.durationSec),
        replyToMessageId: job.telegramMessageId ? Number(job.telegramMessageId) : undefined,
      });
      await updateJob(id, { status: "done", stage: "Sent to Telegram", progress: 100, finishedAt: new Date() });
      await logEvent(
        "success",
        "bot",
        `Sent ${(result.outputBytes / 1024 / 1024).toFixed(2)} MB (${result.height}p) to chat ${job.telegramChatId}`,
      );
    } else {
      await updateJob(id, { finishedAt: new Date() });
    }

    await safeUnlink(inputPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateJob(id, { status: "error", stage: "Failed", error: message, finishedAt: new Date() });
    await logEvent("error", "bot", `Job #${id} failed: ${message}`);
    if (job.source === "telegram" && token && job.telegramChatId) {
      await sendMessage(token, job.telegramChatId, `⚠️ <b>Compression failed</b>\n${message}`).catch(() => undefined);
    }
    await safeUnlink(inputPath);
    await safeUnlink(outputPath);
  }
}

/** Handle an incoming Telegram message coming from either webhook or polling. */
export async function handleMessage(message: TgMessage, context: RequestContext = {}): Promise<string> {
  const settings = await getSettingsRow();
  const token = await getRawToken();
  const chatId = message.chat.id;
  const user = message.from;

  if (!token) return "ignored: no token";

  const allowed = parseAllowList(settings.allowList);
  if (allowed.length > 0 && user && !allowed.includes(String(user.id))) {
    await sendMessage(
      token,
      chatId,
      "🚫 This bot is private. Ask the owner to add your Telegram user ID to the allow list.",
    ).catch(() => undefined);
    return "ignored: not allowed";
  }

  const video = pickIncomingVideo(message);
  if (!video) {
    const targetMb = settings.qualityMode ? `CRF ${settings.crf}` : `${settings.targetSizeMb} MB`;
    await sendMessage(
      token,
      chatId,
      [
        "👋 <b>Send me any iPhone video</b> (HEVC / MOV / MP4) and I will compress it to fit your size budget.",
        "",
        `🎛 Current profile: <b>${targetMb}</b> · max ${settings.maxHeight || "source"}p · max ${settings.maxFps || "source"} fps`,
        "ℹ️ Telegram lets bots download files up to 20 MB — larger clips should be trimmed first.",
      ].join("\n"),
    ).catch(() => undefined);
    return "replied: instructions";
  }

  if (settings.maxDurationSec > 0 && (video.file.duration ?? 0) > settings.maxDurationSec) {
    await sendMessage(
      token,
      chatId,
      `⏱ This clip is ${Math.round((video.file.duration ?? 0) / 60)} min. The profile limit is ${Math.round(settings.maxDurationSec / 60)} min.`,
    ).catch(() => undefined);
    return "rejected: too long";
  }

  const job = await createJob({
    source: "telegram",
    status: "queued",
    stage: "Queued",
    fileName: video.file.file_name || `telegram-${video.file.file_unique_id}.mp4`,
    sourceBytes: video.file.file_size ?? 0,
    sourceWidth: video.file.width ?? 0,
    sourceHeight: video.file.height ?? 0,
    sourceDurationSec: video.file.duration ?? 0,
    targetBytes: settings.qualityMode ? 0 : Math.round(settings.targetSizeMb * 1024 * 1024),
    telegramUserId: user ? String(user.id) : null,
    telegramChatId: String(chatId),
    telegramMessageId: String(message.message_id),
    telegramFileId: video.file.file_id,
  });

  await logEvent("info", "bot", `Queued job #${job.id} from ${user?.username ?? chatId}`);
  await sendMessage(token, chatId, `📥 Got it – job #${job.id} queued. I will send the compressed video here.`).catch(
    () => undefined,
  );

  // The webhook route schedules its own drain with an accurate invocation
  // clock; this covers the long-polling path, where there is no request scope.
  scheduleDrain(`telegram job #${job.id}`, context);

  return `queued:${job.id}`;
}

export async function handleTelegramUpdate(
  update: { update_id: number; message?: TgMessage },
  context: RequestContext = {},
): Promise<void> {
  if (update.message) await handleMessage(update.message, context);
}

export { TelegramError };
