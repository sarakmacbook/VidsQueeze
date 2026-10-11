"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Badge, Card, Progress } from "@/components/ui";
import { formatBytes, formatDuration, type JobDTO } from "@/lib/shared";

type Props = { compact?: boolean };

export function TestBench({ compact = false }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<JobDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!job) return;
    if (["done", "error", "cancelled"].includes(job.status)) return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/jobs/${job.id}`, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { job: JobDTO };
        setJob(data.job);
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [job]);

  const upload = useCallback(async () => {
    if (!file) return;
    setUploading(true);
    setError(null);
    setJob(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/compress", { method: "POST", body: form });
      const data = (await res.json()) as { jobId?: number; error?: string };
      if (!res.ok || !data.jobId) throw new Error(data.error ?? "Upload failed");
      const jobRes = await fetch(`/api/jobs/${data.jobId}`, { cache: "no-store" });
      const jobData = (await jobRes.json()) as { job: JobDTO };
      setJob(jobData.job);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
    }, [file]);
  // eslint-disable-next-line react-hooks/exhaustive-deps

  const running = job ? ["queued", "downloading", "processing", "uploading"].includes(job.status) : false;
  const saved =
    job && job.sourceBytes > 0 && job.outputBytes > 0
      ? Math.max(0, Math.round((1 - job.outputBytes / job.sourceBytes) * 100))
      : null;

  return (
    <Card
      title="Compression test bench"
      subtitle="Upload an iPhone clip and watch the exact pipeline the bot runs"
      right={job ? <Badge tone={job.status === "done" ? "green" : job.status === "error" ? "red" : "amber"}>{job.status}</Badge> : undefined}
    >
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const dropped = e.dataTransfer.files?.[0];
          if (dropped) setFile(dropped);
        }}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-2xl border-2 border-dashed p-6 text-center transition ${
          dragging ? "border-cyan-400/70 bg-cyan-400/10" : "border-white/15 bg-black/25 hover:border-white/30"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="video/*,.mov,.mp4,.m4v"
          className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <p className="text-3xl">📱</p>
        <p className="mt-2 text-sm font-semibold text-slate-200">
          {file ? file.name : "Drop a .MOV / .MP4 clip here"}
        </p>
        <p className="mt-1 text-[11px] text-slate-500">
          {file
            ? formatBytes(file.size)
            : "Max 300 MB · the file never leaves this server, it is encoded locally with ffmpeg"}
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button className="btn-primary" disabled={!file || uploading || running} onClick={() => void upload()}>
          {uploading ? "Uploading…" : running ? "Encoding…" : "⚡ Compress now"}
        </button>
        {file && (
          <button className="btn-ghost" onClick={() => setFile(null)} disabled={running}>
            Clear
          </button>
        )}
        {!compact && (
          <span className="text-[11px] text-slate-500">
            Uses the profile saved in the setup wizard.
          </span>
        )}
      </div>

      {error && (
        <div className="mt-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {job && (
        <div className="mt-5 space-y-3 rounded-xl border border-white/10 bg-black/30 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-slate-100">Job #{job.id}</span>
            <span className="text-[11px] text-slate-500">{job.stage}</span>
          </div>
          <Progress value={job.progress} tone={job.status === "error" ? "rose" : "cyan"} />

          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="Source" value={formatBytes(job.sourceBytes)} hint={`${job.sourceWidth}×${job.sourceHeight} · ${formatDuration(job.sourceDurationSec)} · ${job.sourceCodec ?? "?"}`} />
            <Metric label="Output" value={job.outputBytes ? formatBytes(job.outputBytes) : "—"} hint={job.outputHeight ? `${job.outputWidth}×${job.outputHeight} · ${Math.round(job.videoBitrate / 1000)} kbps` : job.stage} />
            <Metric label="Saved" value={saved !== null ? `${saved}%` : "—"} tone={saved !== null ? "good" : "default"} hint={job.targetBytes ? `budget ${formatBytes(job.targetBytes)}` : "constant quality"} />
          </div>

          {job.status === "done" && (
            <div className="flex flex-wrap items-center gap-2">
              <a className="btn-primary" href={`/api/jobs/${job.id}/download`}>
                ⤓ Download compressed MP4
              </a>
              <span className="text-[11px] text-slate-500">
                Finished in{" "}
                {job.startedAt && job.finishedAt
                  ? `${Math.max(1, Math.round((new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()) / 1000))}s`
                  : "—"}
              </span>
            </div>
          )}

          {job.error && <Alert tone="error">{job.error}</Alert>}

          {job.log && (
            <details className="rounded-lg border border-white/10 bg-black/50 p-3">
              <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                Encoder log
              </summary>
              <pre className="mono mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-slate-500">{job.log}</pre>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

function Metric({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "good";
}) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.03] p-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-black ${tone === "good" ? "text-emerald-300" : "text-slate-100"}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[10px] text-slate-500">{hint}</p>}
    </div>
  );
}
