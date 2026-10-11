import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ffmpeg-static / ffprobe-static ship platform native binaries – keep them
  // external so the bundler does not try to inline the executable paths.
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static"],
  experimental: {
    serverActions: {
      bodySizeLimit: "300mb",
    },
  },
};

export default nextConfig;
