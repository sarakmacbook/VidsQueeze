import path from "node:path";
import { promises as fs } from "node:fs";
import { binaries, probeVideo, run, type ProbeResult } from "@/lib/ffmpeg";
import { workDir } from "@/lib/storage";

export type CompressProfile = {
  qualityMode: boolean;
  targetSizeMb: number;
  maxHeight: number;
  maxFps: number;
  keepAudio: boolean;
  audioBitrateKbps: number;
  videoCodec: string;
  speedPreset: string;
  twoPass: boolean;
  crf: number;
};

export type ProgressUpdate = {
  progress: number;
  stage: string;
  bitrateKbps?: number;
  dimensions?: string;
};

export type CompressArgs = {
  inputPath: string;
  outputPath: string;
  profile: CompressProfile;
  targetBytes?: number;
  onProgress?: (update: ProgressUpdate) => void | Promise<void>;
  onLog?: (line: string) => void | Promise<void>;
  signal?: AbortSignal;
  /**
   * Wall-clock ms after which the platform kills this invocation. Each pass is
   * given only the time that is actually left, so a too-slow encode fails with
   * a readable message instead of being cut off mid-write.
   */
  deadlineMs?: number;
};

export type CompressResult = {
  probe: ProbeResult;
  outputBytes: number;
  width: number;
  height: number;
  durationSec: number;
  videoBitrateKbps: number;
  passes: number;
  command: string;
  log: string;
};

const AUDIO_OVERHEAD_FACTOR = 0.985;
const MIN_VIDEO_BPS = 12_000;
const MAX_ATTEMPTS = 3;
/** Generous ceiling for a long-lived host; serverless uses its own deadline. */
const DEFAULT_PASS_TIMEOUT_MS = 30 * 60 * 1000;
/** Below this there is no point starting another pass. */
const MIN_PASS_TIMEOUT_MS = 15_000;

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

export function displayDimensions(
  width: number,
  height: number,
  rotation: number,
): { width: number; height: number } {
  const swap = Math.abs(rotation) % 180 === 90;
  return swap ? { width: height, height: width } : { width, height };
}

export function planDimensions(
  probe: ProbeResult,
  maxHeightSetting: number,
): { width: number; height: number; scaled: boolean } {
  const display = displayDimensions(probe.width, probe.height, probe.rotation);
  if (!maxHeightSetting || display.height <= maxHeightSetting) {
    return {
      width: even(display.width),
      height: even(display.height),
      scaled: false,
    };
  }
  const ratio = maxHeightSetting / display.height;
  return {
    width: even(display.width * ratio),
    height: even(display.height * ratio),
    scaled: true,
  };
}

export function bitratePlan(
  probe: ProbeResult,
  profile: CompressProfile,
  targetBytes: number,
  dims: { width: number; height: number },
  scaled: boolean,
): { videoBps: number; audioBps: number; note: string } {
  const duration = Math.max(0.5, probe.durationSec);
  const audioBps = profile.keepAudio && probe.hasAudio ? profile.audioBitrateKbps * 1000 : 0;
  const usableBytes = targetBytes * AUDIO_OVERHEAD_FACTOR - (audioBps / 8) * duration;
  let videoBps = Math.floor((usableBytes * 8) / duration);
  let note = "Two-pass bitrate budget from target size";

  // Never spend more bits than the source actually has when the target is generous.
  const sourceVideoBps = Math.max(0, probe.totalBitrate - audioBps);
  if (sourceVideoBps > 0 && videoBps > sourceVideoBps * 0.97) {
    videoBps = Math.floor(sourceVideoBps * 0.97);
    note = scaled
      ? "Target larger than source – using source bitrate with a downscale"
      : "Target larger than source – copying source bitrate";
  }

  return { videoBps: Math.max(MIN_VIDEO_BPS, videoBps), audioBps, note };
}

function codecArgs(profile: CompressProfile, bps?: number): string[] {
  const args: string[] = ["-c:v", profile.videoCodec];
  if (profile.videoCodec === "libx264") {
    args.push("-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p", "-tag:v", "avc1");
  } else {
    args.push("-pix_fmt", "yuv420p", "-tag:v", "hvc1");
  }
  if (typeof bps === "number") {
    args.push(
      "-b:v",
      `${bps}`,
      "-maxrate",
      `${Math.floor(bps * 1.45)}`,
      "-bufsize",
      `${Math.floor(bps * 2.5)}`,
    );
  } else {
    args.push("-crf", String(profile.crf));
  }
  args.push("-preset", profile.speedPreset);
  return args;
}

function fpsArgs(probe: ProbeResult, maxFps: number): string[] {
  if (maxFps > 0 && probe.fps > maxFps + 0.5) return ["-r", String(maxFps)];
  return [];
}

function audioArgs(probe: ProbeResult, profile: CompressProfile): string[] {
  if (!profile.keepAudio || !probe.hasAudio) return ["-an"];
  return ["-c:a", "aac", "-b:a", `${profile.audioBitrateKbps}k`, "-ac", "2"];
}

function progressReader(
  totalSec: number,
  from: number,
  to: number,
  handler: (fraction: number) => void | Promise<void>,
): (chunk: string) => void {
  let carry = "";
  return (chunk: string) => {
    carry += chunk;
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^out_time_us=(\d+)/.exec(line.trim());
      if (!match || totalSec <= 0) continue;
      const seconds = Number(match[1]) / 1_000_000;
      const fraction = Math.min(1, Math.max(0, seconds / totalSec));
      void handler(fraction);
    }
  };
}

/**
 * Compresses a video so that the produced file fits under the configured size
 * budget. Uses a two-pass x264/x265 encode and, if the first attempt still
 * overshoots the budget, recalculates the bitrate and retries.
 */
export async function compressVideo(args: CompressArgs): Promise<CompressResult> {
  const bins = binaries();
  if (!bins) throw new Error("ffmpeg binaries unavailable – install ffmpeg or set FFMPEG_PATH");

  const { inputPath, outputPath, profile, onProgress, onLog, signal } = args;

  /** Time budget for a single ffmpeg pass. */
  const passTimeout = (): number => {
    const remaining = args.deadlineMs ? args.deadlineMs - Date.now() : DEFAULT_PASS_TIMEOUT_MS;
    if (remaining < MIN_PASS_TIMEOUT_MS) {
      throw new Error(
        `Ran out of time before the encode could finish (only ${Math.max(0, Math.round(remaining / 1000))}s left). ` +
          `Shorten the clip, lower the resolution, disable two-pass encoding, or run on a host with a longer limit.`,
      );
    }
    return Math.min(DEFAULT_PASS_TIMEOUT_MS, remaining);
  };
  const log: string[] = [];
  const write = async (line: string) => {
    log.push(line);
    if (log.length > 400) log.splice(0, log.length - 400);
    await onLog?.(line);
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.rm(outputPath, { force: true });

  const probe = await probeVideo(inputPath);
  if (!probe.durationSec) throw new Error("Could not determine video duration");

  const targetBytes =
    args.targetBytes ?? (profile.qualityMode ? 0 : Math.round(profile.targetSizeMb * 1024 * 1024));

  const dims = planDimensions(probe, profile.maxHeight);
  const scaleArgs =
    probe.width && (dims.width !== even(probe.width) || dims.height !== even(probe.height))
      ? ["-vf", `scale=${dims.width}:${dims.height}:flags=bicubic`]
      : [];

  await write(
    `probe: ${probe.width}x${probe.height} (${probe.codec}) ${probe.durationSec.toFixed(1)}s ` +
      `${Math.round(probe.totalBitrate / 1000)} kbps fps=${probe.fps} audio=${probe.hasAudio}`,
  );

  await onProgress?.({ progress: 4, stage: "Analyzing source", dimensions: `${dims.width}×${dims.height}` });

  let videoBps = 0;
  let planNote = "";
  if (!profile.qualityMode && targetBytes > 0) {
    const plan = bitratePlan(probe, profile, targetBytes, dims, dims.scaled);
    videoBps = plan.videoBps;
    planNote = plan.note;
    await write(`plan: ${planNote} → video ${Math.round(videoBps / 1000)} kbps`);
  } else {
    planNote = `Constant quality mode (CRF ${profile.crf})`;
    await write(`plan: ${planNote}`);
  }

  const passStats = path.join(workDir(), "tmp", `pass-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const fps = fpsArgs(probe, profile.maxFps);
  const audio = audioArgs(probe, profile);
  const maps = ["-map", "0:v:0", ...(probe.hasAudio && profile.keepAudio ? ["-map", "0:a:0?"] : [])];
  const tail = ["-movflags", "+faststart", "-f", "mp4"];

  const runPass = async (
    pass: 1 | 2 | 0,
    outPath: string,
    bps: number | undefined,
    from: number,
    to: number,
  ): Promise<void> => {
    const cmd = [
      "-hide_banner",
      "-y",
      "-i",
      inputPath,
      ...maps,
      ...scaleArgs,
      ...codecArgs(profile, bps),
      ...fps,
      ...audio,
    ];
    if (pass === 1) {
      cmd.push("-pass", "1", "-passlogfile", passStats, "-an", "-f", "mp4", "/dev/null");
    } else if (pass === 2) {
      cmd.push("-pass", "2", "-passlogfile", passStats);
    }
    cmd.push(...tail, "-nostats", "-progress", "pipe:1", outPath);

    await write(`ffmpeg ${cmd.filter((c) => c !== inputPath && c !== outPath).join(" ")}`);

    const res = await run(bins.ffmpeg, cmd, {
      timeoutMs: passTimeout(),
      signal,
      onStdout: progressReader(probe.durationSec, from, to, async (fraction) => {
        const share = from + (to - from) * fraction;
        await onProgress?.({
          progress: Math.round(share),
          stage:
            pass === 1
              ? "Pass 1/2 – analyzing complexity"
              : pass === 2
                ? `Pass 2/2 – encoding ${Math.round(fraction * 100)}%`
                : `Encoding ${Math.round(fraction * 100)}%`,
        });
      }),
    });

    if (res.code !== 0) {
      const tailErr = res.stderr.split("\n").filter(Boolean).slice(-4).join(" | ");
      throw new Error(`ffmpeg exited with code ${res.code}: ${tailErr || "unknown error"}`);
    }
  };

  let passes = 0;
  if (profile.qualityMode || targetBytes <= 0) {
    passes = 1;
    await runPass(0, outputPath, undefined, 5, 95);
  } else if (profile.twoPass) {
    passes = 2;
    await onProgress?.({ progress: 5, stage: "Pass 1/2 – analyzing", dimensions: `${dims.width}×${dims.height}` });
    await runPass(1, outputPath, videoBps, 5, 40);
    await onProgress?.({ progress: 42, stage: "Pass 2/2 – encoding", dimensions: `${dims.width}×${dims.height}` });
    await runPass(2, outputPath, videoBps, 42, 94);
  } else {
    passes = 1;
    await runPass(0, outputPath, videoBps, 5, 94);
  }

  let size = (await fs.stat(outputPath)).size;
  let attempt = 1;

  while (!profile.qualityMode && targetBytes > 0 && size > targetBytes && attempt < MAX_ATTEMPTS) {
    attempt += 1;
    const ratio = (targetBytes * 0.94) / size;
    videoBps = Math.max(MIN_VIDEO_BPS, Math.floor(videoBps * ratio));
    await write(`overshoot: ${size} > ${targetBytes} bytes → retry #${attempt} at ${Math.round(videoBps / 1000)} kbps`);
    await onProgress?.({
      progress: 55,
      stage: `Retrying at lower bitrate (attempt ${attempt})`,
      bitrateKbps: Math.round(videoBps / 1000),
    });
    passes += profile.twoPass ? 2 : 1;
    if (profile.twoPass) {
      await runPass(1, outputPath, videoBps, 55, 68);
      await runPass(2, outputPath, videoBps, 68, 94);
    } else {
      await runPass(0, outputPath, videoBps, 55, 94);
    }
    size = (await fs.stat(outputPath)).size;
  }

  if (!profile.qualityMode && targetBytes > 0 && size > targetBytes) {
    throw new Error(
      `Could not reach ${(targetBytes / 1024 / 1024).toFixed(1)} MB budget – best result was ${(size / 1024 / 1024).toFixed(2)} MB. Try lowering resolution or duration.`,
    );
  }

  const outProbe = await probeVideo(outputPath).catch(() => null);
  await fs.rm(`${passStats}-0.log`, { force: true }).catch(() => {});
  await fs.rm(`${passStats}-0.log.mbtree`, { force: true }).catch(() => {});
  await fs.rm(`${passStats}-2.log`, { force: true }).catch(() => {});

  await onProgress?.({ progress: 99, stage: "Finalizing" });

  return {
    probe,
    outputBytes: size,
    width: outProbe?.width ?? dims.width,
    height: outProbe?.height ?? dims.height,
    durationSec: outProbe?.durationSec ?? probe.durationSec,
    videoBitrateKbps: Math.round((size * 8) / Math.max(1, probe.durationSec) / 1000),
    passes,
    command: planNote,
    log: log.join("\n"),
  };
}
