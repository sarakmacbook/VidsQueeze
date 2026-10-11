import {
  bigint,
  boolean,
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Single-row configuration table (id is always 1) that stores everything the
 * WebUI setup wizard configures: bot credentials, connection mode and the
 * video compression profile.
 */
export const botSettings = pgTable("bot_settings", {
  id: integer("id").primaryKey().default(1),

  // --- Telegram credentials / connection -----------------------------------
  botToken: text("bot_token"),
  botUsername: text("bot_username"),
  botTitle: text("bot_title"),
  webhookSecret: text("webhook_secret").notNull().default("vidsqueeze-secret"),
  publicBaseUrl: text("public_base_url"),
  connectionMode: text("connection_mode").notNull().default("polling"), // polling | webhook
  pollingActive: boolean("polling_active").notNull().default(false),
  lastUpdateId: bigint("last_update_id", { mode: "number" }).notNull().default(0),
  lastWebhookAt: timestamp("last_webhook_at", { withTimezone: true }),

  // --- Access control ------------------------------------------------------
  allowList: text("allow_list").notNull().default(""), // comma separated telegram user ids, empty = allow all
  replyMode: text("reply_mode").notNull().default("video"), // video | document
  captionTemplate: text("caption_template")
    .notNull()
    .default("Compressed: {source} → {output} ({saved}% smaller)"),

  // --- Compression profile -------------------------------------------------
  targetSizeMb: doublePrecision("target_size_mb").notNull().default(8),
  maxDurationSec: integer("max_duration_sec").notNull().default(0), // 0 = unlimited
  maxHeight: integer("max_height").notNull().default(1080), // 0 = keep source
  maxFps: integer("max_fps").notNull().default(30), // 0 = keep source
  keepAudio: boolean("keep_audio").notNull().default(true),
  audioBitrateKbps: integer("audio_bitrate_kbps").notNull().default(96),
  videoCodec: text("video_codec").notNull().default("libx264"), // libx264 | libx265
  speedPreset: text("speed_preset").notNull().default("veryfast"),
  twoPass: boolean("two_pass").notNull().default(true),
  crf: integer("crf").notNull().default(23), // used when target size is "0" (quality mode)
  qualityMode: boolean("quality_mode").notNull().default(false), // true = CRF, false = target size

  // --- Setup state ---------------------------------------------------------
  setupStep: integer("setup_step").notNull().default(1),
  setupComplete: boolean("setup_complete").notNull().default(false),
  tokenVerified: boolean("token_verified").notNull().default(false),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per compression job (from Telegram or the web test bench). */
export const jobs = pgTable("jobs", {
  id: serial("id").primaryKey(),
  source: text("source").notNull().default("web"), // telegram | web
  status: text("status").notNull().default("queued"),
  // queued | downloading | probing | processing | uploading | done | error | cancelled
  stage: text("stage").notNull().default("Queued"),
  progress: integer("progress").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),

  fileName: text("file_name").notNull().default("video.mov"),
  sourceBytes: bigint("source_bytes", { mode: "number" }).notNull().default(0),
  sourceWidth: integer("source_width").notNull().default(0),
  sourceHeight: integer("source_height").notNull().default(0),
  sourceDurationSec: doublePrecision("source_duration_sec").notNull().default(0),
  sourceCodec: text("source_codec"),
  targetBytes: bigint("target_bytes", { mode: "number" }).notNull().default(0),

  outputBytes: bigint("output_bytes", { mode: "number" }).notNull().default(0),
  outputWidth: integer("output_width").notNull().default(0),
  outputHeight: integer("output_height").notNull().default(0),
  videoBitrate: integer("video_bitrate").notNull().default(0),
  outputDurationSec: doublePrecision("output_duration_sec").notNull().default(0),

  telegramUserId: text("telegram_user_id"),
  telegramChatId: text("telegram_chat_id"),
  telegramMessageId: text("telegram_message_id"),
  telegramFileId: text("telegram_file_id"),

  inputPath: text("input_path"),
  outputPath: text("output_path"),

  error: text("error"),
  log: text("log").notNull().default(""),

  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Lightweight activity feed shown on the dashboard. */
export const eventLog = pgTable("event_log", {
  id: serial("id").primaryKey(),
  level: text("level").notNull().default("info"), // info | warn | error | success
  scope: text("scope").notNull().default("bot"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BotSettingsRow = typeof botSettings.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type EventRow = typeof eventLog.$inferSelect;
