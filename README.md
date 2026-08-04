# 多商品交易訊號網站 — Stage 2

Next.js 14 (App Router) + TypeScript + TailwindCSS. All 9 symbols
(EURUSD/USDJPY/GBPUSD/XAUUSD/NAS100/GER40/US30/WTI/SPX500) are wired
end-to-end. A Vercel Cron job refreshes every 4h into Supabase, and
`/history` lets you browse past signals by symbol/grade/date.

## Getting started

```bash
npm install
cp .env.example .env.local   # 可以完全空白 — 見下方「零金鑰可跑」
npm run dev
```

Open http://localhost:3000. Pick any symbol in the left panel — each calls
`GET /api/signal/[symbol]`, which runs the whole
fetch → analyze → score → grade → AI-narrative pipeline server-side.
`/history` reads persisted runs from Supabase (see the Cron section below —
it's empty until the cron job has run at least once against a configured
Supabase project).

**No key is required to run the app.** Every external call is wrapped in
try/catch; on failure it logs a human-readable reason to the signal's
`data_gaps[]` instead of fabricating a value. With zero keys configured you
will see a populated `data_gaps` list and, typically, `grade: "no-trade"`
(scoring rules force `no-trade` whenever no protecting structure or no
per-obstacle profit target can be found) rather than a crash or placeholder
numbers.

## Data contracts

`types/signal.ts` — `Timeframe`, `BiasItem`, `EntryStructure`, `PathObstacle`,
`TradeSignal`, `CommodityMeta`, `SignalRow` (a `TradeSignal` row from
Supabase, adds `id`/`created_at`) — field names/values match the spec exactly.

## Scoring — hard rules (`lib/scoring.ts`, `lib/entry-exit.ts`)

Unchanged from Stage 1, now exercised by all 9 symbols:

- `bias_score` = Σ(weight of `BiasItem`s agreeing with signal direction) −
  Σ(weight of opposing items). Neutral items score 0.
- `entry_structure_score` = Σ `strength` of `EntryStructure`s that actually
  protect the entry (`support`/`resistance` on the correct side, within
  1.5% of the entry zone).
- `grade`: A+/A/B/C/no-trade per the fixed lookup table; disqualifiers
  (`total<3`, `bias_score<=0`, `entry_structure_score=0`) are checked first.
- `stop_loss` is hard-anchored on the same protecting structure used for
  `entry_structure_score` (ATR only ever adds a small buffer beyond it,
  never the sole basis). `take_profits` are hard-anchored on real
  `path_obstacles` ahead of the entry, split 100/60-40/40-35-25 by count.
  If either can't be built from real structure, the signal is forced to
  `grade: "no-trade"` rather than inventing a price.

## Per-symbol fundamentals — `config/fundamentals.ts`

One config object per symbol drives which fundamental factors, which CFTC
COT contract, and which news keywords apply — this is what makes
`lib/analysis/{fundamental,positioning,fundflow}.ts` symbol-generic instead
of the Stage 1 XAUUSD-only versions. Two directional-semantics flags matter:

- `dxyInverted` — DXY down normally means "long" for the instrument (weaker
  dollar → asset priced in USD rises). It's `true` only for **USDJPY**,
  where USD is the *base* currency, so dollar weakness points the other way.
- `cotInverted` — same idea for the CFTC contract itself: CME's Japanese
  Yen future quotes USD per 100 JPY, so a non-commercial net-long position
  is a bet on JPY strength, i.e. **bearish USD/JPY**. `USDJPY` is the only
  symbol with this set.
- `vixRiskOffDirection` — high VIX means "long" for XAUUSD (safe-haven bid)
  but "short" for equity indices (risk-off sell-off).

`cotContractCode: null` (currently only `GER40`) means the instrument has
no CFTC data at all — DAX trades on Eurex, not a CFTC-regulated exchange —
so 籌碼面 is legitimately empty for that symbol, logged to `data_gaps`
rather than guessed.

## Six dimensions → `bias_items`

| 面向 | 檔案 | 資料來源 |
|---|---|---|
| 技術面 | `lib/analysis/technical.ts` + `lib/analysis/levels.ts` | OHLCV → swing HH/HL/LH/LL, EMA20/50/200 排列, RSI(14) 背離, MACD histogram, 整數關卡；結構區改用**跨時框聚類**（見下） |
| 基本面 | `lib/analysis/fundamental.ts` | Config-driven per symbol: 實質利率(DGS10−T10YIE，僅XAUUSD), DXY 趨勢, VIX, EIA 原油庫存(僅WTI), Finnhub 財報日曆(僅美股指數) |
| 籌碼面 | `lib/analysis/positioning.ts` | CFTC COT (Socrata, legacy futures-only report) 非商業淨部位、52週極值、週變化，依 config 合約代碼與方向反轉設定 |
| 新聞面 | `lib/analysis/news.ts` | GDELT 2.0 DOC API + Finnhub `/news` → Claude 評 -1~+1 情緒分並摘要，關鍵字依 config 逐商品設定 |
| 資金流 | `lib/analysis/fundflow.ts` + `lib/analysis/open-interest.ts` | SPDR GLD 持倉快照(僅XAUUSD)、DXY 方向、VIX、**未平倉量分析**（價量未平倉四象限、52週水位、異常變化偵測） |
| AI綜合 | `lib/analysis/ai-narrative.ts` | 上述五面向的結構化 JSON → Claude 產生 `narrative`（prompt 明確禁止補充未提供的事實） |

## 結構偵測精準度 — `lib/analysis/levels.ts`

原本直接把每個 swing point 當成一個結構，有三個精準度問題，現在都修掉了：

1. **沒有聚類**：4100、4102、4105 三個 swing 是「市場守了三次的同一個區」，卻被
   當成三個各自很弱的結構。現在會合併成一個 3 次觸及的強區，強度才反映現實。
2. **固定百分比容差**：0.2% 在黃金是 ±8 點還算合理，在 EUR/USD 卻是 ±20 pips
   —— 寬到毫無意義。改用 **0.3×ATR**，自動隨商品波動性調整。
3. **沒有跨時框共振**：D1 和 W1 同時出現的價位，明顯比只在 H4 出現的強。現在
   共振會計入強度。

強度分級：3 次以上觸及、或 2 次觸及且跨時框共振、或位於週線 → 強度 3；
2 次觸及或位於日線 → 強度 2；其餘 → 強度 1。swing 偵測的 fractal lookback
也從 2 放寬到 3，過濾掉更多雜訊。

這直接影響 `entry_structure_score`（強度加總）與停損停利的錨定品質。

## 未平倉量分析 — `lib/analysis/open-interest.ts`

資料來源是**已經在抓的 CFTC Socrata COT**（`open_interest_all` 欄位），免金鑰、
不需額外請求。三項分析：

**1. 價量未平倉四象限** — 把兩份 COT 報告之間的未平倉量變化，對上同期間的
D1 收盤價變化：

| 價格 | 未平倉量 | 判讀 | 方向 | 權重 |
|---|---|---|---|---|
| ↑ | ↑ | 價漲量增：新資金進場推升，趨勢確認 | long | 2 |
| ↓ | ↑ | 價跌量增：新空單進場推跌，趨勢確認 | short | 2 |
| ↑ | ↓ | 價漲量減：空頭回補而非新買盤，動能存疑 | short | 1 |
| ↓ | ↓ | 價跌量減：多頭平倉而非新空單，賣壓耗盡 | long | 1 |

後兩象限是**警示**而非趨勢確認，所以方向與價格走勢相反、權重較低 —— 這是標準
讀法：靠回補推的漲勢缺乏新買盤支撐。價格變動 <0.3% 或未平倉量變動 <1% 時視為
訊號不明確，記 neutral/權重 0，不硬套象限。

**2. 52週水位** — 未平倉量在自身一年區間的百分位。≥90 表示部位擁擠、≤10 表示
乏人問津。兩者都是風險提示不是方向判斷，所以 direction=neutral、權重 0。

**3. 異常變化偵測** — 本週變化對比歷史週變化的標準差，≥2σ 標記為異常。歷史變化
無波動時（標準差為 0，z-score 無定義）改用「平均週變化的倍數」判定，避免漏掉尖峰。

### 限制（重要）

CFTC 未平倉量是**每週**資料：週二收盤結算、週五公布，所以最多落後價格約 3 個
交易日。它衡量的是一週的參與度與資金承諾，**不是即時或當日訊號**。想要日內
未平倉量需要交易所直連資料，沒有免金鑰來源。GER40 在 Eurex 交易、CFTC 無資料，
因此沒有這項分析。

## 預測是怎麼產生的（沒有 AI 也能跑）

**預測引擎是純程式，不是 AI。** 六面向計分、方向判定、A+/A/B/C 評等、進場區間、
結構錨定的停損停利，全部在 `lib/scoring.ts`、`lib/entry-exit.ts`、`lib/analysis/*.ts`
裡以確定性規則計算。LLM 只在三個地方出現（新聞情緒評分、敘述文字、在已算好的
候選清單中挑一個），三個都有本地備援 —— 見「零金鑰可跑」。

### 歷史幾何檢驗 — `lib/analysis/backtest.ts`

規則算出計畫之後，再用**這個商品自己的歷史 K 棒**驗證一次，純本地運算、無 AI、
不需任何新 API：

取出計畫的停損／停利「相對距離」（佔進場價的百分比），然後逐根走過歷史 D1：
假設在那根收盤進場、用同樣的相對距離擺停損停利，往後走最多 20 根，看**哪一邊先被觸及**。
輸出勝率與期望值（`hitRate × 風報比 − (1 − hitRate)`，單位為 R）。

**它回答的問題**：「停損擺這麼近、停利擺這麼遠，以這個商品的波動性來說，
歷史上有多少比例會先碰到停利？」—— 這是對風報比配置的可行性檢驗。

**它不回答的問題**：這個訊號好不好。回測是**逐根無條件取樣**，不篩選六面向狀態，
所以它衡量的是幾何配置對上波動性，不是這個 setup 的優勢。UI 上這句警語直接寫在
數字旁邊，避免被誤讀成策略勝率。

兩個保守處理：同一根 K 棒同時觸及停損與停利時，日線無法判斷先後，**一律計為敗**
（不用擲硬幣灌高勝率），並在 UI 標示；K 棒不足時回傳 null 並記入 `data_gaps`，
不生一個假數字。

## Cron + persistence (Stage 2)

1. Apply `supabase/schema.sql` to your Supabase project (SQL editor or
   `supabase db push`) — creates `signals` with public read / service-role
   write via RLS.
2. Set `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (server-only,
   never expose to the client) and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
3. Deploy to Vercel — `vercel.json` registers `/api/cron/refresh-signals`
   on a `0 */4 * * *` schedule. It builds all 9 signals in parallel
   (`Promise.allSettled`, one symbol's failure doesn't block the others)
   and inserts each as a new row (append-only, so `/history` shows a
   timeline, not just the latest state).
4. Optionally set `CRON_SECRET` — Vercel sends it automatically as
   `Authorization: Bearer <value>` when the env var exists, and the route
   rejects any other caller.

Nine symbols × the full analysis pipeline can run past Vercel's timeout —
`maxDuration = 60` is declared on the route (the Hobby ceiling; a higher
value fails deployment there). Raise it if your plan allows more.

## 零金鑰可跑

除了 `ANTHROPIC_API_KEY` 之外，**所有資料來源都有免金鑰的公開端點**，不設定任何
環境變數也能產生完整訊號：

| 面向 | 免金鑰來源 | 選用的升級 |
|---|---|---|
| OHLCV | Yahoo chart 端點 → Stooq CSV | `TWELVE_DATA_API_KEY` |
| 基本面（總經） | FRED `fredgraph.csv`（免金鑰，資料與官方 API 相同） | `FRED_API_KEY` |
| WTI 原油庫存 | FRED `WCESTUS1`（EIA 原始資料，FRED 轉載） | `EIA_API_KEY` |
| 新聞面 | GDELT 2.0 DOC API | `FINNHUB_API_KEY`（另加財報日曆） |
| 籌碼面 | CFTC Socrata COT | — |
| 資金流 | SPDR GLD 持倉 XML + CFTC 未平倉量 | — |

### 關於 `ANTHROPIC_API_KEY`

**沒有免金鑰的 LLM API** —— 任何 LLM 服務都要註冊。未設定時三個 AI 環節各有本地備援：

| AI 環節 | 無金鑰時的備援 | 損失 |
|---|---|---|
| 新聞情緒評分 | 本地關鍵字表 (`lib/analysis/news-lexicon.ts`) | 讀不出語境（分不出 "gold rallies" 和 "gold rally fades"），權重上限降為 1 |
| AI 綜合敘述 | 本地組裝的衝突提示文字 | 沒有跨面向的綜合判讀 |
| AI 交易計畫 | 預設規則（各取第一個候選、風報比 <1:1 則觀望） | 沒有「哪個進場點最好」的判斷 |

所以零金鑰時六個面向都有分數、訊號完整可用，只是少了 AI 的判斷品質。
卡片會顯示「預設規則」而非「AI 判斷」，關鍵字評分的來源也會標明「非 AI 評分」。

**成本**：預設模型是 `claude-opus-5`（$5/$25 per MTok）。每個訊號約 3 次呼叫，
9 商品 × 每 4 小時 = 每天約 162 次。要壓成本可用 `ANTHROPIC_MODEL=claude-haiku-4-5`
（$1/$5 per MTok，約 1/5 價格）。若想改用其他供應商的免費額度（Gemini、Groq
等），需要自行替換 `lib/analysis/` 下三個檔案的 SDK 呼叫。

一個運作中的備援來源不會被記成 `data_gaps` —— 只有當某個面向的**所有**來源都失敗時才會。

## 申請免費金鑰的步驟

**先確認你真的需要**：目前只有 `ANTHROPIC_API_KEY` 會影響輸出品質，其餘四個都已經有
免金鑰來源在供應資料（見上表）。下面按「值不值得花時間」排序。

拿到金鑰後有兩個地方可以貼，見下方「[在網站裡直接貼金鑰](#在網站裡直接貼金鑰--settings)」。
最簡單的是開 `/settings` 貼上按儲存，立即生效。

### 1. Anthropic（唯一影響 AI 判斷的，需付費）

1. 開 https://console.anthropic.com 註冊帳號
2. 左側 **Settings → API Keys → Create Key**，複製 `sk-ant-...`
3. **Billing** 頁面儲值（最低額度即可試用）
4. 貼進 `/settings` 的 Anthropic 欄位（或 Vercel 環境變數 `ANTHROPIC_API_KEY`）

想省錢就把「Anthropic 模型」欄位填 `claude-haiku-4-5`（約 1/5 價格，且明顯更快）。

### 2. Twelve Data（OHLCV 主要來源，免費且不用信用卡）

1. 開 https://twelvedata.com/pricing 選 **Basic — Free**
2. Email 註冊並驗證
3. 登入後 Dashboard 首頁就有 **API Key**
4. 貼進 `TWELVE_DATA_API_KEY`

免費額度 800 次/日、8 次/分。**最值得申請的免費金鑰** —— Yahoo 對雲端機房 IP
常限流，設定這個等於買一條穩定的主線路。

### 3. Finnhub（新聞與財報日曆，免費不用信用卡）

1. 開 https://finnhub.io/register，Email 註冊
2. 登入後 Dashboard 直接顯示 **API Key**
3. 貼進 `FINNHUB_API_KEY`

免費 60 次/分。新聞面已由 GDELT 免金鑰供應，加了它只是多一個來源＋美股指數的
財報日曆（權重 0 的參考項目），**優先度最低**。

### 4. FRED（總經）／ 5. EIA（原油庫存）—— 通常不需要

兩者現在都走免金鑰路徑（FRED 用 `fredgraph.csv`、原油庫存用 FRED 的 `WCESTUS1`），
資料完全相同。真的要申請：

- FRED：https://fredaccount.stlouisfed.org/apikey → 註冊 → Request API Key → 立即取得
- EIA：https://www.eia.gov/opendata/register.php → 填 Email → 金鑰寄到信箱

## 在網站裡直接貼金鑰 — `/settings`

金鑰有兩種設定方式，可以並存：

| 方式 | 怎麼設 | 生效時機 | 適用 |
| --- | --- | --- | --- |
| **`/settings` 頁面** | 貼上 → 儲存 | 立即，不用重新部署 | 個人自用（推薦） |
| Vercel 環境變數 | Settings → Environment Variables → Redeploy | 下次部署後 | 網址會分享給別人、或跑排程 |

兩者同時存在時**以 `/settings` 的為準**，環境變數是沒填時的後備。

### 運作方式

1. `/settings` 把金鑰存進**這台裝置的瀏覽器 localStorage**（`lib/user-keys-client.ts`）
2. 每次查詢訊號時，以 `x-user-keys` 請求標頭隨該次請求送給本站後端
3. 後端 `parseUserKeyHeader()` 過濾後放進 AsyncLocalStorage，只在這個請求的生命週期內有效
4. 所有抓資料的程式改用 `getKey(name)` 取金鑰 —— 先看請求，再看環境變數

**金鑰不會寫進伺服器**：沒有資料庫、沒有檔案、沒有 log，請求結束就消失。

### 安全邊界

`lib/api-key-names.ts` 的 `USER_SETTABLE_KEYS` 是允許清單，只有這 6 個名字會被接受。
這一點是刻意的：否則任何人都能靠偽造標頭覆蓋 `SUPABASE_SERVICE_ROLE_KEY`、
`CRON_SECRET` 這類與資料來源無關的伺服器設定。清單外的名字直接丟棄，值也限長 200 字元。

排程路由（`/api/cron/refresh-signals`）**只讀環境變數**，不吃這個標頭 —— 排程沒有瀏覽器，
也不該被外部請求影響。

### 代價

localStorage 可以被這個網站上的任何腳本讀取，這一點頁面上也寫明了。個人自用沒問題；
如果部署網址會分享給別人，改用環境變數比較安全。

## 自訂分析標的 — `/symbols`

內建 9 個商品之外，`/symbols` 頁面可以自己加標的，存在瀏覽器 localStorage，
不需要資料庫、不需要金鑰、也不用重新部署。

**只要輸入商品名稱**（中英文皆可），其餘欄位自動帶入。兩個來源：

1. **內建清單** `config/instrument-catalog.ts` —— 約 22 個常見標的（白銀、銅、天然氣、
   日經、恆生、台股、澳幣、比特幣、玉米、咖啡…），建議項標「已校對」，**含 CFTC
   合約代碼**，籌碼面與未平倉量開箱可用。
2. **Yahoo 搜尋**（`/v1/finance/search`，免金鑰）—— 清單以外的任何標的，帶回代碼與
   名稱；CFTC 代碼要自己補，不補則籌碼面與未平倉量從缺。

內建清單的 Yahoo 代碼信心度較高（錯了會明確失敗，不會產生錯誤數字）；Stooq 與
CFTC 代碼取自公開資料整理、未逐一即時驗證 —— CFTC 代碼錯誤只會查無 COT 資料，
籌碼面從缺而不是算錯。

| 欄位 | 必填 | 說明 |
|---|---|---|
| 代號 | ✅ | 自訂識別字串，英數字／底線／連字號 |
| 顯示名稱 | ✅ | 晶片列上顯示的名字 |
| Yahoo 代碼 | ✅ | 自動帶入；手動填的話到 Yahoo Finance 搜尋，網址列的代號就是 |
| Stooq 代碼 | — | 備援來源，留空則沿用 Yahoo 代碼 |
| CFTC 合約代碼 | — | **填了才有籌碼面與未平倉量分析**，留空則這兩項從缺 |
| 新聞查詢 | — | GDELT 查詢字串，留空則用顯示名稱 |

自訂標的套用的是通用基本面設定（DXY、VIX），不會套用實質利率、原油庫存、財報季
這些**商品專屬**因子 —— 把黃金的實質利率邏輯硬套到比特幣上只會產生假訊號。

代碼填錯不會產生錯誤數字：所有 OHLCV 來源都失敗時訊號會回 `no-trade` 並在
`data_gaps` 說明。頁面上的常用範例代碼取自公開資料整理，未逐一即時驗證。

## 部署到 Vercel 後畫面卡在「載入中」/ 沒東西？

先開 **`/api/diagnostics`** —— 它會回報哪些環境變數有設（只回 true/false，不回值），
並從部署環境實際去 ping 每個上游來源，這是唯一能分辨「沒設金鑰」和
「這個主機擋掉 Vercel 機房 IP」的方法。`verdict` 欄位會直接告訴你能不能產生訊號。

最常見的兩個原因：

1. **來源主機擋雲端機房 IP。** `query1.finance.yahoo.com` 對資料中心 IP 常回
   429/401，本機能通不代表 Vercel 能通。這種情況會自動往下掉到 Stooq；
   若兩者都被擋，設定 `TWELVE_DATA_API_KEY` 走主要來源。
2. **Serverless 逾時。** 預設只有 10 秒，這條 pipeline 一定超過。兩個 API route
   都已宣告 `maxDuration = 60`（Hobby 方案上限；更高需要 Pro）。

即使所有來源都失敗，`/api/signal/[symbol]` 也會回 **HTTP 200 + `grade: "no-trade"`**
的訊號（價格欄位為 0 並標明無資料，不是猜的價格），畫面一定看得到東西而不是空白。

### Vercel Cron 方案限制

`vercel.json` 用的是 spec 要求的 `0 */4 * * *`（每 4 小時）。**Hobby 方案只允許每日一次的
cron**，這個排程需要 Pro 方案；若你在 Hobby，把它改成例如 `0 0 * * *` 才會被接受。

## APIs used

| API | Auth | Used for | Notes |
|---|---|---|---|
| [Twelve Data](https://twelvedata.com) `/time_series` | `TWELVE_DATA_API_KEY` | OHLCV, primary | Free tier 800 req/day; local daily counter in `lib/data-sources/cache.ts` prevents exceeding it — now shared across 9 symbols so budget accordingly. |
| Yahoo Finance chart endpoint (`query1.finance.yahoo.com/v8/finance/chart/...`) | none | OHLCV, first keyless fallback (what `yfinance` wraps) | No native 4h interval — H4 candles are resampled from real fetched 1h candles, not fabricated. Commonly rate-limits datacenter IPs. |
| [Stooq](https://stooq.com) `q/d/l/` CSV | none | OHLCV, second keyless fallback (daily/weekly only) | Last resort when Yahoo is blocked. Tickers in `CommodityMeta.stooqSymbol` are unverified live; a wrong one yields no rows and falls through. |
| [FRED](https://fred.stlouisfed.org) `graph/fredgraph.csv` | **none** | DXY (`DTWEXBGS`), DGS10, DGS2, T10YIE, VIX (`VIXCLS`), crude stocks (`WCESTUS1`) | Keyless CSV download serving the same observations as the API. `FRED_API_KEY` switches to the JSON API but changes no data. Endpoint shape not live-verified from the build sandbox. |
| [Finnhub](https://finnhub.io) `/calendar/economic`, `/news`, `/calendar/earnings` | `FINNHUB_API_KEY` | Economic calendar, market news, earnings season (Stage 2) | No commodity-specific "company-news" for gold/indices, so `/news?category=general` is filtered by keyword instead. |
| [GDELT 2.0 DOC API](https://api.gdeltproject.org/api/v2/doc/doc) | none | News, last 48h | Free, no key. |
| [CFTC Socrata](https://publicreporting.cftc.gov) `resource/6dca-aqww.json` | none | Weekly COT (legacy futures-only report) | Contract codes per symbol in `config/fundamentals.ts`; only Gold (`088691`) was validated in Stage 1, the other 7 codes are best-recollection and **unverified live** (see caveat below) — `null` for GER40 (Eurex, no CFTC data). |
| [EIA Open Data](https://www.eia.gov/opendata/) `v2/petroleum/stoc/wstk/data` | `EIA_API_KEY` (optional) | WTI weekly crude inventory | Falls back to FRED's `WCESTUS1`, which mirrors the same EIA series without a key, so this key is never required. |
| SPDR Gold Shares (`spdrgoldshares.com/assets/dynamic/GLD/GLD_US_ProductDetails.xml`) | none | GLD bullion holdings | **Unverified in this build** — outbound network in this sandbox is restricted to an allowlist (npm/PyPI/Anthropic/GitHub) so this endpoint's exact XML schema could not be live-tested here; the parser fails safe to `data_gaps` on any mismatch. |
| Anthropic Messages API | `ANTHROPIC_API_KEY` | News sentiment scoring, AI綜合 narrative | Both prompts explicitly restrict the model to reasoning over the JSON/headlines provided — no outside facts. |
| Supabase | `NEXT_PUBLIC_SUPABASE_URL` + anon/service-role keys | Signal history persistence | Standard `@supabase/supabase-js` client; anon key is read-only via RLS, service-role key (server-only) writes from the cron route. |

### Example responses

Unchanged from Stage 1 — this sandbox's network policy still blocks every
host above, so live verification isn't possible here. See Stage 1's commit
for documented example payloads (Twelve Data, FRED, CFTC, GDELT, Claude
news-sentiment call); the same shapes apply to the new symbols, just with
different `symbol`/`cftc_contract_market_code` values.

## Known Stage-2 limitations (all surfaced via `data_gaps`, never silently faked)

- **CFTC contract codes for the 7 new symbols are unverified.** Gold's code
  (`088691`) was already in use in Stage 1; the rest
  (NAS100/US30/SPX500/WTI/EURUSD/USDJPY/GBPUSD) are coded from training-data
  recollection and could not be checked against a live response in this
  sandbox. If a code is wrong, the Socrata query simply returns nothing and
  `data_gaps` reports it — it fails safe, but verify these against the
  [CFTC's dataset](https://publicreporting.cftc.gov) before relying on 籌碼面
  for those symbols.
- **兩國利差 (FX interest-rate differentials)** aren't computed for
  EURUSD/USDJPY/GBPUSD — FRED's approved series are US-only, so there's no
  approved source for EUR/JPY/GBP short rates. Logged as a permanent gap.
- **央行語調 (central bank tone)** for FX pairs is only as good as whatever
  the news-sentiment analyzer picks up via keywords (`ecb`, `boj`, `boe`) —
  it isn't a dedicated signal.
- **GER40 has no 籌碼面 at all** (DAX trades on Eurex, not covered by CFTC).
- 央行購金 (central bank gold purchases) still has no free API in scope.
- GLD holdings is still a single snapshot; "持倉變化" can't be computed.
- EIA and SPDR endpoints are unverified in this sandbox (see APIs table).

## Next steps

Stage 3 (trade journal + stop-loss postmortem tagging + severity scoring +
grade-intervention rules + `/review` analytics) is queued pending your
review of this stage — not started yet.
