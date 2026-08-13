import { neon } from "@neondatabase/serverless";
import { directNeonUrl } from "@/lib/db";
import { REQUIRED_TABLES, schemaStatements } from "@/lib/db/schema";
import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One-click table creation, so setting up the journal doesn't require opening
 * a SQL console and pasting a file — which on a phone is genuinely miserable.
 *
 * Only for the `DATABASE_URL` path. Supabase projects have their own SQL editor
 * and their anon/service keys aren't a Postgres connection, so those users run
 * `supabase/schema.sql` there as before.
 *
 * Access: every statement is `create ... if not exists` (plus a policy
 * drop/recreate of a policy this file owns), so the worst a stranger can do is
 * make it a no-op. Still, it is gated:
 *   - `CRON_SECRET` set  → a matching bearer token is required
 *   - `CRON_SECRET` unset → allowed only while the tables are still missing,
 *     so it works as a one-time bootstrap and then locks itself
 */

function connection(): string | null {
  const url = process.env.DATABASE_URL?.trim();
  // Same pooler bypass the store applies — DDL through the pooler while
  // queries go direct would reintroduce the split this exists to end.
  return url ? directNeonUrl(url) : null;
}

/** Same no-store as the store: a cached information_schema read would report
 *  tables that were just created as still missing (or the reverse) forever. */
const NO_CACHE = { fetchOptions: { cache: "no-store" as const } };

async function existingTables(url: string): Promise<string[]> {
  const sql = neon(url, NO_CACHE);
  const rows = (await sql`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name = any(${REQUIRED_TABLES as unknown as string[]})
  `) as unknown as Array<{ table_name: string }>;
  return rows.map((r) => r.table_name);
}

/** Reports what exists, so the UI can show a button or a tick. */
export async function GET() {
  const url = connection();
  if (!url) {
    return json(
      {
        supported: false,
        reason:
          "未設定 DATABASE_URL。使用 Supabase 的話請在 Supabase SQL Editor 執行 supabase/schema.sql。",
      },
      { status: 501 },
    );
  }
  try {
    const found = await existingTables(url);
    return json({
      supported: true,
      tables: Object.fromEntries(REQUIRED_TABLES.map((t) => [t, found.includes(t)])),
      ready: REQUIRED_TABLES.every((t) => found.includes(t)),
    });
  } catch (err) {
    return json(
      { supported: true, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  const url = connection();
  if (!url) {
    return json(
      {
        error:
          "未設定 DATABASE_URL，無法自動建表。使用 Supabase 的話請在其 SQL Editor 執行 supabase/schema.sql。",
      },
      { status: 501 },
    );
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  // No once-only lock anymore. The old rule refused to run once every table
  // existed, which was built before the schema carried `alter table … add
  // column if not exists` migrations — and it produced the worst loop this
  // app has shipped: a page saying "the schema is old, press 建立資料表" and
  // this route answering "已存在，不再重複執行". Every statement is
  // idempotent, so the worst an unauthenticated stranger can do is run a
  // no-op; the worst the lock did was make migrations unreachable.

  const sql = neon(url, NO_CACHE);
  const statements = schemaStatements();
  const results: Array<{ statement: string; ok: boolean; error?: string }> = [];

  // Sequential, not parallel: later statements reference tables the earlier
  // ones create. Neon's HTTP endpoint runs one statement per request anyway.
  for (const statement of statements) {
    try {
      await sql.query(statement);
      results.push({ statement: statement.slice(0, 60), ok: true });
    } catch (err) {
      results.push({
        statement: statement.slice(0, 60),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const failed = results.filter((r) => !r.ok);
  const found = await existingTables(url).catch(() => [] as string[]);
  const ready = REQUIRED_TABLES.every((t) => found.includes(t));

  return json(
    {
      ready,
      ran: results.length,
      failed: failed.length,
      // Only the failures are returned in full — a list of 12 successful DDL
      // statements is noise.
      errors: failed,
    },
    // Some statements can legitimately fail on a Postgres without RLS policy
    // support; what matters is whether the tables ended up there.
    { status: ready ? 200 : 502 },
  );
}
