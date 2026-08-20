import type { Candle } from "../data-sources/ohlcv";
import { CONDITIONS, buildContext, type LabContext } from "./lab-conditions";
import { MANAGE_HORIZON, registerLevels, walkManaged } from "./lab-manage";
import { totalCostFraction, tradingCostFor } from "@/config/trading-costs";
import type { CommodityMeta } from "@/types/signal";

export { CONDITIONS, buildContext, FAMILIES } from "./lab-conditions";
export type { Condition, LabContext } from "./lab-conditions";
export { MANAGE_HORIZON, registerLevels, walkManaged } from "./lab-manage";

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
 *    it clears the expectancy floor *and* the followability floor in-sample
 *    and out-of-sample, with a real sample in each.
 * 3. **The baseline is always shown.** Every result sits next to what the
 *    same management does with no condition at all. A 68% hit rate means
 *    nothing until you know the unconditional rate is 61%.
 *
 * ## Why managed exits, not a fixed geometry
 *
 * Every trade here is opened, protected and closed by the exact rules in
 * lib/analysis/lab-manage.ts: stop behind the confirmed swing, target at the
 * nearest overhead pressure, breakeven at 1R, stop trailed behind new swings,
 * exit on an opposite structure break. The comparison between conditions is
 * still fair — every condition trades under the *same* management — but what
 * is being measured is now the trade this system actually takes, per the
 * operator: 「不要用固定R，要看壓力及技術變化來移動止損止盈」. Fundamental
 * and news view-changes cannot be replayed on history (there is no per-bar
 * news archive), so the backtestable form of 看法改變 is the structural one;
 * the live monitor handles the rest in real time, and this file does not
 * pretend otherwise. Outcomes are in R — each trade's exit over its own
 * initial risk, net of costs — because with structural stops every trade has
 * its own payoff and a bare hit rate no longer means one thing.
 */

/** How far forward a trade is given to resolve, in bars. */
const HORIZON = MANAGE_HORIZON;
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
/**
 * 勝率門檻 —— the followability floor, now that outcomes carry their own R.
 *
 * Under managed exits a hit rate alone cannot be the bar (a trailed winner
 * and a full-target winner are different sizes of win), so verification is
 * two-legged: this floor keeps a condition followable — below 55% the losses
 * come too often to sit through, the same absolute floor the live plans
 * carry — and LAB_MIN_EXPECTANCY_R is the edge itself.
 */
export const VERIFY_FLOOR = 0.55;
/**
 * 期望值門檻 —— the operator's old bar, restated in the unit that survives
 * variable geometry. The previous floor was 80% at a fixed 1:1.5, which *is*
 * +1.0R per trade; the number carries over exactly. Deliberately above the
 * live trade floor's +0.75R: a condition promoted to a hard gate over every
 * live entry has to show more edge than the minimum a single plan needs.
 */
export const LAB_MIN_EXPECTANCY_R = 1.0;
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
  /** Resolved trades — the denominator of `hitRate` and `expectancyR`. */
  trades: number;
  /** Trades whose net R was positive. */
  wins: number;
  hitRate: number | null;
  /** Mean R per resolved trade, net of costs — the number that decides. */
  expectancyR: number | null;
  /**
   * Every bar the condition accepted (with a usable ATR), whether or not a
   * trade could be taken there.
   *
   * The gap between this and `trades` is what the rates hide: bars where the
   * condition fired but no sane structural stop existed (no confirmed swing,
   * or the swing inside the noise / too far away — the same refusals the
   * live plan makes). A condition that fires 400 times but is only tradeable
   * 90 of them is a claim about those 90, so the count is carried out of the
   * walk instead of being thrown away inside it.
   */
  entries: number;
  /** entries − trades: fired, but no structural stop to trade against. */
  unresolved: number;
}

/**
 * Walks a slice of history, entering wherever `accept` is true and managing
 * each trade with the shared structural rules (lab-manage.ts). No look-ahead:
 * the decision and the registered levels at bar `i` use only data confirmed
 * by `i`, and the outcome is read from bars after it.
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
  let trades = 0;
  let entries = 0;
  let sumR = 0;
  for (let i = Math.max(from, WARMUP); i < to - HORIZON; i++) {
    const a = ctx.atr[i];
    const entry = ctx.close[i];
    if (a === null || !(a > 0) || !(entry > 0)) continue;
    if (!accept(i)) continue;
    entries++;

    // 結構化進出場：條件成立還不夠，還要有合理的結構停損可掛 —— live 的
    // 計畫同樣會拒絕沒有結構保護的進場，實驗必須量同一種交易。
    const levels = registerLevels(ctx, i, direction);
    if (!levels) continue;

    const exit = walkManaged({
      ctx,
      direction,
      firstBar: i + 1,
      entry,
      stop: levels.stop,
      target: levels.target,
      entryAtr: a,
      horizon: HORIZON,
      costFraction,
    });
    // The loop bound guarantees a full horizon of bars, so a null here is
    // impossible in practice; guarded anyway so a short series cannot lie.
    if (!exit) continue;
    trades++;
    sumR += exit.r;
    if (exit.r > 0) wins++;
  }

  const hitRate = trades > 0 ? wins / trades : null;
  return {
    trades,
    wins,
    hitRate: hitRate === null ? null : Math.round(hitRate * 1000) / 1000,
    expectancyR: trades > 0 ? Math.round((sumR / trades) * 100) / 100 : null,
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
  /** Cleared both floors (expectancy and followability) on BOTH halves. */
  verified: boolean;
  /** Percentage points of hit rate over the unconditional baseline, in-sample. */
  lift: number | null;
}

/**
 * 接近通過 — a finding that failed verification by margins small enough that
 * new data could plausibly close them.
 *
 * ## Why this list exists
 *
 * Under a hard floor, "78% out-of-sample" and "40% out-of-sample" both render
 * as the same absence from the verified table, and the operator's only options
 * are to re-run the lab daily and eyeball the big tables, or to lose track of
 * the combinations worth watching. This names them, with the exact shortfall,
 * so waiting is a decision rather than a default.
 *
 * ## What it must never become
 *
 * A recommendation. A near miss is a hypothesis that has not cleared the bar —
 * the gap may close with new bars or widen, and both outcomes are informative.
 * The adopt endpoint re-verifies against a fresh run regardless, so nothing in
 * this list can be promoted by wishing.
 */
export interface NearMiss extends LabFinding {
  /** Each unmet criterion, with the distance stated. */
  shortfalls: string[];
}

/** A hit rate may miss the floor by at most this much to count as "near". */
export const NEAR_HIT_RATE_MARGIN = 0.05;
/** An expectancy may miss its floor by at most this much R to count as "near". */
export const NEAR_EXPECTANCY_MARGIN = 0.2;
/** A sample count must reach at least this share of its requirement. */
export const NEAR_SAMPLE_SHARE = 0.7;

/**
 * The unmet criteria, in words — or null when the finding is verified or too
 * far off for "near" to be honest.
 *
 * The reported lists already guarantee 100+ in-sample trades (the search
 * drops anything below the floor before it can be reported), so the criteria
 * that can be short here are the two expectancies, the two hit rates and the
 * out-of-sample count. The count genuinely improves with the calendar —
 * every new D1 bar lands in the newest 30% — which is what makes "wait" a
 * meaningful instruction.
 */
export function shortfallsOf(f: LabFinding, floor: number): string[] | null {
  if (f.verified) return null;
  const out: string[] = [];

  for (const [half, result] of [["樣本內", f.inSample], ["樣本外", f.outOfSample]] as const) {
    const rate = result.hitRate;
    const exp = result.expectancyR;
    if (rate === null || exp === null) return null;
    if (rate < floor) {
      if (rate < floor - NEAR_HIT_RATE_MARGIN) return null;
      // The epsilon absorbs float dust: 0.8 − 0.77 is 0.030000…027 in IEEE754,
      // and a bare ceil would report a 3-point gap as 4.
      out.push(`${half}勝率 ${Math.round(rate * 100)}%，差 ${Math.ceil((floor - rate) * 100 - 1e-9)} 個百分點`);
    }
    if (exp < LAB_MIN_EXPECTANCY_R) {
      if (exp < LAB_MIN_EXPECTANCY_R - NEAR_EXPECTANCY_MARGIN) return null;
      out.push(
        `${half}期望值 ${exp >= 0 ? "+" : ""}${exp}R，差 ${Math.round((LAB_MIN_EXPECTANCY_R - exp) * 100) / 100}R`,
      );
    }
  }

  if (f.outOfSample.trades < MIN_OUT_OF_SAMPLE) {
    if (f.outOfSample.trades < MIN_OUT_OF_SAMPLE * NEAR_SAMPLE_SHARE) return null;
    out.push(
      `樣本外 ${f.outOfSample.trades} 筆，還差 ${MIN_OUT_OF_SAMPLE - f.outOfSample.trades} 筆結算` +
        `（新的日線 K 棒會落在樣本外那一半，樣本會隨時間長大）`,
    );
  }

  return out.length > 0 ? out : null;
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
  /** Failed by a small margin, with the distance stated. Never a recommendation. */
  nearMisses: NearMiss[];
  /** How many hypotheses were tested — the multiple-testing denominator. */
  tested: number;
  /** Roughly how many of them would look good by luck alone. */
  expectedFalsePositives: number;
  /** The followability (hit-rate) floor both halves must clear. */
  floor: number;
  /** The expectancy floor both halves must clear, in R. */
  minExpectancyR: number;
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
      (outOfSample.hitRate ?? 0) >= floor &&
      (inSample.expectancyR ?? -Infinity) >= LAB_MIN_EXPECTANCY_R &&
      (outOfSample.expectancyR ?? -Infinity) >= LAB_MIN_EXPECTANCY_R;
    const lift =
      inSample.hitRate !== null && baseline.inSample.hitRate !== null
        ? Math.round((inSample.hitRate - baseline.inSample.hitRate) * 1000) / 10
        : null;
    return { ids, labels: ids.map(label), inSample, outOfSample, verified, lift };
  };

  // Ranked on expectancy — under managed exits that is the number that
  // decides, with the hit rate shown beside it rather than doing the sorting.
  const byExpectancy = (r: ConditionResult) => r.expectancyR ?? -999;
  const solo = CONDITIONS.map((c) => finding([c.id]))
    .filter((f) => f.inSample.trades >= MIN_SAMPLE)
    .sort((a, b) => byExpectancy(b.inSample) - byExpectancy(a.inSample));

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

  combos.sort((a, b) => byExpectancy(b.inSample) - byExpectancy(a.inSample));
  const pairs = combos;

  const tested = solo.length + pairs.length;
  const verified = [...solo, ...pairs]
    .filter((f) => f.verified)
    .sort((a, b) => byExpectancy(b.outOfSample) - byExpectancy(a.outOfSample));

  // 接近通過 — capped, because with ~2,000 hypotheses the band just under the
  // floor is exactly where the luckiest non-discoveries pile up, and a long
  // list of them reads as a menu.
  const nearMisses: NearMiss[] = [...solo, ...pairs]
    .map((f) => {
      const shortfalls = shortfallsOf(f, floor);
      return shortfalls ? { ...f, shortfalls } : null;
    })
    .filter((f): f is NearMiss => f !== null)
    .sort((a, b) => byExpectancy(b.outOfSample) - byExpectancy(a.outOfSample))
    .slice(0, 6);

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
    `出場不再是固定 R：停損掛在已確認 swing 外 0.5×ATR、停利掛在最近的上方壓力（swing high 或 20 根區間高點），` +
      `走出 1R 保本移停、新 swing 確認就把停損墊上去、出現反向 CHoCH（結構翻轉）以收盤離場，最多持有 ${HORIZON} 根後以市價結算。` +
      `這和 live 交易計畫與監控用的是同一套規則。基本面與新聞的看法改變無法重播歷史（沒有逐 bar 的新聞檔案），` +
      `所以「看法改變」在回測裡只有結構這種可驗證的形式 —— live 監控才處理其餘的。`,
  );
  notes.push(
    `通過門檻：樣本內至少 ${MIN_SAMPLE} 筆、樣本外至少 ${MIN_OUT_OF_SAMPLE} 筆（樣本外只有 30% 的資料，` +
      `按同樣的發生率換算），兩邊期望值都要 ≥ +${LAB_MIN_EXPECTANCY_R}R（舊制 80% × 1:1.5 換算成 R 的同一條線），` +
      `且兩邊勝率都要 ≥ ${Math.round(floor * 100)}%（可跟性下限 —— 期望值再高，輸太頻繁也拿不住）。` +
      `條件愈疊愈多，符合的 K 棒就愈少 —— 疊到樣本數不足的組合會在報告前就被剔除，` +
      `這正是防止「十一筆交易 100% 勝率」這種假發現的機制。`,
  );
  // 可交易率 — how many fires actually had structure to trade against.
  const entered = baseline.inSample.entries;
  const resolved = baseline.inSample.trades;
  notes.push(
    `可交易率：基準線在樣本內有 ${entered} 根 K 棒可進場，其中 ${resolved} 筆找得到合理的結構停損並完整走完` +
      `（${entered > 0 ? Math.round((resolved / entered) * 100) : 0}%）。` +
      `找不到結構停損的那些沒有進場 —— live 的計畫同樣會拒絕它們，實驗量的是同一種交易。` +
      `表格中的 n 是「成交筆數／符合條件次數」。`,
  );
  if (verified.length === 0) {
    notes.push(
      "本次沒有任何條件通過樣本外驗證。這是結論而不是失敗：代表在這段歷史上，" +
        "這些條件沒有一個能穩定把期望值推過門檻，硬把樣本內最好的那個拿來用就是過度擬合。",
    );
  }

  return {
    symbol: meta.symbol,
    direction,
    baseline,
    solo,
    pairs,
    verified,
    nearMisses,
    tested,
    expectedFalsePositives: Math.round(tested * 0.05),
    floor,
    minExpectancyR: LAB_MIN_EXPECTANCY_R,
    costPct: Math.round(costFraction * 100 * 1000) / 1000,
    bars: candles.length,
    notes,
  };
}
