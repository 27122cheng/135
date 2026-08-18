import type { Candle } from "../data-sources/ohlcv";
import { CONDITIONS, buildContext, type LabContext } from "./lab-conditions";
import { totalCostFraction, tradingCostFor } from "@/config/trading-costs";
import type { CommodityMeta } from "@/types/signal";

export { CONDITIONS, buildContext, FAMILIES } from "./lab-conditions";
export type { Condition, LabContext } from "./lab-conditions";

/**
 * 實驗室 — which entry conditions actually earn their place.
 *
 * The entry rules in this system were written by reasoning about markets and
 * then tuned by argument. That is how every one of them started life, and it
 * is not evidence. This measures them instead: each condition alone, then in
 * pairs, on the instrument's own history, with costs deducted and the answer
 * checked on data the search never saw.
 *
 * ## The problem this design exists to solve
 *
 * Testing a dozen conditions and their ~66 pairings against one price series
 * will produce winners **whether or not any of them work**. At a 5% false-
 * positive rate, ~4 of 78 tests look significant by luck alone, and the
 * search reliably finds them because finding them is what a search does. A
 * lab that reports its best combination without saying this is not a lab, it
 * is a machine for manufacturing confidence.
 *
 * Three defences, all structural rather than advisory:
 *
 * 1. **Hold-out split.** The oldest 70% of bars is the only data the search
 *    is allowed to see. The newest 30% is untouched until a candidate has
 *    already been chosen, and a candidate that fails there is reported as
 *    failed — not quietly dropped, because "we tried 78 things and 3 survived
 *    out of sample" is the finding.
 * 2. **A floor on both halves.** A combination is only ever labelled 通過 if
 *    it clears the operator's hit-rate floor in-sample *and* out-of-sample,
 *    with a real sample in each.
 * 3. **The baseline is always shown.** Every result sits next to what the
 *    same geometry does with no condition at all. A 68% hit rate means
 *    nothing until you know the unconditional rate is 61%.
 *
 * ## Why a fixed geometry
 *
 * Every condition is measured on the same stop and target — 1×ATR and
 * 1.5×ATR, the operator's own minimum payoff — so the comparison is between
 * *conditions* rather than between conditions and the geometries that happen
 * to suit them. What the lab discovers is when to enter; where to put the
 * stop is already decided by structure elsewhere.
 */

/** Stop at 1×ATR, target at 1.5×ATR: the operator's MIN_RISK_REWARD, exactly. */
const STOP_ATR = 1;
const TARGET_ATR = 1.5;
/** How far forward a trade is given to resolve, in bars. */
const HORIZON = 20;
/**
 * 樣本數門檻 —— the operator's number, and a strict one on purpose.
 *
 * 100 resolved trades in-sample. At 80% that is a rate whose 95% interval is
 * roughly ±8 points, so a combination reported as passing is genuinely
 * distinguishable from one that merely got lucky; at the old 25 the same
 * interval was ±16 and half the "discoveries" were coin flips.
 *
 * It also does the combinatorial pruning for free. Every condition added to
 * a combination cuts the number of bars that satisfy it, so a four-way stack
 * that looks perfect on eleven trades is refused before anyone can be
 * tempted by it — which is exactly the failure mode a deeper search invites.
 */
const MIN_SAMPLE = 100;
/**
 * The hold-out half is 30% of the history against the search half's 70%, so
 * demanding the same 100 there would refuse every finding on arithmetic
 * rather than on evidence. Scaled to the same *rate* of occurrence instead.
 */
const MIN_OUT_OF_SAMPLE = Math.round((MIN_SAMPLE * (1 - 0.7)) / 0.7);
/** 勝率門檻 —— the operator's floor for a condition to be worth adopting. */
export const VERIFY_FLOOR = 0.8;
/**
 * Indicators need to warm up before any bar is a legitimate entry.
 *
 * Exported because the live gate has to honour the same number: a condition
 * measured only on bars ≥60 must not be *checked* on bar 12, where EMA200 is
 * still a partial average of whatever history happened to arrive.
 */
export const WARMUP = 60;
/** The share of history the search is allowed to see. */
const IN_SAMPLE_SHARE = 0.7;

export interface ConditionResult {
  /** Resolved trades — the denominator of `hitRate`. */
  trades: number;
  wins: number;
  hitRate: number | null;
  expectancyR: number | null;
  /**
   * Every bar the condition accepted, whether or not the trade resolved.
   *
   * The gap between this and `trades` is the part a hit rate hides. A trade
   * that reaches neither the stop nor the target inside the 20-bar horizon is
   * not a win and not a loss, and counting only the ones that resolved means
   * the reported rate describes whichever subset happened to move. If a
   * condition takes 400 entries and 90 of them resolve, "83% 勝率" is a claim
   * about 22% of what it would actually have done — so the count is carried
   * out of the walk instead of being thrown away inside it.
   */
  entries: number;
  /** entries − trades. Timed out at the horizon with the position still open. */
  unresolved: number;
}

/**
 * Walks a slice of history, entering wherever `accept` is true and resolving
 * on the fixed geometry. No look-ahead: the decision at bar `i` uses only
 * data up to `i`, and the outcome is read from bars after it.
 */
function run(
  ctx: LabContext,
  direction: "long" | "short",
  accept: (i: number) => boolean,
  from: number,
  to: number,
  costFraction: number,
): ConditionResult {
  let wins = 0;
  let losses = 0;
  let entries = 0;
  for (let i = Math.max(from, WARMUP); i < to - HORIZON; i++) {
    const a = ctx.atr[i];
    const entry = ctx.close[i];
    if (a === null || !(a > 0) || !(entry > 0)) continue;
    if (!accept(i)) continue;
    entries++;

    const stopDist = a * STOP_ATR;
    const targetDist = a * TARGET_ATR;
    const cost = entry * costFraction;
    const stop = direction === "long" ? entry - stopDist : entry + stopDist;
    // The target has to clear the round trip before it counts as a win —
    // same rule as the plan backtest, for the same reason.
    const target =
      direction === "long" ? entry + targetDist + cost : entry - targetDist - cost;

    for (let j = i + 1; j <= i + HORIZON && j < ctx.candles.length; j++) {
      const bar = ctx.candles[j];
      const hitStop = direction === "long" ? bar.low <= stop : bar.high >= stop;
      const hitTarget = direction === "long" ? bar.high >= target : bar.low <= target;
      // Both in one bar: counted as a loss. Daily bars cannot order intrabar
      // events, and the pessimistic read is the only honest one.
      if (hitStop) {
        losses++;
        break;
      }
      if (hitTarget) {
        wins++;
        break;
      }
    }
  }

  const trades = wins + losses;
  const hitRate = trades > 0 ? wins / trades : null;
  const winR = (TARGET_ATR * 1 - 0) / STOP_ATR;
  return {
    trades,
    wins,
    hitRate: hitRate === null ? null : Math.round(hitRate * 1000) / 1000,
    expectancyR:
      hitRate === null ? null : Math.round((hitRate * winR - (1 - hitRate)) * 100) / 100,
    entries,
    unresolved: entries - trades,
  };
}

export interface LabFinding {
  /** One or two condition ids. */
  ids: string[];
  labels: string[];
  inSample: ConditionResult;
  outOfSample: ConditionResult;
  /** Cleared the floor on BOTH halves with a real sample in each. */
  verified: boolean;
  /** Percentage points of hit rate over the unconditional baseline, in-sample. */
  lift: number | null;
}

export interface LabReport {
  symbol: string;
  direction: "long" | "short";
  /** The same geometry with no condition — everything is judged against this. */
  baseline: { inSample: ConditionResult; outOfSample: ConditionResult };
  solo: LabFinding[];
  pairs: LabFinding[];
  /** Verified findings, best out-of-sample hit rate first. */
  verified: LabFinding[];
  /** How many hypotheses were tested — the multiple-testing denominator. */
  tested: number;
  /** Roughly how many of them would look good by luck alone. */
  expectedFalsePositives: number;
  floor: number;
  costPct: number;
  bars: number;
  notes: string[];
}

export function runLab(
  meta: Pick<CommodityMeta, "symbol" | "category">,
  candles: Candle[],
  direction: "long" | "short",
  floor = VERIFY_FLOOR,
): LabReport | null {
  if (!candles || candles.length < WARMUP + HORIZON + 100) return null;

  const ctx = buildContext(candles);
  const cost = tradingCostFor(meta.category);
  const costFraction = totalCostFraction(cost, HORIZON / 2);
  const split = Math.floor(candles.length * IN_SAMPLE_SHARE);

  /**
   * Every condition evaluated once per bar, up front.
   *
   * Without this an exhaustive search is impossible: each combination would
   * re-run every one of its conditions over every bar, and conditions that
   * scan a window would allocate on each call. Precomputed, a combination is
   * an AND over booleans — which is what makes "try every pairing" a second of
   * work instead of a minute of it.
   */
  const mask = new Map<string, Uint8Array>();
  for (const condition of CONDITIONS) {
    const bits = new Uint8Array(candles.length);
    for (let i = 0; i < candles.length; i++) {
      let ok = false;
      try {
        ok = condition.test(ctx, i, direction);
      } catch {
        // A condition that throws on an edge bar is simply not met there. It
        // must not take the whole sweep down with it.
        ok = false;
      }
      bits[i] = ok ? 1 : 0;
    }
    mask.set(condition.id, bits);
  }

  const measure = (accept: (i: number) => boolean) => ({
    inSample: run(ctx, direction, accept, 0, split, costFraction),
    outOfSample: run(ctx, direction, accept, split, candles.length, costFraction),
  });

  const baseline = measure(() => true);

  const label = (id: string) => CONDITIONS.find((c) => c.id === id)!.label;

  const finding = (ids: string[]): LabFinding => {
    const bits = ids.map((id) => mask.get(id)!);
    const accept =
      bits.length === 1
        ? (i: number) => bits[0][i] === 1
        : (i: number) => {
            for (const b of bits) if (b[i] !== 1) return false;
            return true;
          };
    const { inSample, outOfSample } = measure(accept);
    const verified =
      inSample.trades >= MIN_SAMPLE &&
      outOfSample.trades >= MIN_OUT_OF_SAMPLE &&
      (inSample.hitRate ?? 0) >= floor &&
      (outOfSample.hitRate ?? 0) >= floor;
    const lift =
      inSample.hitRate !== null && baseline.inSample.hitRate !== null
        ? Math.round((inSample.hitRate - baseline.inSample.hitRate) * 1000) / 10
        : null;
    return { ids, labels: ids.map(label), inSample, outOfSample, verified, lift };
  };

  const solo = CONDITIONS.map((c) => finding([c.id]))
    .filter((f) => f.inSample.trades >= MIN_SAMPLE)
    .sort((a, b) => (b.inSample.hitRate ?? 0) - (a.inSample.hitRate ?? 0));

  /**
   * Every pairing, then every survivor extended — no pre-selection.
   *
   * The previous search only paired conditions that already beat the baseline
   * alone, which is a reasonable-sounding rule that throws away the whole point
   * of combining: a filter can be worthless on its own and decisive as a veto
   * on someone else's signal. "站在 EMA200 正確側" wins nothing by itself and
   * may be exactly what a reversal pattern needs. So every pair of conditions
   * with a real sample is now measured, whatever either did alone.
   *
   * What stops this from exploding is the sample floor rather than a heuristic.
   * Each added condition cuts the qualifying bars, so three- and four-way
   * stacks fall below 100 trades on their own and are dropped before they can
   * be reported — and only combinations that survived are extended further.
   *
   * The cost is honesty about multiple testing, and it is a real cost: several
   * hundred hypotheses on one price series will produce impressive-looking
   * winners by luck. That number is reported next to the findings, and the
   * hold-out half is what separates the luck from the rest.
   */
  const soloIds = solo.map((f) => f.ids[0]);
  const combos: LabFinding[] = [];
  const seen = new Set<string>();
  let frontier: string[][] = [];

  for (let a = 0; a < soloIds.length; a++) {
    for (let b = a + 1; b < soloIds.length; b++) {
      const ids = [soloIds[a], soloIds[b]];
      const f = finding(ids);
      if (f.inSample.trades < MIN_SAMPLE) continue;
      combos.push(f);
      seen.add(ids.slice().sort().join("+"));
      frontier.push(ids);
    }
  }

  // Depth 3 and 4, grown only from pairs that kept a real sample. Capped so a
  // pathological series cannot walk the function past its time limit; the cap
  // being hit is reported rather than hidden.
  const MAX_DEPTH = 4;
  const MAX_FINDINGS = 4000;
  let truncated = false;
  for (let depth = 3; depth <= MAX_DEPTH && !truncated; depth++) {
    const next: string[][] = [];
    for (const base of frontier) {
      for (const id of soloIds) {
        if (base.includes(id)) continue;
        const ids = [...base, id].sort();
        const key = ids.join("+");
        if (seen.has(key)) continue;
        seen.add(key);
        if (combos.length >= MAX_FINDINGS) {
          truncated = true;
          break;
        }
        const f = finding(ids);
        if (f.inSample.trades < MIN_SAMPLE) continue;
        combos.push(f);
        next.push(ids);
      }
      if (truncated) break;
    }
    if (next.length === 0) break;
    frontier = next;
  }

  combos.sort((a, b) => (b.inSample.hitRate ?? 0) - (a.inSample.hitRate ?? 0));
  const pairs = combos;

  const tested = solo.length + pairs.length;
  const verified = [...solo, ...pairs]
    .filter((f) => f.verified)
    .sort((a, b) => (b.outOfSample.hitRate ?? 0) - (a.outOfSample.hitRate ?? 0));

  const notes: string[] = [];
  notes.push(
    `樣本內取最舊的 ${Math.round(IN_SAMPLE_SHARE * 100)}%（${split} 根 K 棒）搜尋，` +
      `最新的 ${100 - Math.round(IN_SAMPLE_SHARE * 100)}%（${candles.length - split} 根）` +
      `完全沒有參與搜尋，只用來驗證。`,
  );
  notes.push(
    `共測試 ${tested} 個假設（${CONDITIONS.length} 個條件單獨測，加上所有兩兩配對與能維持樣本數的三、四層疊加）。` +
      `以 5% 的偶然顯著率估算，約有 ${Math.round(tested * 0.05)} 個會單純因為運氣好看 —— ` +
      `測得愈多，這個數字愈大，這正是為什麼「樣本內最好的那一個」永遠不能直接拿來用，` +
      `而只有樣本內外都過門檻的才標為「通過」。`,
  );
  notes.push(
    "配對不預先篩選：不管單獨測時表現如何，每一組兩兩搭配都會測。" +
      "一個條件單獨看可能毫無用處，卻剛好是另一個訊號需要的否決條件 —— " +
      "先挑「看起來好的」再配對，等於在搜尋之前就先假設了答案。",
  );
  if (truncated) {
    notes.push(
      `組合數已達上限 ${MAX_FINDINGS}，更深的疊加未全部測完。` +
        "已測的部分照常報告，但這代表本次搜尋不是窮盡的。",
    );
  }
  notes.push(
    `通過門檻：樣本內至少 ${MIN_SAMPLE} 筆、樣本外至少 ${MIN_OUT_OF_SAMPLE} 筆（樣本外只有 30% 的資料，` +
      `按同樣的發生率換算），且兩邊勝率都要達到 ${Math.round(floor * 100)}%。` +
      `條件愈疊愈多，符合的 K 棒就愈少 —— 疊到樣本數不足的組合會在報告前就被剔除，` +
      `這正是防止「十一筆交易 100% 勝率」這種假發現的機制。`,
  );
  // 結算率 — how much of the walk the hit rate is actually a statement about.
  const entered = baseline.inSample.entries;
  const resolved = baseline.inSample.trades;
  notes.push(
    `結算率：基準線在樣本內取了 ${entered} 次進場，其中 ${resolved} 筆在 ${HORIZON} 根 K 棒內` +
      `觸及停損或停利（${entered > 0 ? Math.round((resolved / entered) * 100) : 0}%）。` +
      `勝率只計算有結算的那些 —— 沒結算的既不是贏也不是輸，但它們也不是不存在。` +
      `表格中的 n 是「結算筆數／進場次數」，兩個數字差距愈大，勝率描述的就愈只是「有走出去的那部分」。`,
  );
  if (verified.length === 0) {
    notes.push(
      "本次沒有任何條件通過樣本外驗證。這是結論而不是失敗：代表在這段歷史上，" +
        "這些條件沒有一個能穩定把勝率推過門檻，硬把樣本內最好的那個拿來用就是過度擬合。",
    );
  }

  return {
    symbol: meta.symbol,
    direction,
    baseline,
    solo,
    pairs,
    verified,
    tested,
    expectedFalsePositives: Math.round(tested * 0.05),
    floor,
    costPct: Math.round(costFraction * 100 * 1000) / 1000,
    bars: candles.length,
    notes,
  };
}
