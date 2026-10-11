import { pool } from "@/db";

/**
 * Zero-tooling schema bootstrap.
 *
 * On a long-running host you would run `npm run db:push` once and forget about
 * it. On Vercel there is no shell to run it in, and the build step cannot
 * always reach the database, so instead every cold start makes sure the tables
 * exist. The DDL below is fully idempotent (`IF NOT EXISTS` everywhere) and
 * mirrors `src/db/schema.ts` exactly — if you add a column there, add the
 * matching `ADD COLUMN IF NOT EXISTS` line here.
 *
 * Concurrent cold starts are serialised with a transaction-scoped advisory
 * lock, because `ALTER TABLE … ADD COLUMN IF NOT EXISTS` can still race.
 */

const STATEMENTS: string[] = [
  // --- bot_settings ---------------------------------------------------------
  `create table if not exists bot_settings (
    id integer primary key default 1,
    bot_token text,
    bot_username text,
    bot_title text,
    webhook_secret text not null default 'vidsqueeze-secret',
    public_base_url text,
    connection_mode text not null default 'polling',
    polling_active boolean not null default false,
    last_update_id bigint not null default 0,
    last_webhook_at timestamp with time zone,
    allow_list text not null default '',
    reply_mode text not null default 'video',
    caption_template text not null default 'Compressed: {source} → {output} ({saved}% smaller)',
    target_size_mb double precision not null default 8,
    max_duration_sec integer not null default 0,
    max_height integer not null default 1080,
    max_fps integer not null default 30,
    keep_audio boolean not null default true,
    audio_bitrate_kbps integer not null default 96,
    video_codec text not null default 'libx264',
    speed_preset text not null default 'veryfast',
    two_pass boolean not null default true,
    crf integer not null default 23,
    quality_mode boolean not null default false,
    setup_step integer not null default 1,
    setup_complete boolean not null default false,
    token_verified boolean not null default false,
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now()
  )`,

  // --- jobs -----------------------------------------------------------------
  `create table if not exists jobs (
    id serial primary key,
    source text not null default 'web',
    status text not null default 'queued',
    stage text not null default 'Queued',
    progress integer not null default 0,
    attempts integer not null default 0,
    file_name text not null default 'video.mov',
    source_bytes bigint not null default 0,
    source_width integer not null default 0,
    source_height integer not null default 0,
    source_duration_sec double precision not null default 0,
    source_codec text,
    target_bytes bigint not null default 0,
    output_bytes bigint not null default 0,
    output_width integer not null default 0,
    output_height integer not null default 0,
    video_bitrate integer not null default 0,
    output_duration_sec double precision not null default 0,
    telegram_user_id text,
    telegram_chat_id text,
    telegram_message_id text,
    telegram_file_id text,
    input_path text,
    output_path text,
    error text,
    log text not null default '',
    locked_at timestamp with time zone,
    locked_by text,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone not null default now()
  )`,

  // --- event_log ------------------------------------------------------------
  `create table if not exists event_log (
    id serial primary key,
    level text not null default 'info',
    scope text not null default 'bot',
    message text not null,
    created_at timestamp with time zone not null default now()
  )`,

  // --- upgrades for databases created before the queue lease existed --------
  `alter table jobs add column if not exists locked_at timestamp with time zone`,
  `alter table jobs add column if not exists locked_by text`,

  // --- indexes --------------------------------------------------------------
  `create index if not exists jobs_status_id_idx on jobs (status, id)`,
];

let ready: Promise<void> | null = null;

async function apply(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Any fixed key works; it only has to be unique to VidSqueeze.
    await client.query("select pg_advisory_xact_lock(hashtext('vidsqueeze_schema'))");
    for (const statement of STATEMENTS) await client.query(statement);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Makes sure the schema exists. Resolves immediately after the first success
 * for the lifetime of the process, so it costs nothing on warm invocations.
 */
export function ensureSchema(): Promise<void> {
  if (process.env.VIDSQUEEZE_SKIP_AUTO_MIGRATE === "1") return Promise.resolve();
  if (!ready) {
    ready = apply().catch((err) => {
      // Let the next request try again instead of caching a failure forever.
      ready = null;
      throw err;
    });
  }
  return ready;
}

/** Runs the bootstrap eagerly – used by `npm run db:migrate`. */
export async function migrateAndExit(): Promise<void> {
  await apply();
}
