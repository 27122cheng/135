import { getKey, parseUserKeyHeader, withUserKeys } from "@/lib/api-keys";
import { check, report } from "./_harness";

/**
 * The allowlist in lib/api-key-names.ts is a security boundary: a client-
 * supplied header must never be able to set server configuration it wasn't
 * offered. These tests exist to keep that true.
 */
async function main() {
  process.env.GEMINI_API_KEY = "from-env";
  delete process.env.FINNHUB_API_KEY;

  check("falls back to env when nothing is request-scoped", getKey("GEMINI_API_KEY") === "from-env");
  check("an unset key is undefined", getKey("FINNHUB_API_KEY") === undefined);

  await withUserKeys({ GEMINI_API_KEY: "from-user" }, async () => {
    check("request key beats env", getKey("GEMINI_API_KEY") === "from-user");
    // Every fetcher is async, so the scope has to survive await boundaries.
    await new Promise((r) => setTimeout(r, 10));
    check("scope survives an await", getKey("GEMINI_API_KEY") === "from-user");
  });
  check("scope does not leak out", getKey("GEMINI_API_KEY") === "from-env");

  const parsed = parseUserKeyHeader(
    JSON.stringify({
      GEMINI_API_KEY: "ok",
      SUPABASE_SERVICE_ROLE_KEY: "stolen",
      CRON_SECRET: "stolen",
      DATABASE_URL: "stolen",
      NODE_ENV: "production",
    }),
  );
  check("allowed name passes", parsed.GEMINI_API_KEY === "ok");
  check(
    "privileged names are stripped",
    Object.keys(parsed).length === 1,
    Object.keys(parsed),
  );

  check("malformed JSON yields nothing", Object.keys(parseUserKeyHeader("{not json")).length === 0);
  check("null header yields nothing", Object.keys(parseUserKeyHeader(null)).length === 0);
  check("an array yields nothing", Object.keys(parseUserKeyHeader("[1,2]")).length === 0);
  check(
    "over-long values are dropped",
    parseUserKeyHeader(JSON.stringify({ GEMINI_API_KEY: "x".repeat(201) })).GEMINI_API_KEY ===
      undefined,
  );
  check(
    "whitespace-only values are dropped",
    parseUserKeyHeader(JSON.stringify({ GEMINI_API_KEY: "   " })).GEMINI_API_KEY === undefined,
  );

  // Concurrency: two requests in flight must not see each other's keys.
  const seen = await Promise.all([
    withUserKeys({ GEMINI_API_KEY: "user-a" }, async () => {
      await new Promise((r) => setTimeout(r, 20));
      return getKey("GEMINI_API_KEY");
    }),
    withUserKeys({ GEMINI_API_KEY: "user-b" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return getKey("GEMINI_API_KEY");
    }),
  ]);
  check("concurrent requests stay isolated", seen[0] === "user-a" && seen[1] === "user-b", seen);

  report("api-keys");
}

void main();
