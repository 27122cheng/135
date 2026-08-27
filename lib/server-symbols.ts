import { COMMODITIES, type CommodityMeta } from "@/types/signal";
import { defaultFundamentals, type FundamentalsConfig } from "@/config/fundamentals";
import { parseCustomSymbols, toCommodityMeta } from "./custom-symbols";
import { getSetting } from "./settings";

/**
 * 自訂標的的伺服器端名冊 — what makes a user-added symbol a first-class one.
 *
 * The definitions live in `app_settings` under CUSTOM_SYMBOLS, synced there
 * by the /symbols page the same way the alert settings are. Everything that
 * runs on a schedule — the hourly sweep, the 5-minute monitor, the weekly
 * digest — and everything that reads "all instruments" — the board — asks
 * this module instead of hardcoding COMMODITIES.
 *
 * A custom symbol whose id collides with a built-in is dropped here rather
 * than allowed to shadow it: the built-ins carry hand-verified tickers, CFTC
 * codes and cost categories, and a lookalike quietly replacing one would be
 * a data-integrity bug wearing a feature's clothes.
 */
export interface ServerCustomSymbol {
  meta: CommodityMeta;
  config: FundamentalsConfig;
}

export async function loadServerCustomSymbols(): Promise<ServerCustomSymbol[]> {
  let raw: string | null = null;
  try {
    raw = await getSetting("CUSTOM_SYMBOLS");
  } catch {
    return [];
  }
  const builtIn = new Set(COMMODITIES.map((c) => c.symbol));
  return parseCustomSymbols(raw)
    .filter((s) => !builtIn.has(s.symbol.toUpperCase()))
    .map((s) => ({
      meta: toCommodityMeta(s),
      config: defaultFundamentals(s.symbol, {
        cotContractCode: s.cotContractCode || null,
        gdeltQuery: s.gdeltQuery || s.label,
        newsKeywords: [s.label.toLowerCase()],
      }),
    }));
}

/** Built-ins plus the server-registered customs, for "every instrument" paths. */
export async function allInstruments(): Promise<CommodityMeta[]> {
  const customs = await loadServerCustomSymbols();
  return [...COMMODITIES, ...customs.map((c) => c.meta)];
}
