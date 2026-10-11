import { NextResponse } from "next/server";
import { getRawToken, getSettingsRow, toPublicSettings, updateSettings } from "@/lib/settings";
import { getMe } from "@/lib/telegram";
import { logEvent } from "@/lib/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Verifies a bot token with the Telegram API (getMe) and stores it when valid. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { token?: string };
  const candidate = body.token?.trim();
  const token = candidate && candidate.length > 20 ? candidate : await getRawToken();

  if (!token) {
    return NextResponse.json({ ok: false, error: "No bot token provided" }, { status: 400 });
  }

  try {
    const me = await getMe(token);
    const row = await updateSettings({
      botToken: token,
      tokenVerified: true,
      botUsername: me.username ? `@${me.username}` : null,
      botTitle: me.first_name ?? null,
    });
    await logEvent("success", "setup", `Verified bot ${me.username ? `@${me.username}` : me.id}`);
    return NextResponse.json({ ok: true, bot: me, settings: toPublicSettings(row) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Token verification failed";
    await updateSettings({ tokenVerified: false });
    await logEvent("error", "setup", `Token rejected: ${message}`);
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function GET() {
  const row = await getSettingsRow();
  return NextResponse.json({
    hasToken: row.tokenVerified,
    botUsername: row.botUsername,
    botTitle: row.botTitle,
  });
}
