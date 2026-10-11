# VidSqueeze — Telegram bot that shrinks iPhone videos

A Next.js + Postgres (Drizzle) app that runs a **Telegram bot** which automatically
re-encodes iPhone clips (HEVC / MOV / MP4, 4K 60 fps…) down to a **configurable size
ceiling** using a two-pass ffmpeg encode. Everything is configured from the built-in
WebUI — no external services, the encoding happens locally.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fsarakmacbook%2FVidsQueeze)

## WebUI

| Page | Purpose |
| --- | --- |
| `/` **Dashboard** | Live readiness checklist, encoder/binary info, queue state, job list with progress bars, activity feed, start/stop listener controls. |
| `/setup` **Setup wizard** | 4 steps: ① bot token (verified against `getMe`) → ② compression profile → ③ connection mode (long polling or webhook) → ④ verification with the test bench. |
| `/test` **Test bench** | Drag & drop a clip to run the exact same pipeline in the browser, plus a bitrate budget calculator. |

## Setup requirements (what the wizard asks for)

1. **Bot token** — from [@BotFather](https://t.me/BotFather). Verified with `getMe` and stored in Postgres; the API never returns the raw token (masked as `123456:••••1234`).
2. **Compression profile**
   - target size in MB (or constant-quality CRF mode)
   - max resolution (480p…4K or keep source), max fps
   - audio on/off + AAC bitrate
   - codec H.264/AVC or H.265/HEVC, x264 speed preset
   - two-pass encoding on/off, max source duration
   - reply as `video` (preview) or `document` (untouched file), caption template
   - Telegram user-ID allow list
3. **Connection**
   - *Long polling* — works on localhost/sandboxes, no public URL. Start/stop from the UI.
   - *Webhook* — needs a public HTTPS base URL; the app registers `POST /api/telegram/webhook` with a shared secret token and rejects calls that do not carry it. **This is the mode to use on Vercel.**
4. **Verify** — encode a sample clip, then send a real video to the bot.

## HTTP API

| Route | Description |
| --- | --- |
| `GET/PUT /api/settings` | Read (token masked) / update configuration |
| `POST /api/settings/verify` | `getMe` token verification |
| `GET/POST/DELETE /api/settings/webhook` | Webhook info / register / remove |
| `GET/POST /api/bot/poll` | Long-polling listener status / start & stop |
| `GET/POST /api/compress` | Limits probe / multipart upload → queued job (test bench) |
| `GET /api/jobs`, `GET/DELETE /api/jobs/:id`, `GET /api/jobs/:id/download` | Job list, detail, delete, result download |
| `GET/POST /api/cron/drain` | Queue safety net + scratch cleanup (Vercel Cron, `CRON_SECRET`) |
| `GET /api/system` | ffmpeg/binaries, queue, listener, platform, statistics |
| `GET /api/health` | DB + schema + ffmpeg healthcheck |

## How the sizing works

1. `ffprobe` reads duration, real display dimensions (honouring iPhone rotation metadata), fps, codec and source bitrate.
2. The video bitrate budget is `targetBytes × 0.985 − (audioBitrate × duration)`, capped at the source bitrate so bits are never wasted.
3. Pass 1 analyses the clip, pass 2 encodes with `+faststart`, `-pix_fmt yuv420p`, an H.264 `high` profile and even dimensions so the result plays everywhere.
4. If the output still overshoots, the bitrate is recalculated and the encode is retried (up to 3 attempts) before failing with a readable message.

---

# Deploying on Vercel

VidSqueeze runs on Vercel as-is: ffmpeg is bundled into the function, the schema
creates itself on first request, and the Telegram bot answers in milliseconds while
the encode continues in the background.

## 1. Create a Postgres database

Any Postgres works — [Neon](https://neon.tech), [Supabase](https://supabase.com),
Vercel Postgres, or RDS. Copy the pooled/connection string.

> **Region matters.** `vercel.json` pins functions to `sin1` (Singapore). Put the
> database in the same region or every job pays an extra round trip. Change both
> together if you prefer `iad1`, `fra1`, etc.

## 2. Deploy

Click the **Deploy** button above, or:

```bash
npm i -g vercel
vercel            # preview
vercel --prod     # production
```

Add these environment variables in **Project → Settings → Environment Variables**
(apply to Production *and* Preview):

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | Connection string. A `?sslmode=require` suffix is honoured automatically. |
| `CRON_SECRET` | auto | Vercel generates this when it sees `crons` in `vercel.json`, then sends it as `Authorization: Bearer …`. Set your own to lock `/api/cron/drain` down. |
| `DATABASE_SSL_MODE` | – | Only if your URL has no `sslmode` but the server still needs TLS (`require`, `verify-full`, `disable`). |
| `MAX_UPLOAD_MB` | – | Browser test-bench ceiling. Defaults to **4** on Vercel, 300 elsewhere. |
| `VIDSQUEEZE_TMP_BUDGET_MB` | – | Scratch-space guard. Defaults to 384 MB on Vercel. |
| `TELEGRAM_API_BASE` | – | Self-hosted Bot API server, to lift the 20 MB / 50 MB limits. |

Then open the deployment, run the **setup wizard**, and in step ③ choose
**Webhook**. The base URL is pre-filled from your deployment domain — register it
and send your bot a video.

There is no migration step: the first request to any API route creates the tables
(`src/db/migrate.ts`). Hitting `/api/health` once after deploying is enough to
bootstrap a brand-new database. `npm run db:push` still works locally if you prefer
to apply the schema up front.

## What changes on a serverless host

VidSqueeze detects Vercel at runtime (`src/lib/platform.ts`) and adapts. Nothing to
configure — but it helps to know what is different:

| | Long-lived host (Docker/VPS) | Vercel |
| --- | --- | --- |
| **Telegram connection** | Long polling *or* webhook | **Webhook only** — a polling loop would be frozen the instant a request ended. The UI disables the button and says why. |
| **Job queue** | Postgres-backed, drained in-process | Postgres-backed, drained inside `after()` once the response is sent |
| **Who picks up a job** | The one running process | Any invocation; `FOR UPDATE SKIP LOCKED` + a lease (`locked_at`/`locked_by`) guarantee exactly one worker per job |
| **Crashed mid-encode** | Job is stuck | Lease goes stale after 15 min and the job is re-claimed automatically |
| **Encode time limit** | Unbounded | 300s (Hobby) / up to 800s (Pro) per invocation, shared with the request |
| **Browser uploads** | 300 MB | **4 MB** — Vercel rejects any request body over 4.5 MB at the edge |
| **Scratch space** | Your disk | `/tmp`, 512 MB, wiped between invocations |
| **Result downloads** | Available for 3 h | Only while the same instance is warm — the Telegram bot is the reliable delivery path |

**The Telegram bot itself is not limited by the 4.5 MB body cap.** It downloads the
source from Telegram's servers and uploads the result back to them; the video never
travels through an inbound request body. The cap only affects the `/test` page.

### How a job actually runs

```
Telegram ──POST /api/telegram/webhook──▶ validate secret
                                          │ insert job row (status=queued)
                                          │ scheduleDrain() → after(...)
                                          ▼
                                     200 OK in ~50 ms   ← Telegram is happy
                                          ┊ (same invocation keeps running)
                                          ▼
                              claim lease → download → ffprobe
                              → 2-pass encode → sendVideo
                                          ▼
                                     release lease, job=done
```

`GET /api/cron/drain` is the safety net for the jobs that fall through the cracks —
an invocation killed mid-encode, or a job queued while nothing was running. It is
scheduled daily in `vercel.json` because **Hobby plans cannot run cron more often
than once per day** (a per-minute expression fails the deployment outright). On Pro,
change it to `"* * * * *"` for a real minute-by-minute drainer:

```json
{ "crons": [{ "path": "/api/cron/drain", "schedule": "* * * * *" }] }
```

You can also trigger it by hand: `POST /api/cron/drain` with
`Authorization: Bearer $CRON_SECRET`.

## Function size budget

Vercel rejects a function over **250 MB unzipped**. ffmpeg (76 MB) and ffprobe
(62 MB) are most of that, so `next.config.ts` traces *only* the `linux/x64`
binaries — `ffprobe-static` ships every platform in its npm package (336 MB), and
pulling all of it in would fail the build immediately.

Check it any time:

```bash
npm run verify:bundle
#   ✓   139.6 MB  /api/telegram/webhook
#   OK: largest function is 139.6 MB, 110.4 MB of headroom.
```

Neither package can be traced automatically — both compute their binary path from
`process.platform`/`process.arch` at runtime, which the bundler cannot evaluate — so
`outputFileTracingIncludes` names them explicitly. Remove that config and every job
fails with *"ffmpeg binaries unavailable"* only after deploying.

`npm run deploy:check` runs typecheck + lint + build + the size guard in one go.

## Vercel troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Serverless Function has exceeded the unzipped maximum size of 250 MB` | Something else joined the bundle. Run `npm run verify:bundle`; as a last resort set `VERCEL_SUPPORT_LARGE_FUNCTIONS=1` (Fluid Compute). |
| `ffmpeg binaries unavailable on this host` | `outputFileTracingIncludes` was removed, or the build skipped `ffmpeg-static`'s download. Redeploy without a cached `node_modules`; you can point `FFMPEG_BINARIES_URL` at an internal mirror. |
| `FUNCTION_PAYLOAD_TOO_LARGE` / `413` on `/test` | Expected — the 4.5 MB body cap. Use the Telegram bot, or run on a long-lived host. |
| `The server does not support SSL connections` | TLS was forced against a plain cluster. Unset `DATABASE_SSL_MODE` or set it to `disable`. |
| Job stuck in `processing` forever | The invocation was killed. The lease expires after 15 min and the cron drainer retries it; trigger `/api/cron/drain` manually to retry now. |
| `Hobby accounts are limited to daily cron jobs` | A cron schedule more frequent than daily. Keep `0 0 * * *` or upgrade to Pro. |
| Bot never replies | Webhook not registered, or the base URL is a preview domain. Re-register from step ③; check `/api/system` → `settings.publicBaseUrl`. |
| Encodes fail on long clips | 300s is the whole budget for download + 2 passes + upload. Lower resolution, use `ultrafast`, disable two-pass, or raise `maxDuration` (Pro). |

## Running elsewhere

The serverless adaptations are all conditional, so a long-lived host keeps the full
feature set — long polling, 300 MB browser uploads, unbounded encode time,
persistent result downloads:

```bash
docker run …  # or: npm run build && npm start
DATABASE_URL=postgresql://… npm run db:push   # optional, the app self-migrates
```

Set `VIDSQUEEZE_SERVERLESS=1` to force serverless behaviour on a platform that is
not auto-detected.

---

## Limits to know about

* The standard Bot API lets a **bot download files up to 20 MB** and upload up to 50 MB. Larger clips must be trimmed, or run a [local Bot API server](https://github.com/tdlib/telegram-bot-api) and set `TELEGRAM_API_BASE`.
* The web test bench accepts uploads up to 300 MB — except on serverless hosts, where the 4.5 MB request-body cap applies.

## Environment

```
DATABASE_URL=postgresql://…      # required
FFMPEG_PATH=/usr/bin/ffmpeg      # optional, otherwise ffmpeg-static is used
FFPROBE_PATH=/usr/bin/ffprobe    # optional
VIDSQUEEZE_DIR=/tmp/vidsqueeze   # optional scratch/output dir
TELEGRAM_API_BASE=…              # optional, for a local Bot API server
CRON_SECRET=…                    # optional, guards /api/cron/drain
```

See [`.env.example`](.env.example) for the full annotated list.
