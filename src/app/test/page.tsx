"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Alert, Badge, Card, Field } from "@/components/ui";
import { TestBench } from "@/components/TestBench";
import { formatBytes, type PublicSettingsDTO, type SystemStatusDTO } from "@/lib/shared";

export default function TestPage() {
  const [settings, setSettings] = useState<PublicSettingsDTO | null>(null);
  const [status, setStatus] = useState<SystemStatusDTO | null>(null);
  const [duration, setDuration] = useState(60);

  useEffect(() => {
    void (async () => {
      const [sRes, sysRes] = await Promise.all([
        fetch("/api/settings", { cache: "no-store" }),
        fetch("/api/system", { cache: "no-store" }),
      ]);
      if (sRes.ok) setSettings(((await sRes.json()) as { settings: PublicSettingsDTO }).settings);
      if (sysRes.ok) setStatus((await sysRes.json()) as SystemStatusDTO);
    })();
  }, []);

  const calc = useMemo(() => {
    if (!settings) return null;
    if (settings.qualityMode) return null;
    const audioKbps = settings.keepAudio ? settings.audioBitrateKbps : 0;
    const budgetBytes = settings.targetSizeMb * 1024 * 1024;
    const videoKbps = Math.max(12, Math.round(((budgetBytes * 0.985) / Math.max(1, duration)) * 8) / 1000 - audioKbps);
    const totalKbps = videoKbps + audioKbps;
    return { audioKbps, videoKbps, totalKbps, mb: (totalKbps * duration) / 8 / 1000 };
  }, [settings, duration]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-white">Test bench</h1>
          <p className="mt-1 text-sm text-slate-400">
            Run the exact same two-pass encoder the Telegram bot uses, straight from the browser.
          </p>
        </div>
        <Link href="/setup" className="btn-ghost">
          ⚙ Change profile
        </Link>
      </div>

      {settings && (
        <Card title="Active profile" subtitle="Saved in Postgres, used by both the bot and this bench">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Info label="Size budget" value={settings.qualityMode ? `CRF ${settings.crf}` : `${settings.targetSizeMb} MB`} />
            <Info label="Resolution" value={settings.maxHeight ? `${settings.maxHeight}p max` : "source resolution"} />
            <Info label="Frame rate" value={settings.maxFps ? `${settings.maxFps} fps max` : "source fps"} />
            <Info
              label="Encoder"
              value={`${settings.videoCodec === "libx265" ? "HEVC" : "H.264"} · ${settings.speedPreset}`}
              extra={settings.twoPass ? "two-pass" : "single-pass"}
            />
            <Info label="Audio" value={settings.keepAudio ? `AAC ${settings.audioBitrateKbps} kbps` : "removed"} />
            <Info label="Reply as" value={settings.replyMode} />
            <Info label="Allow list" value={settings.allowList ? `${settings.allowList.split(",").length} user(s)` : "everyone"} />
            <Info label="Max duration" value={settings.maxDurationSec ? `${Math.round(settings.maxDurationSec / 60)} min` : "unlimited"} />
          </div>

          {calc && (
            <div className="mt-5 rounded-xl border border-white/10 bg-black/30 p-4">
              <Field label={`Bitrate preview for a ${duration}s clip`} hint="Same maths the encoder uses to hit the budget.">
                <input
                  type="range"
                  min={5}
                  max={600}
                  step={5}
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                  className="w-full"
                />
              </Field>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <Info label="Video bitrate" value={`${calc.videoKbps} kbps`} />
                <Info label="Audio bitrate" value={`${calc.audioKbps} kbps`} />
                <Info label="Resulting file" value={`${calc.mb.toFixed(2)} MB`} extra={`budget ${formatBytes(settings.targetSizeMb * 1024 * 1024)}`} />
              </div>
            </div>
          )}
        </Card>
      )}

      {status && !status.ffmpeg.available && (
        <Alert tone="error">
          ffmpeg was not found on the server. Install it (<code className="rounded bg-white/10 px-1">apt-get install ffmpeg</code>)
          or set <code className="rounded bg-white/10 px-1">FFMPEG_PATH</code> / <code className="rounded bg-white/10 px-1">FFPROBE_PATH</code>.
        </Alert>
      )}

      <TestBench />

      <Card title="How the sizing works" subtitle="Why iPhone HEVC clips shrink so well">
        <div className="grid gap-4 text-xs leading-relaxed text-slate-400 sm:grid-cols-3">
          <div>
            <Badge tone="cyan">1 · Probe</Badge>
            <p className="mt-2">
              ffprobe reads duration, real display dimensions (including iPhone rotation metadata), fps, codec and the
              original bitrate.
            </p>
          </div>
          <div>
            <Badge tone="cyan">2 · Budget</Badge>
            <p className="mt-2">
              Target bytes × 0.985 minus the AAC audio stream gives the exact video bitrate for the clip length, capped at
              the source bitrate so quality is never wasted.
            </p>
          </div>
          <div>
            <Badge tone="cyan">3 · Two-pass encode</Badge>
            <p className="mt-2">
              Pass 1 analyses complexity, pass 2 encodes with <code className="rounded bg-white/10 px-1">+faststart</code>{" "}
              for instant playback. If the output still overshoots, the bitrate is recalculated and the encode retries.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Info({ label, value, extra }: { label: string; value: string; extra?: string }) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.03] p-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-bold text-slate-100">{value}</p>
      {extra && <p className="text-[10px] text-slate-500">{extra}</p>}
    </div>
  );
}
