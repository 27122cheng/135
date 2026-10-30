import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, report } from "./_harness";
import { directNeonUrl } from "@/lib/db";
import { signalExtras, unpackSignalRow } from "@/lib/db/signal-extras";
import { explain, toJournalEntry } from "@/lib/db/postgres-store";
import { REQUIRED_TABLES, SCHEMA_SQL, schemaStatements } from "@/lib/db/schema";
import { USER_SETTABLE_KEYS } from "@/lib/api-key-names";
import { parseUserKeyHeader } from "@/lib/api-keys";
import { classifyBlocker } from "@/lib/analysis/blockers";
import type { TradeSignal } from "@/types/signal";

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

// ── the pooler bypass ─────────────────────────────────────────────
//
// Through the -pooler endpoint the live deployment committed INSERTs that the
// very next SELECT could not see. Neon's direct endpoint is the same host
// minus the suffix; only that convention is rewritten, everything else passes
// through byte-identical.
{
  check("a Neon pooler host is rewritten to its direct twin",
    directNeonUrl("postgresql://u:p@ep-autumn-boat-aw5ckl5v-pooler.c-12.us-east-1.aws.neon.tech/neondb?sslmode=require")
      === "postgresql://u:p@ep-autumn-boat-aw5ckl5v.c-12.us-east-1.aws.neon.tech/neondb?sslmode=require");
  check("a direct Neon host is untouched",
    directNeonUrl("postgresql://u:p@ep-autumn-boat-aw5ckl5v.c-12.us-east-1.aws.neon.tech/neondb")
      === "postgresql://u:p@ep-autumn-boat-aw5ckl5v.c-12.us-east-1.aws.neon.tech/neondb");
  const supabasePooler = "postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
  check("a Supabase pooler is not Neon's convention and passes through",
    directNeonUrl(supabasePooler) === supabasePooler);
  check("garbage passes through rather than throwing",
    directNeonUrl("not a url") === "not a url");
}

// ── the driver must opt out of the platform fetch cache ───────────
//
// The neon driver queries via fetch() POSTs. Vercel's Data Cache captured
// those responses and replayed them across requests AND deployments: writes
// (unique params) always reached the database, reads (identical SQL) froze at
// their first execution — two days of committed INSERTs invisible to every
// SELECT. Every neon() instantiation must therefore pass cache: "no-store".
{
  const store = readFileSync(join(__dirname, "..", "lib", "db", "postgres-store.ts"), "utf8");
  const setup = readFileSync(join(__dirname, "..", "app", "api", "setup", "route.ts"), "utf8");
  check("the signal store's driver disables the fetch cache",
    /neon\(connectionString,\s*\{\s*fetchOptions:\s*\{\s*cache:\s*"no-store"/.test(store));
  check("the schema-setup driver disables it too",
    setup.includes('cache: "no-store"') && !/neon\((url|connectionString)\)[^,]/.test(setup));
}

// ── history rows carry the gate evidence, packed and unpacked ─────
//
// The history insert writes named columns, and five later-added fields
// (confidence, lab_gate, downgrades, reference_plan, graded_as) were never
// among them — so the blocker census, once it switched from latestPerSymbol
// to a week of history rows, could not see the confidence/lab/trend gates at
// all and silently under-reported the exact tunable gates it exists to
// expose. They now ride in one `extras` jsonb; this pins the round trip.
{
  const signal = {
    symbol: "XAUUSD",
    grade: "A",
    graded_as: "A+",
    bias_score: 6,
    entry_structure_score: 5,
    total_score: 11,
    confidence: { score: 42, level: "low", factors: ["評等 A（基準 70）", "缺口 -15"] },
    lab_gate: { ids: ["ema-stack"], labels: ["均線排列"], met: false, blocked: true, checks: [] },
    downgrades: ["逆勢：D1 趨勢與方向相反"],
    reference_plan: null,
    thesis: { playbook: { regime: "trend", name: "順勢回調" }, invalidations: [] },
    forward_evidence: { support: ["ema-stack"], oppose: [], asOf: "2026-09-01" },
    direction_tie: true,
    trade_plan: { stance: "wait", wait_for: "w", summary: "s" },
    data_gaps: [],
  } as unknown as TradeSignal;

  const packed = signalExtras(signal);
  const restored = unpackSignalRow({
    id: "row-1", symbol: "XAUUSD", grade: "A", trade_plan: signal.trade_plan,
    data_gaps: [], extras: packed,
  });
  check("confidence survives the round trip",
    restored.confidence?.score === 42, restored.confidence);
  check("the lab gate survives", restored.lab_gate?.blocked === true, restored.lab_gate);
  check("downgrades survive", restored.downgrades?.[0]?.includes("逆勢") === true,
    restored.downgrades);
  check("graded_as survives", restored.graded_as === "A+", restored.graded_as);
  // Second wave: the monitor's regime snapshot reads `thesis` off the board
  // row, the card's recomputed confidence reads `forward_evidence`, and
  // /history renders `direction_tie` — none of which a history row carried.
  check("the thesis survives, so the regime exit can be armed from a history row",
    (restored.thesis as { playbook?: { regime?: string } } | null)?.playbook?.regime === "trend", restored.thesis);
  check("forward evidence survives, so a recomputed confidence matches the gate's",
    (restored.forward_evidence as { support?: string[] } | null)?.support?.[0] === "ema-stack", restored.forward_evidence);
  check("direction_tie survives, so /history can say 中性", restored.direction_tie === true, restored.direction_tie);

  // The point of the exercise: the census can now see these gates on a
  // history row at all. This row carries a 逆勢 downgrade, which sits
  // earlier in the pipeline than confidence — first gate wins, so the
  // trend gate is the correct classification AND the proof that a field
  // the named columns never carried reached the classifier.
  check("classifyBlocker sees the trend gate on an unpacked history row",
    classifyBlocker(restored as unknown as TradeSignal).id === "trend-gate",
    classifyBlocker(restored as unknown as TradeSignal));

  // Without the downgrade, the same row classifies on its low confidence —
  // the other previously-invisible gate.
  const confidenceOnly = unpackSignalRow({
    id: "row-2", symbol: "XAUUSD", grade: "A", trade_plan: signal.trade_plan,
    data_gaps: [], extras: { ...packed, downgrades: [], lab_gate: null },
  });
  check("and the confidence gate on a row with nothing earlier in the pipeline",
    classifyBlocker(confidenceOnly as unknown as TradeSignal).id === "confidence",
    classifyBlocker(confidenceOnly as unknown as TradeSignal));

  // A row written before the migration has no extras and must unpack to
  // itself — "gate not observable", never an error.
  const legacy = unpackSignalRow({ id: "old", symbol: "XAUUSD", grade: "B", extras: null });
  check("a pre-migration row unpacks to itself", legacy.symbol === "XAUUSD" && legacy.grade === "B");

  // Named columns are the table's contract; a colliding key inside extras
  // must never override one.
  const collided = unpackSignalRow({
    symbol: "XAUUSD", grade: "B", extras: { grade: "A+", confidence: { score: 9 } },
  });
  check("named columns win over the packed copy", collided.grade === "B", collided.grade);

  // Both stores actually write and unpack it — structural, like the driver
  // pin above, so a refactor cannot quietly drop one side.
  const pg = readFileSync(join(__dirname, "..", "lib", "db", "postgres-store.ts"), "utf8");
  const sb = readFileSync(join(__dirname, "..", "lib", "db", "supabase-store.ts"), "utf8");
  for (const [name, src] of [["postgres", pg], ["supabase", sb]] as const) {
    check(`${name} writes extras on insert`, src.includes("signalExtras(signal)"), name);
    check(`${name} unpacks extras on read`, src.includes("unpackSignalRow"), name);
    // And neither may lose the whole history row when the column predates
    // the migration — the fallback keys on the column's own name.
    check(`${name} falls back when the column is missing`, /extras/i.test(src) &&
      src.includes("/extras/i"), name);
  }
}

/**
 * The driver's types, not the declared ones.
 *
 * /api/review returned 500 with `e.closed_at.slice is not a function` the day
 * the journal first had rows in it: the Neon HTTP driver decodes `timestamptz`
 * to a JS `Date` and `numeric` to a string, and the readers call
 * `.slice(0, 10)` and `localeCompare` on fields the type declares as strings.
 * Supabase's PostgREST hands back JSON strings, so nothing in test or in the
 * Supabase deployment ever saw it. Normalise at the store boundary.
 */
{
  const closed = new Date("2026-08-30T14:05:00.000Z");
  const e = toJournalEntry({
    id: 7,
    signal_id: null,
    symbol: "XAUUSD",
    direction: "long",
    grade: "A",
    entry_price: "3421.50",
    exit_price: "3455.25",
    result: "win",
    pnl_pct: "0.98",
    closed_at: closed,
    stop_reason_tag: null,
    severity: "2",
    review_note: null,
    created_at: closed,
  });

  check("a Date closed_at becomes an ISO string",
    typeof e.closed_at === "string" && e.closed_at.slice(0, 10) === "2026-08-30", e.closed_at);
  check("and created_at with it", typeof e.created_at === "string", e.created_at);
  check("numeric columns become numbers",
    e.entry_price === 3421.5 && e.exit_price === 3455.25 && e.pnl_pct === 0.98,
    [e.entry_price, e.exit_price, e.pnl_pct]);
  check("severity too, when present", e.severity === 2, e.severity);
  check("a bigint id becomes a string", e.id === "7", e.id);
  check("sortable against another row",
    typeof e.closed_at.localeCompare === "function" &&
      e.closed_at.localeCompare("2026-08-29T00:00:00.000Z") > 0);

  // Nulls stay null rather than becoming the string "null" — the review page
  // keys 「未分類」 off a null stop_reason_tag.
  const bare = toJournalEntry({
    id: "x", symbol: "US30", direction: "short", grade: "B",
    result: "loss", closed_at: "2026-08-30T00:00:00.000Z",
    stop_reason_tag: null, severity: null, review_note: null, signal_id: null,
  });
  check("null tags stay null", bare.stop_reason_tag === null && bare.severity === null);
  check("a missing numeric falls back to 0 rather than NaN",
    bare.pnl_pct === 0 && Number.isFinite(bare.pnl_pct), bare.pnl_pct);
  check("an already-string timestamp is untouched",
    bare.closed_at === "2026-08-30T00:00:00.000Z", bare.closed_at);

  // And the store actually routes both journal reads through it — structural,
  // so a later `select *` cannot quietly reintroduce the blind cast.
  const pg = readFileSync(join(__dirname, "..", "lib", "db", "postgres-store.ts"), "utf8");
  check("postgres never casts a journal row blind",
    !pg.includes("as unknown as JournalEntry"), "blind cast is back");
  check("the single-row read normalises",
    pg.includes("return toJournalEntry(rows[0]"), "insertJournalEntry");
  check("the list read normalises", pg.includes(".map(toJournalEntry)"), "listJournal");
}

report("db setup errors");
