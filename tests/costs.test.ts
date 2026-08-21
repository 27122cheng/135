import { check, report } from "./_harness";
import {
  activeTradingCostOverrides,
  defaultTradingCostFor,
  parseTradingCostOverrides,
  setTradingCostOverrides,
  tradingCostFor,
} from "@/config/trading-costs";
import { isSecretSetting, isSettableKey } from "@/lib/settings";

/**
 * 成本參數覆寫 — the operator's broker figures replacing the built-in guesses.
 *
 * The property to pin hard: an override can adjust the costs but can never
 * *remove* them. A zero or negative round-trip would resurrect the
 * free-spread backtest the cost model exists to prevent, and a unit slip
 * (typing pips into a percent field) must degrade to the defaults, not to a
 * strategy nobody can trade.
 */

// ── parsing and its bounds ────────────────────────────────────────
{
  const ok = parseTradingCostOverrides(
    JSON.stringify({ forex: { roundTripPct: 0.01, perBarPct: 0.001 } }),
  );
  check("a sane override parses", ok.forex?.roundTripPct === 0.01 && ok.forex?.perBarPct === 0.001, ok);

  const zero = parseTradingCostOverrides(JSON.stringify({ forex: { roundTripPct: 0 } }));
  check("a zero round trip is refused — free spread is the lie this file prevents",
    zero.forex === undefined, zero);

  const negative = parseTradingCostOverrides(JSON.stringify({ metal: { roundTripPct: -0.01 } }));
  check("a negative cost is refused", negative.metal === undefined, negative);

  const pips = parseTradingCostOverrides(JSON.stringify({ forex: { roundTripPct: 1.5 } }));
  check("a unit slip (1.5 'percent' = pips typed into the wrong field) is refused",
    pips.forex === undefined, pips);

  const freeSwap = parseTradingCostOverrides(JSON.stringify({ index: { perBarPct: 0 } }));
  check("a zero holding cost is allowed — swap genuinely rounds to nothing on some accounts",
    freeSwap.index?.perBarPct === 0, freeSwap);

  const mixed = parseTradingCostOverrides(
    JSON.stringify({ energy: { roundTripPct: 0.09, perBarPct: 99 } }),
  );
  check("one bad field is dropped without discarding its sibling",
    mixed.energy?.roundTripPct === 0.09 && mixed.energy?.perBarPct === undefined, mixed);

  check("garbage is an empty override, not a crash",
    Object.keys(parseTradingCostOverrides("not json")).length === 0 &&
    Object.keys(parseTradingCostOverrides(JSON.stringify([1, 2]))).length === 0 &&
    Object.keys(parseTradingCostOverrides(null)).length === 0);
}

// ── the merge ─────────────────────────────────────────────────────
{
  const defaults = defaultTradingCostFor("forex");
  setTradingCostOverrides({ forex: { roundTripPct: 0.02 } });
  const merged = tradingCostFor("forex");
  check("an override replaces only the field it names",
    merged.roundTripPct === 0.02 && merged.perBarPct === defaults.perBarPct, merged);
  check("other categories keep their defaults",
    tradingCostFor("metal").roundTripPct === defaultTradingCostFor("metal").roundTripPct);
  check("the active set is inspectable",
    activeTradingCostOverrides().forex?.roundTripPct === 0.02);

  setTradingCostOverrides({});
  check("clearing restores the defaults",
    tradingCostFor("forex").roundTripPct === defaults.roundTripPct);
}

// ── the settings-boundary rules ───────────────────────────────────
{
  check("the override key is settable from the browser", isSettableKey("TRADING_COSTS_OVERRIDE"));
  check("and is configuration, not a secret", !isSecretSetting("TRADING_COSTS_OVERRIDE"));
  // The boundary this key must never loosen.
  check("DATABASE_URL stays unsettable", !isSettableKey("DATABASE_URL"));
  check("CRON_SECRET stays unsettable", !isSettableKey("CRON_SECRET"));
}

report("成本參數");
