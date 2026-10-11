import { db } from "@/db";
import { botSettings, type BotSettingsRow } from "@/db/schema";
import { eq } from "drizzle-orm";

export const SETTINGS_ID = 1;

export function randomSecret(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export async function getSettingsRow(): Promise<BotSettingsRow> {
  const existing = await db
    .select()
    .from(botSettings)
    .where(eq(botSettings.id, SETTINGS_ID))
    .limit(1);

  if (existing.length > 0) return existing[0];

  const inserted = await db
    .insert(botSettings)
    .values({ id: SETTINGS_ID, webhookSecret: randomSecret() })
    .onConflictDoNothing()
    .returning();

  if (inserted.length > 0) return inserted[0];

  const retry = await db
    .select()
    .from(botSettings)
    .where(eq(botSettings.id, SETTINGS_ID))
    .limit(1);
  return retry[0];
}

export type SettingsPatch = Partial<Omit<BotSettingsRow, "id" | "createdAt">>;

export async function updateSettings(patch: SettingsPatch): Promise<BotSettingsRow> {
  await getSettingsRow();
  const rows = await db
    .update(botSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(botSettings.id, SETTINGS_ID))
    .returning();
  return rows[0];
}

export function maskToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const clean = token.trim();
  if (clean.length < 12) return "•".repeat(clean.length);
  const [idPart, ...rest] = clean.split(":");
  const secret = rest.join(":");
  const tail = secret.slice(-4);
  return `${idPart}:${"•".repeat(Math.max(6, secret.length - 4))}${tail}`;
}

/** Shape returned to the browser – never includes the raw bot token. */
export type PublicSettings = Omit<BotSettingsRow, "botToken"> & {
  hasToken: boolean;
  botTokenMasked: string | null;
};

export function toPublicSettings(row: BotSettingsRow): PublicSettings {
  const { botToken, ...rest } = row;
  return {
    ...rest,
    hasToken: Boolean(botToken && botToken.trim().length > 10),
    botTokenMasked: maskToken(botToken),
  };
}

export async function getRawToken(): Promise<string | null> {
  const row = await getSettingsRow();
  const token = row.botToken?.trim();
  return token && token.length > 10 ? token : null;
}

export function parseAllowList(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export const CLIP_CHOICES = [480, 720, 1080, 1440, 2160];
export const PRESET_CHOICES = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
];
