/** Client-safe DTOs and formatters shared by the browser UI (no node imports). */

export type PublicSettingsDTO = {
  id: number;
  botUsername: string | null;
  botTitle: string | null;
  webhookSecret: string;
  publicBaseUrl: string | null;
  connectionMode: string;
  pollingActive: boolean;
  lastUpdateId: number;
  allowList: string;
  replyMode: string;
  captionTemplate: string;
  targetSizeMb: number;
  maxDurationSec: number;
  maxHeight: number;
  maxFps: number;
  keepAudio: boolean;
  audioBitrateKbps: number;
  videoCodec: string;
  speedPreset: string;
  twoPass: boolean;
  crf: number;
  qualityMode: boolean;
  setupStep: number;
  setupComplete: boolean;
  tokenVerified: boolean;
  createdAt: string;
  updatedAt: string;
  hasToken: boolean;
  botTokenMasked: string | null;
};

export type JobDTO = {
  id: number;
  source: string;
  status: string;
  stage: string;
  progress: number;
  attempts: number;
  fileName: string;
  sourceBytes: number;
  sourceWidth: number;
  sourceHeight: number;
  sourceDurationSec: number;
  sourceCodec: string | null;
  targetBytes: number;
  outputBytes: number;
  outputWidth: number;
  outputHeight: number;
  videoBitrate: number;
  outputDurationSec: number;
  telegramUserId: string | null;
  telegramChatId: string | null;
  error: string | null;
  log: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

export type EventDTO = {
  id: number;
  level: string;
  scope: string;
  message: string;
  createdAt: string;
};

export type PlatformDTO = {
  name: string;
  mode: "serverless" | "persistent";
  isVercel: boolean;
  serverless: boolean;
  region: string | null;
  deploymentId: string | null;
  maxUploadBytes: number;
  maxFunctionDurationSec: number;
  tmpBudgetBytes: number | null;
  supportsLongPolling: boolean;
  longPollingBlockedReason: string | null;
  supportsBackgroundDrain: boolean;
  cronConfigured: boolean;
};

export type SystemStatusDTO = {
  ffmpeg: {
    available: boolean;
    ffmpegPath: string | null;
    ffprobePath: string | null;
    version: string | null;
    codecs: { libx264: boolean; libx265: boolean };
  };
  storage: { dir: string; usedBytes: number };
  queue: {
    active: number | null;
    running: boolean;
    drained: number;
    lastRunAt: number | null;
    lastError: string | null;
    dbActive: number;
    queued: number;
  };
  platform: PlatformDTO;
  poller: {
    running: boolean;
    startedAt: number | null;
    lastPollAt: number | null;
    lastError: string | null;
    processed: number;
  };
  stats: {
    total: number;
    done: number;
    failed: number;
    active: number;
    queued: number;
    bytesIn: number;
    bytesOut: number;
  };
  settings: PublicSettingsDTO;
  serverTime: string;
};

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds < 1) return "0s";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (Number.isNaN(then)) return "—";
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export const STATUS_STYLES: Record<string, string> = {
  queued: "bg-slate-500/15 text-slate-300 border-slate-400/30",
  downloading: "bg-sky-500/15 text-sky-300 border-sky-400/30",
  probing: "bg-sky-500/15 text-sky-300 border-sky-400/30",
  processing: "bg-amber-500/15 text-amber-300 border-amber-400/30",
  uploading: "bg-violet-500/15 text-violet-300 border-violet-400/30",
  done: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30",
  error: "bg-rose-500/15 text-rose-300 border-rose-400/30",
};

export const PRESETS = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
];

export const HEIGHT_PRESETS = [
  { value: 0, label: "Keep source" },
  { value: 480, label: "480p SD" },
  { value: 720, label: "720p HD" },
  { value: 1080, label: "1080p Full HD" },
  { value: 1440, label: "1440p QHD" },
  { value: 2160, label: "2160p 4K" },
];

export const FPS_PRESETS = [
  { value: 0, label: "Keep source" },
  { value: 24, label: "24 fps" },
  { value: 30, label: "30 fps" },
  { value: 60, label: "60 fps" },
];

export const TARGET_PRESETS = [
  { value: 2, label: "2 MB" },
  { value: 8, label: "8 MB" },
  { value: 16, label: "16 MB" },
  { value: 20, label: "20 MB (Telegram bot limit)" },
  { value: 50, label: "50 MB" },
  { value: 100, label: "100 MB" },
];
