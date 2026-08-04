/**
 * Most data_gaps entries are "this API key isn't configured", which no amount
 * of code can fix — only the operator setting the env var can. Splitting them
 * out turns a wall of warnings into a short to-do list.
 */

const KEY_PATTERN = /(?:缺少|未設定) ([A-Z0-9_]+)/;

/**
 * Where each key comes from. Every one is free; the whole stack runs without
 * any of them, just with weaker AI judgement — so these are upgrades, not
 * requirements.
 */
export const KEY_SOURCES: Record<string, string> = {
  GEMINI_API_KEY: "aistudio.google.com/apikey（免費 1500 次/日，AI 主力）",
  GROQ_API_KEY: "console.groq.com/keys（免費 30 次/分，AI 備援）",
  OPENROUTER_API_KEY: "openrouter.ai/keys（免費 :free 模型，AI 第二備援）",
  ANTHROPIC_API_KEY: "console.anthropic.com（付費，選用；免費供應商可用時不會走到）",
  FRED_API_KEY: "fred.stlouisfed.org（選用，已改用 FRED 免金鑰 CSV 端點）",
  FINNHUB_API_KEY: "finnhub.io（選用，新聞已由 GDELT 免金鑰供應）",
  EIA_API_KEY: "eia.gov/opendata（選用，庫存已由 FRED WCESTUS1 供應）",
};

/**
 * Some gaps are facts about the instrument or the free-data landscape that no
 * amount of retrying or configuring will change — DAX has no CFTC filing,
 * central-bank gold buying isn't published as a free API. Listing those beside
 * "this fetch failed" inflates the warning count with things nobody can act
 * on, and trains the reader to ignore the whole panel.
 *
 * Matched on phrasing rather than a flag because these messages are written at
 * a dozen call sites; one whose wording drifts just falls back to the louder
 * category, which is the safe direction to fail.
 */
const PERMANENT_PATTERNS = [
  /不在免費 API 清單內/,
  /無對應的 CFTC COT 合約代碼/,
  /沒有免金鑰來源/,
  // e.g. 兩國利差 — FRED's approved series are US-only, so there is no free
  // source for foreign sovereign yields. Retrying will never fix it.
  /本階段(暫)?不納入/,
  /核准清單僅含/,
];

function isPermanent(gap: string): boolean {
  return PERMANENT_PATTERNS.some((p) => p.test(gap));
}

export interface GroupedGaps {
  /** Unique env var names that would close one or more gaps. */
  missingKeys: string[];
  /** Gap messages caused by a missing key. */
  keyRelated: string[];
  /** This run failed to get something it could normally get — actionable. */
  other: string[];
  /** Known limitations of the data landscape — informational, not actionable. */
  permanent: string[];
}

export function groupDataGaps(gaps: string[]): GroupedGaps {
  const missingKeys = new Set<string>();
  const keyRelated: string[] = [];
  const other: string[] = [];
  const permanent: string[] = [];

  for (const gap of gaps) {
    const match = gap.match(KEY_PATTERN);
    if (match && match[1].endsWith("_KEY")) {
      missingKeys.add(match[1]);
      keyRelated.push(gap);
    } else if (isPermanent(gap)) {
      permanent.push(gap);
    } else {
      other.push(gap);
    }
  }

  return { missingKeys: [...missingKeys], keyRelated, other, permanent };
}
