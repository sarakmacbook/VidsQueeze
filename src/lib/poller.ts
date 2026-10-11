import { getRawToken, getSettingsRow, updateSettings } from "@/lib/settings";
import { deleteWebhook, getUpdates, TelegramError } from "@/lib/telegram";
import { handleTelegramUpdate, logEvent } from "@/lib/queue";
import { longPollingBlockedReason, supportsLongPolling } from "@/lib/platform";

type PollerState = {
  running: boolean;
  loopId: number;
  startedAt: number | null;
  lastPollAt: number | null;
  lastError: string | null;
  processed: number;
  controller: AbortController | null;
};

const globalForPoller = globalThis as typeof globalThis & { __vidsqueezePoller?: PollerState };

function poller(): PollerState {
  if (!globalForPoller.__vidsqueezePoller) {
    globalForPoller.__vidsqueezePoller = {
      running: false,
      loopId: 0,
      startedAt: null,
      lastPollAt: null,
      lastError: null,
      processed: 0,
      controller: null,
    };
  }
  return globalForPoller.__vidsqueezePoller;
}

export function pollerSnapshot() {
  const p = poller();
  return {
    running: p.running,
    startedAt: p.startedAt,
    lastPollAt: p.lastPollAt,
    lastError: p.lastError,
    processed: p.processed,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function loop(loopId: number): Promise<void> {
  const p = poller();
  while (p.running && p.loopId === loopId && !p.controller?.signal.aborted) {
    const token = await getRawToken();
    if (!token) {
      p.lastError = "No bot token configured";
      await stopPolling("No bot token configured");
      return;
    }
    try {
      const settings = await getSettingsRow();
      const offset = settings.lastUpdateId + 1;
      const updates = await getUpdates(token, offset, 25, p.controller?.signal);
      p.lastPollAt = Date.now();
      for (const update of updates) {
        await handleTelegramUpdate(update);
        await updateSettings({ lastUpdateId: update.update_id });
        p.processed += 1;
      }
      p.lastError = null;
    } catch (err) {
      if (p.controller?.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      p.lastError = message;
      if (err instanceof TelegramError && err.code === 409) {
        // A webhook is still registered for this bot – remove it and retry.
        await deleteWebhook(token, false).catch(() => undefined);
      }
      await logEvent("warn", "poller", message.slice(0, 300));
      await sleep(3000);
    }
  }
}

export async function startPolling(): Promise<{ started: boolean; error?: string }> {
  // A polling loop only survives inside a process that never exits. Serverless
  // platforms freeze the function the moment the HTTP response is sent, so the
  // loop would silently stop after one request.
  if (!supportsLongPolling()) {
    const reason = longPollingBlockedReason() ?? "Long polling is not supported on this host.";
    await logEvent("warn", "poller", reason);
    return { started: false, error: reason };
  }

  const token = await getRawToken();
  if (!token) return { started: false, error: "Add a bot token before starting the listener." };

  const p = poller();
  if (p.running) return { started: true };

  // Polling and webhooks are mutually exclusive in the Bot API.
  await deleteWebhook(token, false).catch(() => undefined);

  p.running = true;
  p.loopId += 1;
  p.startedAt = Date.now();
  p.lastError = null;
  p.controller = new AbortController();
  await updateSettings({ connectionMode: "polling", pollingActive: true });
  await logEvent("info", "poller", "Long polling listener started");
  void loop(p.loopId);
  return { started: true };
}

export async function stopPolling(reason = "Stopped from the dashboard"): Promise<{ stopped: boolean }> {
  const p = poller();
  p.running = false;
  p.controller?.abort();
  p.controller = null;
  await updateSettings({ pollingActive: false });
  await logEvent("info", "poller", `Long polling listener stopped (${reason})`);
  return { stopped: true };
}

/** Resume the listener after a server restart when it was left enabled. */
export async function autoResume(): Promise<void> {
  if (!supportsLongPolling()) return;
  try {
    const settings = await getSettingsRow();
    if (!settings.pollingActive || settings.connectionMode !== "polling") return;
    if (poller().running) return;
    if (!(await getRawToken())) return;
    await startPolling();
  } catch {
    /* ignore */
  }
}
