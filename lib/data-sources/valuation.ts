import { fetchFree } from "./free-source";
import { fetchJson, fetchText } from "./http";

/**
 * 估值 — the S&P 500 P/E, from three keyless sources in order.
 *
 * Index CFDs had macro (rates, dollar, VIX) and positioning, but nothing that
 * said whether the market was expensive. Earnings and multiples move slowly,
 * which is exactly why they belong on the card: they set the tide the
 * day-plan swims in, and a short at a 10th-percentile multiple is fighting
 * something the chart cannot show.
 *
 * Three free, keyless sources, tried in order; the first that parses wins:
 *   1. multpl.com — the current trailing P/E, plus its monthly table for the
 *      percentile.
 *   2. Nasdaq Data Link's MULTPL dataset — the same series as JSON, a few
 *      anonymous calls a day.
 *   3. Finviz's SPY snapshot — the ETF's P/E, a close proxy for the index.
 *
 * The S&P multiple stands in for the whole US market (NAS100, US30) and, at
 * weight 0, for GER40: the US cycle leads the DAX, but it is not its P/E, and
 * the item says which it is.
 */

export interface Valuation {
  /** Trailing twelve-month P/E of the S&P 500 (or SPY). */
  pe: number;
  /** 1 / pe, in percent. */
  earningsYieldPct: number;
  /** Monthly P/E history, oldest first, when the source had it. */
  history: Array<{ date: string; pe: number }>;
  source: "multpl" | "nasdaq-data-link" | "finviz";
  asOf: string;
}

const UA = { headers: { "User-Agent": "Mozilla/5.0" } };
const TTL = 12 * 60 * 60 * 1000;

export function parseMultplCurrent(html: string): number | null {
  const m = html.match(/PE Ratio[^0-9]{0,80}?([0-9]{1,3}\.[0-9]{1,2})/i);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v > 1 && v < 200 ? v : null;
}

export function parseMultplTable(html: string): Array<{ date: string; pe: number }> {
  const out: Array<{ date: string; pe: number }> = [];
  const row = /<td class="left">\s*([A-Z][a-z]{2} \d{1,2}, \d{4})\s*<\/td>\s*<td class="right">\s*([0-9.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = row.exec(html)) !== null) {
    const d = new Date(m[1]);
    const pe = Number(m[2]);
    if (!Number.isNaN(d.getTime()) && Number.isFinite(pe)) out.push({ date: d.toISOString().slice(0, 10), pe });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function parseFinvizPe(html: string): number | null {
  const m = html.match(/>P\/E<\/td>\s*<td[^>]*>(?:<b>)?\s*([0-9]{1,3}\.[0-9]{1,2})/);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v > 1 && v < 200 ? v : null;
}

async function fromMultpl(): Promise<Valuation | null> {
  const html = await fetchText("https://www.multpl.com/s-p-500-pe-ratio", UA, 8000);
  const pe = html ? parseMultplCurrent(html) : null;
  if (pe === null) return null;
  const table = await fetchText("https://www.multpl.com/s-p-500-pe-ratio/table/by-month", UA, 8000);
  const history = table ? parseMultplTable(table) : [];
  return { pe, earningsYieldPct: Math.round((100 / pe) * 100) / 100, history, source: "multpl", asOf: new Date().toISOString() };
}

async function fromNasdaqDataLink(): Promise<Valuation | null> {
  const data = await fetchJson<{ dataset?: { data?: Array<[string, number]> } }>(
    "https://data.nasdaq.com/api/v3/datasets/MULTPL/SP500_PE_RATIO_MONTH.json?rows=240",
    undefined,
    8000,
  );
  const rows = data?.dataset?.data;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const history = rows
    .filter((r) => Array.isArray(r) && typeof r[0] === "string" && Number.isFinite(r[1]))
    .map((r) => ({ date: r[0], pe: r[1] }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = history[history.length - 1];
  if (!latest) return null;
  return { pe: latest.pe, earningsYieldPct: Math.round((100 / latest.pe) * 100) / 100, history, source: "nasdaq-data-link", asOf: latest.date };
}

async function fromFinviz(): Promise<Valuation | null> {
  const html = await fetchText("https://finviz.com/quote.ashx?t=SPY", UA, 8000);
  const pe = html ? parseFinvizPe(html) : null;
  if (pe === null) return null;
  return { pe, earningsYieldPct: Math.round((100 / pe) * 100) / 100, history: [], source: "finviz", asOf: new Date().toISOString() };
}

/** The ladder, in order. Exported so the sources page can show it. */
export const VALUATION_LADDER = [
  { source: "multpl", label: "multpl.com S&P 500 P/E（免金鑰）", probe: "https://www.multpl.com/s-p-500-pe-ratio" },
  { source: "nasdaq-data-link", label: "Nasdaq Data Link MULTPL（免金鑰，每日少量）", probe: "https://data.nasdaq.com/api/v3/datasets/MULTPL/SP500_PE_RATIO_MONTH.json?rows=1" },
  { source: "finviz", label: "Finviz SPY 本益比（免金鑰）", probe: "https://finviz.com/quote.ashx?t=SPY" },
] as const;

export async function fetchSp500Valuation(gaps: string[]): Promise<Valuation | null> {
  const result = await fetchFree<Valuation>({
    source: "valuation",
    label: "S&P 500 估值（multpl → Nasdaq Data Link → Finviz）",
    key: "valuation:sp500",
    ttlMs: TTL,
    limit: { perDay: 40 },
    gaps,
    fn: async () => {
      for (const attempt of [fromMultpl, fromNasdaqDataLink, fromFinviz]) {
        try {
          const v = await attempt();
          if (v) return v;
        } catch {
          // next rung
        }
      }
      return null;
    },
  });
  return result?.value ?? null;
}
