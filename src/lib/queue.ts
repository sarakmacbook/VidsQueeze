import { db } from "@/db";
import { eventLog, jobs, type JobRow } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { promises as fs } from "node:fs";
import { compressVideo } from "@/lib/compress";
import { jobInputPath, jobOutputPath, safeUnlink } from "@/lib/storage";
import { getRawToken, getSettingsRow, parseAllowList } from "@/lib/settings";
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

type QueueState = {
  pending: number[];
  active: number | null;
  running: boolean;
  startedAt: number;
};

const globalForQueue = globalThis as typeof globalThis & {
  __vidsqueezeQueue?: QueueState;
};

function state(): QueueState {
  if (!globalForQueue.__vidsqueezeQueue) {
    globalForQueue.__vidsqueezeQueue = { pending: [], active: null, running: false, startedAt: 0 };
  }
  return globalForQueue.__vidsqueezeQueue;
}

export function queueSnapshot(): { pending: number; active: number | null } {
  const s = state();
  return { pending: s.pending.length, active: s.active };
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
  const rows = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listJobs(limit = 25): Promise<JobRow[]> {
  return db.select().from(jobs).orderBy(desc(jobs.id)).limit(limit);
}

export function enqueue(id: number): void {
  const s = state();
  if (s.active === id || s.pending.includes(id)) return;
  s.pending.push(id);
  s.pending.sort((a, b) => a - b);
  void drain();
}

async function drain(): Promise<void> {
  const s = state();
  if (s.running) return;
  s.running = true;
  try {
    while (s.pending.length > 0) {
      const id = s.pending.shift() as number;
      s.active = id;
      try {
        await processJob(id);
      } catch (err) {
        await updateJob(id, {
          status: "error",
          stage: "Failed",
          error: err instanceof Error ? err.message : String(err),
          finishedAt: new Date(),
        }).catch(() => undefined);
      } finally {
        s.active = null;
      }
    }
  } finally {
    s.running = false;
  }
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

/** Full pipeline: download (telegram) → compress → upload / store result. */
export async function processJob(id: number): Promise<void> {
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
  }
}

/** Handle an incoming Telegram message coming from either webhook or polling. */
export async function handleMessage(message: TgMessage): Promise<string> {
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

  enqueue(job.id);
  await logEvent("info", "bot", `Queued job #${job.id} from ${user?.username ?? chatId}`);
  await sendMessage(token, chatId, `📥 Got it – job #${job.id} queued. I will send the compressed video here.`).catch(
    () => undefined,
  );
  return `queued:${job.id}`;
}

export async function handleTelegramUpdate(update: { update_id: number; message?: TgMessage }): Promise<void> {
  if (update.message) await handleMessage(update.message);
}

export { TelegramError };
