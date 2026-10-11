import { NextResponse } from "next/server";
import { getRawToken, getSettingsRow, toPublicSettings, updateSettings } from "@/lib/settings";
import { deleteWebhook, getWebhookInfo, setWebhook } from "@/lib/telegram";
import { logEvent } from "@/lib/queue";
import { stopPolling } from "@/lib/poller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeBase(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** Registers the Telegram webhook for this deployment. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { baseUrl?: string };
  const settings = await getSettingsRow();
  const base = normalizeBase(body.baseUrl || settings.publicBaseUrl || "");
  const token = await getRawToken();

  if (!token) return NextResponse.json({ ok: false, error: "Save a verified bot token first" }, { status: 400 });
  if (!base.startsWith("https://")) {
    return NextResponse.json(
      { ok: false, error: "Telegram only accepts public HTTPS URLs for webhooks" },
      { status: 400 },
    );
  }

  const url = `${base}/api/telegram/webhook`;
  try {
    await setWebhook(token, url, settings.webhookSecret);
    await stopPolling("switching to webhook mode");
    const info = await getWebhookInfo(token);
    const row = await updateSettings({
      connectionMode: "webhook",
      publicBaseUrl: base,
      pollingActive: false,
      lastWebhookAt: null,
    });
    await logEvent("success", "webhook", `Webhook registered: ${url}`);
    return NextResponse.json({ ok: true, url, info, settings: toPublicSettings(row) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "setWebhook failed";
    await logEvent("error", "webhook", message);
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

/** Removes the webhook (needed before long polling can run). */
export async function DELETE() {
  const token = await getRawToken();
  if (!token) return NextResponse.json({ ok: false, error: "No bot token configured" }, { status: 400 });
  try {
    await deleteWebhook(token, false);
    const info = await getWebhookInfo(token);
    const row = await updateSettings({ connectionMode: "polling" });
    await logEvent("info", "webhook", "Webhook removed");
    return NextResponse.json({ ok: true, info, settings: toPublicSettings(row) });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "deleteWebhook failed" },
      { status: 400 },
    );
  }
}

export async function GET() {
  const token = await getRawToken();
  const settings = await getSettingsRow();
  if (!token) return NextResponse.json({ info: null, settings: toPublicSettings(settings) });
  try {
    const info = await getWebhookInfo(token);
    return NextResponse.json({ info, settings: toPublicSettings(settings) });
  } catch (err) {
    return NextResponse.json({
      info: null,
      error: err instanceof Error ? err.message : "getWebhookInfo failed",
      settings: toPublicSettings(settings),
    });
  }
}
