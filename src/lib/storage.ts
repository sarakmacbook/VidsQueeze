import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

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

/** Remove workdir artefacts older than `maxAgeMs`. */
export async function cleanupOldFiles(maxAgeMs = 3 * 60 * 60 * 1000): Promise<void> {
  const dir = await ensureWorkDir();
  const now = Date.now();
  const entries = await fs.readdir(dir).catch(() => []);
  for (const entry of entries) {
    if (!entry.endsWith(".mp4")) continue;
    const full = path.join(dir, entry);
    try {
      const stat = await fs.stat(full);
      if (now - stat.mtimeMs > maxAgeMs) await fs.unlink(full);
    } catch {
      /* ignore */
    }
  }
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
