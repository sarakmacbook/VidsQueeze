import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * Reads DATABASE_URL from the environment (or `.env`), so the same config works
 * locally, in CI, and against a production database.
 *
 * Note: you do *not* need to run this to deploy on Vercel — the app creates any
 * missing tables on first request (see `src/db/migrate.ts`). Use it when you
 * want to apply the schema ahead of time or generate SQL migration files.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:5432/app_db",
  },
  strict: true,
  verbose: true,
});
