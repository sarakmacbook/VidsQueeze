import { NextResponse } from "next/server";
import { getSettingsRow } from "@/lib/settings";
import { handleTelegramUpdate, logEvent } from "@/lib/queue";
import type { TgUpdate } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Telegram calls this endpoint. Requests must carry the shared secret. */
export async function POST(request: Request) {
  const settings = await getSettingsRow();
  const provided = request.headers.get("x-telegram-bot-api-secret-token");

  if (settings.webhookSecret && provided !== settings.webhookSecret) {
    await logEvent("warn", "webhook", "Rejected webhook call with an invalid secret token");
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const update = (await request.json().catch(() => null)) as TgUpdate | null;
  if (!update) return NextResponse.json({ ok: true });

  try {
    await handleTelegramUpdate(update);
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
