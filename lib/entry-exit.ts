import type { EntryStructure, PathObstacle } from "@/types/signal";

export interface BuiltStopLoss {
  price: number;
  structure: string;
  reason: string;
  invalidation: string;
}

export interface BuiltTakeProfit {
  price: number;
  structure: string;
  reason: string;
  allocation_pct: number;
}

const TP_ALLOCATION_TABLE: Record<number, number[]> = {
  1: [100],
  2: [60, 40],
  3: [40, 35, 25],
};

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * SL is hard-anchored on the same real structure protecting the entry
 * (identical filter to entry_structure_score) — never a fixed R-multiple or
 * flat percentage. ATR, if available, is only added as a small buffer
 * beyond the structure edge, never the sole basis. Returns null when no
 * protecting structure exists — callers must force grade='no-trade'.
 */
export function buildStopLoss(
  direction: "long" | "short",
  entryZone: { low: number; high: number },
  structures: EntryStructure[],
  atr: number | null,
  /**
   * ATR multiple for the buffer beyond the structure. 0.5 is the baseline the
   * Stage 3 spec names; the S3 intervention raises it to 1.0 after repeated
   * "stop was too tight" reviews. Never lowered — see lib/journal/interventions.ts.
   */
  bufferAtrMultiple = 0.5,
): BuiltStopLoss | null {
  const protecting = structures.filter((s) => {
    if (Math.abs(s.distance_pct) > 1.5) return false;
    return direction === "long"
      ? s.role === "support" && s.price <= entryZone.high
      : s.role === "resistance" && s.price >= entryZone.low;
  });
  if (protecting.length === 0) return null;
  const anchor = protecting.reduce((closest, s) =>
    Math.abs(s.distance_pct) < Math.abs(closest.distance_pct) ? s : closest,
  );
  const buffer = atr && atr > 0 ? atr * bufferAtrMultiple : 0;
  const price = direction === "long" ? anchor.price - buffer : anchor.price + buffer;
  const bufferNote = buffer ? `，再扣 ${bufferAtrMultiple}×ATR buffer ${round(buffer)}` : "";
  return {
    price: round(price),
    structure: `${anchor.timeframe} ${anchor.type} @ ${anchor.price}`,
    reason:
      direction === "long"
        ? `貼在 ${anchor.timeframe} ${anchor.type} (${anchor.price}) 之外${bufferNote}`
        : `貼在 ${anchor.timeframe} ${anchor.type} (${anchor.price}) 之外${bufferNote}`,
    invalidation: `觸及此價位代表「${anchor.type} 仍是有效${anchor.role === "support" ? "支撐" : "壓力"}」的假設已被推翻`,
  };
}

/**
 * TPs are hard-anchored on real path_obstacles ahead of the entry in the
 * trade direction, split into up to 3 tranches. Returns [] when no
 * obstacle exists ahead — callers must force grade='no-trade' rather than
 * invent a price target.
 */
export function buildTakeProfits(
  direction: "long" | "short",
  entryZone: { low: number; high: number },
  obstacles: PathObstacle[],
): BuiltTakeProfit[] {
  const ahead = obstacles
    .filter((o) => (direction === "long" ? o.price > entryZone.high : o.price < entryZone.low))
    .sort((a, b) => (direction === "long" ? a.price - b.price : b.price - a.price))
    .slice(0, 3);
  const allocations = TP_ALLOCATION_TABLE[ahead.length] ?? [];
  return ahead.map((o, i) => ({
    price: round(o.price),
    structure: `${o.timeframe} ${o.type} @ ${o.price}`,
    reason: `進場到停利路徑上第 ${i + 1} 個反向障礙（${o.type}，強度 ${o.strength}）`,
    allocation_pct: allocations[i] ?? 0,
  }));
}
