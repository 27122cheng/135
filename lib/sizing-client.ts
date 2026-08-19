/**
 * The sizing inputs, stored on the device and nowhere else.
 *
 * Deliberately localStorage rather than app_settings: the account size is the
 * one number on this site that is about the user rather than about a market.
 * The AI-provider policy already forbids it from prompts; the same reasoning
 * keeps it out of a free-tier database whose tables are mostly public-read.
 * The cost is accepted and stated in the UI: the value does not follow you
 * across devices.
 */

const STORAGE_KEY = "sizing-config-v1";

export interface SizingConfig {
  accountSize: number | null;
  /** Percent per trade. Defaults to 1 — the number every risk text starts at. */
  riskPct: number;
}

export const DEFAULT_SIZING: SizingConfig = { accountSize: null, riskPct: 1 };

export function loadSizingConfig(): SizingConfig {
  if (typeof window === "undefined") return DEFAULT_SIZING;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SIZING;
    const parsed = JSON.parse(raw) as Partial<SizingConfig>;
    const accountSize =
      typeof parsed.accountSize === "number" && parsed.accountSize > 0
        ? parsed.accountSize
        : null;
    const riskPct =
      typeof parsed.riskPct === "number" && parsed.riskPct > 0 && parsed.riskPct <= 10
        ? parsed.riskPct
        : DEFAULT_SIZING.riskPct;
    return { accountSize, riskPct };
  } catch {
    return DEFAULT_SIZING;
  }
}

export function saveSizingConfig(config: SizingConfig): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}
