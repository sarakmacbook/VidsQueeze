/**
 * Runtime / hosting detection.
 *
 * VidSqueeze was written for a long-running host (a VPS, a container, your
 * laptop) where a Telegram long-polling loop and an in-memory job queue can
 * live forever. Serverless platforms such as Vercel freeze or kill a function
 * as soon as it answers a request, so the same code paths need to behave
 * differently there:
 *
 *   - long polling is impossible            -> webhook mode only
 *   - the in-memory queue cannot be trusted -> Postgres-backed queue + after()
 *   - /tmp is small and wiped constantly    -> tighter scratch budget
 *   - request bodies are capped (4.5 MB)    -> smaller web upload limit
 *
 * Everything below is derived from environment variables, so the app never has
 * to be rebuilt to move between hosts.
 */

/** True when running on Vercel (build or runtime). */
export function isVercel(): boolean {
  return process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
}

/**
 * True when the process is a short-lived function rather than a persistent
 * server. Covers Vercel plus any plain AWS Lambda / Fastly Compute host.
 */
export function isServerless(): boolean {
  return (
    isVercel() ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
    Boolean(process.env.VERCEL_REGION) ||
    // Escape hatch for other platforms (Fly machines, Cloud Run jobs, …).
    process.env.VIDSQUEEZE_SERVERLESS === "1"
  );
}

export type RuntimeMode = "serverless" | "persistent";

export function runtimeMode(): RuntimeMode {
  return isServerless() ? "serverless" : "persistent";
}

/** Human-readable label used by the dashboard. */
export function platformName(): string {
  if (isVercel()) return `Vercel (${process.env.VERCEL_ENV ?? "unknown"})`;
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return "AWS Lambda";
  if (process.env.FLY_APP_NAME) return `Fly.io (${process.env.FLY_APP_NAME})`;
  if (process.env.RENDER) return "Render";
  if (process.env.RAILWAY_ENVIRONMENT) return "Railway";
  return "Self-hosted";
}

/** Vercel deployment region, e.g. `sin1`. */
export function region(): string | null {
  return process.env.VERCEL_REGION ?? process.env.AWS_REGION ?? null;
}

/** Deployment id – handy when reading logs for one specific release. */
export function deploymentId(): string | null {
  return process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Vercel Functions reject any request body larger than 4.5 MB at the edge with
 * `413 FUNCTION_PAYLOAD_TOO_LARGE`, before our handler ever runs. Multipart
 * encoding adds a little overhead on top of the raw file, so we keep a margin.
 */
export const VERCEL_BODY_LIMIT_BYTES = 4.5 * 1024 * 1024;
export const SERVERLESS_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;
export const PERSISTENT_UPLOAD_LIMIT_BYTES = 300 * 1024 * 1024;

/** Largest upload the web test bench will accept on this host. */
export function maxUploadBytes(): number {
  const override = Number(process.env.MAX_UPLOAD_MB);
  if (Number.isFinite(override) && override > 0) return Math.round(override * 1024 * 1024);
  return isServerless() ? SERVERLESS_UPLOAD_LIMIT_BYTES : PERSISTENT_UPLOAD_LIMIT_BYTES;
}

/**
 * Longest a single function invocation may run. Vercel Hobby caps at 300s;
 * Pro can be raised to 800s. Keep this in sync with the `maxDuration` exports
 * in the API routes (those must be static literals).
 */
export const MAX_FUNCTION_DURATION_SEC = 300;

/** Seconds of head-room left at the end of an invocation to finish cleanly. */
export const SHUTDOWN_RESERVE_SEC = 25;

/**
 * Usable scratch space. Vercel gives every function 512 MB of `/tmp`; we stay
 * well under it because a job needs room for the source *and* the output (plus
 * ffmpeg's two-pass log files).
 */
export function tmpBudgetBytes(): number {
  const override = Number(process.env.VIDSQUEEZE_TMP_BUDGET_MB);
  if (Number.isFinite(override) && override > 0) return Math.round(override * 1024 * 1024);
  return isServerless() ? 384 * 1024 * 1024 : Number.POSITIVE_INFINITY;
}

/**
 * A job whose lock is older than this is considered abandoned (the function
 * that owned it was killed mid-encode) and may be re-claimed by the drainer.
 * Must stay comfortably above `MAX_FUNCTION_DURATION_SEC`.
 */
export const STALE_LOCK_MINUTES = 15;

/** Long polling needs a process that never exits – impossible on serverless. */
export function supportsLongPolling(): boolean {
  return !isServerless();
}

/** Explains *why* a capability is unavailable, for the UI. */
export function longPollingBlockedReason(): string | null {
  if (supportsLongPolling()) return null;
  return `${platformName()} runs short-lived functions, so a long-polling loop would be frozen the moment the request ends. Use webhook mode instead.`;
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export type PlatformDTO = {
  name: string;
  mode: RuntimeMode;
  isVercel: boolean;
  serverless: boolean;
  region: string | null;
  deploymentId: string | null;
  maxUploadBytes: number;
  maxFunctionDurationSec: number;
  tmpBudgetBytes: number | null;
  supportsLongPolling: boolean;
  longPollingBlockedReason: string | null;
  supportsBackgroundDrain: boolean;
  cronConfigured: boolean;
};

export function platformInfo(): PlatformDTO {
  const budget = tmpBudgetBytes();
  return {
    name: platformName(),
    mode: runtimeMode(),
    isVercel: isVercel(),
    serverless: isServerless(),
    region: region(),
    deploymentId: deploymentId(),
    maxUploadBytes: maxUploadBytes(),
    maxFunctionDurationSec: MAX_FUNCTION_DURATION_SEC,
    tmpBudgetBytes: Number.isFinite(budget) ? budget : null,
    supportsLongPolling: supportsLongPolling(),
    longPollingBlockedReason: longPollingBlockedReason(),
    // `after()` keeps work running once the response has been sent.
    supportsBackgroundDrain: true,
    cronConfigured: Boolean(process.env.CRON_SECRET),
  };
}
