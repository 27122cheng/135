import { check, report } from "./_harness";
import { collapseCascades, groupDataGaps } from "@/lib/data-gaps";

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

// One AI outage is one problem, not four. The count feeds the confidence
// penalty, so double-counting a single cause moves the number that decides
// whether a signal is tradeable.
{
  const collapsed = collapseCascades([
    "CFTC COT (NAS100) 取得失敗，且無可用快取",
    "所有 AI 供應商皆無法回應（gemini: HTTP 429；groq: HTTP 429）",
    "AI 綜合敘述改用本地備援文字",
    "交易計畫改用預設規則判斷",
    "所有 AI 供應商皆無法回應（gemini 目前連線不穩）",
  ]);
  check("five gaps become two", collapsed.length === 2, collapsed);
  check("the unrelated failure survives untouched",
    collapsed.includes("CFTC COT (NAS100) 取得失敗，且無可用快取"), collapsed);
  // The surviving AI line must be the one naming the provider errors — that is
  // the only one anyone can act on.
  check("the kept line names the provider errors",
    collapsed.some((g) => g.includes("HTTP 429")), collapsed);
  check("and says how many followed from it",
    collapsed.some((g) => g.includes("另有 3 項後續影響")), collapsed);

  // The live sweep showed the same missing key billed twice on every symbol:
  // "未設定任何 AI 金鑰…" plus the store-your-keys instruction. One fact, one
  // line — and the surviving line is the one with the instruction in it.
  const keyNote =
    "AI 金鑰在瀏覽器與伺服器兩邊都沒有：排程掃描只讀伺服器端設定，到設定頁把金鑰按一次「儲存」就會同時寫入兩邊（每個金鑰旁會出現「排程也有」）";
  const merged = collapseCascades([
    "未設定任何 AI 金鑰（GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY），AI 環節改用本地規則",
    keyNote,
  ]);
  check("the missing key is one gap, not two", merged.length === 1, merged);
  check("and the instruction is the line that survives",
    merged[0].startsWith("AI 金鑰在瀏覽器與伺服器兩邊都沒有"), merged[0]);

  // A lone AI gap must not be rewritten — there is no cascade to collapse.
  const single = collapseCascades(["交易計畫改用預設規則判斷"]);
  check("one AI gap stays exactly as written",
    single.length === 1 && single[0] === "交易計畫改用預設規則判斷", single);

  // Nothing unrelated may ever be merged away.
  const untouched = collapseCascades(["A 取得失敗", "B 取得失敗", "C 取得失敗"]);
  check("unrelated failures are never collapsed", untouched.length === 3, untouched);

  check("duplicates are still removed",
    collapseCascades(["同一則", "同一則"]).length === 1);
}

// Anything unrecognised must land in the loud bucket, never be silenced.
{
  const g = groupDataGaps(["某個沒見過的新錯誤訊息"]);
  check("unknown wording stays actionable", g.other.length === 1 && g.permanent.length === 0, g);
}

// The system explaining its own behaviour is not a data gap. The screenshot
// that prompted this said "4 項資料缺口" — two were real (a GDELT failure and
// a key note) and two were rules doing their jobs: the add-on rule declining
// to add on at grade B, and the RR sanity check rejecting an AI pick. Nothing
// was missing in either, and counting them as gaps taught the owner the
// warning panel lies.
{
  const g = groupDataGaps([
    "本次不提供加倉點：評等 B 對方向的信心不足以加倉（僅 A / A+ 提供加倉點）",
    "AI 選出的組合風險報酬比僅 1:0.66，低於 1:1 門檻，已改用預設規則",
    "GDELT 新聞 (gold price) 取得失敗：HTTP 429，且無可用快取",
  ]);
  check("behaviour notes are informational, not gaps", g.informational.length === 2,
    g.informational);
  check("and are not counted as failures", g.other.length === 1, g.other);
  check("while the real failure stays loud", g.other[0].includes("GDELT"), g.other);
}

// Round two of the same principle, from a card still showing "6 項資料缺口"
// where most lines were the system narrating itself: the market being closed,
// which witness supplied the price, a quiet news day. Facts about the market
// or the run — not data that failed to arrive.
{
  const g = groupDataGaps([
    "最後成交距今 17.2 小時（報價與 K 棒都沒有更新的跡象），市場休市中或所有價格來源停更，不發送進場通知",
    "即時報價來源已 6.5 小時未更新，K 棒較新，進場區間改用最新 K 棒收盤價計算",
    "GDELT 近 48 小時查無「Nasdaq 100」相關新聞",
    "新聞面改用本地關鍵字評分（準確度低於 AI 評分，權重上限 1）",
    "NAS100 H4 OHLCV 所有來源皆失敗（行情代理無回應）",
  ]);
  check("market state and price-basis notes are informational",
    g.informational.length === 4, g.informational);
  check("a real fetch failure is still the only warning", g.other.length === 1, g.other);
  check("and it is the OHLCV one", g.other[0].includes("所有來源皆失敗"), g.other);
}

report("data-gaps");
