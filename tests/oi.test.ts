import { check, report } from "./_harness";
import { analyzeOpenInterest } from "@/lib/analysis/open-interest";
import { COMMODITIES } from "@/types/signal";

const gold = COMMODITIES.find((c) => c.symbol === "XAUUSD")!;

function reports(ois: number[]) {
  return ois.map((oi, i) => ({
    reportDate: `2026-0${Math.floor(i / 28) + 1}-${String((i % 28) + 1).padStart(2, "0")}`,
    noncommercialLong: 100, noncommercialShort: 50, netNonCommercial: 50, openInterest: oi,
  }));
}
function candles(pairs: [string, number][]) {
  return pairs.map(([d, close]) => ({
    time: `${d}T00:00:00.000Z`, open: close, high: close, low: close, close, volume: null,
  }));
}

function quadrant(priceFrom: number, priceTo: number, oiFrom: number, oiTo: number) {
  const gaps: string[] = [];
  const items = analyzeOpenInterest(
    gold,
    reports([oiFrom, oiTo]),
    candles([["2026-01-01", priceFrom], ["2026-01-02", priceTo]]),
    gaps,
  );
  const m = items.find((i) => i.factor.includes("價"));
  return m ? `${m.factor.slice(0, 4)} → ${m.direction}/w${m.weight}` : "none";
}

console.log("price↑ OI↑ :", quadrant(4000, 4200, 500000, 550000));
console.log("price↑ OI↓ :", quadrant(4000, 4200, 500000, 450000));
console.log("price↓ OI↑ :", quadrant(4200, 4000, 500000, 550000));
console.log("price↓ OI↓ :", quadrant(4200, 4000, 500000, 450000));
console.log("tiny moves :", quadrant(4000, 4001, 500000, 500100));

check("up/up must be long w2", quadrant(4000, 4200, 500000, 550000).includes("long/w2"));
check("down/up must be short w2", quadrant(4200, 4000, 500000, 550000).includes("short/w2"));
check("short-covering must caution", quadrant(4000, 4200, 500000, 450000).includes("short/w1"));
check("liquidation must caution", quadrant(4200, 4000, 500000, 450000).includes("long/w1"));
check("tiny moves must be neutral", quadrant(4000, 4001, 500000, 500100).includes("neutral/w0"));

// Surge detection: 20 weeks of realistic noise, then a huge jump.
const noise = [0, 3, -2, 5, -4, 1, 2, -3, 4, -1, 3, -2, 1, 5, -4, 2, -1, 3, -3, 2];
const stable = noise.map((n, i) => 500000 + i * 200 + n * 1500);
const gaps2: string[] = [];
const surge = analyzeOpenInterest(gold, reports([...stable, 700000]), null, gaps2);
console.log("\nsurge items:", surge.map((i) => i.factor.slice(0, 22)));
check("surge not detected", surge.some((i) => i.factor.includes("異常")));
check("52w extreme not detected", surge.some((i) => i.factor.includes("高位")));
check("should note missing candles", gaps2.some((g) => g.includes("D1 K棒")));

report("oi");
