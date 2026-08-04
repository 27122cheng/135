import { check, report } from "./_harness";
import { explain } from "@/lib/db/postgres-store";
import { USER_SETTABLE_KEYS } from "@/lib/api-key-names";
import { parseUserKeyHeader } from "@/lib/api-keys";

/**
 * First-run setup errors, and the boundary that keeps database credentials
 * out of the browser-settable key list.
 */

{
  const missing = explain(new Error('relation "trade_journal" does not exist'));
  check("a missing table names the fix", missing.message.includes("supabase/schema.sql"), missing.message);
  check("the original error is preserved", missing.message.includes("does not exist"));

  const auth = explain(new Error("password authentication failed for user \"neondb_owner\""));
  check("an auth failure points at DATABASE_URL", auth.message.includes("DATABASE_URL"), auth.message);

  // Anything unrecognised must pass through untouched — inventing friendly
  // text for an unknown failure would hide it.
  const unknown = explain(new Error("connection terminated unexpectedly"));
  check("unknown errors pass through verbatim", unknown.message === "connection terminated unexpectedly", unknown.message);
  check("non-Error values are stringified", explain("boom").message === "boom");
}

// DATABASE_URL grants write access to the whole database, so it must never be
// settable from the browser the way a data-source key is.
{
  check(
    "DATABASE_URL is not user-settable",
    !(USER_SETTABLE_KEYS as readonly string[]).includes("DATABASE_URL"),
    USER_SETTABLE_KEYS,
  );
  const parsed = parseUserKeyHeader(
    JSON.stringify({ DATABASE_URL: "postgres://attacker@evil/db", GEMINI_API_KEY: "ok" }),
  );
  check("a DATABASE_URL header is dropped", !("DATABASE_URL" in parsed), parsed);
  check("the legitimate key still passes", parsed.GEMINI_API_KEY === "ok", parsed);
}

report("db setup errors");
