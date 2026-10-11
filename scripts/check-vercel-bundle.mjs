#!/usr/bin/env node
/**
 * Reports the size of each traced serverless function and fails if one would be
 * rejected by Vercel.
 *
 * Vercel's standard limit is 250 MB *unzipped* per function. VidSqueeze spends
 * most of that on the ffmpeg and ffprobe binaries (~138 MB), so this is worth
 * checking on every build rather than discovering it in a failed deployment.
 *
 *   npm run build && npm run verify:bundle
 *
 * Set VERCEL_BUNDLE_LIMIT_MB to override the limit (e.g. 5120 when you have
 * opted into large functions with VERCEL_SUPPORT_LARGE_FUNCTIONS=1).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TRACE_ROOT = path.join(ROOT, ".next");
const LIMIT_MB = Number(process.env.VERCEL_BUNDLE_LIMIT_MB || 250);

function findNftFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findNftFiles(full, out);
    else if (entry.name.endsWith(".nft.json")) out.push(full);
  }
  return out;
}

function sizeOf(nftFile) {
  const manifest = JSON.parse(readFileSync(nftFile, "utf8"));
  const base = path.dirname(nftFile);
  let total = 0;
  const heavy = [];
  for (const rel of manifest.files ?? []) {
    const abs = path.resolve(base, rel);
    try {
      const size = statSync(abs).size;
      total += size;
      if (size > 5 * 1024 * 1024) heavy.push({ size, rel });
    } catch {
      /* traced but absent locally (e.g. another platform's binary) */
    }
  }
  heavy.sort((a, b) => b.size - a.size);
  return { total, heavy };
}

const nftFiles = findNftFiles(TRACE_ROOT);
if (nftFiles.length === 0) {
  console.error("No .nft.json trace files found under .next – run `npm run build` first.");
  process.exit(1);
}

const mb = (n) => (n / 1024 / 1024).toFixed(1);
let worst = 0;
let worstName = "";

console.log(`Vercel function bundle sizes (limit ${LIMIT_MB} MB unzipped)\n`);

// Only server functions are deployed; group them by route for readability.
const routes = [];
for (const file of nftFiles) {
  const rel = path.relative(TRACE_ROOT, file).replace(/\.nft\.json$/, "");
  if (!rel.startsWith(path.join("server", "app"))) continue;
  const { total, heavy } = sizeOf(file);
  routes.push({ route: "/" + rel.replace(/^server[\\/]app[\\/]/, "").replace(/[\\/]route\.js$/, ""), total, heavy });
  if (total > worst) {
    worst = total;
    worstName = rel;
  }
}

routes.sort((a, b) => b.total - a.total);
for (const r of routes.slice(0, 8)) {
  const flag = r.total > LIMIT_MB * 1024 * 1024 ? "✗" : "✓";
  console.log(`  ${flag} ${mb(r.total).padStart(7)} MB  ${r.route}`);
}
if (routes.length > 8) console.log(`  … ${routes.length - 8} more`);

const largest = routes[0];
if (largest?.heavy?.length) {
  console.log("\n  heaviest files in the largest function:");
  for (const h of largest.heavy.slice(0, 5)) console.log(`    ${mb(h.size).padStart(7)} MB  ${h.rel}`);
}

console.log("");
if (worst > LIMIT_MB * 1024 * 1024) {
  console.error(
    `FAIL: ${worstName} is ${mb(worst)} MB, over the ${LIMIT_MB} MB limit.\n` +
      `      Options: drop unused dependencies, keep only this platform's ffmpeg/ffprobe\n` +
      `      binary in outputFileTracingIncludes, or opt into large functions with\n` +
      `      VERCEL_SUPPORT_LARGE_FUNCTIONS=1.`,
  );
  process.exit(1);
}

console.log(`OK: largest function is ${mb(worst)} MB, ${mb(LIMIT_MB * 1024 * 1024 - worst)} MB of headroom.`);
