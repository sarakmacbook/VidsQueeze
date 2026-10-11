import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, copyFileSync, chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";

export type FfmpegBinaries = { ffmpeg: string; ffprobe: string };

/**
 * `require` exists in Next's CJS server output but not in a pure ESM build, so
 * resolve it once and fall back to a `createRequire` rooted at the app. On
 * Vercel that is `/var/task`, which is exactly where `node_modules` lives.
 */
const nodeRequire: NodeRequire =
  typeof require === "function" ? require : createRequire(path.join(process.cwd(), "vidsqueeze.cjs"));

/** Where we stash a copy when the bundled binary is present but not executable. */
function escapeDir(): string {
  return path.join(os.tmpdir(), "vidsqueeze-bin");
}

/**
 * Returns a path we are actually allowed to `spawn`.
 *
 * Serverless filesystems are read-only outside `/tmp`, and files pulled in by
 * output-file-tracing do not always keep their executable bit. Rather than
 * failing, copy the binary to `/tmp` (writable *and* executable on Vercel) and
 * chmod it there. The copy is cached per instance.
 */
function ensureExecutable(bin: string): string | null {
  if (!existsSync(bin)) return null;
  try {
    // Already runnable – the common case on a normal host.
    if (canExec(bin)) return bin;
    chmodSync(bin, 0o755);
    if (canExec(bin)) return bin;
  } catch {
    /* read-only filesystem – fall through to the /tmp copy */
  }

  try {
    const dir = escapeDir();
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, path.basename(bin));
    if (!existsSync(target)) copyFileSync(bin, target);
    chmodSync(target, 0o755);
    return canExec(target) ? target : null;
  } catch {
    return null;
  }
}

function canExec(file: string): boolean {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fromStatic(): FfmpegBinaries | null {
  try {
    const ffmpeg = nodeRequire("ffmpeg-static") as string | null;
    const ffprobeMod = nodeRequire("ffprobe-static") as { path?: string } | null;
    const ffprobe = ffprobeMod?.path;
    if (ffmpeg && ffprobe && existsSync(ffmpeg) && existsSync(ffprobe)) {
      return { ffmpeg, ffprobe };
    }
  } catch {
    /* static binaries not installed */
  }
  return null;
}

let cached: FfmpegBinaries | null | undefined;

export function binaries(): FfmpegBinaries | null {
  if (cached !== undefined) return cached;
  const candidates: FfmpegBinaries[] = [];
  if (process.env.FFMPEG_PATH && process.env.FFPROBE_PATH) {
    candidates.push({ ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH });
  }
  if (process.env.FFMPEG_PATH) {
    candidates.push({ ffmpeg: process.env.FFMPEG_PATH, ffprobe: "ffprobe" });
  }
  const stat = fromStatic();
  if (stat) candidates.push(stat);
  candidates.push({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" });

  for (const candidate of candidates) {
    const isPathLookup = candidate.ffmpeg === "ffmpeg" || candidate.ffprobe === "ffprobe";

    if (isPathLookup) {
      // Only trust PATH binaries if they are actually runnable.
      try {
        execOk(candidate.ffmpeg, ["-hide_banner", "-version"]);
        execOk(candidate.ffprobe, ["-hide_banner", "-version"]);
      } catch {
        continue;
      }
      cached = candidate;
      return cached;
    }

    // Bundled/absolute paths: make sure they exist and can be executed here.
    const ffmpeg = ensureExecutable(candidate.ffmpeg);
    const ffprobe = ensureExecutable(candidate.ffprobe);
    if (!ffmpeg || !ffprobe) continue;
    try {
      execOk(ffmpeg, ["-hide_banner", "-version"]);
      execOk(ffprobe, ["-hide_banner", "-version"]);
    } catch {
      continue;
    }
    cached = { ffmpeg, ffprobe };
    return cached;
  }
  cached = null;
  return null;
}

function execOk(bin: string, args: string[]): void {
  const res = spawnSyncSafe(bin, args, 10_000);
  if (res.status !== 0 || res.error) throw new Error(`${bin} not runnable`);
}

function spawnSyncSafe(bin: string, args: string[], timeoutMs: number) {
  // Lazy require keeps this module usable in edge-ish bundling contexts.
  const { spawnSync } = nodeRequire("node:child_process") as typeof import("node:child_process");
  return spawnSync(bin, args, { timeout: timeoutMs, encoding: "utf8" });
}

export type RunResult = { code: number | null; stdout: string; stderr: string };

export type RunOptions = {
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
};

export function run(bin: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : null;

    const onAbort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      if (stdout.length < 400_000) stdout += text;
      options.onStdout?.(text);
    });
    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      if (stderr.length < 400_000) stderr += text;
      options.onStderr?.(text);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr });
    });
  });
}

export type ProbeResult = {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  totalBitrate: number;
  hasAudio: boolean;
  rotation: number;
  sizeBytes: number;
};

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  bit_rate?: string;
  duration?: string;
  side_data_list?: { rotation?: number; displaymatrix?: string }[];
  tags?: { rotate?: string };
};

export async function probeVideo(file: string): Promise<ProbeResult> {
  const bins = binaries();
  if (!bins) throw new Error("ffmpeg/ffprobe binaries are unavailable on this host");

  const res = await run(
    bins.ffprobe,
    [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      file,
    ],
    { timeoutMs: 30_000 },
  );

  if (res.code !== 0) throw new Error(`ffprobe failed: ${res.stderr.slice(-300)}`);

  const parsed = JSON.parse(res.stdout || "{}") as {
    streams?: ProbeStream[];
    format?: { duration?: string; bit_rate?: string; size?: string };
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!video) throw new Error("No video stream found in file");

  const fpsRaw = video.avg_frame_rate || video.r_frame_rate || "30/1";
  const [num, den] = fpsRaw.split("/").map(Number);
  const fps = den ? num / den : Number(fpsRaw) || 30;

  const rotation =
    video.side_data_list?.find((s) => typeof s.rotation === "number")?.rotation ??
    Number(video.tags?.rotate ?? 0) ??
    0;

  return {
    durationSec: Number(parsed.format?.duration ?? video.duration ?? 0) || 0,
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: Math.round(fps * 100) / 100,
    codec: video.codec_name ?? "unknown",
    totalBitrate: Number(parsed.format?.bit_rate ?? video.bit_rate ?? 0) || 0,
    hasAudio: Boolean(audio),
    rotation: rotation || 0,
    sizeBytes: Number(parsed.format?.size ?? 0) || 0,
  };
}

export async function ffmpegVersion(): Promise<string | null> {
  const bins = binaries();
  if (!bins) return null;
  try {
    const res = await run(bins.ffmpeg, ["-hide_banner", "-version"], { timeoutMs: 15_000 });
    if (res.code !== 0) return null;
    return res.stdout.split("\n")[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

export async function codecAvailable(codec: string): Promise<boolean> {
  const bins = binaries();
  if (!bins) return false;
  try {
    const res = await run(bins.ffmpeg, ["-hide_banner", "-encoders"], { timeoutMs: 20_000 });
    return res.stdout.includes(codec);
  } catch {
    return false;
  }
}
