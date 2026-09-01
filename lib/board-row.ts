import { COMMODITIES, type AddOnLevel, type Grade, type SignalRow } from "@/types/signal";
import { groupDataGaps } from "@/lib/data-gaps";
import { summariseRegime } from "@/lib/analysis/regime-summary";
import { breadthOf } from "@/lib/analysis/evidence";
import { MIN_CONSENSUS_DIMENSIONS } from "@/lib/notify/alert";

export interface BoardAddOn {
  sequence: number;
  price: number;
  structure: string;
  new_stop_loss: number;
}

/**
 * 參考價位 — but only when something was actually *chosen*.
 *
 * This used to be built from `entry_zone` / `stop_loss` / `take_profits`
 * directly, on every scanned row. Those three fields are always populated:
 * they are the mid of the entry zone, the nearest protecting structure and the
 * nearest obstacles ahead. Nothing has screened them — no hit-rate floor, no
 * risk-reward floor, no backtest — so on a row where the rules refused to
 * trade, the board was printing an entry, a stop and a target anyway. A row of
 * prices reads as a recommendation whatever the label above it says, and
 * labelling them 參考價位 does not change what a reader does with them.
 *
 * `reference_plan` is the selected version: the same search that picks a real
 * plan, run at the lower reference bar (backtest hit rate ≥55%, payoff ≥1:1.5).
 * When that search comes back empty there is genuinely nothing to show, and
 * the row now says so — the same rule the detail card follows, so the two
 * pages cannot disagree about whether a price is worth looking at.
 */
export interface BoardReference {
  entryLow: number;
  entryHigh: number;
  entryReason: string;
  stopLoss: number;
  stopReason: string;
  takeProfits: { price: number; allocationPct: number; structure: string }[];
  /** True when the statistical veto refused it — shown, but never as advice. */
  vetoed: boolean;
  vetoNote: string | null;
}

/**
 * 美元同向曝險 — the aggregation a per-symbol card cannot see.
 *
 * EURUSD long, GBPUSD long and gold long are, to a first approximation, the
 * same trade: short the dollar, three times. Position sizing that treats them
 * as three independent risks is 3× levered on one macro view without saying
 * so. This flags it when two or more *entered* recommendations share a USD
 * side, so the reader sizes the cluster as one position.
 *
 * Deliberately FX + gold only. Indices and oil correlate with the dollar too,
 * but loosely and regime-dependently; claiming them as "the same trade" would
 * overstate what a sign table can know.
 */
const USD_SIDE: Record<string, 1 | -1> = {
  EURUSD: -1, // long the pair = short USD
  GBPUSD: -1,
  XAUUSD: -1,
  USDJPY: 1, // long the pair = long USD
};

export interface UsdExposure {
  side: "long" | "short";
  symbols: string[];
}

export function usdExposure(
  rows: Array<Pick<BoardRow, "symbol" | "stance" | "direction">>,
): UsdExposure | null {
  const longUsd: string[] = [];
  const shortUsd: string[] = [];
  for (const r of rows) {
    if (r.stance !== "enter" || !r.direction) continue;
    const side = USD_SIDE[r.symbol];
    if (!side) continue;
    const usd = (r.direction === "long" ? 1 : -1) * side;
    (usd > 0 ? longUsd : shortUsd).push(r.symbol);
  }
  if (longUsd.length >= 2) return { side: "long", symbols: longUsd };
  if (shortUsd.length >= 2) return { side: "short", symbols: shortUsd };
  return null;
}

export interface BoardRow {
  symbol: string;
  label: string;
  category: string;
  /** Null when this symbol has never been scanned. */
  signalId: string | null;
  direction: "long" | "short" | null;
  /** True when the factors cancelled out — show 中性, not a direction. */
  directionTie: boolean;
  grade: Grade | null;
  /** "enter" is the only one that means there is a trade. */
  stance: "enter" | "wait" | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
  /** The stored 信心度 score, or null for a signal written before it existed. */
  confidence: number | null;
  addOns: BoardAddOn[];
  summary: string | null;
  waitFor: string | null;
  /**
   * 為什麼手機沒收到 —— why this row was not pushed, when it was not.
   *
   * The push bar is deliberately higher than the display bar: the grade
   * measures how much evidence there is, the consensus bar measures how many
   * independent dimensions it came from, and a phone interruption is reserved
   * for the trades where several agree. Narrower trades still store and still
   * show — the site is where you go looking, the push is what comes looking
   * for you.
   *
   * That is defensible design and it was completely invisible, so what the
   * operator saw was 「信號與網頁的信號不一致，有些沒有」: a signal on the
   * board that Telegram had never mentioned, with nothing anywhere to say
   * why. Now the row carries the reason, so the two views reconcile on screen
   * instead of looking like a bug.
   *
   * Null when the row would be pushed (or has nothing to push).
   */
  notPushedReason: string | null;
  /**
   * Structure-derived levels, present on every scanned row including the ones
   * that stood aside. Null only when the symbol has never been scanned.
   */
  reference: BoardReference | null;
  /**
   * When `reference` is null: the reason the signal itself recorded, verbatim.
   *
   * The board used to assert its own reason ("沒有任何組合通過 55% 門檻") —
   * a guess dressed as a fact, and wrong whenever the reference was withheld
   * by the low-confidence rule instead. The builder writes the real reason
   * into data_gaps at the moment it decides; this carries that line through
   * so the board can only ever quote, never invent.
   */
  referenceNote: string | null;
  generatedAt: string | null;
  /** How many data gaps the scan reported — a count, not the list. */
  gapCount: number;
  /**
   * 趨勢品質 — what the ranking page sorts on.
   *
   * The grade answers "is this tradeable"; it says nothing about whether the
   * market is trending or chopping, and a B-grade in a clean trend is a
   * different proposition from a B-grade in a round trip. Derived from the
   * stored bias items via the same summary the detail card reads, so the two
   * pages cannot disagree about what regime an instrument is in.
   */
  trendPhase: "up" | "down" | "mixed" | null;
  /** Kaufman efficiency ratio 0..1, or null on a row written before it existed. */
  trendEfficiency: number | null;
  /** True when both the daily structure and the weekly anchor agree. */
  weeklyAligned: boolean;
  /**
   * 實測證據 — the managed backtest behind the chosen plan, so a recommendation
   * on the board carries its evidence instead of asking to be trusted. A
   * senior reader's first question about any entry is "measured on what?";
   * the detail card answers it three taps away, which is two too many.
   * Null on rows written before the backtest existed or when nothing resolved.
   */
  planEvidence: { hitRate: number | null; expectancyR: number | null; resolved: number } | null;
}

/**
 * Defensive on purpose: these come back as a JSON blob from the database, and
 * rows written by earlier versions of the builder are not guaranteed to have
 * every field the current type claims. A board that throws because one stored
 * signal predates a field is worse than one that shows eight rows and a gap.
 */
export function toReference(row: SignalRow): BoardReference | null {
  const ref = row.reference_plan;
  if (!ref || !Number.isFinite(ref.entry) || !Number.isFinite(ref.stop_loss)) return null;
  return {
    // A single price, not a band: the reference geometry chose one entry, and
    // widening it back into the raw zone would show a number nothing selected.
    entryLow: ref.entry,
    entryHigh: ref.entry,
    entryReason: `${ref.entry_reason}｜${ref.basis}`,
    stopLoss: ref.stop_loss,
    stopReason: ref.stop_reason,
    takeProfits: Number.isFinite(ref.take_profit)
      ? [{ price: ref.take_profit, allocationPct: 100, structure: ref.target_reason }]
      : [],
    // Rows written before the paper tier stopped being gated carry neither
    // field; they were only ever stored when they had passed, so absent
    // reads as passed.
    vetoed: ref.vetoed === true,
    vetoNote: ref.vetoNote ?? null,
  };
}

export function toBoardRow(meta: (typeof COMMODITIES)[number], row: SignalRow | undefined): BoardRow {
  const base = {
    symbol: meta.symbol,
    label: meta.label,
    category: meta.category,
  };
  if (!row) {
    return {
      ...base,
      signalId: null,
      direction: null,
      directionTie: false,
      grade: null,
      stance: null,
      entry: null,
      stopLoss: null,
      takeProfit: null,
      riskReward: null,
      confidence: null,
      addOns: [],
      summary: null,
      waitFor: null,
      notPushedReason: null,
      reference: null,
      referenceNote: null,
      generatedAt: null,
      gapCount: 0,
      trendPhase: null,
      trendEfficiency: null,
      weeklyAligned: false,
      planEvidence: null,
    };
  }

  const plan = row.trade_plan;
  return {
    ...base,
    signalId: row.id,
    direction: row.direction,
    directionTie: row.direction_tie === true,
    grade: row.grade,
    stance: plan?.stance ?? null,
    entry: plan?.entry ?? null,
    stopLoss: plan?.stop_loss ?? null,
    takeProfit: plan?.take_profit ?? null,
    riskReward: plan?.risk_reward ?? null,
    confidence: row.confidence?.score ?? null,
    addOns: (plan?.add_ons ?? []).map((a: AddOnLevel) => ({
      sequence: a.sequence,
      price: a.price,
      structure: a.structure,
      new_stop_loss: a.new_stop_loss,
    })),
    summary: plan?.summary ?? null,
    waitFor: plan?.wait_for ?? null,
    // Only meaningful for a row that is actually a trade — a 觀望 row is not
    // "withheld from the push", it simply is not a trade.
    notPushedReason:
      plan?.stance === "enter"
        ? (() => {
            const agreeing = breadthOf(row.direction, row.bias_items ?? []).agreeing.length;
            return agreeing < MIN_CONSENSUS_DIMENSIONS
              ? `同向面向僅 ${agreeing} 個（推播需 ≥ ${MIN_CONSENSUS_DIMENSIONS}），` +
                `此訊號只在網站顯示，手機不會收到 —— 證據夠成立一筆交易，但還不夠打擾你`
              : null;
          })()
        : null,
    reference: toReference(row),
    referenceNote: Array.isArray(row.data_gaps)
      ? ((row.data_gaps as string[]).find((g) => g.startsWith("本次不提供參考價位")) ?? null)
      : null,
    planEvidence:
      row.plan_backtest && typeof row.plan_backtest.resolved === "number" && row.plan_backtest.resolved > 0
        ? {
            hitRate: row.plan_backtest.hitRate ?? null,
            expectancyR: row.plan_backtest.expectancyR ?? null,
            resolved: row.plan_backtest.resolved,
          }
        : null,
    generatedAt: row.generated_at,
    gapCount: Array.isArray(row.data_gaps)
      ? // The board chip counts what someone could act on — behaviour notes and
        // permanent free-data limitations are explained on the card, not here.
        (() => {
          const g = groupDataGaps(row.data_gaps as string[]);
          return g.keyRelated.length + g.other.length;
        })()
      : 0,
    ...(() => {
      // One summary, read the same way the detail card reads it, so the
      // ranking and the analysis page can never describe different regimes.
      const r = summariseRegime(row.bias_items);
      const phase =
        r.structure.tone === "long" ? "up" : r.structure.tone === "short" ? "down" : "mixed";
      const er = Number.parseFloat(r.efficiency.label);
      return {
        trendPhase: r.structure.label === "—" ? null : (phase as "up" | "down" | "mixed"),
        trendEfficiency: Number.isFinite(er) ? er : null,
        weeklyAligned:
          r.weekly.tone !== "neutral" && r.weekly.tone === r.structure.tone,
      };
    })(),
  };
}
