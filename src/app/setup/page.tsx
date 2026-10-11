"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Badge, Card, CopyButton, Field, Toggle } from "@/components/ui";
import { TestBench } from "@/components/TestBench";
import {
  FPS_PRESETS,
  HEIGHT_PRESETS,
  PRESETS,
  TARGET_PRESETS,
  type PublicSettingsDTO,
  type SystemStatusDTO,
} from "@/lib/shared";

const STEPS = [
  { id: 1, title: "Bot token", blurb: "Create the bot with @BotFather" },
  { id: 2, title: "Compression profile", blurb: "Size budget, resolution, audio" },
  { id: 3, title: "Connection", blurb: "Webhook or long polling" },
  { id: 4, title: "Verify", blurb: "Test encode + live chat test" },
];

export default function SetupPage() {
  const [settings, setSettings] = useState<PublicSettingsDTO | null>(null);
  const [status, setStatus] = useState<SystemStatusDTO | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
    void (async () => {
      const [sRes, sysRes] = await Promise.all([
        fetch("/api/settings", { cache: "no-store" }),
        fetch("/api/system", { cache: "no-store" }),
      ]);
      if (sRes.ok) {
        const data = (await sRes.json()) as { settings: PublicSettingsDTO };
        setSettings(data.settings);
        setStep(Math.min(4, Math.max(1, data.settings.setupStep)));
      }
      if (sysRes.ok) setStatus((await sysRes.json()) as SystemStatusDTO);
    })();
  }, []);

  const save = useCallback(
    async (patch: Record<string, unknown>, opts: { step?: number; silent?: boolean } = {}) => {
      setBusy("save");
      try {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...patch, ...(opts.step ? { setupStep: opts.step } : {}) }),
        });
        const data = (await res.json()) as { settings?: PublicSettingsDTO; error?: string };
        if (!res.ok || !data.settings) throw new Error(data.error ?? "Save failed");
        setSettings(data.settings);
        if (!opts.silent) setNotice({ tone: "success", text: "Settings saved." });
        return true;
      } catch (err) {
        setNotice({ tone: "error", text: err instanceof Error ? err.message : "Save failed" });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  async function verifyToken() {
    setBusy("verify");
    setNotice(null);
    try {
      const res = await fetch("/api/settings/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: tokenInput.trim() || undefined }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; bot?: { username?: string }; settings?: PublicSettingsDTO };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Verification failed");
      if (data.settings) setSettings(data.settings);
      setTokenInput("");
      setNotice({ tone: "success", text: `Token verified for @${data.bot?.username ?? "bot"}` });
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Verification failed" });
    } finally {
      setBusy(null);
    }
  }

  async function pollAction(action: "start" | "stop") {
    setBusy(action);
    setNotice(null);
    try {
      const res = await fetch("/api/bot/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json()) as { started?: boolean; error?: string };
      if (!res.ok || data.started === false) throw new Error(data.error ?? "Could not change listener state");
      setNotice({
        tone: "success",
        text: action === "start" ? "Listener is live – send a video to your bot." : "Listener stopped.",
      });
      await refresh();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Listener error" });
    } finally {
      setBusy(null);
    }
  }

  async function webhookAction(action: "register" | "remove") {
    setBusy(action);
    setNotice(null);
    try {
      const res =
        action === "register"
          ? await fetch("/api/settings/webhook", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ baseUrl: settings?.publicBaseUrl || origin }),
            })
          : await fetch("/api/settings/webhook", { method: "DELETE" });
      const data = (await res.json()) as { ok?: boolean; error?: string; url?: string; settings?: PublicSettingsDTO };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Webhook call failed");
      if (data.settings) setSettings(data.settings);
      setNotice({
        tone: "success",
        text: action === "register" ? `Webhook registered: ${data.url}` : "Webhook removed.",
      });
      await refresh();
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : "Webhook call failed" });
    } finally {
      setBusy(null);
    }
  }

  const refresh = useCallback(async () => {
    const [sRes, sysRes] = await Promise.all([
      fetch("/api/settings", { cache: "no-store" }),
      fetch("/api/system", { cache: "no-store" }),
    ]);
    if (sRes.ok) setSettings(((await sRes.json()) as { settings: PublicSettingsDTO }).settings);
    if (sysRes.ok) setStatus((await sysRes.json()) as SystemStatusDTO);
  }, []);

  const webhookUrl = useMemo(
    () => `${(settings?.publicBaseUrl || origin).replace(/\/+$/, "")}/api/telegram/webhook`,
    [settings?.publicBaseUrl, origin],
  );

  if (!settings) {
    return <div className="card animate-pulse text-sm text-slate-400">Loading setup…</div>;
  }

  const bitrateHint = (() => {
    if (settings.qualityMode) return "Constant quality mode ignores the size budget and keeps whatever bitrate CRF needs.";
    if (!status) return "";
    const durationExample = 60;
    const audioKbps = settings.keepAudio ? settings.audioBitrateKbps : 0;
    const budgetBytes = settings.targetSizeMb * 1024 * 1024;
    const videoKbps = Math.max(
      12,
      Math.round(((budgetBytes * 0.985) / durationExample) * 8 / 1000) - audioKbps,
    );
    return `For a ${durationExample}s clip that is ≈ ${videoKbps} kbps video + ${audioKbps} kbps audio.`;
  })();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight text-white">Setup wizard</h1>
        <p className="mt-1 text-sm text-slate-400">
          Four short steps: token → compression profile → how the bot listens → verification.
        </p>
      </div>

      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s) => {
          const active = step === s.id;
          const done = step > s.id;
          return (
            <li key={s.id}>
              <button
                onClick={() => setStep(s.id)}
                className={`w-full rounded-xl border p-3.5 text-left transition ${
                  active
                    ? "border-cyan-400/60 bg-cyan-400/10"
                    : done
                      ? "border-emerald-400/30 bg-emerald-400/5"
                      : "border-white/10 bg-white/[0.03] hover:border-white/25"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                    Step {s.id}
                  </span>
                  <span>{done ? "✅" : active ? "●" : "○"}</span>
                </div>
                <p className="mt-1 text-sm font-bold text-slate-100">{s.title}</p>
                <p className="text-[11px] text-slate-500">{s.blurb}</p>
              </button>
            </li>
          );
        })}
      </ol>

      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      {step === 1 && (
        <Card title="1 · Telegram bot token" subtitle="Paste the token @BotFather gave you (format: 123456789:AA…)">
          <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="space-y-4">
              <Field
                label="Bot token"
                hint="Stored server-side in Postgres and only ever sent to api.telegram.org. Leave empty to keep the saved one."
              >
                <input
                  className="input font-mono"
                  placeholder="123456789:AAExampleTokenFromBotFather"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  spellCheck={false}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <button className="btn-primary" disabled={busy !== null || (!tokenInput && !settings.hasToken)} onClick={() => void verifyToken()}>
                  {busy === "verify" ? "Verifying…" : "Verify & save token"}
                </button>
                {settings.hasToken && (
                  <>
                    <Badge tone={settings.tokenVerified ? "green" : "amber"}>
                      {settings.tokenVerified ? "verified" : "not verified"}
                    </Badge>
                    <span className="mono rounded bg-black/40 px-2 py-1 text-slate-400">
                      {settings.botTokenMasked}
                    </span>
                  </>
                )}
              </div>
              {settings.botUsername && (
                <p className="text-xs text-slate-400">
                  Bot: <b className="text-slate-200">{settings.botUsername}</b>
                  {settings.botTitle ? ` · ${settings.botTitle}` : ""}
                </p>
              )}
            </div>
            <div className="space-y-3 rounded-xl border border-white/10 bg-black/25 p-4 text-xs leading-relaxed text-slate-400">
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-300">How to get a token</p>
              <ol className="list-decimal space-y-1.5 pl-4">
                <li>Open Telegram and search for <b className="text-slate-200">@BotFather</b>.</li>
                <li>Send <code className="rounded bg-white/10 px-1">/newbot</code> and pick a name + username.</li>
                <li>Copy the token it replies with and paste it here.</li>
                <li>
                  Optional: send <code className="rounded bg-white/10 px-1">/setprivacy</code> → <i>Disable</i> if you want the
                  bot in groups.
                </li>
              </ol>
              <p className="text-slate-500">
                No Telegram API key or external service is needed — the bot talks straight to api.telegram.org.
              </p>
            </div>
          </div>
          <div className="mt-5 flex justify-between">
            <span />
            <button
              className="btn-primary"
              disabled={!settings.tokenVerified}
              onClick={() => void save({}, { step: 2, silent: true })}
            >
              Next: compression profile →
            </button>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card title="2 · Compression profile" subtitle="What the encoder does to every iPhone video it receives">
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-4">
              <Toggle
                checked={settings.qualityMode}
                onChange={(v) => void save({ qualityMode: v }, { silent: true })}
                label="Constant quality mode (CRF)"
                hint="Best quality, unpredictable size. Turn off to enforce an exact size ceiling."
              />

              {!settings.qualityMode && (
                <>
                  <Field label={`Target size: ${settings.targetSizeMb} MB`} hint={bitrateHint}>
                    <input
                      type="range"
                      min={1}
                      max={100}
                      step={0.5}
                      value={settings.targetSizeMb}
                      onChange={(e) => void save({ targetSizeMb: Number(e.target.value) }, { silent: true })}
                      className="w-full"
                    />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    {TARGET_PRESETS.map((preset) => (
                      <button
                        key={preset.value}
                        onClick={() => void save({ targetSizeMb: preset.value }, { silent: true })}
                        className={`chip transition ${
                          Math.abs(settings.targetSizeMb - preset.value) < 0.01
                            ? "border-cyan-400/50 bg-cyan-400/15 text-cyan-200"
                            : "border-white/10 bg-white/5 text-slate-400 hover:border-white/25"
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Max resolution">
                  <select
                    className="input"
                    value={settings.maxHeight}
                    onChange={(e) => void save({ maxHeight: Number(e.target.value) }, { silent: true })}
                  >
                    {HEIGHT_PRESETS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Max frame rate">
                  <select
                    className="input"
                    value={settings.maxFps}
                    onChange={(e) => void save({ maxFps: Number(e.target.value) }, { silent: true })}
                  >
                    {FPS_PRESETS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <Toggle
                checked={settings.keepAudio}
                onChange={(v) => void save({ keepAudio: v }, { silent: true })}
                label="Keep audio track"
                hint="Re-encoded to AAC. Disabling frees ~10% of the bitrate budget for video."
              />
              {settings.keepAudio && (
                <Field label={`Audio bitrate: ${settings.audioBitrateKbps} kbps`}>
                  <input
                    type="range"
                    min={32}
                    max={192}
                    step={8}
                    value={settings.audioBitrateKbps}
                    onChange={(e) => void save({ audioBitrateKbps: Number(e.target.value) }, { silent: true })}
                    className="w-full"
                  />
                </Field>
              )}
            </div>

            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Video codec" hint={status?.ffmpeg.codecs.libx265 ? "HEVC is ~25% smaller but much slower." : "libx265 binary not detected in this ffmpeg build."}>
                  <select
                    className="input"
                    value={settings.videoCodec}
                    onChange={(e) => void save({ videoCodec: e.target.value }, { silent: true })}
                  >
                    <option value="libx264">H.264 / AVC (compatible)</option>
                    <option value="libx265" disabled={!status?.ffmpeg.codecs.libx265}>
                      H.265 / HEVC (smaller, slower)
                    </option>
                  </select>
                </Field>
                <Field label="Encoder preset" hint="Faster presets use more bits for the same quality.">
                  <select
                    className="input"
                    value={settings.speedPreset}
                    onChange={(e) => void save({ speedPreset: e.target.value }, { silent: true })}
                  >
                    {PRESETS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <Toggle
                checked={settings.twoPass}
                onChange={(v) => void save({ twoPass: v }, { silent: true })}
                label="Two-pass encoding"
                hint="Recommended: pass 1 analyses the clip, pass 2 hits the size budget precisely."
              />

              <Field label={`CRF (quality mode): ${settings.crf}`} hint="Lower = better quality. 20–26 is a sane iPhone range.">
                <input
                  type="range"
                  min={14}
                  max={34}
                  value={settings.crf}
                  onChange={(e) => void save({ crf: Number(e.target.value) }, { silent: true })}
                  className="w-full"
                />
              </Field>

              <Field
                label={`Max source duration: ${settings.maxDurationSec ? Math.round(settings.maxDurationSec / 60) + " min" : "unlimited"}`}
                hint="Rejects longer clips so a 4K screen recording cannot stall the queue."
              >
                <input
                  type="range"
                  min={0}
                  max={3600}
                  step={60}
                  value={settings.maxDurationSec}
                  onChange={(e) => void save({ maxDurationSec: Number(e.target.value) }, { silent: true })}
                  className="w-full"
                />
              </Field>

              <Field label="Send result as" hint="Document preserves the exact bitrate; Video gets a Telegram preview.">
                <select
                  className="input"
                  value={settings.replyMode}
                  onChange={(e) => void save({ replyMode: e.target.value }, { silent: true })}
                >
                  <option value="video">Video (streamable preview)</option>
                  <option value="document">Document (original file)</option>
                </select>
              </Field>

              <Field
                label="Caption template"
                hint="Placeholders: {source} {output} {original} {saved}"
              >
                <input
                  className="input"
                  value={settings.captionTemplate}
                  onChange={(e) => setSettings({ ...settings, captionTemplate: e.target.value })}
                  onBlur={() => void save({ captionTemplate: settings.captionTemplate }, { silent: true })}
                />
              </Field>

              <Field
                label="Allow list (Telegram user IDs)"
                hint="Comma separated. Empty = anyone who finds the bot can use it."
              >
                <input
                  className="input font-mono"
                  value={settings.allowList}
                  onChange={(e) => setSettings({ ...settings, allowList: e.target.value })}
                  onBlur={() => void save({ allowList: settings.allowList }, { silent: true })}
                  placeholder="e.g. 123456789, 987654321"
                />
              </Field>
            </div>
          </div>

          <div className="mt-5 flex justify-between">
            <button className="btn-ghost" onClick={() => setStep(1)}>
              ← Token
            </button>
            <button className="btn-primary" onClick={() => void save({}, { step: 3, silent: true })}>
              Next: connection →
            </button>
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card title="3 · How the bot listens" subtitle="Webhook for public deployments, long polling for local sandboxes">
          <div className="grid gap-5 lg:grid-cols-2">
            <div className={`rounded-2xl border p-4 ${settings.connectionMode === "polling" ? "border-cyan-400/50 bg-cyan-400/5" : "border-white/10 bg-black/25"}`}>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-100">Long polling</h3>
                <Badge tone={status?.poller.running ? "green" : "slate"}>
                  {status?.poller.running ? "running" : "stopped"}
                </Badge>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">
                The app calls <code className="rounded bg-white/10 px-1">getUpdates</code> in a loop. Works behind
                localhost, Docker and sandboxes — no public URL or TLS needed.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {status?.poller.running ? (
                  <button className="btn-danger" disabled={busy !== null} onClick={() => void pollAction("stop")}>
                    ■ Stop listener
                  </button>
                ) : (
                  <button className="btn-primary" disabled={busy !== null} onClick={() => void pollAction("start")}>
                    ▶ Start listener
                  </button>
                )}
                <button
                  className="btn-ghost"
                  disabled={busy !== null}
                  onClick={() => void save({ connectionMode: "polling" }, { silent: true })}
                >
                  Set as default mode
                </button>
              </div>
              {status?.poller.lastError && (
                <p className="mt-3 rounded-lg border border-amber-400/25 bg-amber-400/10 p-2.5 text-[11px] text-amber-100">
                  {status.poller.lastError}
                </p>
              )}
            </div>

            <div className={`rounded-2xl border p-4 ${settings.connectionMode === "webhook" ? "border-cyan-400/50 bg-cyan-400/5" : "border-white/10 bg-black/25"}`}>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-100">Webhook</h3>
                <Badge tone={settings.connectionMode === "webhook" ? "green" : "slate"}>
                  {settings.connectionMode === "webhook" ? "active" : "inactive"}
                </Badge>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">
                Telegram pushes updates to your public HTTPS endpoint. Requires a reachable domain (deploy URL, ngrok,
                Cloudflare Tunnel…).
              </p>
              <div className="mt-3 space-y-3">
                <Field label="Public base URL">
                  <input
                    className="input font-mono text-xs"
                    value={settings.publicBaseUrl ?? origin}
                    onChange={(e) => setSettings({ ...settings, publicBaseUrl: e.target.value })}
                    onBlur={() => void save({ publicBaseUrl: settings.publicBaseUrl ?? origin }, { silent: true })}
                    placeholder="https://my-app.example.com"
                  />
                </Field>
                <div className="flex items-center gap-2">
                  <code className="mono flex-1 truncate rounded bg-black/50 px-2 py-1.5 text-slate-400">{webhookUrl}</code>
                  <CopyButton value={webhookUrl} />
                </div>
                <Field label="Webhook secret token" hint="Sent back as x-telegram-bot-api-secret-token and verified on every call.">
                  <div className="flex items-center gap-2">
                    <input
                      className="input font-mono text-xs"
                      value={settings.webhookSecret}
                      onChange={(e) => setSettings({ ...settings, webhookSecret: e.target.value })}
                      onBlur={() => void save({ webhookSecret: settings.webhookSecret }, { silent: true })}
                    />
                    <CopyButton value={settings.webhookSecret} />
                  </div>
                </Field>
                <div className="flex flex-wrap gap-2">
                  <button className="btn-primary" disabled={busy !== null} onClick={() => void webhookAction("register")}>
                    ⟳ Register webhook
                  </button>
                  <button className="btn-ghost" disabled={busy !== null} onClick={() => void webhookAction("remove")}>
                    ✕ Remove
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 flex justify-between">
            <button className="btn-ghost" onClick={() => setStep(2)}>
              ← Profile
            </button>
            <button className="btn-primary" onClick={() => void save({}, { step: 4, silent: true })}>
              Next: verify →
            </button>
          </div>
        </Card>
      )}

      {step === 4 && (
        <div className="space-y-6">
          <Card title="4 · Verify the pipeline" subtitle="Encode a clip in the browser, then try it live in Telegram">
            <TestBench compact />
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <CheckRow ok={settings.tokenVerified} label="Token verified" detail={settings.botUsername ?? "—"} />
              <CheckRow
                ok={status?.poller.running || settings.connectionMode === "webhook"}
                label="Listener"
                detail={settings.connectionMode === "webhook" ? "webhook mode" : status?.poller.running ? "polling live" : "not started"}
              />
              <CheckRow ok={Boolean(status?.ffmpeg.available)} label="ffmpeg" detail={status?.ffmpeg.version?.split(" ").slice(0, 2).join(" ") ?? "—"} />
            </div>
          </Card>

          <Card title="Live Telegram test" subtitle="Everything is wired — just send a clip to the bot">
            <ol className="list-decimal space-y-2 pl-5 text-xs leading-relaxed text-slate-400">
              <li>
                Start the listener in step 3 (or register the webhook if this deployment has a public HTTPS URL).
              </li>
              <li>
                Open <b className="text-slate-200">{settings.botUsername ?? "your bot"}</b> in Telegram and press{" "}
                <b className="text-slate-200">Start</b>.
              </li>
              <li>
                Send a video — compress it as a <b className="text-slate-200">file</b> (not a preview) from your iPhone so
                Telegram does not re-compress it first.
              </li>
              <li>Watch the job appear live on the dashboard; the compressed MP4 is returned to the same chat.</li>
            </ol>
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="btn-ghost" onClick={() => void refresh()}>
                ⟳ Refresh status
              </button>
              <button
                className="btn-primary"
                disabled={busy !== null}
                onClick={async () => {
                  await save({ setupComplete: true }, { step: 4 });
                }}
              >
                ✓ Mark setup complete
              </button>
              {settings.setupComplete && <Badge tone="green">setup complete</Badge>}
            </div>
            <div className="mt-4">
              <Alert tone="info">
                Telegram limits bot file downloads to <b>20 MB</b> and uploads to <b>50 MB</b> on the standard Bot API.
                Larger iPhone clips should be trimmed, or run a{" "}
                <span className="underline">local Bot API server</span> and set{" "}
                <code className="rounded bg-white/10 px-1">TELEGRAM_API_BASE</code>.
              </Alert>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function CheckRow({ ok, label, detail }: { ok?: boolean; label: string; detail: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/25 p-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">{label}</p>
        <span className={ok ? "text-emerald-400" : "text-amber-400"}>{ok ? "✓" : "!"}</span>
      </div>
      <p className="mono mt-1 truncate text-slate-300">{detail}</p>
    </div>
  );
}
