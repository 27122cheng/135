import type { Candle } from "../data-sources/ohlcv";
import { atr as atrOf, ema, efficiencyRatio, macd, rsi } from "./indicators";
import { totalCostFraction, tradingCostFor } from "@/config/trading-costs";
import type { CommodityMeta } from "@/types/signal";

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

export interface Condition {
  id: string;
  label: string;
  /** What it is trying to capture, in one line. */
  rationale: string;
  /** True when bar `i` satisfies it for `direction`. */
  test: (ctx: LabContext, i: number, direction: "long" | "short") => boolean;
}

export interface LabContext {
  candles: Candle[];
  close: number[];
  ema20: number[];
  ema50: number[];
  ema200: number[];
  hist: (number | null)[];
  rsi14: (number | null)[];
  atr: (number | null)[];
  /** Efficiency ratio at each bar, over the trailing 20. */
  er: (number | null)[];
}

function align<T>(length: number, series: T[]): (T | null)[] {
  const out: (T | null)[] = new Array(length).fill(null);
  const offset = length - series.length;
  for (let i = 0; i < series.length; i++) out[offset + i] = series[i];
  return out;
}

/**
 * @param only When given, ATR and the efficiency ratio are computed at these
 *   bar indices alone. Both are O(n) per bar, so a full context is O(n²) — the
 *   sweep needs every bar and pays it once, but the live gate needs exactly one
 *   and would otherwise re-derive four hundred bars of history it never reads,
 *   nine times a scan. Everything else is O(n) whole-series either way.
 */
export function buildContext(candles: Candle[], only?: number[]): LabContext {
  const close = candles.map((c) => c.close);
  const er: (number | null)[] = new Array(candles.length).fill(null);
  const atrSeries: (number | null)[] = new Array(candles.length).fill(null);
  // ATR the same way the plan builder computes its single value — a lab
  // measuring on a different volatility definition would not be measuring the
  // system's own geometry.
  const wanted = only ?? null;
  for (let i = 0; i < candles.length; i++) {
    if (wanted && !wanted.includes(i)) continue;
    if (i >= 20) er[i] = efficiencyRatio(close.slice(0, i + 1), 20);
    if (i >= 14) atrSeries[i] = atrOf(candles.slice(0, i + 1), 14);
  }
  return {
    candles,
    close,
    ema20: ema(close, 20),
    ema50: ema(close, 50),
    ema200: ema(close, 200),
    hist: align(close.length, macd(close).histogram),
    rsi14: align(close.length, rsi(close, 14)),
    atr: atrSeries,
    er,
  };
}

const side = (direction: "long" | "short", value: number, threshold: number) =>
  direction === "long" ? value > threshold : value < threshold;

/**
 * The candidate conditions.
 *
 * Every one is something the analysis already believes, written so it can be
 * checked rather than argued about. Deliberately kept to a dozen: each extra
 * condition adds itself plus a dozen pairings to the multiple-testing
 * problem, and a lab that tests everything discovers nothing.
 */
export const CONDITIONS: Condition[] = [
  {
    id: "ema-stack",
    label: "均線多頭／空頭排列",
    rationale: "價格、EMA20、EMA50 三者同向排列 —— 系統目前給權重 2 的主力條件",
    test: (c, i, d) =>
      side(d, c.close[i], c.ema20[i]) && side(d, c.ema20[i], c.ema50[i]),
  },
  {
    id: "ema50-side",
    label: "站在 EMA50 正確側",
    rationale: "最寬鬆的趨勢過濾，回測分層的第三層就是它",
    test: (c, i, d) => side(d, c.close[i], c.ema50[i]),
  },
  {
    id: "ema200-side",
    label: "站在 EMA200 正確側",
    rationale: "主趨勢方向；比 EMA50 慢，理論上更少但更乾淨的訊號",
    test: (c, i, d) => Number.isFinite(c.ema200[i]) && side(d, c.close[i], c.ema200[i]),
  },
  {
    id: "macd-agree",
    label: "MACD 柱狀圖同向",
    rationale: "動能與方向一致，避免在動能反向時進場",
    test: (c, i, d) => {
      const h = c.hist[i];
      return h !== null && (d === "long" ? h > 0 : h < 0);
    },
  },
  {
    id: "macd-fresh",
    label: "MACD 剛翻正／翻負（3 根內）",
    rationale: "動能剛轉向，理論上比已經翻很久更早進場",
    test: (c, i, d) => {
      const now = c.hist[i];
      if (now === null || (d === "long" ? now <= 0 : now >= 0)) return false;
      for (let k = 1; k <= 3; k++) {
        const prev = c.hist[i - k];
        if (prev !== null && (d === "long" ? prev <= 0 : prev >= 0)) return true;
      }
      return false;
    },
  },
  {
    id: "rsi-side",
    label: "RSI 在方向側（>50／<50）",
    rationale: "相對強度與方向一致，回測最強分層的組成之一",
    test: (c, i, d) => {
      const v = c.rsi14[i];
      return v !== null && (d === "long" ? v > 50 : v < 50);
    },
  },
  {
    id: "rsi-not-extreme",
    label: "RSI 未進入極端（30–70）",
    rationale: "避免在超買追高、超賣殺低 —— 常見說法，但值得實測",
    test: (c, i) => {
      const v = c.rsi14[i];
      return v !== null && v > 30 && v < 70;
    },
  },
  {
    id: "trending",
    label: "趨勢效率 ER ≥ 0.35",
    rationale: "走勢夠直才叫趨勢；系統已用它替盤整降權，這裡驗證門檻是否合適",
    test: (c, i) => (c.er[i] ?? 0) >= 0.35,
  },
  {
    id: "not-choppy",
    label: "非盤整 ER ≥ 0.18",
    rationale: "較寬鬆的盤整過濾，看看是不是比 0.35 更划算",
    test: (c, i) => (c.er[i] ?? 0) >= 0.18,
  },
  {
    id: "pullback",
    label: "回檔至 EMA20 附近（1×ATR 內）",
    rationale: "不追價 —— 交易員視角裡最核心的執行紀律，值得單獨驗證",
    test: (c, i) => {
      const a = c.atr[i];
      return a !== null && a > 0 && Math.abs(c.close[i] - c.ema20[i]) <= a;
    },
  },
  {
    id: "not-extended",
    label: "未過度乖離（距 EMA50 < 3×ATR）",
    rationale: "乖離過大時進場，等於買在別人準備獲利了結的位置",
    test: (c, i) => {
      const a = c.atr[i];
      return a !== null && a > 0 && Math.abs(c.close[i] - c.ema50[i]) < a * 3;
    },
  },
  {
    id: "higher-structure",
    label: "20 根內創新高／新低",
    rationale: "最單純的動能突破定義，作為對照組",
    test: (c, i, d) => {
      const window = c.candles.slice(Math.max(0, i - 20), i);
      if (window.length < 10) return false;
      return d === "long"
        ? c.close[i] > Math.max(...window.map((b) => b.high))
        : c.close[i] < Math.min(...window.map((b) => b.low));
    },
  },
];

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

  const measure = (accept: (i: number) => boolean) => ({
    inSample: run(ctx, direction, accept, 0, split, costFraction),
    outOfSample: run(ctx, direction, accept, split, candles.length, costFraction),
  });

  const baseline = measure(() => true);

  const finding = (ids: string[], labels: string[]): LabFinding => {
    const tests = ids.map((id) => CONDITIONS.find((c) => c.id === id)!);
    const { inSample, outOfSample } = measure((i) =>
      tests.every((t) => t.test(ctx, i, direction)),
    );
    const verified =
      inSample.trades >= MIN_SAMPLE &&
      outOfSample.trades >= MIN_OUT_OF_SAMPLE &&
      (inSample.hitRate ?? 0) >= floor &&
      (outOfSample.hitRate ?? 0) >= floor;
    const lift =
      inSample.hitRate !== null && baseline.inSample.hitRate !== null
        ? Math.round((inSample.hitRate - baseline.inSample.hitRate) * 1000) / 10
        : null;
    return { ids, labels, inSample, outOfSample, verified, lift };
  };

  const solo = CONDITIONS.map((c) => finding([c.id], [c.label]))
    .filter((f) => f.inSample.trades >= MIN_SAMPLE)
    .sort((a, b) => (b.inSample.hitRate ?? 0) - (a.inSample.hitRate ?? 0));

  // Only combine conditions that beat the baseline on their own. Stacking two
  // conditions that each do nothing is how a search spends its whole budget
  // on noise — and every extra test makes the false-positive count worse.
  const promising = solo
    .filter((f) => (f.lift ?? 0) > 0)
    .slice(0, 6)
    .map((f) => f.ids[0]);

  const label = (id: string) => CONDITIONS.find((c) => c.id === id)!.label;

  /**
   * Combinations, grown one condition at a time rather than fixed at two.
   *
   * Beam search, not exhaustive: at each depth only the best few survivors
   * are extended. Enumerating all 3-way and 4-way stacks of twelve
   * conditions is 715 more hypotheses, and testing 700 things against one
   * price series guarantees a spectacular-looking winner that means nothing.
   * The beam keeps the search honest by keeping it small.
   *
   * Growth stops on its own: every added condition cuts how many bars
   * qualify, so combinations fall below the 100-trade floor after two or
   * three and are dropped before they can be reported.
   */
  const BEAM = 5;
  const MAX_DEPTH = 4;
  const combos: LabFinding[] = [];
  let frontier: string[][] = promising.map((id) => [id]);

  for (let depth = 2; depth <= MAX_DEPTH; depth++) {
    const next: LabFinding[] = [];
    const seen = new Set<string>();
    for (const base of frontier) {
      for (const id of promising) {
        if (base.includes(id)) continue;
        const ids = [...base, id].sort();
        const key = ids.join("+");
        if (seen.has(key)) continue;
        seen.add(key);
        const f = finding(ids, ids.map(label));
        // Below the sample floor it cannot be reported *or* extended: a
        // thinner stack built on top of it can only have fewer trades.
        if (f.inSample.trades >= MIN_SAMPLE) next.push(f);
      }
    }
    if (next.length === 0) break;
    next.sort((a, b) => (b.inSample.hitRate ?? 0) - (a.inSample.hitRate ?? 0));
    combos.push(...next);
    frontier = next.slice(0, BEAM).map((f) => f.ids);
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
    `共測試 ${tested} 個假設。以 5% 的偶然顯著率估算，約有 ${Math.round(tested * 0.05)} 個` +
      `會單純因為運氣好看 —— 這就是為什麼只有樣本內外都過門檻的才標為「通過」。`,
  );
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
