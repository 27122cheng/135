import { check, report } from "./_harness";
import { analyzeIntraday, H1_MIN_BARS, M15_MIN_BARS } from "@/lib/intraday/engine";
import { intradayStats, openIntradayTrade, PROVE_MIN, resolveIntradayTrades } from "@/lib/intraday/ledger";
import type { Candle } from "@/lib/data-sources/ohlcv";

/** 日內模式 — H1 background, M15 pullback, confirm fill, paper ledger. */

function bars(n: number, start: number, step: (i: number) => number, range: number, from = Date.UTC(2026, 10, 1), spacingMs = 15 * 60_000): Candle[] {
  const out: Candle[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const next = p + step(i);
    const wick = range * (1 + (i % 3) * 0.15);
    out.push({ time: new Date(from + i * spacingMs).toISOString(), open: p, high: Math.max(p, next) + wick, low: Math.min(p, next) - wick, close: next, volume: 100 });
    p = next;
  }
  return out;
}

// H1 up-trend with a wave so swings exist: three steps up, one step down.
const h1Up = bars(122, 100, (i) => (i % 6 >= 4 ? -1.5 : 1), 0.4, Date.UTC(2026, 10, 1), 60 * 60_000);
// M15: a wave that pulls back to a swing low and closes back above it on the last bar.
function m15Pullback(): Candle[] {
  const m = bars(200, 150, (i) => (i % 8 < 5 ? 0.3 : -0.4), 0.15);
  const lastClose = m[m.length - 1].close;
  // Find the nearest swing low below the close and make the last bar touch it and close above.
  const lows = m.slice(-80, -3).map((c) => c.low);
  const zone = Math.max(...lows.filter((l) => l < lastClose - 0.2));
  const last = m[m.length - 1];
  m[m.length - 1] = { ...last, low: zone - 0.05, close: zone + 0.6, high: zone + 0.8, open: zone + 0.3 };
  return m;
}

{
  const short = analyzeIntraday({ symbol: "BTCUSD", pair: "BTCUSDT", h1: h1Up.slice(0, 10), m15: m15Pullback() });
  check("too few bars is said", short.stance === "no-trade" && short.verdict.includes("K 棒不足"), short.verdict);
  check("minimums are what the message quotes", short.verdict.includes(String(H1_MIN_BARS)) && short.verdict.includes(String(M15_MIN_BARS)));
}

{
  const s = analyzeIntraday({ symbol: "BTCUSD", pair: "BTCUSDT", h1: h1Up, m15: m15Pullback() });
  check("an H1 up-trend reads long", s.direction === "long", s.background);
  check("a touched-and-reclaimed zone is an entry", s.stance === "enter" || s.stance === "wait", s.verdict);
  if (s.stance === "enter") {
    check("entry is the confirming close, not the zone", s.entry !== null && s.zone !== null && s.entry > s.zone, [s.entry, s.zone]);
    check("stop sits below the zone", s.stop !== null && s.zone !== null && s.stop < s.zone, [s.stop, s.zone]);
    check("target is at least 1.5R away", s.riskReward !== null && s.riskReward >= 1.5, s.riskReward);
    check("every leg has a reason", s.reasons.entry.length > 0 && s.reasons.stop.length > 0 && s.reasons.target.length > 0, s.reasons);
  } else {
    check("a wait names what it waits for", s.verdict.length > 0, s.verdict);
  }
}

{
  // Flat H1: alternating bars, no structure → no-trade.
  const h1Flat = bars(120, 100, (i) => (i % 2 ? -1 : 1), 0.4, Date.UTC(2026, 10, 1), 60 * 60_000);
  const s = analyzeIntraday({ symbol: "ETHUSD", pair: "ETHUSDT", h1: h1Flat, m15: m15Pullback() });
  check("a flat H1 stands aside", s.stance === "no-trade" && s.direction === null, s.verdict);
}

{
  // Ledger: one open per symbol, idempotent per bar, resolves on later bars.
  const m15 = m15Pullback();
  const sig = analyzeIntraday({ symbol: "BTCUSD", pair: "BTCUSDT", h1: h1Up, m15 });
  const forced = { ...sig, stance: "enter" as const, direction: "long" as const, entry: 160, stop: 158, target: 164, atr15: 0.8, barTime: m15[m15.length - 1].time };
  const t = openIntradayTrade(forced, [], new Date("2026-11-03T00:00:00Z"));
  check("a trade opens from an entering signal", t !== null && t.conditionId === "intraday:m15-pullback" && t.status === "open", t);
  check("the same bar never opens twice", openIntradayTrade(forced, [t!]) === null);
  check("a second symbol-open is refused while one runs", openIntradayTrade({ ...forced, barTime: "2026-12-01T00:00:00.000Z" }, [t!]) === null);
  check("a wait signal opens nothing", openIntradayTrade({ ...forced, stance: "wait" }, []) === null);

  // Future bars run straight up through the target.
  const future = bars(25, 160, () => 0.3, 0.1, Date.parse(forced.barTime) + 15 * 60_000);
  const done = resolveIntradayTrades([t!], [...m15, ...future]);
  check("the trade resolves on later bars", done.length === 1 && done[0].status !== "open", done[0]?.status);
  check("a run to the target is a win", done[0]?.status === "win", done[0]);
  const stats = intradayStats([...done]);
  check("stats count it", stats.resolved === 1 && stats.wins === 1);
  check("one trade is not proof", !stats.proven && stats.note.includes(`1/${PROVE_MIN}`), stats.note);
  check("no bars after the entry means still open", resolveIntradayTrades([t!], m15).length === 0);
}

report("intraday");
