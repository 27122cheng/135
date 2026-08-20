import type { Candle } from "../data-sources/ohlcv";
import { ema, macd, rsi } from "./indicators";

/**
 * 進場條件庫 — every hypothesis the lab is allowed to test.
 *
 * ## What belongs here
 *
 * A condition is a yes/no question about one bar that can be answered from
 * price and volume alone, with no look-ahead. That constraint is what makes
 * the lab's numbers mean anything: if a condition could peek at the next bar
 * its hit rate would be a measurement of the peeking.
 *
 * The families below — SMC/ICT structure, CRT, naked price action, volume
 * behaviour, and the classic commodity/FX setups — are here because they are
 * what people actually trade these instruments on. None of them is assumed to
 * work. That is the entire point: they get measured, most will turn out to be
 * worth nothing on their own, and the ones that survive both halves of the
 * split earn their place in the trade rules.
 *
 * ## What cannot be here, honestly
 *
 * **足跡圖 (footprint)** needs bid/ask volume at each price level — order-flow
 * data from a paid feed. Free OHLCV has one volume number per bar and no side.
 * What is implemented instead are the volume-behaviour readings that *can* be
 * derived from a bar (climax, effort-versus-result, close position within the
 * range as a delta proxy). They are labelled as proxies, not as footprint,
 * because calling them footprint would be a lie the numbers cannot detect.
 *
 * **巨鯨 (whales)** on FX and commodities means the COT report and central-bank
 * flows, both already in the signal's 籌碼面 dimension. They are weekly and the
 * free source does not go back ten years, so they cannot be tested here yet;
 * the price-derived institutional-participation proxies below (large body on
 * large volume) are what the candles can support. Spot FX also reports no real
 * volume at all, so every volume condition returns false there rather than
 * inventing participation — which is why they will show up with tiny samples
 * on the FX pairs. That is the correct answer, not a bug.
 *
 * **ICT killzones** are intraday windows (London open, New York open). On a
 * daily bar there is no such thing, so they are absent rather than faked.
 *
 * ## Cost
 *
 * Every helper below is O(n) over the series and computed once into the
 * context. The lab evaluates hundreds of combinations; a condition that
 * allocates an array per bar would make an exhaustive search impossible, and
 * an exhaustive search is what was asked for.
 */

export interface LabContext {
  candles: Candle[];
  close: number[];
  high: number[];
  low: number[];
  open: number[];
  ema20: number[];
  ema50: number[];
  ema200: number[];
  hist: (number | null)[];
  rsi14: (number | null)[];
  atr: (number | null)[];
  er: (number | null)[];

  // ── structure (SMC/ICT) ────────────────────────────────────────
  /** Price of the newest swing high confirmed at or before this bar; NaN before one exists. */
  swingHigh: number[];
  swingLow: number[];
  /**
   * The same confirmed pivots, but never "consumed" by a break.
   *
   * swingHigh/swingLow are BOS bookkeeping: once a close breaks the standing
   * level it is set to NaN so the next break needs a new pivot. Right for
   * detecting structure *events*, useless as a stop or target anchor — in a
   * trend the broken side is NaN for most of the move. These carry the newest
   * confirmed pivot unconditionally, for the managed exits.
   */
  anchorHigh: number[];
  anchorLow: number[];
  /** True on the bar whose close broke the standing swing high / low. */
  bosUp: boolean[];
  bosDown: boolean[];
  /** A BOS that reversed the prevailing structural direction. */
  chochUp: boolean[];
  chochDown: boolean[];
  /** Bounds of the newest unfilled bullish/bearish fair-value gap; NaN when none. */
  fvgUpLow: number[];
  fvgUpHigh: number[];
  fvgDownLow: number[];
  fvgDownHigh: number[];
  /** Bounds of the active bullish/bearish order block; NaN when none. */
  obUpLow: number[];
  obUpHigh: number[];
  obDownLow: number[];
  obDownHigh: number[];
  /** Position of the close inside the 20-bar dealing range, 0 (low) to 1 (high). */
  rangePos: number[];
  /** Two or more highs/lows clustered within 0.15×ATR — a liquidity pool. */
  equalHighs: boolean[];
  equalLows: boolean[];

  // ── bar behaviour ──────────────────────────────────────────────
  /** Close position inside the bar's own range, 0 (at low) to 1 (at high). */
  closePos: number[];
  /** |close − open| ÷ ATR. */
  bodyAtr: number[];
  /** Volume ÷ 20-bar average volume; NaN when the feed reports no volume. */
  volRatio: number[];

  // ── classic levels ─────────────────────────────────────────────
  /** Highest high / lowest low of the 20 bars *before* this one. */
  donHigh: number[];
  donLow: number[];
  /** Bollinger bandwidth (2σ ÷ SMA20) and its 20-bar minimum. */
  bbWidth: number[];
  bbWidthFloor: number[];
  /** The previous bar's extremes — the most traded level in FX. */
  prevHigh: number[];
  prevLow: number[];
  /** Open of the first bar of this bar's week. */
  weekOpen: number[];
}

const NaNs = (n: number) => new Array<number>(n).fill(NaN);
const falses = (n: number) => new Array<boolean>(n).fill(false);

/** Left/right bars a pivot needs to be called a swing. Confirmation lags by this. */
const PIVOT = 2;
/** How far back an order block may be looked for behind the impulse. */
const OB_LOOKBACK = 10;
/** The dealing range and most rolling windows. */
const WINDOW = 20;

function align<T>(length: number, series: T[]): (T | null)[] {
  const out: (T | null)[] = new Array(length).fill(null);
  const offset = length - series.length;
  for (let i = 0; i < series.length; i++) out[offset + i] = series[i];
  return out;
}

/**
 * Everything a condition might ask about, computed once.
 *
 * @param only Restrict the O(n)-per-bar readings (ATR, ER) to these indices.
 *   The live gate needs exactly one bar and would otherwise re-derive the
 *   whole history nine times a scan. Structure is always computed in full —
 *   it is O(n) either way and每 condition depends on it.
 */
export function buildContext(candles: Candle[], only?: number[]): LabContext {
  const n = candles.length;
  const close = candles.map((c) => c.close);
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const open = candles.map((c) => c.open);

  // ── ATR and ER, rolling ──────────────────────────────────────────
  // Both were O(n) *per bar* (a slice plus a reduce), which is O(n²) over the
  // series — tolerable on 250 bars, not on the 2,500 the lab now reads, and
  // certainly not with an exhaustive search on top. Rolling sums give the same
  // numbers: ATR here is the mean of the last 14 true ranges, and the
  // efficiency ratio is net move ÷ path length over 21 closes.
  const atr = NaNs(n).map(() => null as number | null);
  const er = NaNs(n).map(() => null as number | null);
  const wanted = only ? new Set(only) : null;
  const tr: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const prevClose = close[i - 1];
    tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - prevClose), Math.abs(low[i] - prevClose));
  }
  let trSum = 0;
  for (let i = 1; i < n; i++) {
    trSum += tr[i];
    if (i > 14) trSum -= tr[i - 14];
    if (i >= 14 && (!wanted || wanted.has(i))) atr[i] = trSum / 14;
  }
  let path = 0;
  for (let i = 1; i < n; i++) {
    path += Math.abs(close[i] - close[i - 1]);
    if (i > WINDOW) path -= Math.abs(close[i - WINDOW] - close[i - WINDOW - 1]);
    if (i >= WINDOW && (!wanted || wanted.has(i))) {
      const net = Math.abs(close[i] - close[i - WINDOW]);
      er[i] = path === 0 ? null : net / path;
    }
  }

  // ── swings, structure, BOS and CHoCH ─────────────────────────────
  //
  // A pivot is only *knowable* two bars after it printed, so it is recorded at
  // the bar that confirms it. Reading a swing on the bar it formed would be
  // look-ahead — the single most common way a backtest of these ideas lies.
  const swingHigh = NaNs(n);
  const swingLow = NaNs(n);
  const anchorHigh = NaNs(n);
  const anchorLow = NaNs(n);
  const bosUp = falses(n);
  const bosDown = falses(n);
  const chochUp = falses(n);
  const chochDown = falses(n);
  let curHigh = NaN;
  let curLow = NaN;
  let lastHigh = NaN;
  let lastLow = NaN;
  let structDir = 0;
  for (let i = 0; i < n; i++) {
    const p = i - PIVOT;
    if (p >= PIVOT) {
      let isHigh = true;
      let isLow = true;
      for (let k = 1; k <= PIVOT; k++) {
        if (high[p] < high[p - k] || high[p] < high[p + k]) isHigh = false;
        if (low[p] > low[p - k] || low[p] > low[p + k]) isLow = false;
      }
      if (isHigh) {
        curHigh = high[p];
        lastHigh = high[p];
      }
      if (isLow) {
        curLow = low[p];
        lastLow = low[p];
      }
    }
    swingHigh[i] = curHigh;
    swingLow[i] = curLow;
    anchorHigh[i] = lastHigh;
    anchorLow[i] = lastLow;

    if (Number.isFinite(curHigh) && close[i] > curHigh) {
      bosUp[i] = true;
      if (structDir === -1) chochUp[i] = true;
      structDir = 1;
      // The broken high is consumed: the next BOS needs a new one.
      curHigh = NaN;
    } else if (Number.isFinite(curLow) && close[i] < curLow) {
      bosDown[i] = true;
      if (structDir === 1) chochDown[i] = true;
      structDir = -1;
      curLow = NaN;
    }
  }

  // ── fair value gaps ──────────────────────────────────────────────
  //
  // Bullish: bar i's low sits above bar i−2's high, so the middle bar left a
  // window price never traded through. It stays "open" until price trades back
  // into it. Only the newest unfilled one is tracked — an FVG from 400 bars ago
  // is not what anybody means by an imbalance.
  const fvgUpLow = NaNs(n);
  const fvgUpHigh = NaNs(n);
  const fvgDownLow = NaNs(n);
  const fvgDownHigh = NaNs(n);
  let upGap: { low: number; high: number } | null = null;
  let downGap: { low: number; high: number } | null = null;
  for (let i = 0; i < n; i++) {
    if (upGap && low[i] <= upGap.low) upGap = null;
    if (downGap && high[i] >= downGap.high) downGap = null;
    if (i >= 2) {
      if (low[i] > high[i - 2]) upGap = { low: high[i - 2], high: low[i] };
      if (high[i] < low[i - 2]) downGap = { low: high[i], high: low[i - 2] };
    }
    fvgUpLow[i] = upGap?.low ?? NaN;
    fvgUpHigh[i] = upGap?.high ?? NaN;
    fvgDownLow[i] = downGap?.low ?? NaN;
    fvgDownHigh[i] = downGap?.high ?? NaN;
  }

  // ── order blocks ─────────────────────────────────────────────────
  //
  // The last opposing candle before the move that broke structure. Kept active
  // until price closes through it, which is the usual definition of the block
  // being "mitigated" and no longer interesting.
  const obUpLow = NaNs(n);
  const obUpHigh = NaNs(n);
  const obDownLow = NaNs(n);
  const obDownHigh = NaNs(n);
  let obUp: { low: number; high: number } | null = null;
  let obDown: { low: number; high: number } | null = null;
  for (let i = 0; i < n; i++) {
    if (bosUp[i]) {
      for (let k = 1; k <= OB_LOOKBACK && i - k >= 0; k++) {
        if (close[i - k] < open[i - k]) {
          obUp = { low: low[i - k], high: high[i - k] };
          break;
        }
      }
    }
    if (bosDown[i]) {
      for (let k = 1; k <= OB_LOOKBACK && i - k >= 0; k++) {
        if (close[i - k] > open[i - k]) {
          obDown = { low: low[i - k], high: high[i - k] };
          break;
        }
      }
    }
    if (obUp && close[i] < obUp.low) obUp = null;
    if (obDown && close[i] > obDown.high) obDown = null;
    obUpLow[i] = obUp?.low ?? NaN;
    obUpHigh[i] = obUp?.high ?? NaN;
    obDownLow[i] = obDown?.low ?? NaN;
    obDownHigh[i] = obDown?.high ?? NaN;
  }

  // ── ranges, channels, bands ──────────────────────────────────────
  const donHigh = NaNs(n);
  const donLow = NaNs(n);
  const rangePos = NaNs(n);
  const equalHighs = falses(n);
  const equalLows = falses(n);
  const bbWidth = NaNs(n);
  const bbWidthFloor = NaNs(n);
  const prevHigh = NaNs(n);
  const prevLow = NaNs(n);
  for (let i = 0; i < n; i++) {
    prevHigh[i] = i > 0 ? high[i - 1] : NaN;
    prevLow[i] = i > 0 ? low[i - 1] : NaN;
    if (i < WINDOW) continue;

    let hh = -Infinity;
    let ll = Infinity;
    let sum = 0;
    for (let k = i - WINDOW; k < i; k++) {
      if (high[k] > hh) hh = high[k];
      if (low[k] < ll) ll = low[k];
      sum += close[k];
    }
    donHigh[i] = hh;
    donLow[i] = ll;
    rangePos[i] = hh > ll ? (close[i] - ll) / (hh - ll) : NaN;

    const mean = sum / WINDOW;
    let variance = 0;
    for (let k = i - WINDOW; k < i; k++) variance += (close[k] - mean) ** 2;
    bbWidth[i] = mean > 0 ? (2 * Math.sqrt(variance / WINDOW)) / mean : NaN;

    // A liquidity pool: several highs (lows) resting at the same level. The
    // tolerance scales with volatility, so it means the same thing on gold and
    // on EURUSD.
    const a = atr[i] ?? tr[i];
    if (a > 0) {
      let nearHigh = 0;
      let nearLow = 0;
      for (let k = i - WINDOW; k < i; k++) {
        if (Math.abs(high[k] - hh) <= a * 0.15) nearHigh++;
        if (Math.abs(low[k] - ll) <= a * 0.15) nearLow++;
      }
      equalHighs[i] = nearHigh >= 2 && hh > close[i];
      equalLows[i] = nearLow >= 2 && ll < close[i];
    }
  }
  for (let i = 0; i < n; i++) {
    if (i < WINDOW * 2) continue;
    let floor = Infinity;
    for (let k = i - WINDOW; k <= i; k++) {
      if (Number.isFinite(bbWidth[k]) && bbWidth[k] < floor) floor = bbWidth[k];
    }
    bbWidthFloor[i] = Number.isFinite(floor) ? floor : NaN;
  }

  // ── bar behaviour and volume ─────────────────────────────────────
  const closePos = NaNs(n);
  const bodyAtr = NaNs(n);
  const volRatio = NaNs(n);
  let volSum = 0;
  let volCount = 0;
  for (let i = 0; i < n; i++) {
    const range = high[i] - low[i];
    closePos[i] = range > 0 ? (close[i] - low[i]) / range : NaN;
    const a = atr[i];
    bodyAtr[i] = a && a > 0 ? Math.abs(close[i] - open[i]) / a : NaN;

    // Spot FX reports no volume; a zero here means "not measured", never "no
    // trading", and must not become a participation reading.
    const v = candles[i].volume;
    const usable = typeof v === "number" && Number.isFinite(v) && v > 0;
    if (i >= WINDOW) {
      const old = candles[i - WINDOW].volume;
      if (typeof old === "number" && Number.isFinite(old) && old > 0) {
        volSum -= old;
        volCount--;
      }
    }
    if (volCount >= WINDOW / 2 && volSum > 0 && usable) {
      volRatio[i] = v! / (volSum / volCount);
    }
    if (usable) {
      volSum += v!;
      volCount++;
    }
  }

  // ── week open ────────────────────────────────────────────────────
  const weekOpen = NaNs(n);
  let currentWeek = "";
  let currentOpen = NaN;
  for (let i = 0; i < n; i++) {
    const d = new Date(candles[i].time);
    // Monday-anchored week key from the UTC date.
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    if (key !== currentWeek) {
      currentWeek = key;
      currentOpen = open[i];
    }
    weekOpen[i] = currentOpen;
  }

  return {
    candles,
    close,
    high,
    low,
    open,
    ema20: ema(close, 20),
    ema50: ema(close, 50),
    ema200: ema(close, 200),
    hist: align(n, macd(close).histogram),
    rsi14: align(n, rsi(close, 14)),
    atr,
    er,
    swingHigh,
    swingLow,
    anchorHigh,
    anchorLow,
    bosUp,
    bosDown,
    chochUp,
    chochDown,
    fvgUpLow,
    fvgUpHigh,
    fvgDownLow,
    fvgDownHigh,
    obUpLow,
    obUpHigh,
    obDownLow,
    obDownHigh,
    rangePos,
    equalHighs,
    equalLows,
    closePos,
    bodyAtr,
    volRatio,
    donHigh,
    donLow,
    bbWidth,
    bbWidthFloor,
    prevHigh,
    prevLow,
    weekOpen,
  };
}

export interface Condition {
  id: string;
  label: string;
  /** What it is trying to capture, in one line. */
  rationale: string;
  /** Which school it comes from, for grouping on the page. */
  family: "趨勢" | "動能" | "SMC/ICT" | "CRT" | "裸K" | "量能" | "型態" | "位置";
  /** True when bar `i` satisfies it for `direction`. */
  test: (ctx: LabContext, i: number, direction: "long" | "short") => boolean;
}

const side = (direction: "long" | "short", value: number, threshold: number) =>
  direction === "long" ? value > threshold : value < threshold;

const inZone = (price: number, low: number, high: number) =>
  Number.isFinite(low) && Number.isFinite(high) && price >= low && price <= high;

export const CONDITIONS: Condition[] = [
  // ── 趨勢 / 動能: what the system already believed ────────────────
  {
    id: "ema-stack",
    label: "均線多頭／空頭排列",
    rationale: "價格、EMA20、EMA50 三者同向排列 —— 系統目前給權重 2 的主力條件",
    family: "趨勢",
    test: (c, i, d) => side(d, c.close[i], c.ema20[i]) && side(d, c.ema20[i], c.ema50[i]),
  },
  {
    id: "ema50-side",
    label: "站在 EMA50 正確側",
    rationale: "最寬鬆的趨勢過濾，回測分層的第三層就是它",
    family: "趨勢",
    test: (c, i, d) => side(d, c.close[i], c.ema50[i]),
  },
  {
    id: "ema200-side",
    label: "站在 EMA200 正確側",
    rationale: "主趨勢方向；比 EMA50 慢，理論上更少但更乾淨的訊號",
    family: "趨勢",
    test: (c, i, d) => Number.isFinite(c.ema200[i]) && side(d, c.close[i], c.ema200[i]),
  },
  {
    id: "macd-agree",
    label: "MACD 柱狀圖同向",
    rationale: "動能與方向一致，避免在動能反向時進場",
    family: "動能",
    test: (c, i, d) => {
      const h = c.hist[i];
      return h !== null && (d === "long" ? h > 0 : h < 0);
    },
  },
  {
    id: "macd-fresh",
    label: "MACD 剛翻正／翻負（3 根內）",
    rationale: "動能剛轉向，理論上比已經翻很久更早進場",
    family: "動能",
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
    id: "rsi-divergence",
    label: "RSI 背離（價格新極值、RSI 不跟）",
    rationale:
      "做多：價格創 20 根新低但 RSI 高於前低點的 RSI —— 動能衰竭的經典反轉線索。兩個低點至少隔 5 根，避免把同一支腳算成背離",
    family: "動能",
    test: (c, i, d) => {
      const r = c.rsi14[i];
      if (r === null || i < 25) return false;
      let extIdx = -1;
      if (d === "long") {
        let ext = Infinity;
        for (let k = i - 20; k <= i - 5; k++) {
          if (c.low[k] < ext) {
            ext = c.low[k];
            extIdx = k;
          }
        }
        const rPrev = extIdx >= 0 ? c.rsi14[extIdx] : null;
        return rPrev !== null && c.low[i] < ext && r > rPrev;
      }
      let ext = -Infinity;
      for (let k = i - 20; k <= i - 5; k++) {
        if (c.high[k] > ext) {
          ext = c.high[k];
          extIdx = k;
        }
      }
      const rPrev = extIdx >= 0 ? c.rsi14[extIdx] : null;
      return rPrev !== null && c.high[i] > ext && r < rPrev;
    },
  },
  {
    id: "hist-divergence",
    label: "MACD 柱背離",
    rationale:
      "價格創 20 根新極值但 MACD 柱的力道比前一個極值弱 —— 和 RSI 背離同一個想法，用另一支溫度計量",
    family: "動能",
    test: (c, i, d) => {
      const h = c.hist[i];
      if (h === null || i < 25) return false;
      let extIdx = -1;
      if (d === "long") {
        let ext = Infinity;
        for (let k = i - 20; k <= i - 5; k++) {
          if (c.low[k] < ext) {
            ext = c.low[k];
            extIdx = k;
          }
        }
        const hPrev = extIdx >= 0 ? c.hist[extIdx] : null;
        return hPrev !== null && c.low[i] < ext && h > hPrev;
      }
      let ext = -Infinity;
      for (let k = i - 20; k <= i - 5; k++) {
        if (c.high[k] > ext) {
          ext = c.high[k];
          extIdx = k;
        }
      }
      const hPrev = extIdx >= 0 ? c.hist[extIdx] : null;
      return hPrev !== null && c.high[i] > ext && h < hPrev;
    },
  },
  {
    id: "rsi-side",
    label: "RSI 在方向側（>50／<50）",
    rationale: "相對強度與方向一致，回測最強分層的組成之一",
    family: "動能",
    test: (c, i, d) => {
      const v = c.rsi14[i];
      return v !== null && (d === "long" ? v > 50 : v < 50);
    },
  },
  {
    id: "rsi-not-extreme",
    label: "RSI 未進入極端（30–70）",
    rationale: "避免在超買追高、超賣殺低 —— 常見說法，但值得實測",
    family: "動能",
    test: (c, i) => {
      const v = c.rsi14[i];
      return v !== null && v > 30 && v < 70;
    },
  },
  {
    id: "trending",
    label: "趨勢效率 ER ≥ 0.35",
    rationale: "走勢夠直才叫趨勢；系統已用它替盤整降權，這裡驗證門檻是否合適",
    family: "趨勢",
    test: (c, i) => (c.er[i] ?? 0) >= 0.35,
  },
  {
    id: "not-choppy",
    label: "非盤整 ER ≥ 0.18",
    rationale: "較寬鬆的盤整過濾，看看是不是比 0.35 更划算",
    family: "趨勢",
    test: (c, i) => (c.er[i] ?? 0) >= 0.18,
  },
  {
    id: "pullback",
    label: "回檔至 EMA20 附近（1×ATR 內）",
    rationale: "不追價 —— 交易員視角裡最核心的執行紀律，值得單獨驗證",
    family: "位置",
    test: (c, i) => {
      const a = c.atr[i];
      return a !== null && a > 0 && Math.abs(c.close[i] - c.ema20[i]) <= a;
    },
  },
  {
    id: "not-extended",
    label: "未過度乖離（距 EMA50 < 3×ATR）",
    rationale: "乖離過大時進場，等於買在別人準備獲利了結的位置",
    family: "位置",
    test: (c, i) => {
      const a = c.atr[i];
      return a !== null && a > 0 && Math.abs(c.close[i] - c.ema50[i]) < a * 3;
    },
  },
  {
    id: "higher-structure",
    label: "20 根內創新高／新低",
    rationale: "最單純的動能突破定義，作為對照組",
    family: "型態",
    test: (c, i, d) =>
      d === "long"
        ? Number.isFinite(c.donHigh[i]) && c.close[i] > c.donHigh[i]
        : Number.isFinite(c.donLow[i]) && c.close[i] < c.donLow[i],
  },

  // ── SMC / ICT ────────────────────────────────────────────────────
  {
    id: "bos",
    label: "結構突破 BOS",
    rationale: "收盤突破已確認的擺動高／低點 —— SMC 對「趨勢延續」的定義",
    family: "SMC/ICT",
    test: (c, i, d) => (d === "long" ? c.bosUp[i] : c.bosDown[i]),
  },
  {
    id: "choch",
    label: "結構轉變 CHoCH",
    rationale: "反向的第一次結構突破，SMC 用來標記趨勢反轉的起點",
    family: "SMC/ICT",
    test: (c, i, d) => (d === "long" ? c.chochUp[i] : c.chochDown[i]),
  },
  {
    id: "order-block",
    label: "回測訂單塊 OB",
    rationale: "價格回到造成結構突破的那根反向 K 棒區間，SMC 的核心進場位",
    family: "SMC/ICT",
    test: (c, i, d) =>
      d === "long"
        ? inZone(c.close[i], c.obUpLow[i], c.obUpHigh[i])
        : inZone(c.close[i], c.obDownLow[i], c.obDownHigh[i]),
  },
  {
    id: "fvg-open",
    label: "下方／上方有未填補 FVG",
    rationale: "存在未回補的失衡區，ICT 認為價格傾向回頭補上",
    family: "SMC/ICT",
    test: (c, i, d) =>
      d === "long"
        ? Number.isFinite(c.fvgUpLow[i]) && c.close[i] > c.fvgUpHigh[i]
        : Number.isFinite(c.fvgDownHigh[i]) && c.close[i] < c.fvgDownLow[i],
  },
  {
    id: "fvg-inside",
    label: "價格正在 FVG 內回補",
    rationale: "回補失衡區的當下進場，是 ICT 最常被引用的進場時機",
    family: "SMC/ICT",
    test: (c, i, d) =>
      d === "long"
        ? inZone(c.close[i], c.fvgUpLow[i], c.fvgUpHigh[i])
        : inZone(c.close[i], c.fvgDownLow[i], c.fvgDownHigh[i]),
  },
  {
    id: "liquidity-sweep",
    label: "流動性掃蕩後收回",
    rationale: "先破前低（前高）獵停損再收回 —— ICT 的 turtle soup／SMC 的流動性抓取",
    family: "SMC/ICT",
    test: (c, i, d) => {
      if (i < 11) return false;
      if (d === "long") {
        let lowest = Infinity;
        for (let k = i - 10; k < i; k++) if (c.low[k] < lowest) lowest = c.low[k];
        return c.low[i] < lowest && c.close[i] > lowest;
      }
      let highest = -Infinity;
      for (let k = i - 10; k < i; k++) if (c.high[k] > highest) highest = c.high[k];
      return c.high[i] > highest && c.close[i] < highest;
    },
  },
  {
    id: "discount",
    label: "折價區買／溢價區賣",
    rationale: "只在 20 根區間的下半部做多、上半部做空 —— ICT 的 premium/discount",
    family: "位置",
    test: (c, i, d) => {
      const p = c.rangePos[i];
      return Number.isFinite(p) && (d === "long" ? p <= 0.5 : p >= 0.5);
    },
  },
  {
    id: "liquidity-target",
    label: "前方有等高／等低流動性池",
    rationale: "上方有並排的高點（下方有並排的低點），SMC 認為那是價格要去的地方",
    family: "SMC/ICT",
    test: (c, i, d) => (d === "long" ? c.equalHighs[i] : c.equalLows[i]),
  },

  // ── CRT ──────────────────────────────────────────────────────────
  {
    id: "crt",
    label: "CRT 三根模型",
    rationale: "第一根定範圍、第二根掃單邊、第三根往反向展開 —— Candle Range Theory 的完整型態",
    family: "CRT",
    test: (c, i, d) => {
      if (i < 2) return false;
      const mid = (c.high[i - 2] + c.low[i - 2]) / 2;
      if (d === "long") {
        const swept = c.low[i - 1] < c.low[i - 2] && c.close[i - 1] >= c.low[i - 2];
        return swept && c.close[i] > mid;
      }
      const swept = c.high[i - 1] > c.high[i - 2] && c.close[i - 1] <= c.high[i - 2];
      return swept && c.close[i] < mid;
    },
  },

  // ── 裸K ──────────────────────────────────────────────────────────
  {
    id: "engulfing",
    label: "吞噬型態",
    rationale: "實體完全包住前一根且方向相反 —— 最基本的裸K 反轉訊號",
    family: "裸K",
    test: (c, i, d) => {
      if (i < 1) return false;
      const bull = c.close[i] > c.open[i];
      if (d === "long") {
        return bull && c.close[i - 1] < c.open[i - 1] &&
          c.close[i] >= c.open[i - 1] && c.open[i] <= c.close[i - 1];
      }
      return !bull && c.close[i - 1] > c.open[i - 1] &&
        c.close[i] <= c.open[i - 1] && c.open[i] >= c.close[i - 1];
    },
  },
  {
    id: "pin-bar",
    label: "針形棒（錘子／流星）",
    rationale: "長影線代表某一側被拒絕，裸K 交易者最常用的單根訊號",
    family: "裸K",
    test: (c, i, d) => {
      const range = c.high[i] - c.low[i];
      if (!(range > 0)) return false;
      const body = Math.abs(c.close[i] - c.open[i]);
      if (body > range * 0.35) return false;
      const upper = c.high[i] - Math.max(c.close[i], c.open[i]);
      const lower = Math.min(c.close[i], c.open[i]) - c.low[i];
      return d === "long" ? lower >= range * 0.5 : upper >= range * 0.5;
    },
  },
  {
    id: "inside-break",
    label: "內包棒後突破",
    rationale: "前一根被完全包含在再前一根之內，本根突破 —— 壓縮後釋放",
    family: "裸K",
    test: (c, i, d) => {
      if (i < 2) return false;
      const inside = c.high[i - 1] <= c.high[i - 2] && c.low[i - 1] >= c.low[i - 2];
      if (!inside) return false;
      return d === "long" ? c.close[i] > c.high[i - 1] : c.close[i] < c.low[i - 1];
    },
  },

  // ── 量能（足跡圖的可得替代） ───────────────────────────────────────
  {
    id: "volume-climax",
    label: "量能高潮（≥2× 均量）",
    rationale: "成交量遠高於近期均值，代表大額參與者進場 —— 外匯現貨無量，會自動不成立",
    family: "量能",
    test: (c, i) => c.volRatio[i] >= 2,
  },
  {
    id: "close-strength",
    label: "收盤落在 K 棒方向側 70%",
    rationale: "收盤貼近高（低）點代表該根由買方（賣方）主導，是 delta 的免費替代",
    family: "量能",
    test: (c, i, d) => {
      const p = c.closePos[i];
      return Number.isFinite(p) && (d === "long" ? p >= 0.7 : p <= 0.3);
    },
  },
  {
    id: "effort-result",
    label: "有量無價（吸籌）",
    rationale: "量大但實體小，代表有人在這裡吸收賣單／買單，量價分析的核心讀法",
    family: "量能",
    test: (c, i) => c.volRatio[i] >= 1.5 && c.bodyAtr[i] < 0.5,
  },
  {
    id: "whale-bar",
    label: "巨量大實體棒",
    rationale: "大實體配大量 —— 機構參與的痕跡，價格能提供最接近「巨鯨」的證據",
    family: "量能",
    test: (c, i, d) => {
      if (!(c.volRatio[i] >= 1.5) || !(c.bodyAtr[i] >= 1)) return false;
      return d === "long" ? c.close[i] > c.open[i] : c.close[i] < c.open[i];
    },
  },

  // ── 經典商品／外匯 ────────────────────────────────────────────────
  {
    id: "donchian",
    label: "唐奇安 20 通道突破",
    rationale: "海龜法則的原始進場條件，商品期貨最古老也最被驗證過的規則之一",
    family: "型態",
    test: (c, i, d) =>
      d === "long"
        ? Number.isFinite(c.donHigh[i]) && c.high[i] > c.donHigh[i]
        : Number.isFinite(c.donLow[i]) && c.low[i] < c.donLow[i],
  },
  {
    id: "squeeze",
    label: "布林帶收窄後（波動壓縮）",
    rationale: "帶寬處於 20 根內最窄附近，經典的「壓縮後擴張」前提",
    family: "型態",
    test: (c, i) =>
      Number.isFinite(c.bbWidth[i]) &&
      Number.isFinite(c.bbWidthFloor[i]) &&
      c.bbWidth[i] <= c.bbWidthFloor[i] * 1.2,
  },
  {
    id: "atr-expansion",
    label: "波動擴張（本根 TR ≥ 1.5×ATR）",
    rationale: "區間被打破的當下往往就是波動放大的那一根",
    family: "型態",
    test: (c, i) => {
      const a = c.atr[i];
      return a !== null && a > 0 && c.high[i] - c.low[i] >= a * 1.5;
    },
  },
  {
    id: "prev-day-break",
    label: "突破前一根高／低",
    rationale: "前一日高低是外匯日內交易者最常掛單的位置",
    family: "位置",
    test: (c, i, d) =>
      d === "long"
        ? Number.isFinite(c.prevHigh[i]) && c.close[i] > c.prevHigh[i]
        : Number.isFinite(c.prevLow[i]) && c.close[i] < c.prevLow[i],
  },
  {
    id: "week-open-side",
    label: "站上／跌破本週開盤價",
    rationale: "週開盤是機構部位的成本參考，ICT 與外匯波段交易都在用",
    family: "位置",
    test: (c, i, d) =>
      Number.isFinite(c.weekOpen[i]) && side(d, c.close[i], c.weekOpen[i]),
  },
  {
    id: "round-number",
    label: "接近整數關卡",
    rationale: "外匯與黃金的停損最常掛在整數，價格到那裡的行為值得單獨測",
    family: "位置",
    test: (c, i) => {
      const a = c.atr[i];
      const p = c.close[i];
      if (a === null || !(a > 0) || !(p > 0)) return false;
      const step = 10 ** (Math.floor(Math.log10(p)) - 1);
      const distance = Math.abs(p - Math.round(p / step) * step);
      return distance <= a * 0.15;
    },
  },
];

/** Families in the order the page should group them. */
export const FAMILIES = ["趨勢", "動能", "SMC/ICT", "CRT", "裸K", "量能", "型態", "位置"] as const;
