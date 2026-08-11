import { readFileSync } from "node:fs";
import { check, report } from "./_harness";

/**
 * 「到現在網站沒有一個歷史信號出現過，但 telegram 卻有信號」.
 *
 * The history page's "只看建議進場" was a client-side filter over whatever
 * /api/history returned — and /api/history returns the newest 50 rows. Nine
 * symbols scanning every four hours write ~54 觀望 rows a day, so every 進場
 * row had left the window within hours of being written, and the checkbox
 * filtered a list that no longer contained what it was filtering for. The
 * page showed "全部是觀望" forever while Telegram — fed by the same scans at
 * alert time, not query time — kept showing trades.
 *
 * The filter has to be a database predicate, applied before the limit. These
 * checks are structural, pinning where the filtering happens, because a unit
 * test of the query needs a live database this sandbox doesn't have.
 */

const src = (p: string) => readFileSync(p, "utf8");

{
  const page = src("app/history/page.tsx");
  check("the page sends the filter to the server",
    page.includes('params.set("stance", "enter")'));
  check("and no longer filters rows client-side",
    !page.includes('filter((r) => r.trade_plan?.stance'), "client filter is back");

  const route = src("app/api/history/route.ts");
  check("the API parses the stance param", route.includes('get("stance")'));

  // Both stores must apply it — whichever backs the deployment.
  check("postgres filters in SQL, before the limit",
    src("lib/db/postgres-store.ts").includes("trade_plan->>'stance'"));
  check("supabase filters in the query, before the limit",
    src("lib/db/supabase-store.ts").includes('eq("trade_plan->>stance"'));
}

report("history filter");
