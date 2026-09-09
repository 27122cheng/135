import { check, report } from "./_harness";
import { buildWeeklyDigest, inSendWindow, isoWeek } from "@/lib/notify/weekly-digest";
import type { JournalEntry } from "@/types/journal";

/** 週結摘要 — window, dedupe token, and the message itself. */

let seq = 0;
function entry(over: Partial<JournalEntry> = {}): JournalEntry {
  seq++;
  return {
    id: `id-${seq}`,
    signal_id: null,
    symbol: "XAUUSD",
    direction: "long",
    grade: "B",
    entry_price: 2000,
    exit_price: 1980,
    result: "loss",
    pnl_pct: -1,
    closed_at: "2026-08-12T00:00:00.000Z",
    stop_reason_tag: "S3",
    severity: 3,
    review_note: "[自動追蹤] x",
    created_at: "2026-08-12T00:00:00.000Z",
    ...over,
  } as JournalEntry;
}

// ── the send window ───────────────────────────────────────────────
{
  check("Sunday 22:30 UTC is inside the window",
    inSendWindow(new Date("2026-08-16T22:30:00Z")));
  check("Sunday morning is not", !inSendWindow(new Date("2026-08-16T10:00:00Z")));
  check("Monday is not", !inSendWindow(new Date("2026-08-17T23:00:00Z")));
}

// ── the dedupe token ──────────────────────────────────────────────
{
  check("a week has one label",
    isoWeek(new Date("2026-08-16T23:00:00Z")) === isoWeek(new Date("2026-08-16T22:05:00Z")));
  check("the next week has another",
    isoWeek(new Date("2026-08-16T23:00:00Z")) !== isoWeek(new Date("2026-08-23T23:00:00Z")));
  check("labels look like ISO weeks", /^\d{4}-W\d{2}$/.test(isoWeek(new Date("2026-08-16T23:00:00Z"))));
}

// ── the message ───────────────────────────────────────────────────
{
  const quiet = buildWeeklyDigest([], "2026-W33");
  check("a quiet week still reports", quiet.includes("0 筆結算"), quiet);
  check("and frames standing aside as a result", quiet.includes("觀望也是一種紀錄"));

  const busy = buildWeeklyDigest(
    [
      entry({ result: "win", pnl_pct: 1.5 }),
      entry({ result: "win", pnl_pct: 1.5 }),
      entry({ result: "loss", pnl_pct: -3, stop_reason_tag: "S3" }),
      entry({ result: "loss", pnl_pct: -1, stop_reason_tag: "S6" }),
    ],
    "2026-W33",
  );
  check("names the week", busy.includes("2026-W33"));
  check("reports the real-signal bucket", busy.includes("正式訊號：4 筆"), busy);
  check("puts the breakeven bar beside the win rate", busy.includes("損益兩平需"), busy);
  check("names the costliest stop tag", busy.includes("最痛的停損原因：S3"), busy);
  check("teaches the reading", busy.includes("正期望"));
}

// ── an open position is not the same claim as nothing traded ──────
//
// The live bug: XAUUSD entered on the 21st, was still in flight when the
// digest ran, and the message said 「本次不放行任何交易」— false, and the
// falseness is exactly what made the next add-on alert read as coming out
// of nowhere. A held position must be visible even when nothing settled.
{
  const held = [{ symbol: "XAUUSD", direction: "long" as const, entry: 4597.19, since: "2026-08-21T09:00:00Z" }];

  const quietButHeld = buildWeeklyDigest([], "2026-W34", held);
  check("zero settlements with an open position is not framed as no trading",
    !quietButHeld.includes("門檻未放行任何交易"), quietButHeld);
  check("the position is named, with its entry and signal date",
    quietButHeld.includes("XAUUSD") && quietButHeld.includes("4597.19") &&
    quietButHeld.includes("08-21"),
    quietButHeld);
  check("still says nothing settled",
    quietButHeld.includes("0 筆結算"), quietButHeld);

  const busyWithHeld = buildWeeklyDigest(
    [entry({ result: "win", pnl_pct: 1.5 })], "2026-W34", held,
  );
  check("a week with settlements also lists what's still open",
    busyWithHeld.includes("另有 1 筆持倉中") && busyWithHeld.includes("XAUUSD"), busyWithHeld);

  const noneHeld = buildWeeklyDigest([], "2026-W34", []);
  check("no open positions keeps the original quiet-week wording",
    noneHeld.includes("門檻未放行任何交易"), noneHeld);
}

// ── the running score rides along ─────────────────────────────────
//
// One week's numbers invite overreacting to one week's noise; the digest
// closes with where the whole book stands and the deepest drawdown it has
// survived — the same two numbers the /review equity curve headlines.
{
  const withTotal = buildWeeklyDigest(
    [entry({ result: "win", pnl_pct: 1.5 })], "2026-W35", [],
    { totalPct: 4.2, maxDrawdownPct: -3.1, trades: 17 },
  );
  check("the all-time line names total, trades and max drawdown",
    withTotal.includes("+4.2%") && withTotal.includes("17 筆") &&
      withTotal.includes("最大回撤 -3.1%"),
    withTotal);
  check("no settled history means no all-time line",
    !buildWeeklyDigest([], "2026-W35", [], null).includes("累計"));
}

// ── 每一種出場都算數 ─────────────────────────────────────────────
{
  const week = [
    entry({ result: "win", pnl_pct: 3, stop_reason_tag: null, review_note: "[自動追蹤] 觸及停利 2060，未經人工複核。" }),
    entry({ result: "loss", pnl_pct: -1, stop_reason_tag: "S3", review_note: "[自動追蹤] 觸及停損 1980" }),
    entry({ result: "loss", pnl_pct: -0.6, stop_reason_tag: "S2", review_note: "[自動追蹤] 結構翻轉出場 1988（虧損 -0.6%）" }),
    entry({ result: "breakeven", pnl_pct: 0, stop_reason_tag: null, review_note: "[自動追蹤] 保本出場 2000" }),
  ];
  const msg = buildWeeklyDigest(week, "2026-W36");
  check("profit and loss are reported apart", msg.includes("獲利 +3%") && msg.includes("虧損 -1.6%"), msg);
  check("and netted", msg.includes("淨 +1.4%"), msg);
  check("the exit-kind line lists every ending", msg.includes("出場方式：") && msg.includes("結構翻轉提早出場 1 筆"), msg);
  check("including the scratch", msg.includes("保本出場 1 筆"), msg);
  check("the worst stop reason is named with its label", msg.includes("S3 停損過窄被掃"), msg);
  check("and comes with the advice for it", msg.includes("建議：") && msg.includes("結構外加緩衝"), msg);
  check("and says whether the engine has tightened yet", msg.includes("達門檻後會自動套用") || msg.includes("已自動套用"), msg);
}

report("weekly digest");
