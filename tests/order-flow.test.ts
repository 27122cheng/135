import { check, report } from "./_harness";
import { analyzeOrderFlow, CVD_RECENT } from "@/lib/analysis/order-flow";
import type { Candle } from "@/lib/data-sources/ohlcv";
import type { EntryStructure } from "@/types/signal";

/** 訂單流 — bar-approximated delta, CVD and the four desk reads. */

function bar(i: number, open: number, close: number, vol: number | null = 1000, range = 4): Candle {
  const hi = Math.max(open, close) + range / 4;
  const lo = Math.min(open, close) - range / 4;
  return { time: `2026-10-${String(1 + Math.floor(i / 6)).padStart(2, "0")}T${String((i % 6) * 4).padStart(2, "0")}:00:00.000Z`, open, high: hi, low: lo, close, volume: vol };
}

// A steady up-trend: with-trend bars on 1500, counter bars on 600 → healthy pullback; CVD up.
function uptrend(vol = true): Candle[] {
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < 30; i++) {
    const up = i % 3 !== 2;
    const next = up ? p + 2 : p - 1;
    out.push(bar(i, p, next, vol ? (up ? 1500 : 600) : null));
    p = next;
  }
  return out;
}

{
  const gaps: string[] = [];
  const r = analyzeOrderFlow({ H4: uptrend() }, [], 3, gaps);
  check("a summary exists on volume bars", r.summary?.source === "volume" && r.summary.timeframe === "H4", r.summary);
  check("CVD reads net buying in an up-trend", r.summary?.cvdTrend === "up", r.summary?.cvdRecent);
  check("the CVD item votes long at weight 1", r.items.some((i) => i.key === "orderflow-cvd" && i.direction === "long" && i.weight === 1), r.items);
  check("light pullback volume is a long vote", r.items.some((i) => i.key === "orderflow-pullback" && i.direction === "long"), r.items.map((i) => i.key));
  check("no divergence in a clean trend", r.summary?.divergence === null);
  check("no gaps", gaps.length === 0, gaps);
}

{
  // FX: no volume → range proxy, every item weight 0, and the summary says so.
  const r = analyzeOrderFlow({ H4: uptrend(false) }, [], 3, []);
  check("no volume falls back to the range proxy", r.summary?.source === "range-proxy");
  check("proxy items never vote", r.items.every((i) => i.weight === 0), r.items.map((i) => [i.key, i.weight]));
  check("and the summary says so", r.summary?.lines.some((l) => l.includes("不投票")) === true, r.summary?.lines);
}

{
  // Bearish divergence: the newest bars print a higher high, but on heavy selling closes.
  const bars = uptrend();
  for (let i = bars.length - CVD_RECENT; i < bars.length; i++) {
    const b = bars[i];
    bars[i] = { ...b, high: b.high + 6, close: b.low + 0.2, open: b.high + 5, volume: 3000 };
  }
  const r = analyzeOrderFlow({ H4: bars }, [], 3, []);
  check("a higher high on net selling is a bearish divergence", r.summary?.divergence === "bearish", r.summary);
  check("which votes short", r.items.some((i) => i.key === "orderflow-divergence" && i.direction === "short"));
}

{
  // Absorption: a heavy, narrow bar whose low sits on a known support.
  const bars = uptrend();
  const last = bars[bars.length - 1];
  bars[bars.length - 1] = { ...last, open: last.close, high: last.close + 0.5, low: 150, close: last.close + 0.3, volume: 4000 };
  const support: EntryStructure = { price: 150, type: "需求區", role: "support", timeframe: "H4", strength: 2, distance_pct: 0.2 };
  const r = analyzeOrderFlow({ H4: bars }, [support], 3, []);
  check("a heavy narrow bar on support is absorption", r.summary?.absorption?.price === 150, r.summary?.absorption);
  check("absorption on support votes long", r.items.some((i) => i.key === "orderflow-absorption" && i.direction === "long"));
}

{
  // Climax: 2× volume, wide range, closing at the high → reported, weight 0.
  const bars = uptrend();
  const last = bars[bars.length - 1];
  bars[bars.length - 1] = { ...last, open: last.open, high: last.open + 12, low: last.open - 1, close: last.open + 11.5, volume: 5000 };
  const r = analyzeOrderFlow({ H4: bars }, [], 3, []);
  check("a buying climax is reported", r.summary?.climax?.kind === "buying", r.summary?.climax);
  check("and never votes", r.items.find((i) => i.key === "orderflow-climax")?.weight === 0);
}

{
  const gaps: string[] = [];
  const r = analyzeOrderFlow({ H4: uptrend().slice(0, 5), D1: undefined }, [], 3, gaps);
  check("too few bars: no summary, a gap", r.summary === null && gaps.length === 1, gaps);
}

report("order-flow");
