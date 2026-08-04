/**
 * Most data_gaps entries are "this API key isn't configured", which no amount
 * of code can fix — only the operator setting the env var can. Splitting them
 * out turns a wall of warnings into a short to-do list.
 */

const KEY_PATTERN = /缺少 ([A-Z0-9_]+)/;

/**
 * Where each key comes from. All except Anthropic are optional upgrades —
 * every other dimension has a keyless public source, so they should no longer
 * appear as gaps at all.
 */
export const KEY_SOURCES: Record<string, string> = {
  ANTHROPIC_API_KEY: "console.anthropic.com（付費；AI 判斷唯一無免費替代的部分）",
  TWELVE_DATA_API_KEY: "twelvedata.com（選用，已有 yfinance／Stooq 免金鑰來源）",
  FRED_API_KEY: "fred.stlouisfed.org（選用，已改用 FRED 免金鑰 CSV 端點）",
  FINNHUB_API_KEY: "finnhub.io（選用，新聞已由 GDELT 免金鑰供應）",
  EIA_API_KEY: "eia.gov/opendata（選用，庫存已由 FRED WCESTUS1 供應）",
};

export interface GroupedGaps {
  /** Unique env var names that would close one or more gaps. */
  missingKeys: string[];
  /** Gap messages caused by a missing key. */
  keyRelated: string[];
  /** Everything else — real limitations or upstream failures. */
  other: string[];
}

export function groupDataGaps(gaps: string[]): GroupedGaps {
  const missingKeys = new Set<string>();
  const keyRelated: string[] = [];
  const other: string[] = [];

  for (const gap of gaps) {
    const match = gap.match(KEY_PATTERN);
    if (match && match[1].endsWith("_KEY")) {
      missingKeys.add(match[1]);
      keyRelated.push(gap);
    } else {
      other.push(gap);
    }
  }

  return { missingKeys: [...missingKeys], keyRelated, other };
}
