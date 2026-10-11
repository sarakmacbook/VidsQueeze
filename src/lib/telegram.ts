import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

const API_BASE = process.env.TELEGRAM_API_BASE?.replace(/\/+$/, "") || "https://api.telegram.org";

export type TgResult<T> = { ok: true; result: T } | { ok: false; description: string; error_code?: number };

export class TelegramError extends Error {
  code: number;
  constructor(description: string, code: number) {
    super(description);
    this.code = code;
  }
}

async function call<T>(token: string, method: string, payload?: unknown, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
      signal: controller.signal,
      cache: "no-store",
    });
    const json = (await res.json()) as TgResult<T>;
    if (!json.ok) throw new TelegramError(json.description || "Telegram API error", json.error_code ?? res.status);
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

export type BotUser = { id: number; username?: string; first_name?: string; can_join_groups?: boolean };

export const getMe = (token: string) => call<BotUser>(token, "getMe", {}, 15_000);

export type WebhookInfo = {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_message?: string;
  last_error_date?: number;
  ip_address?: string;
};

export const getWebhookInfo = (token: string) => call<WebhookInfo>(token, "getWebhookInfo", {}, 15_000);

export async function setWebhook(token: string, url: string, secret: string): Promise<boolean> {
  return call<boolean>(
    token,
    "setWebhook",
    { url, secret_token: secret, allowed_updates: ["message", "edited_message"], drop_pending_updates: false, max_connections: 40 },
    20_000,
  );
}

export async function deleteWebhook(token: string, dropPending = false): Promise<boolean> {
  return call<boolean>(token, "deleteWebhook", { drop_pending_updates: dropPending }, 20_000);
}

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
};

export type TgMessage = {
  message_id: number;
  date: number;
  chat: { id: number; type: string; title?: string; username?: string; first_name?: string };
  from?: { id: number; is_bot: boolean; username?: string; first_name?: string; last_name?: string };
  text?: string;
  caption?: string;
  video?: TgVideoFile;
  document?: TgVideoFile & { mime_type?: string };
  animation?: TgVideoFile;
};

export type TgVideoFile = {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  file_size?: number;
  duration?: number;
  width?: number;
  height?: number;
  mime_type?: string;
};

export async function getUpdates(
  token: string,
  offset: number,
  timeoutSec: number,
  signal?: AbortSignal,
): Promise<TgUpdate[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (timeoutSec + 10) * 1000);
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const res = await fetch(
      `${API_BASE}/bot${token}/getUpdates?timeout=${timeoutSec}&offset=${offset}&limit=10&allowed_updates=${encodeURIComponent(
        JSON.stringify(["message"]),
      )}`,
      { signal: controller.signal, cache: "no-store" },
    );
    const json = (await res.json()) as TgResult<TgUpdate[]>;
    if (!json.ok) throw new TelegramError(json.description || "getUpdates failed", json.error_code ?? res.status);
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

export async function getFile(token: string, fileId: string): Promise<{ file_path?: string; file_size?: number }> {
  return call<{ file_path?: string; file_size?: number }>(token, "getFile", { file_id: fileId }, 20_000);
}

export async function downloadFile(token: string, filePath: string, destPath: string): Promise<void> {
  const res = await fetch(`${API_BASE}/file/bot${token}/${filePath}`, { cache: "no-store" });
  if (!res.ok || !res.body) throw new Error(`Telegram file download failed (${res.status})`);
  const nodeStream = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
  await fs.writeFile(destPath, nodeStream);
}

export async function sendMessage(token: string, chatId: number | string, text: string): Promise<void> {
  await call(token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML" }, 20_000);
}

export async function sendChatAction(token: string, chatId: number | string, action = "upload_video"): Promise<void> {
  await call(token, "sendChatAction", { chat_id: chatId, action }, 10_000).catch(() => undefined);
}

export type SendVideoOptions = {
  caption?: string;
  asDocument?: boolean;
  width?: number;
  height?: number;
  duration?: number;
  replyToMessageId?: number;
};

export async function sendVideoFile(
  token: string,
  chatId: number | string,
  filePath: string,
  options: SendVideoOptions = {},
): Promise<{ message_id: number }> {
  const stat = await fs.stat(filePath);
  const buffer = await fs.readFile(filePath);
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (options.caption) form.append("caption", options.caption.slice(0, 1000));
  if (options.replyToMessageId) form.append("reply_to_message_id", String(options.replyToMessageId));
  if (options.duration) form.append("duration", String(Math.round(options.duration)));
  if (options.width) form.append("width", String(options.width));
  if (options.height) form.append("height", String(options.height));
  form.append(options.asDocument ? "document" : "video", new Blob([new Uint8Array(buffer)], { type: "video/mp4" }), filePath.split("/").pop() || "video.mp4");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(120_000, Math.round(stat.size / 40_000)));
  try {
    const res = await fetch(`${API_BASE}/bot${token}/sendVideo`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    const json = (await res.json()) as TgResult<{ message_id: number }>;
    if (!json.ok) throw new TelegramError(json.description || "sendVideo failed", json.error_code ?? res.status);
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

export function pickIncomingVideo(message: TgMessage): { file: TgVideoFile; kind: "video" | "document" | "animation" } | null {
  if (message.video) return { file: message.video, kind: "video" };
  if (message.document && message.document.mime_type?.startsWith("video/")) {
    return { file: message.document, kind: "document" };
  }
  if (message.animation) return { file: message.animation, kind: "animation" };
  return null;
}

export function readableStreamFromFile(filePath: string): ReadableStream<Uint8Array> {
  const nodeStream = createReadStream(filePath);
  return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
}
