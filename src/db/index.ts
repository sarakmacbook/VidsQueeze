import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { isServerless } from "@/lib/platform";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

/**
 * TLS handling.
 *
 * Two things make this subtle:
 *
 *  1. `pg` has no "prefer" fallback. If `ssl` is truthy and the server answers
 *     "N", the connection fails outright with *The server does not support SSL
 *     connections*. So enabling TLS unconditionally would break every local
 *     cluster and Docker Postgres.
 *  2. Most managed providers (Neon, Supabase, Vercel Postgres, RDS) hand out a
 *     URL that already ends in `?sslmode=require`, and `pg-connection-string`
 *     turns that into an SSL config by itself.
 *
 * So the default is to stay out of the way and let the URL decide. Set
 * `DATABASE_SSL_MODE` only when the URL does not carry `sslmode` but the server
 * still demands TLS — `require` encrypts while accepting a self-signed
 * certificate, `verify-full`/`verify-ca` additionally check the CA chain, and
 * `disable` forces a plaintext connection.
 */
function sslConfig(): PoolConfig["ssl"] {
  const mode = (process.env.DATABASE_SSL_MODE ?? "").trim().toLowerCase();
  switch (mode) {
    case "":
    case "default":
      // Defer to `?sslmode=` in DATABASE_URL (and to no-TLS when it is absent).
      return undefined;
    case "disable":
    case "off":
      return false;
    case "verify-full":
    case "verify-ca":
      return { rejectUnauthorized: true };
    case "require":
    case "prefer":
      return { rejectUnauthorized: false };
    default:
      return undefined;
  }
}

/**
 * Every serverless instance opens its own pool, so a large `max` multiplies
 * fast and exhausts the database's connection limit under concurrency.
 */
const poolConfig: PoolConfig = {
  connectionString: databaseUrl,
  ssl: sslConfig(),
  max: Number(process.env.PGPOOL_MAX) || (isServerless() ? 3 : 10),
  idleTimeoutMillis: isServerless() ? 10_000 : 30_000,
  connectionTimeoutMillis: 15_000,
  allowExitOnIdle: false,
};

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

export const pool = globalForDb.__arenaNextJsPostgresqlPool ?? new Pool(poolConfig);

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool);
