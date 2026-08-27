import { COMMODITIES, type CommodityMeta } from "@/types/signal";
import { defaultFundamentals, type FundamentalsConfig } from "@/config/fundamentals";
import {
  MAX_CUSTOM_SYMBOLS,
  parseCustomSymbols,
  toCommodityMeta,
  validateCustomSymbol,
  type CustomSymbol,
} from "./custom-symbols";
import { getSignalStore } from "./db";
import { clearSettingsCache, getSetting } from "./settings";

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

/**
 * Resolves one symbol against the full roster. Every route that used to do
 * `COMMODITIES.find(...)` goes through here instead — that lookup is exactly
 * how BTCUSD could be scanned, monitored, and boarded, and still get a 404
 * from the lab: five routes each kept their own idea of what a symbol is.
 */
export async function findInstrument(symbol: string): Promise<CommodityMeta | null> {
  const wanted = symbol.toUpperCase();
  return (await allInstruments()).find((c) => c.symbol === wanted) ?? null;
}

/**
 * Registers (or refreshes) one custom symbol in the server-side roster.
 *
 * Called by the custom scan route, so scanning a symbol once is enough to
 * make it first-class — no dependence on the /symbols page being revisited
 * after a deploy. Upsert by symbol id; built-in ids are refused for the same
 * shadowing reason as above; the parser's cap applies, oldest kept.
 */
export async function registerCustomSymbol(candidate: CustomSymbol): Promise<void> {
  const cleaned: CustomSymbol = {
    symbol: candidate.symbol.trim().toUpperCase(),
    label: candidate.label.trim(),
    yahooSymbol: candidate.yahooSymbol.trim(),
    stooqSymbol: candidate.stooqSymbol.trim(),
    cotContractCode: candidate.cotContractCode.trim(),
    gdeltQuery: candidate.gdeltQuery.trim(),
  };
  if (validateCustomSymbol(cleaned) !== null) return;
  if (COMMODITIES.some((c) => c.symbol === cleaned.symbol)) return;

  const store = getSignalStore();
  if (!store) return;
  const current = parseCustomSymbols(await getSetting("CUSTOM_SYMBOLS").catch(() => null));
  const existing = current.find((s) => s.symbol === cleaned.symbol);
  // Idempotent when nothing changed — this runs on every custom scan, and a
  // settings write plus cache clear per page view would be pure churn.
  if (existing && JSON.stringify(existing) === JSON.stringify(cleaned)) return;
  const next = [...current.filter((s) => s.symbol !== cleaned.symbol), cleaned].slice(
    0,
    MAX_CUSTOM_SYMBOLS,
  );
  await store.saveSetting("CUSTOM_SYMBOLS", JSON.stringify(next));
  clearSettingsCache();
}
