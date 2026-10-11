# VidSqueeze — Telegram bot that shrinks iPhone videos

A Next.js + Postgres (Drizzle) app that runs a **Telegram bot** which automatically
re-encodes iPhone clips (HEVC / MOV / MP4, 4K 60 fps…) down to a **configurable size
ceiling** using a two-pass ffmpeg encode. Everything is configured from the built-in
WebUI — no external services, the encoding happens locally.

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
   - *Webhook* — needs a public HTTPS base URL; the app registers `POST /api/telegram/webhook` with a shared secret token and rejects calls that do not carry it.
4. **Verify** — encode a sample clip, then send a real video to the bot.

## HTTP API

| Route | Description |
| --- | --- |
| `GET/PUT /api/settings` | Read (token masked) / update configuration |
| `POST /api/settings/verify` | `getMe` token verification |
| `GET/POST/DELETE /api/settings/webhook` | Webhook info / register / remove |
| `GET/POST /api/bot/poll` | Long-polling listener status / start & stop |
| `POST /api/telegram/webhook` | Telegram update receiver (secret checked) |
| `POST /api/compress` | Multipart upload → queued job (test bench) |
| `GET /api/jobs`, `GET/DELETE /api/jobs/:id`, `GET /api/jobs/:id/download` | Job list, detail, delete, result download |
| `GET /api/system` | ffmpeg/binaries, queue, listener, statistics |
| `GET /api/health` | DB + ffmpeg healthcheck |

## How the sizing works

1. `ffprobe` reads duration, real display dimensions (honouring iPhone rotation metadata), fps, codec and source bitrate.
2. The video bitrate budget is `targetBytes × 0.985 − (audioBitrate × duration)`, capped at the source bitrate so bits are never wasted.
3. Pass 1 analyses the clip, pass 2 encodes with `+faststart`, `-pix_fmt yuv420p`, an H.264 `high` profile and even dimensions so the result plays everywhere.
4. If the output still overshoots, the bitrate is recalculated and the encode is retried (up to 3 attempts) before failing with a readable message.

## Limits to know about

* The standard Bot API lets a **bot download files up to 20 MB** and upload up to 50 MB. Larger clips must be trimmed, or run a [local Bot API server](https://github.com/tdlib/telegram-bot-api) and set `TELEGRAM_API_BASE`.
* The web test bench accepts uploads up to 300 MB.

## Environment

```
DATABASE_URL=postgresql://…      # required
FFMPEG_PATH=/usr/bin/ffmpeg      # optional, otherwise ffmpeg-static is used
FFPROBE_PATH=/usr/bin/ffprobe    # optional
VIDSQUEEZE_DIR=/tmp/vidsqueeze   # optional scratch/output dir
TELEGRAM_API_BASE=…              # optional, for a local Bot API server
```
