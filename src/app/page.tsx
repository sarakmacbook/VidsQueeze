"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Alert, Badge, Card, Progress, Stat } from "@/components/ui";
import {
  formatBytes,
  formatDuration,
  relativeTime,
  STATUS_STYLES,
  type EventDTO,
  type JobDTO,
  type SystemStatusDTO,
} from "@/lib/shared";

export default function DashboardPage() {
  const [status, setStatus] = useState<SystemStatusDTO | null>(null);
  const [jobs, setJobs] = useState<JobDTO[]>([]);
  const [events, setEvents] = useState<EventDTO[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [sysRes, jobRes] = await Promise.all([
        fetch("/api/system", { cache: "no-store" }),
        fetch("/api/jobs?limit=20", { cache: "no-store" }),
      ]);
      if (sysRes.ok) setStatus((await sysRes.json()) as SystemStatusDTO);
      if (jobRes.ok) {
        const data = (await jobRes.json()) as { jobs: JobDTO[]; events: EventDTO[] };
        setJobs(data.jobs ?? []);
        setEvents(data.events ?? []);
      }
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => clearInterval(timer);
  }, [load]);

  async function control(action: "start" | "stop" | "webhook" | "removeWebhook") {
    setBusy(action);
    setNotice(null);
    try {
      let res: Response;
      if (action === "webhook") {
        const base =
          status?.settings.publicBaseUrl ||
          (typeof window !== "undefined" ? window.location.origin : "");
        res = await fetch("/api/settings/webhook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseUrl: base }),
        });
      } else if (action === "removeWebhook") {
        res = await fetch("/api/settings/webhook", { method: "DELETE" });
      } else {
        res = await fetch("/api/bot/poll", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        });
      }
      const data = (await res.json()) as { error?: string; url?: string };
      setNotice(
        res.ok
          ? {
              tone: "success",
              text:
                action === "webhook"
                  ? `Webhook registered at ${data.url}`
                  : action === "stop"
                    ? "Listener stopped."
                    : action === "removeWebhook"
                      ? "Webhook removed – long polling can now run."
                      : "Listener running. Send a video to your bot!",
            }
          : { tone: "error", text: data.error ?? "Request failed" },
      );
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function removeJob(id: number) {
    await fetch(`/api/jobs/${id}`, { method: "DELETE" });
    await load();
  }

  if (!status) {
    return (
      <div className="card animate-pulse">
        <p className="text-sm text-slate-400">Loading system status…</p>
      </div>
    );
  }

  const { settings, ffmpeg, stats, queue, poller } = status;
  const checklist = [
    {
      label: "ffmpeg encoder available",
      ok: ffmpeg.available,
      detail: ffmpeg.version ?? "install ffmpeg or set FFMPEG_PATH",
    },
    {
      label: "Bot token verified",
      ok: settings.tokenVerified,
      detail: settings.botUsername ?? "no token saved",
    },
    {
      label: settings.connectionMode === "webhook" ? "Webhook registered" : "Long-poll listener running",
      ok: settings.connectionMode === "webhook" ? Boolean(settings.publicBaseUrl) && !poller.lastError : poller.running,
      detail:
        settings.connectionMode === "webhook"
          ? settings.publicBaseUrl
            ? `${settings.publicBaseUrl}/api/telegram/webhook`
            : "set a public HTTPS base URL"
          : poller.running
            ? `listening · ${poller.processed} updates`
            : "listener stopped",
    },
    {
      label: "Compression profile configured",
      ok: settings.qualityMode || settings.targetSizeMb > 0,
      detail: settings.qualityMode
        ? `Constant quality CRF ${settings.crf}`
        : `${settings.targetSizeMb} MB · ${settings.maxHeight || "source"}p · ${settings.maxFps || "source"} fps`,
    },
  ];
  const ready = checklist.every((c) => c.ok);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-white">Control room</h1>
          <p className="mt-1 text-sm text-slate-400">
            Live status of the encoder, the Telegram listener and every compression job.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/test" className="btn-ghost">
            ▶ Test bench
          </Link>
          <Link href="/setup" className="btn-primary">
            {settings.setupComplete ? "Open setup" : "Finish setup"} →
          </Link>
        </div>
      </div>

      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      {!ready && (
        <Alert tone="warn">
          Setup is not finished.{" "}
          <Link href="/setup" className="font-semibold underline">
            Open the setup wizard
          </Link>{" "}
          to {checklist.filter((c) => !c.ok).map((c) => c.label.toLowerCase()).join(", ")}.
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Encoder"
          value={ffmpeg.available ? "Ready" : "Missing"}
          tone={ffmpeg.available ? "good" : "bad"}
          hint={ffmpeg.version?.slice(0, 44) ?? "ffmpeg binary not found"}
        />
        <Stat
          label="Bot"
          value={settings.tokenVerified ? "Verified" : "Not set"}
          tone={settings.tokenVerified ? "good" : "warn"}
          hint={settings.botUsername ?? "no token configured"}
        />
        <Stat
          label="Listener"
          value={
            settings.connectionMode === "webhook"
              ? "Webhook"
              : poller.running
                ? "Polling"
                : "Offline"
          }
          tone={settings.connectionMode === "webhook" ? (poller.lastError ? "warn" : "good") : poller.running ? "good" : "warn"}
          hint={
            settings.connectionMode === "webhook"
              ? poller.lastError
                ? `webhook error: ${poller.lastError.slice(0, 40)}`
                : "waiting for Telegram calls"
              : poller.running
                ? `last poll ${relativeTime(poller.lastPollAt ? new Date(poller.lastPollAt).toISOString() : null)}`
                : "start it to receive videos"
          }
        />
        <Stat
          label="Queue"
          value={`${queue.active !== null ? 1 : 0} / ${queue.pending}`}
          hint={`${queue.dbActive} processing · ${queue.queued} queued`}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Jobs completed" value={stats.done} hint={`${stats.total} total`} tone="good" />
        <Stat label="Failed" value={stats.failed} tone={stats.failed ? "bad" : "default"} />
        <Stat label="Bytes ingested" value={formatBytes(stats.bytesIn)} hint="uploaded to the bot" />
        <Stat
          label="Bytes delivered"
          value={formatBytes(stats.bytesOut)}
          hint={
            stats.bytesIn > stats.bytesOut
              ? `saved ${formatBytes(stats.bytesIn - stats.bytesOut)}`
              : "no savings yet"
          }
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <Card
          title="Readiness checklist"
          subtitle="Everything the bot needs before it can answer a video message"
          right={<Badge tone={ready ? "green" : "amber"}>{ready ? "ready" : "incomplete"}</Badge>}
        >
          <ul className="space-y-2.5">
            {checklist.map((item) => (
              <li
                key={item.label}
                className="flex items-start justify-between gap-3 rounded-xl border border-white/5 bg-black/25 px-3.5 py-3"
              >
                <div>
                  <p className="text-sm font-semibold text-slate-200">{item.label}</p>
                  <p className="mono mt-0.5 break-all text-slate-500">{item.detail}</p>
                </div>
                <span className={item.ok ? "text-emerald-400" : "text-amber-400"}>{item.ok ? "✓" : "!"}</span>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex flex-wrap gap-2">
            {settings.connectionMode === "webhook" ? (
              <>
                <button className="btn-ghost" disabled={busy !== null} onClick={() => void control("webhook")}>
                  ⟳ Re-register webhook
                </button>
                <button className="btn-ghost" disabled={busy !== null} onClick={() => void control("removeWebhook")}>
                  ✕ Remove webhook
                </button>
              </>
            ) : poller.running ? (
              <button className="btn-danger" disabled={busy !== null} onClick={() => void control("stop")}>
                ■ Stop listener
              </button>
            ) : (
              <button className="btn-primary" disabled={busy !== null} onClick={() => void control("start")}>
                ▶ Start listener (long polling)
              </button>
            )}
          </div>

          {ffmpeg.available && (
            <p className="mono mt-4 break-all rounded-lg bg-black/40 p-3 text-slate-500">
              ffmpeg: {ffmpeg.ffmpegPath}
              <br />
              ffprobe: {ffmpeg.ffprobePath}
              <br />
              codecs: {ffmpeg.codecs.libx264 ? "libx264 ✓" : "libx264 ✗"} ·{" "}
              {ffmpeg.codecs.libx265 ? "libx265 ✓" : "libx265 ✗"}
            </p>
          )}
        </Card>

        <Card title="Activity" subtitle="Last 12 pipeline events">
          <ul className="space-y-2">
            {events.length === 0 && <li className="text-xs text-slate-500">Nothing yet.</li>}
            {events.map((event) => (
              <li key={event.id} className="rounded-lg border border-white/5 bg-black/25 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <Badge tone={event.level === "error" ? "red" : event.level === "success" ? "green" : event.level === "warn" ? "amber" : "cyan"}>
                    {event.scope}
                  </Badge>
                  <span className="text-[10px] text-slate-500">{relativeTime(event.createdAt)}</span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-300">{event.message}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card title="Jobs" subtitle="Telegram and web test-bench compressions" right={<Badge tone="cyan">auto-refresh 2.5s</Badge>}>
        {jobs.length === 0 ? (
          <p className="text-sm text-slate-500">
            No jobs yet. Send a video to your bot or upload one in the{" "}
            <Link href="/test" className="text-cyan-300 underline">
              test bench
            </Link>
            .
          </p>
        ) : (
          <div className="space-y-3">
            {jobs.map((job) => {
              const running = ["queued", "downloading", "processing", "uploading"].includes(job.status);
              return (
                <div key={job.id} className="rounded-xl border border-white/10 bg-black/30 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="text-xs font-black text-slate-500">#{job.id}</span>
                      <span className="truncate text-sm font-semibold text-slate-100">{job.fileName}</span>
                      <span className={`chip ${STATUS_STYLES[job.status] ?? STATUS_STYLES.queued}`}>{job.status}</span>
                      <span className="chip border-white/10 bg-white/5 text-slate-400">{job.source}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-slate-500">{relativeTime(job.createdAt)}</span>
                      {job.status === "done" && (
                        <a className="btn-ghost px-2.5! py-1! text-[11px]" href={`/api/jobs/${job.id}/download`}>
                          ⤓ Download
                        </a>
                      )}
                      {!running && (
                        <button className="btn-danger px-2.5! py-1! text-[11px]" onClick={() => void removeJob(job.id)}>
                          Delete
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="mt-3">
                    <Progress value={job.progress} tone={job.status === "error" ? "rose" : "cyan"} />
                    <p className="mt-1.5 text-[11px] text-slate-500">{job.stage}</p>
                  </div>

                  <div className="mt-3 grid gap-2 text-[11px] text-slate-400 sm:grid-cols-2 lg:grid-cols-4">
                    <span>
                      Source: <b className="text-slate-200">{formatBytes(job.sourceBytes)}</b>
                      {job.sourceHeight ? ` · ${job.sourceWidth}×${job.sourceHeight}` : ""}
                      {job.sourceDurationSec ? ` · ${formatDuration(job.sourceDurationSec)}` : ""}
                    </span>
                    <span>
                      Target:{" "}
                      <b className="text-slate-200">{job.targetBytes ? formatBytes(job.targetBytes) : "CRF quality"}</b>
                    </span>
                    <span>
                      Output:{" "}
                      <b className={job.outputBytes ? "text-emerald-300" : "text-slate-200"}>
                        {job.outputBytes ? formatBytes(job.outputBytes) : "—"}
                      </b>
                      {job.outputHeight ? ` · ${job.outputWidth}×${job.outputHeight}` : ""}
                    </span>
                    <span>
                      Bitrate: <b className="text-slate-200">{job.videoBitrate ? `${Math.round(job.videoBitrate / 1000)} kbps` : "—"}</b>
                    </span>
                  </div>

                  {job.error && (
                    <p className="mt-2 rounded-lg border border-rose-400/25 bg-rose-500/10 p-2.5 text-[11px] text-rose-200">
                      {job.error}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
