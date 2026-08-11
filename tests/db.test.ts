import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, report } from "./_harness";
import { explain } from "@/lib/db/postgres-store";
import { REQUIRED_TABLES, SCHEMA_SQL, schemaStatements } from "@/lib/db/schema";
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

  // Postgres phrases a missing column as `column "x" of relation "y" does not
  // exist`, which *contains* `relation "y" does not exist` — and the relation
  // branch was rewriting schema drift into "the tables don't exist", sending a
  // user whose tables existed into a loop with a setup call that said so.
  const drift = explain(
    new Error('column "tracked" of relation "plan_monitor" does not exist'),
  );
  check("a missing column is schema drift, not missing tables",
    drift.message.includes("結構過舊") && !drift.message.includes("資料表尚未建立"),
    drift.message);

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

// The embedded schema must stay byte-identical to the canonical .sql file,
// otherwise /api/setup would create tables that differ from what a manual run
// produces — and nobody would notice until a column was missing.
{
  const disk = readFileSync(join(process.cwd(), "supabase/schema.sql"), "utf8");
  check(
    "embedded SCHEMA_SQL matches supabase/schema.sql",
    SCHEMA_SQL === disk,
    SCHEMA_SQL === disk ? undefined : "編輯 supabase/schema.sql 後也要更新 lib/db/schema.ts",
  );
}

// Statement splitting: Neon's HTTP endpoint takes one statement per request.
{
  const statements = schemaStatements();
  check("splits into multiple statements", statements.length >= 12, statements.length);
  check("no empty statements", statements.every((s) => s.length > 0));
  check("no statement still carries a comment", !statements.some((s) => s.includes("--")),
    statements.find((s) => s.includes("--")));
  check(
    "every statement starts with DDL",
    statements.every((s) => /^(create|alter|drop)\b/i.test(s)),
    statements.find((s) => !/^(create|alter|drop)\b/i.test(s)),
  );
  check("both tables are created", REQUIRED_TABLES.every((t) =>
    statements.some((s) => new RegExp(`create table if not exists public\\.${t}\\b`, "i").test(s))));

  // A comment ending a line must not swallow the semicolon that follows it.
  const tricky = schemaStatements("create table a (x int); -- comment\ncreate table b (y int);");
  check("a trailing comment does not merge statements", tricky.length === 2, tricky);
}

report("db setup errors");
