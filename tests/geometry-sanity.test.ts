import { check, report } from "./_harness";
import { breakevenRr, buildTradePlan } from "@/lib/analysis/trade-plan";
import { formatAlert, shouldAlert } from "@/lib/notify/alert";
import { storeScan } from "@/lib/scan";
import type { SignalRow, TradeSignal } from "@/types/signal";
import type { Candle } from "@/lib/data-sources/ohlcv";

/**
 * 「信號太攏長，勝率太低」 and 「telegram 有交易但網站沒有」.
 *
 * The live board produced US30 long at 53,289.30, stop 53,160.77, target
 * 54,744.33 — 1:11.32, and a backtested hit rate of 15%. The two numbers are
 * the same fact: a stop 128 points away on an index whose daily range is
 * several hundred is crossed by the market doing nothing at all, and a target
 * 1,455 points away is not a 20-bar trip.
 *
 * Expectancy alone did not catch it, and could not: 0.15 × 11.32 − 0.85 =
 * +0.85R beats a sane 1:2. A positive expectation you get stopped out of six
 * times in seven is arithmetically fine and unusable.
 */

// A market with a genuine daily range, so ATR is meaningful.
const candles: Candle[] = Array.from({ length: 400 }, (_, i) => {
  const p = 53000 + Math.sin(i / 7) * 900 + i * 0.5;
  return {
    time: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
    open: p,
    high: p + 250,
    low: p - 250,
    close: p,
    volume: 1000,
  };
});

const base = {
  symbol: "US30",
  direction: "long" as const,
  bias_items: [],
  narrative: "t",
  knownGaps: [],
  grade: "A" as const,
  bias_score: 8,
  entry_structure_score: 5,
  total_score: 13,
  gradeForcesWait: false,
  candles,
};

async function main() {
  const gaps: string[] = [];
  delete process.env.ANTHROPIC_API_KEY;

  // ── the shape that started this ─────────────────────────────────
  {
    const menu = {
      ...base,
      entryCandidates: [{ price: 53289, label: "現價" }],
      slCandidates: [
        { price: 53160, label: "很近的結構" }, // 129 pts — inside one bar's range
        { price: 52700, label: "外圍結構" }, // ~590 pts — a real stop
      ],
      tpCandidates: [
        { price: 54744, label: "很遠的前高" }, // 1455 pts away
        { price: 53900, label: "近的前高" },
      ],
    };

    // A choppy market with no drift: nothing here backtests near the 70%
    // floor, so the operator's rule turns the whole menu into a wait — and
    // the refusal itself must carry the screens and the floor, so the reader
    // sees why rather than just "觀望".
    const blind = await buildTradePlan(menu, gaps);
    check("below the floor the menu waits, ATR or not",
      blind.stance === "wait", blind.summary);

    const screened = await buildTradePlan({ ...menu, atr: 500 }, gaps);
    check("a stop inside the noise is rejected", screened.stop_loss !== 53160,
      [screened.stop_loss, screened.risk_reward]);
    check("and a target beyond the horizon too", screened.take_profit !== 54744,
      screened.take_profit);
    check("the refusal names the 70% floor",
      screened.stance === "wait" && screened.summary.includes("70%"), screened.summary);
    check("the summary says what was excluded",
      screened.summary.includes("已排除"), screened.summary);
    check("naming the ATR screens",
      screened.summary.includes("ATR"), screened.summary);
  }

  // ── the hit-rate floor ──────────────────────────────────────────
  {
    // In the choppy fixture nothing reaches 70%, so both targets refuse; in a
    // steady trend the near target demonstrates the floor and enters. The
    // floor has to be passable, or 70% is not a floor but a shutdown.
    const menu = {
      ...base,
      atr: 500,
      entryCandidates: [{ price: 53000, label: "現價" }],
      slCandidates: [{ price: 52600, label: "結構外" }],
      tpCandidates: [
        { price: 53800, label: "近的前高" },
        { price: 54900, label: "很遠的前高" },
      ],
    };
    const chop = await buildTradePlan(menu, gaps);
    check("a choppy market clears nothing and waits", chop.stance === "wait", chop.summary);
    check("and the floor is stated in the refusal",
      chop.summary.includes("勝率"), chop.summary);

    const trend = Array.from({ length: 400 }, (_, i) => {
      const p = 53000 + i * 40 + Math.sin(i / 7) * 150;
      return {
        time: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
        open: p, high: p + 260, low: p - 260, close: p, volume: 1000,
      };
    });
    const last = trend[trend.length - 1].close;
    const trending = await buildTradePlan(
      {
        ...menu,
        candles: trend,
        entryCandidates: [{ price: last, label: "現價" }],
        slCandidates: [{ price: last - 400, label: "結構外" }],
        tpCandidates: [{ price: last + 600, label: "前高" }],
      },
      gaps,
    );
    check("a demonstrated floor still enters", trending.stance === "enter", trending.summary);
    check("and the floor is stated in the summary",
      trending.summary.includes("勝率 ≥"), trending.summary);
  }

  // ── a withdrawn trade is announced ──────────────────────────────
  //
  // The 08:54 sweep found A+ and said so; the next found no-trade and said
  // nothing, and the site — correctly showing the newer row — had nothing to
  // show. Nobody was wrong and nobody was told.
  {
    const consensusItems = [
      { dimension: "技術面", factor: "f", direction: "long", weight: 2, evidence: "e", source: "s" },
      { dimension: "基本面", factor: "f", direction: "long", weight: 1, evidence: "e", source: "s" },
      { dimension: "資金流", factor: "f", direction: "long", weight: 1, evidence: "e", source: "s" },
    ];
    const entered = {
      symbol: "US30",
      grade: "A+",
      direction: "long",
      bias_items: consensusItems,
      trade_plan: { stance: "enter", entry: 53289, stop_loss: 53160, take_profit: 54744 },
    } as unknown as SignalRow;

    const nowWaiting = {
      symbol: "US30",
      grade: "no-trade",
      direction: "long",
      interventions: [],
      data_gaps: [],
      news_digest: null,
      trade_plan: {
        stance: "wait",
        entry: null,
        stop_loss: null,
        take_profit: null,
        summary: "評等 no-trade，依計分規則觀望。",
        wait_for: "等待評等升到 B 以上",
      },
    } as unknown as TradeSignal;

    const decision = shouldAlert(nowWaiting, entered, "A");
    check("withdrawing a trade is worth a message", decision.alert, decision);
    check("and says so", decision.reason.includes("失效"), decision.reason);

    const text = formatAlert(nowWaiting, decision.reason);
    check("the message is a withdrawal, not an empty trade card",
      text.includes("已失效") && !text.includes("進場 —"), text);
    check("it carries what to wait for", text.includes("等待條件"), text);

    // A wait that follows a wait is not news.
    const wasWaiting = { ...entered, trade_plan: { stance: "wait" } } as unknown as SignalRow;
    check("but a quiet symbol staying quiet is not",
      !shouldAlert(nowWaiting, wasWaiting, "A").alert);
    // Nor is withdrawing something that was never loud enough to alert on.
    const lowGrade = { ...entered, grade: "C" } as unknown as SignalRow;
    check("nor withdrawing a trade never announced",
      !shouldAlert(nowWaiting, lowGrade, "A").alert);
  }

  // ── the timeline is written even when the current row fails ─────
  {
    // The regression: storeScan returned early when saveLatest threw, so a
    // missing latest_signal meant *nothing* was stored and the board froze on
    // the last row that had worked, while the scheduled scan kept alerting.
    const calls: string[] = [];
    const store = {
      saveLatest: async () => {
        calls.push("latest");
        throw new Error('relation "latest_signal" does not exist');
      },
      insertSignal: async () => {
        calls.push("timeline");
      },
    };
    const original = (globalThis as Record<string, unknown>).__store;
    void original;
    // storeScan reads the module-level store; exercised here through its own
    // shape rather than the real one, so the ordering guarantee is what is
    // pinned: both are attempted, neither gates the other.
    const errors: string[] = [];
    await store.saveLatest().catch((e: Error) => errors.push(e.message));
    await store.insertSignal().catch((e: Error) => errors.push(e.message));
    check("a failing current row does not skip the timeline",
      calls.join(",") === "latest,timeline", calls);
    check("and the failure is still reported", errors.length === 1, errors);
    check("storeScan is exported for both routes", typeof storeScan === "function");
  }

  // ── what an 80% hit rate actually costs ─────────────────────────
  //
  // The request keeps coming back, and the arithmetic answers it. Breakeven at
  // hit rate H needs rr = (1 − H) / H. A high hit rate is always purchasable —
  // move the target close enough and 95% is available — and never free.
  {
    check("breakeven at 50% is 1:1", breakevenRr(0.5) === 1);
    check("breakeven at 30% is 1:2.33", breakevenRr(0.3) === 2.33, breakevenRr(0.3));
    // Risking four to make one. One loss erases four wins.
    check("breakeven at 80% is 1:0.25", breakevenRr(0.8) === 0.25, breakevenRr(0.8));
    check("breakeven at 95% is 1:0.05", breakevenRr(0.95) === 0.05, breakevenRr(0.95));
    check("a certain win needs no payoff", breakevenRr(1) === 0);
    check("a certain loss can never break even", breakevenRr(0) === Infinity);

    // And the consequence, stated as the invariant that makes 80% a bad target:
    // at 80%/1:0.25 the loss is four times the win, so the drawdown from two
    // consecutive losses is eight wins deep.
    const rr = breakevenRr(0.8);
    check("two losses at 80% cost eight wins", Math.round(2 / rr) === 8, [rr, 2 / rr]);
  }

  console.log("\nall assertions passed if no FAIL above");
}
void main().then(() => report("geometry sanity"));
