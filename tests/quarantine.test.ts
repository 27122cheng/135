import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, report } from "./_harness";
import {
  FABRICATION_FIXED_AT,
  dedupeJournal,
  isFabricated,
  partitionJournal,
  quarantineNote,
  usableJournal,
} from "@/lib/journal/quarantine";
import { AUTO_MARKER, PAPER_MARKER } from "@/lib/journal/markers";
import { computeReviewStats } from "@/lib/journal/stats";
import type { JournalEntry } from "@/types/journal";

/**
 * 「不可能勝率一百」.
 *
 * /review reported a 100% win rate at every grade — 70/0/0, 36/0/0, 125/0/0,
 * 269/0/0 — off 500 rows with not one loss among them, and the 學習紀錄 below
 * it showed the same XAUUSD trade ten times over. Both are the same wreckage:
 * before 2026-08-12 the monitor decided a fill with profit-side logic, so a
 * long "filled" whenever price was above its entry and any stale plan booked
 * entry and take-profit in one tick. The fill rule was fixed; the fabrications
 * stayed in the table, and every statistic, the intervention engine and the
 * realized-rate calibration have been reading them ever since.
 */

let seq = 0;
function entry(over: Partial<JournalEntry> = {}): JournalEntry {
  seq += 1;
  return {
    id: `row-${seq}`,
    signal_id: "sig-1",
    symbol: "XAUUSD",
    direction: "long",
    grade: "A",
    entry_price: 4231,
    exit_price: 4326.7002,
    result: "win",
    pnl_pct: 2.25,
    closed_at: "2026-08-20T00:00:00.000Z",
    stop_reason_tag: null,
    severity: null,
    review_note: `${AUTO_MARKER} 觸及停利 4326.7002，未經人工複核。`,
    created_at: "2026-08-20T00:00:00.000Z",
    ...over,
  };
}

// ── the boundary ──────────────────────────────────────────────────
{
  check("an auto row from before the fill fix is fabricated",
    isFabricated(entry({ closed_at: "2026-08-12T09:00:00.000Z" })));
  check("an auto row from after it is not",
    !isFabricated(entry({ closed_at: "2026-08-13T00:00:00.001Z" })));
  check("the boundary is the day the fill rule was fixed",
    FABRICATION_FIXED_AT.startsWith("2026-08-13"), FABRICATION_FIXED_AT);

  // Both halves of the rule matter. A person who watched a trade in that
  // period recorded something real; no monitor bug could fabricate it.
  check("a hand-written row from the same period survives",
    !isFabricated(entry({ closed_at: "2026-08-01T00:00:00.000Z", review_note: "看錯方向，追高" })));
  check("and a row with no note at all survives",
    !isFabricated(entry({ closed_at: "2026-08-01T00:00:00.000Z", review_note: null })));
  // Paper rows carry both markers and are auto-written, so they quarantine too
  // — 269 of the 500 fabricated rows were the no-trade paper stream.
  check("paper rows from the period are fabricated like any other auto row",
    isFabricated(entry({
      closed_at: "2026-08-12T00:00:00.000Z",
      grade: "no-trade",
      review_note: `${AUTO_MARKER}${PAPER_MARKER} 觸及停利。`,
    })));
  // A row whose timestamp cannot be read is not evidence of anything.
  check("an empty timestamp is not treated as fabricated",
    !isFabricated(entry({ closed_at: "" })));
}

// ── the duplicate invariant ───────────────────────────────────────
{
  // The operator's screen: ten rows, one trade.
  const ten = Array.from({ length: 10 }, (_, i) =>
    entry({ closed_at: `2026-08-20T0${i}:00:00.000Z` }),
  );
  const { unique, duplicates } = dedupeJournal(ten);
  check("ten copies of one resolution collapse to one", unique.length === 1, unique.length);
  check("and the other nine are reported, not silently dropped", duplicates.length === 9);
  check("the surviving copy is the earliest — the one written when it resolved",
    unique[0].closed_at === "2026-08-20T00:00:00.000Z", unique[0].closed_at);

  // Genuinely different trades must all survive. Each field of the identity
  // is load-bearing: same signal re-entered at a different price, the other
  // direction, a different symbol, a different outcome.
  const distinct = [
    entry(),
    entry({ exit_price: 4400 }),
    entry({ entry_price: 4200 }),
    entry({ direction: "short" }),
    entry({ symbol: "EURUSD" }),
    entry({ signal_id: "sig-2" }),
    entry({ result: "loss", pnl_pct: -1.2 }),
  ];
  check("distinct trades are all kept", dedupeJournal(distinct).unique.length === 7,
    dedupeJournal(distinct).unique.length);
}

// ── what the statistics see ───────────────────────────────────────
{
  // The exact shape of the bug: fabricated wins plus one real loss. Before
  // the gate the page said 100%; the honest answer is 0%.
  const stored = [
    ...Array.from({ length: 8 }, (_, i) =>
      entry({ signal_id: `f-${i}`, closed_at: `2026-08-1${i % 2}T00:00:00.000Z` }),
    ),
    entry({
      signal_id: "real-1",
      closed_at: "2026-08-25T00:00:00.000Z",
      result: "loss",
      pnl_pct: -1.4,
      exit_price: 4180,
      stop_reason_tag: "S1",
      severity: 3,
      review_note: `${AUTO_MARKER} 觸及停損 4180。分類 S1`,
    }),
  ];
  const p = partitionJournal(stored);
  check("the fabricated rows are held out", p.fabricated.length === 8, p.fabricated.length);
  check("the real one is kept", p.usable.length === 1 && p.usable[0].signal_id === "real-1",
    p.usable);

  const before = computeReviewStats(stored).gradePerformance.find((g) => g.grade === "A");
  const after = computeReviewStats(p.usable).gradePerformance.find((g) => g.grade === "A");
  check("ungated, the contaminated table reports a near-perfect win rate",
    (before?.winRate ?? 0) > 80, before);
  check("gated, it reports the truth about the one real trade",
    after?.winRate === 0 && after?.trades === 1, after);
  // And the loss taxonomy has something to classify again — it was empty for
  // the same reason (「停損原因分布：尚無已分類的停損紀錄」).
  check("the stop-reason distribution is no longer starved",
    computeReviewStats(p.usable).tagDistribution.length === 1,
    computeReviewStats(p.usable).tagDistribution);

  const note = quarantineNote(p);
  check("the page is told how many and why",
    note?.includes("8 筆") === true && note.includes("勝率 100%") === true, note);
  check("and told the fix is already in", note?.includes("2026-08-13") === true, note);
  check("a clean table says nothing", quarantineNote(partitionJournal([entry()])) === null);
}

// ── every reader goes through the gate ────────────────────────────
//
// Structural: six modules read the journal and a contaminated row reaching
// any one of them is a lie in a different place — the win rate, the weekly
// digest, the severity baseline, or the intervention engine deciding the
// system is beating its own promises and relaxing nothing.
{
  const root = join(__dirname, "..");
  const readers: [string, string][] = [
    ["review API", "app/api/review/route.ts"],
    ["journal API", "app/api/journal/route.ts"],
    ["intervention engine", "lib/signal-builder.ts"],
    ["weekly digest", "lib/notify/weekly-digest.ts"],
    ["severity baseline", "lib/journal/auto-log.ts"],
  ];
  for (const [name, file] of readers) {
    const src = readFileSync(join(root, file), "utf8");
    check(`${name} filters the journal before using it`,
      /usableJournal\(|partitionJournal\(/.test(src), name);
  }
  // The writer refuses a repeat too, so the table stays honest and the reader
  // is not the only thing standing between a bug and ten identical rows.
  const autoLog = readFileSync(join(root, "lib/journal/auto-log.ts"), "utf8");
  check("the writer refuses to log a resolution twice",
    autoLog.includes("alreadyLogged"), "auto-log");
  check("and a refused write pushes nothing",
    /alreadyLogged[\s\S]{0,600}outcome: null/.test(autoLog), "auto-log");
}

// usableJournal is the same gate, for readers that need nothing else.
check("usableJournal agrees with partitionJournal",
  usableJournal([entry({ closed_at: "2026-08-01T00:00:00.000Z" })]).length === 0);

report("journal quarantine");
