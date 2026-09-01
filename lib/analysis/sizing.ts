import { streakFactor } from "./exposure";
import type { SupportedSymbol } from "@/types/signal";

/**
 * 部位大小 — the last step between a plan and an order.
 *
 * Every plan on this site states an entry, a stop and a target, and none of
 * them ever answered the only question left at the broker screen: how much.
 * That answer is arithmetic, not judgement — risk amount ÷ stop distance —
 * and leaving arithmetic to be done in a hurry at 2am is how a 1% idea gets
 * executed as a 4% position.
 *
 * ## Where the account size lives, and why
 *
 * In the browser's localStorage, never on the server. The AI-provider policy
 * in lib/ai/provider.ts already draws this line: prompts carry only public
 * market data, "do not add account balances or position sizes". The same rule
 * applies to our own database — a free-tier Postgres with a public read
 * policy on most tables is no place for someone's account size. Sizing is a
 * display-time calculation; the inputs stay on the device.
 *
 * ## Units, honestly
 *
 * The output is stated in the instrument's own unit (currency units, ounces,
 * index units) via `unitsPerPoint = 1`: one unit gains or loses one quote
 * currency per point of price movement, which is exactly how USD-quoted CFDs
 * settle. Two stated approximations rather than silent ones:
 *  - USDJPY's P&L accrues in JPY; the USD figure divides by the current rate,
 *    and the note says so.
 *  - Contract/lot conversion uses the conventional sizes (FX lot 100k, gold
 *    100oz) — a broker's CFD lot may differ, and the raw unit count is always
 *    shown so the reader can convert to their own broker's contract.
 */

export interface SizingInput {
  accountSize: number;
  /** Percent of the account risked if the stop is hit, e.g. 1 = 1%. */
  riskPct: number;
  direction: "long" | "short";
  entry: number;
  stopLoss: number;
  symbol: string;
  /**
   * Held symbols that are the same bet as this one — from
   * lib/analysis/exposure.ts, which reads the sign of the correlation, both
   * directions and the USD side. The n-th copy of one view risks 1/(n+1).
   */
  correlatedHeld?: string[];
  /** Why each of them counts, for the note. Same order as correlatedHeld. */
  correlatedReasons?: string[];
  /**
   * 連敗減碼 — consecutive real losses immediately before this trade. Two
   * cuts the risk to three-quarters, three or more to half; a win resets.
   */
  lossStreak?: number;
}

export interface SizingResult {
  /** Money at risk if the stop is hit, in account currency. */
  riskAmount: number;
  /** Instrument units: P&L = units × price move (quote currency). */
  units: number;
  /** Conventional lot/contract equivalent, when one exists. */
  lots: number | null;
  lotLabel: string | null;
  /** Notional exposure at entry, and as a multiple of the account. */
  notional: number;
  leverage: number;
  /** 1 / (1 + number of held positions that are the same bet). */
  correlationFactor: number;
  /** 1, 0.75 or 0.5 by the current loss streak — see streakFactor. */
  streakFactor: number;
  /** Facts the number alone would hide. */
  notes: string[];
}

/** Conventional contract sizes, for the lot conversion only. */
const LOT_SIZE: Partial<Record<SupportedSymbol, { size: number; label: string }>> = {
  EURUSD: { size: 100_000, label: "標準手（10 萬基準貨幣）" },
  GBPUSD: { size: 100_000, label: "標準手（10 萬基準貨幣）" },
  USDJPY: { size: 100_000, label: "標準手（10 萬基準貨幣）" },
  XAUUSD: { size: 100, label: "標準手（100 盎司）" },
};

/**
 * Null when the inputs cannot produce an honest number — a zero stop distance
 * divides by zero, and a stop on the wrong side of the entry means the plan
 * and the direction disagree, which is a data problem to surface, not to
 * paper over with Math.abs.
 */
export function positionSize(input: SizingInput): SizingResult | null {
  const { accountSize, riskPct, direction, entry, stopLoss } = input;
  if (!(accountSize > 0) || !(riskPct > 0) || !(entry > 0)) return null;
  const stopDistance = direction === "long" ? entry - stopLoss : stopLoss - entry;
  if (!(stopDistance > 0)) return null;

  const n = input.correlatedHeld?.length ?? 0;
  const correlationFactor = 1 / (1 + n);
  const streak = streakFactor(input.lossStreak ?? 0);
  const riskAmount = ((accountSize * riskPct) / 100) * correlationFactor * streak;
  const units = riskAmount / stopDistance;
  const notional = units * entry;
  const leverage = notional / accountSize;

  const notes: string[] = [];
  if (correlationFactor < 1) {
    const why = input.correlatedReasons?.length ? `（${input.correlatedReasons.join("；")}）` : "";
    notes.push(
      `已持有 ${n} 個與本單同一觀點的部位（${input.correlatedHeld!.join("、")}）${why}，` +
        `本單風險降為 1/${n + 1} —— ${n + 1} 個同觀點部位各擔 1/${n + 1}，合計才等於對這個觀點下 ${riskPct}%。`,
    );
  }
  if (streak < 1) {
    notes.push(
      `連敗減碼：最近連續 ${input.lossStreak} 筆停損，本單風險先降到 ${Math.round(streak * 100)}% —— ` +
        `系統與行情明顯不同步時不用全額去驗證，賺一筆就恢復。`,
    );
  }
  if (input.symbol === "USDJPY") {
    notes.push("USDJPY 的損益以日圓計，此處以現價換算為美元，為近似值。");
  }
  if (leverage > 20) {
    notes.push(
      `名目曝險是帳戶的 ${leverage.toFixed(1)} 倍。停損很近時算式會給出很大的部位 —— ` +
        `若券商保證金或滑價風險不允許，以可承受的槓桿為準縮小部位，風險金額會等比例下降。`,
    );
  }

  const lot = LOT_SIZE[input.symbol as SupportedSymbol];
  // USDJPY: units are USD (base currency); risk arithmetic above treated the
  // stop distance as quote-currency (JPY) per unit, so convert to USD terms.
  const adjustedUnits = input.symbol === "USDJPY" ? units * entry : units;

  return {
    riskAmount: Math.round(riskAmount * 100) / 100,
    units: Math.round(adjustedUnits * 100) / 100,
    lots: lot ? Math.round((adjustedUnits / lot.size) * 100) / 100 : null,
    lotLabel: lot?.label ?? null,
    notional: Math.round(notional),
    leverage: Math.round(leverage * 10) / 10,
    correlationFactor,
    streakFactor: streak,
    notes,
  };
}
