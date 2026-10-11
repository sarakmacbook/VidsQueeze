import { NextResponse } from "next/server";
import { getSettingsRow, updateSettings } from "@/lib/settings";
import { handleTelegramUpdate, logEvent } from "@/lib/queue";
import type { TgUpdate } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Vercel Hobby caps a function at 300s. The encode itself runs in `after()`
 * (see `scheduleDrain`), which shares this same budget – so this value is the
 * real ceiling for how long one clip may take. Raise it on Pro (up to 800).
 */
export const maxDuration = 300;

/**
 * Telegram calls this endpoint. Requests must carry the shared secret.
 *
 * This is the only connection mode that works on serverless hosts: answer
 * Telegram immediately with 200, then keep encoding in the background.
 */
export async function POST(request: Request) {
  const invocationStartedAt = Date.now();
  const settings = await getSettingsRow();
  const provided = request.headers.get("x-telegram-bot-api-secret-token");

  if (settings.webhookSecret && provided !== settings.webhookSecret) {
    await logEvent("warn", "webhook", "Rejected webhook call with an invalid secret token");
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const update = (await request.json().catch(() => null)) as TgUpdate | null;
  if (!update) return NextResponse.json({ ok: true });

  try {
    // The invocation clock is passed down so the queue knows how much of this
    // function's lifetime is left before it starts an encode.
    await handleTelegramUpdate(update, { invocationStartedAt });
    await updateSettings({ lastWebhookAt: new Date() }).catch(() => undefined);
  } catch (err) {
    await logEvent("error", "webhook", err instanceof Error ? err.message : "update handling failed");
  }

  // Always answer 200 quickly so Telegram does not retry-storm the endpoint.
  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    hint: "Telegram webhook receiver. Configure this URL with POST /api/settings/webhook.",
  });
}
