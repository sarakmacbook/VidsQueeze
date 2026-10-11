import type { NextConfig } from "next";

/**
 * Vercel builds on linux-x64 even when you develop on macOS or Windows, so pin
 * the traced binaries to the *deploy* platform.
 *
 * This matters a lot for size: `ffprobe-static` ships every platform in the npm
 * package (336 MB total). Tracing the whole directory would blow straight past
 * Vercel's 250 MB unzipped function limit, so we point at one binary.
 */
const DEPLOY_PLATFORM = process.env.VERCEL ? "linux" : process.platform;
const DEPLOY_ARCH = process.env.VERCEL ? "x64" : process.arch;

/**
 * Neither `ffmpeg-static` nor `ffprobe-static` can be traced statically: both
 * compute their binary path at runtime from `process.platform`/`process.arch`,
 * which `@vercel/nft` cannot evaluate. Without this the binaries are silently
 * missing from the deployed function and every job fails with "ffmpeg binaries
 * unavailable".
 */
const ffmpegBinaries = [
  // ffmpeg-static downloads a single `ffmpeg` (or `ffmpeg.exe`) next to index.js
  "./node_modules/ffmpeg-static/ffmpeg",
  "./node_modules/ffmpeg-static/ffmpeg.exe",
  // ffprobe-static keeps per-platform builds under bin/<os>/<arch>/
  `./node_modules/ffprobe-static/bin/${DEPLOY_PLATFORM}/${DEPLOY_ARCH}/ffprobe`,
  `./node_modules/ffprobe-static/bin/${DEPLOY_PLATFORM}/${DEPLOY_ARCH}/ffprobe.exe`,
];

const nextConfig: NextConfig = {
  // ffmpeg-static / ffprobe-static ship platform native binaries – keep them
  // external so the bundler does not try to inline the executable paths.
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static"],

  outputFileTracingIncludes: {
    // Every API route can end up spawning the encoder, and Next may group
    // several of them into one function, so include the binaries for all of
    // them. The dashboard pages are static and produce no function.
    "/api/**": ffmpegBinaries,
    "/**": ffmpegBinaries,
  },

  experimental: {
    serverActions: {
      bodySizeLimit: "300mb",
    },
  },
};

export default nextConfig;
