import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isServerless } from "@/lib/platform";

export function workDir(): string {
  return process.env.VIDSQUEEZE_DIR || path.join(os.tmpdir(), "vidsqueeze");
}

export async function ensureWorkDir(): Promise<string> {
  const dir = workDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(dir, "tmp"), { recursive: true });
  return dir;
}

export function jobInputPath(jobId: number, originalName: string): string {
  const ext = guessExt(originalName);
  return path.join(workDir(), "tmp", `job-${jobId}-source${ext}`);
}

export function jobOutputPath(jobId: number, originalName: string): string {
  const base = path.basename(originalName).replace(/\.[^.]+$/, "") || "video";
  const safe = base.replace(/[^a-zA-Z0-9-_ ]/g, "").slice(0, 48) || "video";
  return path.join(workDir(), `job-${jobId}-${safe}.mp4`);
}

export function guessExt(name: string): string {
  const match = /\.([a-zA-Z0-9]{2,5})$/.exec(name || "");
  if (!match) return ".mov";
  return `.${match[1].toLowerCase()}`;
}

export async function safeUnlink(file: string | null | undefined): Promise<void> {
  if (!file) return;
  try {
    await fs.unlink(file);
  } catch {
    /* ignore */
  }
}

export async function fileSize(file: string): Promise<number> {
  try {
    const stat = await fs.stat(file);
    return stat.size;
  } catch {
    return 0;
  }
}

/**
 * Remove workdir artefacts older than `maxAgeMs`.
 *
 * On a long-lived host results are kept for a few hours so the dashboard can
 * still offer a download. On serverless `/tmp` is tiny (512 MB on Vercel) and
 * wiped between invocations anyway, so leftovers are dropped much sooner –
 * including downloaded sources and ffmpeg two-pass logs under `tmp/`.
 */
export async function cleanupOldFiles(maxAgeMs = defaultMaxAgeMs()): Promise<void> {
  const dir = await ensureWorkDir();
  const now = Date.now();

  const sweep = async (target: string, predicate: (name: string) => boolean) => {
    const entries = await fs.readdir(target).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!predicate(entry)) continue;
      const full = path.join(target, entry);
      try {
        const stat = await fs.stat(full);
        if (now - stat.mtimeMs > maxAgeMs) await fs.unlink(full);
      } catch {
        /* ignore */
      }
    }
  };

  await sweep(dir, (name) => name.endsWith(".mp4"));
  await sweep(path.join(dir, "tmp"), (name) => name !== "." && name !== "..");
}

function defaultMaxAgeMs(): number {
  return isServerless() ? 10 * 60 * 1000 : 3 * 60 * 60 * 1000;
}

/** Bytes currently held in the work dir – used to warn before a big job. */
export async function workDirUsage(): Promise<number> {
  const dir = await ensureWorkDir();
  let total = 0;
  for (const sub of [dir, path.join(dir, "tmp")]) {
    const entries = await fs.readdir(sub).catch(() => [] as string[]);
    for (const entry of entries) {
      const stat = await fs.stat(path.join(sub, entry)).catch(() => null);
      if (stat?.isFile()) total += stat.size;
    }
  }
  return total;
}

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
