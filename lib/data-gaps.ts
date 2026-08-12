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
  // Kept for any future message that genuinely has no free source.
  /不在免費 API 清單內/,
  // An upstream mirror that has stopped updating is not a failed fetch and not
  // a wrong series code — retrying and reconfiguring are both useless. DBnomics'
  // IMF datasets were verified sitting 370–766 days behind, which disabled all
  // five 央行購金 sources at once; that belongs beside "DAX has no CFTC filing",
  // not in the list of things that went wrong on this particular scan.
  /資料集已停更/,
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

/**
 * Some lines in `data_gaps` are not gaps at all — they are the system
 * explaining a decision it made on purpose. "本次不提供加倉點：評等 B…" is the
 * add-on rule working exactly as designed; "AI 選出的組合風報比過低，已改用預設
 * 規則" is the sanity check doing its job and the deterministic engine taking
 * over. No data is missing in either case.
 *
 * They ride in `data_gaps` because that is the only per-signal free-text
 * channel the schema has, but counting them in "⚠ N 項資料缺口" told the owner
 * data was missing when it wasn't — the screenshot that prompted this had four
 * "gaps" of which two were behaviour notes.
 */
const INFORMATIONAL_PATTERNS = [
  // Covers 加倉點, 波段變體, and whatever the next "declined by rule, with
  // the reason attached" note is — the prefix is the contract.
  /本次不提供/,
  /已改用預設規則/,
  // Legacy rows written before dedupe notes stopped being filed as gaps.
  /已合併為一票/,
  /合併後視為中性/,
  // The market being closed is a fact about the market, not missing data —
  // both the weekend-clock wording and the two-witnesses-stale wording.
  /不發送進場通知/,
  // Price-basis notes: which witness supplied the price and why. The data was
  // served; these explain the choice.
  /進場區間以此價位計算/,
  /進場區間改用最新 K 棒/,
  /進場區間改用最後一根 K 棒/,
  // A quiet news day — the fetch worked and nothing matched. "No news" and
  // "news source down" must not share a bucket.
  /查無「.*」相關新聞/,
  // The zero-key news path doing its designed job.
  /改用本地關鍵字評分/,
  /改用本地備援文字/,
  // Rule conclusions about this signal (downgrades, interventions firing).
  // They explain a verdict; nothing failed to arrive.
  /訊號強制降級為 no-trade/,
  /干涉：/,
  // The counter-trend asymmetry explaining its verdict — both the downgrade
  // and the "held because bias cleared the A+ bar" wording.
  /逆勢降級：/,
  /逆勢訊號：/,
];

export function isInformational(gap: string): boolean {
  return INFORMATIONAL_PATTERNS.some((p) => p.test(gap));
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
  /** The system explaining its own behaviour — nothing is missing. */
  informational: string[];
}

/**
 * One root cause, one line.
 *
 * A single AI outage was producing four separate gaps — "所有 AI 供應商皆無法
 * 回應", "AI 綜合敘述改用本地備援文字", "交易計畫改用預設規則判斷", and a
 * second providers-down line from the retry. Two problems with that:
 *
 *  - the panel says "6 項資料缺口" when three sources are actually down
 *  - `data_gaps.length` is what the confidence score penalises, so one outage
 *    cost 12 points instead of 3, and did it *again* on the plan's own −10
 *
 * Collapsed here rather than at each call site: the messages are written in
 * half a dozen modules that have no idea what else failed in the same run.
 * Anything not matched is left untouched — silence is the wrong default.
 */
const CASCADES: Array<{ match: RegExp; keep: RegExp; label: string }> = [
  {
    // Everything downstream of "no AI answered" — including the keys-not-
    // stored instruction, which used to survive *beside* "未設定任何 AI 金鑰"
    // and bill the same missing key as two actionable gaps on all nine
    // symbols (18 of the sweep's warning lines were this one fact).
    match:
      /所有 AI 供應商皆無法回應|AI 綜合敘述改用本地備援|交易計畫改用預設規則|AI 環節改用本地規則|未設定任何 AI 金鑰|AI 金鑰在瀏覽器與伺服器兩邊都沒有/,
    // Keep the line someone can act on: the store-your-keys instruction when
    // present, else the one naming the provider errors.
    keep: /AI 金鑰在瀏覽器與伺服器兩邊都沒有|所有 AI 供應商皆無法回應/,
    label: "AI",
  },
];

export function collapseCascades(gaps: string[]): string[] {
  let remaining = [...new Set(gaps)];
  for (const cascade of CASCADES) {
    const hit = remaining.filter((g) => cascade.match.test(g));
    if (hit.length <= 1) continue;
    const primary = hit.find((g) => cascade.keep.test(g)) ?? hit[0];
    const others = hit.length - 1;
    remaining = remaining
      .filter((g) => !cascade.match.test(g))
      .concat(`${primary}（另有 ${others} 項後續影響皆源自同一原因）`);
  }
  return remaining;
}

export function groupDataGaps(gaps: string[]): GroupedGaps {
  const missingKeys = new Set<string>();
  const keyRelated: string[] = [];
  const other: string[] = [];
  const permanent: string[] = [];
  const informational: string[] = [];

  for (const gap of gaps) {
    const match = gap.match(KEY_PATTERN);
    if (match && match[1].endsWith("_KEY")) {
      missingKeys.add(match[1]);
      keyRelated.push(gap);
    } else if (isInformational(gap)) {
      informational.push(gap);
    } else if (isPermanent(gap)) {
      permanent.push(gap);
    } else {
      other.push(gap);
    }
  }

  return { missingKeys: [...missingKeys], keyRelated, other, permanent, informational };
}
