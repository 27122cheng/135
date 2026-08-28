import type { LabContext } from "./lab-conditions";

/**
 * 結構管理式出場 — the one exit engine both the lab backtest and the forward
 * ledger run, so their columns stay comparable by construction.
 *
 * The lab used to resolve every trade on a fixed 1×ATR stop and 1.5×ATR
 * target. That made conditions comparable, but it measured a trade nobody
 * here actually takes: the live plans put stops behind structure, take profit
 * into overhead pressure, move to breakeven at 1R and step the stop up behind
 * new swings — and a condition that looks good under a geometry the system
 * never trades is not evidence about the system. Per the operator's
 * instruction the lab now trades the way the site trades:
 *
 *  - **停損在結構外**：最近的下方保護結構（已確認 swing low 或前一根低點，
 *    取較近且通過篩選者）外加 0.5×ATR 緩衝，與 live 計畫相同。條件成立但
 *    找不到合理結構停損（距離在雜訊內／太遠）就不進場 —— live 也不會進。
 *  - **停利在壓力位**：最近的上方已確認 swing high 或 20 根區間高點，取較近
 *    者。上方沒有記錄到壓力就不設停利，讓移動停損決定出場。
 *  - **保本移停**：走出 1R 後停損移到進場價 —— lib/monitor/plan-state.ts
 *    的同一條規則。
 *  - **結構移停**：新的 swing low 在停損之上確認，就把停損墊上去（只朝
 *    安全方向）。
 *  - **看法改變就出場**：出現反向 CHoCH（結構翻轉）以收盤價離場。這是
 *    「技術面看法改變」可以誠實回測的形式；基本面與新聞的看法改變無法
 *    重播歷史（沒有逐 bar 的新聞檔案），只有 live 的監控在做，這裡不假裝。
 *
 * Outcomes are measured in R — exit distance over the *initial* risk, net of
 * the round-trip cost — because with structural geometry every trade has its
 * own payoff and a bare hit rate no longer means one thing.
 */

/** Bars a trade may run before it is closed at the market. */
export const MANAGE_HORIZON = 20;
/** Structure stop buffer — the live plan's default (lib/entry-exit.ts). */
export const STOP_BUFFER_ATR = 0.5;
/** A stop closer than this is inside the noise — the live plan's own screen. */
export const MIN_STOP_ATR = 0.6;
/** A swing further than this is not protecting *this* entry. */
export const MAX_STOP_ATR = 2.5;
/** Overhead pressure closer than this is not a target worth registering. */
export const MIN_TARGET_ATR = 0.5;

export interface RegisteredLevels {
  stop: number;
  /** Null when no overhead pressure is on record — managed by the stop alone. */
  target: number | null;
}

/**
 * The levels a trade at bar `i` registers, from confirmed structure only —
 * or null when no sane structural stop exists, in which case there is no
 * trade. Everything read here is confirmed at or before bar `i`; the swing
 * series already carries the 2-bar confirmation lag, so this cannot peek.
 */
export function registerLevels(
  ctx: LabContext,
  i: number,
  direction: "long" | "short",
): RegisteredLevels | null {
  const a = ctx.atr[i];
  const entry = ctx.close[i];
  if (a === null || !(a > 0) || !(entry > 0)) return null;

  const buffer = a * STOP_BUFFER_ATR;
  if (direction === "long") {
    // Protecting structure below the entry: the newest confirmed swing low
    // (never consumed — anchorLow) and the previous bar's low, the most
    // traded classic level. Nearest first; the first one whose buffered stop
    // passes the noise/reach screens is the stop. In a strong trend the swing
    // can be far behind price while the prior bar's low still protects.
    const supports = [ctx.anchorLow[i], ctx.prevLow[i]]
      .filter((p) => Number.isFinite(p) && p < entry)
      .sort((x, y) => y - x);
    for (const support of supports) {
      const stop = support - buffer;
      const dist = entry - stop;
      if (dist >= a * MIN_STOP_ATR && dist <= a * MAX_STOP_ATR) {
        const overhead = [ctx.anchorHigh[i], ctx.donHigh[i]].filter(
          (p) => Number.isFinite(p) && p >= entry + a * MIN_TARGET_ATR,
        );
        return { stop, target: overhead.length > 0 ? Math.min(...overhead) : null };
      }
    }
    return null;
  }

  const resistances = [ctx.anchorHigh[i], ctx.prevHigh[i]]
    .filter((p) => Number.isFinite(p) && p > entry)
    .sort((x, y) => x - y);
  for (const resistance of resistances) {
    const stop = resistance + buffer;
    const dist = stop - entry;
    if (dist >= a * MIN_STOP_ATR && dist <= a * MAX_STOP_ATR) {
      const below = [ctx.anchorLow[i], ctx.donLow[i]].filter(
        (p) => Number.isFinite(p) && p <= entry - a * MIN_TARGET_ATR,
      );
      return { stop, target: below.length > 0 ? Math.max(...below) : null };
    }
  }
  return null;
}

/** Fraction of the position banked when the first target is touched. */
export const SCALE_OUT_FRACTION = 0.5;

/**
 * 分批止盈的前提：第一目標至少要值一個 R。
 *
 * The first cut scaled out at *every* registered target. But targets sit at
 * the nearest overhead pressure, which can be as close as 0.5×ATR — against
 * a 0.6–2.5×ATR stop that is often 0.2–0.8R — and banking half of a sub-1R
 * move while the remainder scratches at breakeven pockets a fraction of an
 * already-small win. The live sweep then measured it: every symbol's best
 * combination collapsed to ≈0R expectancy (SPX500 +0.04R, EURUSD −0.13R) and
 * the floors correctly refused everything — zero trades, zero reference
 * plans, eleven symbols. The textbook partial-exit rule carries this exact
 * precondition: scale out only when the first target pays at least the risk.
 * Nearer shelves exit in full — taking the whole shelf beats banking half a
 * crumb and donating the rest to a breakeven wash.
 */
export const SCALE_OUT_MIN_R = 1.0;

/**
 * 打平帶 — |net R| at or below this is a scratch, not a loss (or a win).
 *
 * The managed rules *manufacture* near-zero exits by design: breakeven at 1R
 * turns pullbacks into ±0R washes, trailing stops step out with small change.
 * Counting those as losses collapsed raw hit rates to 19–38% on the live
 * sweep while expectancy barely moved — and the 55% followability floor then
 * refused every plan for a reason the number no longer expressed. Wins and
 * losses are what the rate is *for*: whether the real losses come too often
 * to sit through. Scratches stay in expectancy (they cost the spread) and are
 * reported in their own bucket, never hidden.
 */
export const SCRATCH_R = 0.1;

/** Classify a net R the way every counter in this system now counts. */
export function classifyR(r: number): "win" | "loss" | "scratch" {
  if (r > SCRATCH_R) return "win";
  if (r < -SCRATCH_R) return "loss";
  return "scratch";
}

export interface ManagedExit {
  exitIndex: number;
  exitPrice: number;
  /**
   * Blended R over the initial risk, net of the round-trip cost: when the
   * trade scaled out, half the position's R comes from the banked target and
   * half from wherever the remainder exited.
   */
  r: number;
  kind: "stop" | "target" | "flip" | "horizon";
  /** Set when half was banked at the target before the final exit. */
  scaleOut?: { index: number; price: number };
}

export interface WalkInput {
  ctx: LabContext;
  direction: "long" | "short";
  /** First bar the open trade lives through — the bar after the entry bar. */
  firstBar: number;
  entry: number;
  /** The initial stop, already buffered. Never widened, only trailed. */
  stop: number;
  target: number | null;
  /** ATR at entry — the risk unit the trailing buffer is measured in. */
  entryAtr: number;
  horizon: number;
  /** Round-trip cost as a fraction of the entry price. */
  costFraction: number;
}

/**
 * Walks an open trade forward under the management rules above.
 *
 * Order inside each bar is pessimistic and fixed: the standing stop first,
 * then the target, then the structure flip — a bar that ran through stop and
 * target reports the stop, because daily bars cannot order intrabar events.
 * Stop *updates* (breakeven, trailing) apply after the bar's exits are
 * checked, so a stop can never be moved by the same bar that would have hit
 * the new level.
 *
 * Returns null only when the data ends before the horizon — a trade that is
 * still legitimately open.
 */
export function walkManaged(input: WalkInput): ManagedExit | null {
  const { ctx, direction, firstBar, entry, entryAtr, horizon, costFraction } = input;
  const long = direction === "long";
  const risk0 = long ? entry - input.stop : input.stop - entry;
  if (!(risk0 > 0)) return null;
  const costAmount = entry * costFraction;
  const netR = (exit: number) =>
    Math.round((((long ? exit - entry : entry - exit) - costAmount) / risk0) * 1000) / 1000;

  const lastBar = Math.min(firstBar + horizon - 1, ctx.candles.length - 1);
  let stop = input.stop;
  // 分批止盈 — the first target banks half, the remainder rides.
  //
  // Full exit at the first overhead pressure was the amateur shape: it caps
  // every winner at the nearest shelf while losers still cost a full R. The
  // professional shape sells SCALE_OUT_FRACTION into the pressure, moves the
  // stop to at least breakeven (the banked half has paid for the trade), and
  // lets the rest run under the trailing/flip rules — smaller losers when the
  // move fails after touching the target, and the occasional runner the old
  // shape never kept. Blended R makes the accounting exact, and because this
  // is the one exit engine, the lab, the forward ledger and the plan
  // selection all measure the same behaviour the monitor executes.
  let target = input.target;
  let scaleOut: { index: number; price: number } | null = null;
  const finish = (exitIndex: number, exitPrice: number, kind: ManagedExit["kind"]): ManagedExit =>
    scaleOut
      ? {
          exitIndex,
          exitPrice,
          r:
            Math.round(
              (SCALE_OUT_FRACTION * netR(scaleOut.price) +
                (1 - SCALE_OUT_FRACTION) * netR(exitPrice)) *
                1000,
            ) / 1000,
          kind,
          scaleOut,
        }
      : { exitIndex, exitPrice, r: netR(exitPrice), kind };

  for (let j = firstBar; j <= lastBar; j++) {
    const hitStop = long ? ctx.low[j] <= stop : ctx.high[j] >= stop;
    if (hitStop) return finish(j, stop, "stop");
    if (target !== null) {
      const hitTarget = long ? ctx.high[j] >= target : ctx.low[j] <= target;
      if (hitTarget) {
        // A target worth less than SCALE_OUT_MIN_R exits in full — see the
        // constant above. Only a target that pays at least the risk earns
        // the split: bank half, stop to at least breakeven, no second fixed
        // target — structure decides the rest.
        const tpR = (long ? target - entry : entry - target) / risk0;
        if (tpR < SCALE_OUT_MIN_R) return finish(j, target, "target");
        scaleOut = { index: j, price: target };
        target = null;
        stop = long ? Math.max(stop, entry) : Math.min(stop, entry);
      }
    }
    // 看法改變：反向 CHoCH 確認在這根 —— 結構翻轉，以收盤離場。
    if (long ? ctx.chochDown[j] : ctx.chochUp[j]) {
      return finish(j, ctx.close[j], "flip");
    }

    // ── management, from this bar's information ──
    const oneR = long ? entry + risk0 : entry - risk0;
    if (long ? ctx.high[j] >= oneR && stop < entry : ctx.low[j] <= oneR && stop > entry) {
      stop = entry;
    }
    const swing = long ? ctx.anchorLow[j] : ctx.anchorHigh[j];
    if (Number.isFinite(swing)) {
      const candidate = long
        ? swing - entryAtr * STOP_BUFFER_ATR
        : swing + entryAtr * STOP_BUFFER_ATR;
      // Only toward safety, and never through the current close — a trailing
      // stop above price would manufacture an exit out of thin air.
      const improves = long
        ? candidate > stop && candidate < ctx.close[j]
        : candidate < stop && candidate > ctx.close[j];
      if (improves) stop = candidate;
    }
  }

  // Out of time with data still flowing: closed at the market, a real result.
  if (lastBar - firstBar + 1 >= horizon) {
    return finish(lastBar, ctx.close[lastBar], "horizon");
  }
  return null;
}
