import { check, report } from "./_harness";
import { groupDataGaps } from "@/lib/data-gaps";

/**
 * data_gaps are split three ways so the warning count only ever shows things
 * someone can act on. A count that can never reach zero is a count people
 * stop reading.
 */

// The three lines a deployed signal card actually showed.
{
  const g = groupDataGaps([
    "央行購金數據不在免費 API 清單內，本階段基本面計分不納入此項",
    "SPDR GLD 持倉 取得失敗，且無可用快取",
    "SPDR GLD 持倉資料取得失敗或 XML 格式與預期不符（來源未經即時驗證，見 README）",
  ]);
  check("central-bank gold is a permanent limitation", g.permanent.length === 1, g.permanent);
  check("it is not counted as a failure", !g.other.some((x) => x.includes("央行購金")), g.other);
  check("the GLD lines stay actionable", g.other.length === 2, g.other);
}

// After the fix only the permanent note remains.
{
  const g = groupDataGaps(["央行購金數據不在免費 API 清單內，本階段基本面計分不納入此項"]);
  check("nothing actionable is left", g.other.length === 0 && g.keyRelated.length === 0, g);
  check("the note is still shown", g.permanent.length === 1, g.permanent);
}

// Missing keys keep their own bucket and are deduplicated.
{
  const g = groupDataGaps([
    "未設定 GEMINI_API_KEY，AI 環節改用本地規則",
    "未設定 FRED_API_KEY，無法取得 DGS10",
    "未設定 FRED_API_KEY，無法取得 VIX",
    "缺少 DGS10 或 T10YIE，無法計算實質利率偏向",
  ]);
  check("two distinct keys found", g.missingKeys.length === 2, g.missingKeys);
  check("three messages are key-related", g.keyRelated.length === 3, g.keyRelated);
  // "缺少 DGS10" matches the key pattern's shape, but DGS10 is a FRED series
  // id, not an env var — it must not turn into a "set this key" instruction.
  check("a series id is not mistaken for a key", !g.missingKeys.includes("DGS10"), g.missingKeys);
  check("it stays in the actionable bucket", g.other.length === 1, g.other);
}

// GER40 has no CFTC filing at all — nothing to fix.
{
  const g = groupDataGaps([
    "GER40 無對應的 CFTC COT 合約代碼（可能在美國以外的交易所交易），籌碼面本階段從缺",
    "行情代理 (GC=F D1) 取得失敗，且無可用快取",
  ]);
  check("missing CFTC code is permanent", g.permanent.length === 1, g.permanent);
  check("a real fetch failure stays loud", g.other.length === 1, g.other);
}

// The three lines a EURUSD card showed. Two were the same fact reported twice,
// and the interest-rate one is a limitation of FRED's approved series list.
{
  const g = groupDataGaps([
    "兩國利差需要外國公債殖利率資料，FRED 核准清單僅含美國公債，本階段暫不納入此項",
    "GDELT 新聞 (euro) 取得失敗，且無可用快取",
  ]);
  check("the rate-differential note is permanent", g.permanent.length === 1, g.permanent);
  check("only the GDELT failure is actionable", g.other.length === 1, g.other);
}

// An upstream mirror a year behind is neither a failed fetch nor a wrong
// config. Verified live: every IMF series on DBnomics was 370–766 days stale,
// so all five 央行購金 sources went dark at once. Retrying can't fix it, so it
// must not shout under 本次取得失敗 on every four-hourly scan.
{
  const g = groupDataGaps([
    "央行購金／黃金流向：5 個來源都無法計分（DBnomics 的 IMF 資料集已停更，最新只到 2025-07，此因子暫時無可用來源）",
    "GDELT 新聞 (gold price) 取得失敗：HTTP 429，且無可用快取",
  ]);
  check("a dormant upstream dataset is a limitation", g.permanent.length === 1, g.permanent);
  check("and the live failure stays actionable", g.other.length === 1, g.other);
  // The distinction only holds while the two are worded differently; if the
  // gold message ever regains 取得失敗 phrasing it belongs in the loud bucket.
  check("the actionable one names its cause", g.other[0].includes("HTTP 429"), g.other[0]);
}

// Anything unrecognised must land in the loud bucket, never be silenced.
{
  const g = groupDataGaps(["某個沒見過的新錯誤訊息"]);
  check("unknown wording stays actionable", g.other.length === 1 && g.permanent.length === 0, g);
}

report("data-gaps");
