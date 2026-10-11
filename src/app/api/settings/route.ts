import { NextResponse } from "next/server";
import { getSettingsRow, toPublicSettings, updateSettings, type SettingsPatch } from "@/lib/settings";
import { logEvent } from "@/lib/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const row = await getSettingsRow();
  return NextResponse.json({ settings: toPublicSettings(row) });
}

const NUMERIC: Array<{ key: keyof SettingsPatch; min: number; max: number; integer?: boolean }> = [
  { key: "targetSizeMb", min: 0.1, max: 4096 },
  { key: "maxDurationSec", min: 0, max: 60 * 180 },
  { key: "maxHeight", min: 0, max: 4320 },
  { key: "maxFps", min: 0, max: 120 },
  { key: "audioBitrateKbps", min: 32, max: 320 },
  { key: "crf", min: 14, max: 40 },
];

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    await getSettingsRow();
    const patch: SettingsPatch = {};

    for (const spec of NUMERIC) {
      if (body[spec.key as string] === undefined) continue;
      let value = Number(body[spec.key as string]);
      if (!Number.isFinite(value)) continue;
      value = Math.min(spec.max, Math.max(spec.min, value));
      (patch as Record<string, unknown>)[spec.key as string] = spec.integer ? Math.round(value) : value;
    }

    if (typeof body.videoCodec === "string" && ["libx264", "libx265"].includes(body.videoCodec)) {
      patch.videoCodec = body.videoCodec;
    }
    if (typeof body.speedPreset === "string") patch.speedPreset = body.speedPreset;
    if (typeof body.replyMode === "string" && ["video", "document"].includes(body.replyMode)) {
      patch.replyMode = body.replyMode;
    }
    if (typeof body.connectionMode === "string" && ["polling", "webhook"].includes(body.connectionMode)) {
      patch.connectionMode = body.connectionMode;
    }
    for (const key of ["keepAudio", "twoPass", "qualityMode"] as const) {
      if (typeof body[key] === "boolean") patch[key] = body[key] as boolean;
    }
    if (typeof body.captionTemplate === "string") patch.captionTemplate = body.captionTemplate.slice(0, 500);
    if (typeof body.allowList === "string") patch.allowList = body.allowList.slice(0, 2000);
    if (typeof body.publicBaseUrl === "string") {
      patch.publicBaseUrl = body.publicBaseUrl.trim().replace(/\/+$/, "").slice(0, 300);
    }
    if (typeof body.webhookSecret === "string" && body.webhookSecret.trim().length >= 6) {
      patch.webhookSecret = body.webhookSecret.trim().slice(0, 128);
    }
    if (typeof body.botToken === "string") {
      const token = body.botToken.trim();
      if (token === "") {
        // empty string = keep existing token
      } else if (token === "__CLEAR__") {
        patch.botToken = null;
        patch.tokenVerified = false;
        patch.botUsername = null;
      } else if (token.length > 20 && token.includes(":")) {
        patch.botToken = token;
        patch.tokenVerified = false;
      }
    }
    if (typeof body.setupStep === "number") patch.setupStep = Math.min(4, Math.max(1, Math.round(body.setupStep)));
    if (typeof body.setupComplete === "boolean") patch.setupComplete = body.setupComplete;

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    const row = await updateSettings(patch);
    if (patch.botToken) await logEvent("info", "setup", "Bot token saved from the WebUI");
    return NextResponse.json({ settings: toPublicSettings(row) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save settings" },
      { status: 500 },
    );
  }
}
