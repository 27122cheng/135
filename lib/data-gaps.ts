/**
 * Most data_gaps entries are "this API key isn't configured", which no amount
 * of code can fix — only the operator setting the env var can. Splitting them
 * out turns a wall of warnings into a short to-do list.
 */

const KEY_PATTERN = /缺少 ([A-Z0-9_]+)/;

/** Where each key comes from, for the UI hint. */
export const KEY_SOURCES: Record<string, string> = {
  TWELVE_DATA_API_KEY: "twelvedata.com（免費 800 次/日）",
  FRED_API_KEY: "fred.stlouisfed.org（免費，立即發卡）",
  FINNHUB_API_KEY: "finnhub.io（免費方案）",
  EIA_API_KEY: "eia.gov/opendata（免費）",
  ANTHROPIC_API_KEY: "console.anthropic.com（付費）",
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
