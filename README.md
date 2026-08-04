# 多商品交易訊號網站 — Stage 3（全免費版）

Next.js 14 (App Router) + TypeScript + TailwindCSS. All 9 symbols
(EURUSD/USDJPY/GBPUSD/XAUUSD/NAS100/GER40/US30/WTI/SPX500) are wired
end-to-end. A GitHub Actions workflow refreshes every 4h into Postgres, and
`/history` lets you browse past signals by symbol/grade/date.

**沒有任何一項需要付費**，而且完全不設金鑰也能跑 —— 見
「[全免費技術堆疊](#全免費技術堆疊)」。

## Getting started

```bash
npm install
cp .env.example .env.local   # 可以完全空白 — 見下方「零金鑰可跑」
npm run dev
npm test                     # 12 個測試套件，189 項斷言
```

Open http://localhost:3000. Pick any symbol in the left panel — each calls
`GET /api/signal/[symbol]`, which runs the whole
fetch → analyze → score → grade → AI-narrative pipeline server-side.
`/history` reads persisted runs from whichever database is configured (see
「排程與儲存」below — it's empty until the refresh workflow has run at least
once).

**No key is required to run the app.** Every external call is wrapped in
try/catch; on failure it logs a human-readable reason to the signal's
`data_gaps[]` instead of fabricating a value. With zero keys configured you
will see a populated `data_gaps` list and, typically, `grade: "no-trade"`
(scoring rules force `no-trade` whenever no protecting structure or no
per-obstacle profit target can be found) rather than a crash or placeholder
numbers.

## Data contracts

`types/signal.ts` — `Timeframe`, `BiasItem`, `EntryStructure`, `PathObstacle`,
`TradeSignal`, `CommodityMeta`, `SignalRow` (a stored `TradeSignal`, adds
`id`/`created_at`). `types/journal.ts` — `StopReasonTag`, `JournalEntry`,
`AppliedIntervention`, `TagStat`. Field names/values match the spec exactly.

## Scoring — hard rules (`lib/scoring.ts`, `lib/entry-exit.ts`)

Unchanged from Stage 1, now exercised by all 9 symbols:

- `bias_score` = Σ(weight of `BiasItem`s agreeing with signal direction) −
  Σ(weight of opposing items). Neutral items score 0.
- `entry_structure_score` = Σ `strength` of `EntryStructure`s that actually
  protect the entry (`support`/`resistance` on the correct side, within
  1.5% of the entry zone).
- `grade`: A+/A/B/C/no-trade per the fixed lookup table; disqualifiers
  (`total<3`, `bias_score<=0`, `entry_structure_score=0`) are checked first.
  Two departures from the literal table, both removing cases where a *better*
  signal graded worse. (1) The A band no longer caps at total 13 — it reads
  `total >= 10 且 bias >= 6`. With the cap, bias 6 / structure 7 graded A while
  bias 6 / structure 8 dropped to B: more structure, lower grade. (2) A
  catch-all sends any remaining `total >= 14` to **B**; without it those
  matched no rule and fell to `no-trade`, so bias 7 / structure 8 was
  untradeable while a weaker bias 5 / structure 4 graded B.
  One inversion is left on purpose and pinned by tests: below the bias floor
  (`bias_score < 6`), total 6-9 grades B, total 10-13 is `no-trade`, and total
  14+ is B again. The middle band is the spec working as intended — weak
  directional conviction shouldn't trade — and the outer two are the B band and
  the catch-all. Making it uniform means dropping the catch-all or giving the B
  band a bias floor; both are scoring-policy calls, not bug fixes.
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
| 新聞面 | `lib/analysis/news.ts` | GDELT 2.0 DOC API + Finnhub `/news` → AI 評 -1~+1 情緒分並摘要（走 `lib/ai` 的供應商鏈），關鍵字依 config 逐商品設定 |
| 資金流 | `lib/analysis/fundflow.ts` + `lib/analysis/open-interest.ts` | GLD 成交量資金流代理(僅XAUUSD，見下)、SPDR GLD 持倉快照、DXY 方向、VIX、**未平倉量分析**（價量未平倉四象限、52週水位、異常變化偵測） |
| AI綜合 | `lib/analysis/ai-narrative.ts` | 上述五面向的結構化 JSON → AI 產生 `narrative`（prompt 明確禁止補充未提供的事實） |

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

## 資金流的 ETF 訊號 — 為什麼不是持倉

SPDR 官方持倉 XML 有兩個問題：它會擋雲端機房 IP，而且**只給一個當下的數字**，
沒有歷史。沒有基準就比較不出變化，所以它最多只能產生一條權重 0 的「今天幾噸」，
卻同時噴兩則警告 —— 成本全付了，分數一分沒拿到。

改成用 **GLD 自己的日線成交量**當資金流代理，資料來自我們自架的 yfinance 代理：

- 近 5 日均量 vs 前 20 日均量，放大 ≥20% 才算數
- 同期價格漲 >0.3% → 買盤進場（long，權重 1）
- 同期價格跌 >0.3% → 賣壓出場（short，權重 1）
- 只縮量不算 —— 人潮散去不代表價格接下來要往哪走

**這是代理指標，不是持倉。** 成交量是交易活動，不是實際的申購贖回，
所以 `source` 欄位直接寫「資金流代理指標，非實際持倉」。

官方持倉 XML 還是會試，抓到就多一條參考用的噸數（權重 0）。
抓不到就**安靜跳過** —— 代理指標已經把這個面向撐住了，
為一個沒改變任何數字的來源噴警告只是狼來了。

### 資料缺口分成兩類

先前 `data_gaps` 把「這次抓失敗」和「免費資料源就是沒有」混在一起數，
於是警告數字永遠歸不了零，久了就沒人看。現在分開：

- **本次取得失敗** — 可以處理的，計入警告數
- **先天限制** — 央行購金沒有免費 API、GER40 在 Eurex 交易所以 CFTC 沒資料。
  照樣列出來，但不計入警告數，樣式也降到灰色

判斷是靠訊息措辭比對（`lib/data-gaps.ts` 的 `PERMANENT_PATTERNS`）。
沒比對到的訊息一律歸到吵的那一類 —— 寧可多叫一次，也不要把真的失敗藏起來。

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

## 復盤怎麼設定（一次性，約 5 分鐘）

`/review` 與交易日誌需要資料庫。這是整個專案唯一**不能**在網站 `/settings` 裡設定的東西 ——
資料庫連線字串能寫入整個資料庫，所以只放伺服器端環境變數，不進瀏覽器可設定的允許清單。

### 步驟 1：開一個 Neon 免費 Postgres

**建議走 Vercel 這條**（少一次複製貼上，也不會漏抄密碼）：

1. Vercel 專案 → **Storage** 分頁 → **Create Database** → 選 **Neon**
2. 選 Free 方案，按 Create
3. 完成 —— Vercel 會自動把 `DATABASE_URL` 注入這個專案的環境變數，
   **步驟 3 可以整個跳過**

或者自己去 Neon 開：

1. 到 https://neon.tech，用 GitHub 或 Google 登入（免費方案不用信用卡）
2. **Create project** → 名字隨便取，region 挑離你近的
3. 建好後首頁會顯示 **Connection string**，長這樣：
   `postgresql://neondb_owner:xxxx@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`
4. 整串複製起來（**密碼在字串中間**，最常見的失敗就是漏抄）

### 步驟 2：建資料表

在 Neon 專案頁面左側點 **SQL Editor**，把本專案 `supabase/schema.sql` 的
**整個檔案內容**貼進去按 Run。

那個檔案是純 SQL，Neon 與 Supabase 都適用，會建 `signals`（歷史訊號）
與 `trade_journal`（交易日誌）兩張表。可以重複執行 —— 全部都是
`create table if not exists`。

### 步驟 3：把連線字串給 Vercel

**從 Vercel Storage 建的話這步跳過** —— `DATABASE_URL` 已經在了。

自己開 Neon 的話：Vercel 專案 → **Settings → Environment Variables** → 新增：

| Name | Value |
|---|---|
| `DATABASE_URL` | 步驟 1 複製的那整串 |

不管哪一條，最後都要到 **Deployments** 頁按 **Redeploy** ——
環境變數不會套用到既有的部署。

### 步驟 4：確認

打開 `/review`。設定成功的話會看到「還沒有交易紀錄」加上底部的記錄表單，
而不是紅色錯誤。也可以開 `/api/diagnostics` 看 `database` 欄位是不是 `postgres`。

常見兩個錯誤，畫面會直接告訴你怎麼修：

- **「資料表尚未建立」** → 步驟 2 沒做，或貼到了別的資料庫
- **「資料庫連線被拒」** → 連線字串複製不完整（Neon 的密碼在字串中間，很容易漏）

### 用 Supabase 也可以

不想用 Neon 就改設 `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、
`SUPABASE_SERVICE_ROLE_KEY` 三把，一樣先跑 `supabase/schema.sql`。
`DATABASE_URL` 有設的話以它為準。

### 設定完之後怎麼用

1. 平倉一筆交易後，到 `/review` 底部的表單記一筆：標的、方向、進出場價、
   結果、當時評等。虧損的話**必須**選一個 S1–S8 停損原因。
2. 按「記錄」之後，畫面會直接展開 severity 是怎麼算出來的（三個項目各加幾分），
   不是給你一個沒來由的數字。
3. 累積到某個 tag 在近 30 筆裡出現 ≥3 次、且平均 severity ≥3，
   下一次產生訊號時就會自動加嚴，訊號卡上會出現「本次已套用的干涉」，
   並列出是哪幾筆歷史停損造成的。

干涉是**逐商品**的：EURUSD 的連續失誤不會影響黃金的訊號。

## 停損復盤與干涉機制（Stage 3）

訊號產生 → 交易 → 停損 → 分類原因 → 自動加嚴下一次的訊號。這是唯一會讓系統
隨時間改變行為的迴路，所以每一步都是確定性的、可稽核的。

### `trade_journal`

一筆平倉交易一列。到 `/review` 頁面底部記錄。

`stop_reason_tag` 由**人**在復盤時選，不是 AI 判的 —— 只有你知道當時在想什麼。
虧損的交易一定要選一個（資料庫的 `loss_needs_tag` 約束擋著）。

| tag | 意思 | 可事前預防 |
|---|---|---|
| S1 | 結構誤判（方向根本錯） | 否 |
| S2 | 進場位置太差（追價、未等回測） | 是 |
| S3 | 停損過窄被掃（結構抓對但 buffer 不足） | 是 |
| S4 | 事件衝擊（數據或突發新聞） | 否 |
| S5 | 執行問題（滑價、點差、時段流動性差） | 是 |
| S6 | 未依規則進場（紀律問題） | 是 |
| S7 | 總經方向反向（基本面判斷錯） | 否 |
| S8 | 籌碼反向（COT / 未平倉量訊號被忽略） | 是 |

「可事前預防」那一欄規格沒有指定，是我釘在 `types/journal.ts` 的
`PREVENTABLE_TAGS` 常數裡的。判準是「有沒有一條規則能在進場前擋下這件事」。
**這是整條公式裡唯一的主觀判斷，不同意就改那張表。**

### severity — 不准讓 AI 自由評分

```
severity = clamp(1, 5, round(
    (可事前預防 ? 2 : 0)
  + (本次虧損 > 平均虧損 * 1.5 ? 1 : 0)
  + (近 20 筆中同 tag 出現次數 >= 3 ? 2 : 0)
))
```

`lib/journal/severity.ts`，照抄。三個輸入全是既有事實：你選的 tag、這次的虧損、
歷史紀錄的統計。同樣的輸入永遠得到同樣的數字 —— 這正是干涉規則裡「平均 severity」
有意義的前提。

三個實作細節：

- **下限是 1 不是 0。** 三項都不成立的虧損還是 1 分。沒有零嚴重度的虧損。
- **平均虧損只算過去的虧損單**，不含獲利單。把獲利算進去會把平均拉向 0，
  於是幾乎每一筆虧損都變成「超額」。
- **第一筆沒有平均可比**，此時該項固定 0，不會因為「沒有基準」就預設成超額。

API 刻意**不接受**請求裡的 `severity`，一律用歷史重算。人能填的數字，
干涉規則就不能拿來平均。

### 干涉規則

產生新訊號時，讀該商品自己近 30 筆日誌。某個 tag **出現 ≥3 次且平均 severity ≥3**
就啟用對應懲罰：

| tag | 懲罰 |
|---|---|
| S1 | `bias_score` 門檻整體 +2 才給同等級 |
| S2 | 進場區間收窄 30%，且強制要求回測確認因子（找不到就 no-trade） |
| S3 | 停損的結構外 buffer 由 0.5×ATR 提高到 1.0×ATR |
| S4 | 24h 內有高影響力數據時，評等自動降一級 |
| S5 | 非主要交易時段（UTC 07:00–21:00 之外）產生的訊號自動降一級 |
| S7 | 基本面方向與訊號相反時，直接 no-trade |
| S8 | COT 處於極端且方向相反時，直接 no-trade |

**S6 沒有懲罰**，這是刻意的。系統攔不住一個人不照自己的規則做，
硬去轉某個不相干的旋鈕只是演戲。它照樣出現在 `/review` 的統計裡。

### 「只准降級」是結構上保證的，不是靠小心

規格第 3 條：干涉只做降級 / 加嚴門檻，永遠不准升級或放寬。三層防護：

1. **旋鈕的型別就只能收緊。** `InterventionEffects` 裡沒有一個欄位能表達「放寬」——
   `entryZoneWidthFactor` 只會 ≤1，`stopBufferAtrMultiple` 只會 ≥ 預設，
   `biasScoreThresholdBump` 只會 ≥0。
2. **`applyGradePenalties` 最後夾一次。** 不管中間的分支做了什麼，
   結果的等級不准高於傳進來的 baseline。
3. **`assertNeverLoosened()` 在 pipeline 裡跑。** 未來有人改壞了會直接丟例外，
   而不是安靜地讓訊號變寬鬆。

測試用 160 種輸入組合窮舉過：沒有任何一組能讓等級變高。

### `/review` 頁面

- 停損原因分布（甜甜圈圖）
- severity 隨時間的趨勢線＋5 筆移動平均
- 各 tag 累積虧損排行（最花錢的排最前面 —— 那就是下一個該修的）
- 各等級 A+/A/B/C 的實際勝率與期望值
- 目前生效中的干涉，以及記錄新交易的表單

圖表是手寫 SVG，沒有引入圖表函式庫。

### 訊號卡上的「本次已套用的干涉」

規格要求不只顯示改了什麼，還要說明**是因為哪幾筆歷史停損**。所以每一條干涉
都帶著觸發它的日期清單，你隨時可以回頭查那幾筆到底發生什麼事。

## 排程與儲存

### 為什麼不用 Vercel Cron

Vercel Hobby 方案的 cron **一天只能跑一次**，規格要求每 4 小時。所以排程搬到
GitHub Actions（`.github/workflows/refresh.yml`，`cron: "0 */4 * * *"`），
應用端只留一個 `/api/refresh` 端點給它打。`vercel.json` 的 `crons` 已移除。

設定步驟：

1. 套用 `supabase/schema.sql`（純 SQL，Neon 與 Supabase 都適用）。
2. 設定資料庫（二選一，見下節）。
3. 在 GitHub repo → **Settings → Secrets and variables → Actions** 新增：
   - `APP_URL` — 例如 `https://your-app.vercel.app`
   - `CRON_SECRET` — 自己想一組字串，同一組也要填進 Vercel 環境變數
4. 到 **Actions** 分頁按 **Run workflow** 手動跑一次確認。

workflow **一次打一個商品**（9 次請求，中間 sleep 20 秒），原因有兩個：
九個商品的完整 pipeline 塞不進 Vercel Hobby 的 60 秒函式上限；而且分開打之後
單一商品失敗只賠掉它自己。免費資料源多半是「每分鐘」限流，慢慢打反而更穩。

### 資料庫：`DATABASE_URL` 一個變數切換

| 設了 `DATABASE_URL` | 用什麼 |
|---|---|
| 有 | 該連線字串指向的 Postgres（Neon 免費方案，或任何 Postgres） |
| 沒有 | Supabase（`NEXT_PUBLIC_SUPABASE_URL` + 金鑰） |

程式碼層面是 `lib/db/index.ts` 的 `SignalStore` 介面，兩個實作
（`postgres-store.ts` / `supabase-store.ts`）。換資料庫不用改任何一行程式。

Neon 用的是 HTTP driver 而不是 TCP 連線池 —— serverless 函式生命週期很短，
連線池會在每次呼叫時建了又丟，而免費方案的連線數上限抓得很緊。

兩邊都是 append-only 寫入，所以 `/history` 看到的是時間軸而不是只有最新狀態。

## 全免費技術堆疊

付費依賴全部換掉，其餘規格不變。

| 層 | 用什麼 | 免費額度 | 換掉了什麼 |
|---|---|---|---|
| AI 主用 | Gemini `gemini-2.5-flash` | 1500 次/日、1M context | Claude（付費） |
| AI 備援 | Groq `llama-3.3-70b-versatile` | 30 次/分 | — |
| AI 第三備援 | OpenRouter `:free` 模型 | 依帳戶而定 | — |
| 行情 | 自架 yfinance 代理 + 30 分快取 | 無公開上限（自訂預算） | Twelve Data（免費只開 3 市場）、Alpha Vantage（剩 25 次/日） |
| 行情備援 | Stooq CSV（免金鑰） | — | — |
| 總經／新聞／籌碼 | FRED、GDELT 2.0、CFTC Socrata、EIA | 本來就免費 | 不變 |
| 排程 | GitHub Actions | 公開 repo 免費 | Vercel Cron（Hobby 一天只能一次） |
| 資料庫 | Neon 免費 Postgres 或 Supabase 免費層 | — | — |

### AI 層：可切換介面 — `lib/ai/`

免費層的模型與額度變動很快，所以**任何一家的 SDK 都不准寫進業務邏輯**。
分析程式只認識一個介面：

```ts
// lib/ai/provider.ts — 這個檔案不提任何廠商名稱
export interface AIProvider {
  readonly name: string;
  readonly tier: "free" | "paid";
  isConfigured(): boolean;
  complete<T>(prompt: string, schema: ResponseSchema<T>, options?): Promise<T>;
}
```

- `lib/ai/index.ts` 是註冊表與 fallback chain，`completeAI()` 是唯一入口。
- `lib/ai/providers/*.ts` 是實作，全部走純 `fetch`，**沒有安裝任何廠商 SDK**
  （`@anthropic-ai/sdk` 這次一併移除了）。
- Groq 與 OpenRouter 都是 OpenAI 相容格式，共用同一份實作
  （`openai-compatible.ts`），加第四家只是加一筆設定。
- 換順序不用改程式：`AI_PROVIDER_ORDER=groq,gemini`。

`ResponseSchema` 帶一個 `parse()`：模型答錯格式**算這家失敗**，直接換下一家，
呼叫端永遠拿不到半個解析成功的物件。

### 隱私

免費層通常保留拿 prompt 去訓練的權利。本專案送給 AI 的只有**公開市場資料** ——
價格、公開新聞標題、CFTC 持倉、算好的分數。要加任何新欄位進 prompt 之前，
先確認它不是使用者的私人資料。

### 行情：為什麼要自架代理

`lib/data-sources/yfinance.ts` + `app/api/proxy/ohlcv/route.ts`。

同時涵蓋外匯＋指數＋商品的行情服務現在全部要錢了。`yfinance` 這個 Python
套件包的其實是 Yahoo 的公開 chart 端點 —— 九個代碼全支援、免金鑰。所以改成
從自己的伺服器打它，快取 30 分鐘，並記帳。

兩件要講清楚的事：

1. 這是**沒有 SLA 的非公開端點**，隨時可能改格式或封鎖機房 IP。所以
   `ohlcv.ts` 保留真正的備援（Finnhub → Stooq），不把它當唯一來源。
2. 資料是 **EOD 或延遲約 15 分鐘**。這可以接受（最小時框是 H4），但絕不會
   被當成即時報價呈現 —— `/api/proxy/ohlcv` 的回應裡直接帶 `delayed: true`。

時間框架只做 **H4 / D1 / W1**，不做日內。H4 沒有原生 interval，是拿真實的
1 小時 K 棒**重新聚合**出來的，不是內插。

Finnhub 是規格指定的備援，程式有寫，但九個內建商品的 `finnhubSymbol` 都是
`null` —— 免費層的外匯／商品／指數 K 線是付費功能，打過去只會拿到 403。
留著是給使用者自己新增的美股用的（那個免費層真的有）。

### 硬性要求：額度追蹤、指數退避、stale 標記

`lib/data-sources/quota.ts` + `free-source.ts`。每個免費來源都走同一個
`fetchFree()`，優先順序由強到弱：

1. **新鮮快取** — 免費、當下
2. **實際呼叫** — 花額度
3. **過期快取，標記 stale** — 舊，但是真的
4. **null + 一筆 `data_gaps`** — 誠實的沒有

**沒有第五個選項。** 拿到 null 的呼叫端必須降級訊號，不准補假資料或隨機值。
超額時回傳的 stale 結果會附上「這是 X 分鐘前的快取」寫進 `data_gaps`，
使用者看得到。連續失敗會指數退避（2s 起跳、每次加倍、上限 5 分鐘），成功即歸零。

**範圍限制（請務必知道）**：這些計數器活在**行程記憶體**裡。Serverless 實例
是短命的、而且可能同時有好幾個 warm，所以真正的上限是「實例數 × 額度」而不是
「額度」。對「一個實例連續跑 9 個商品」這種主要情境是有效的防護，對整個叢集則不是。
要做到精確需要共用計數器（Postgres／Redis）。`/api/diagnostics` 會回傳即時計數。

## 零金鑰可跑

**所有資料來源都有免金鑰的公開端點**，不設定任何環境變數也能產生完整訊號：

| 面向 | 免金鑰來源 | 選用的升級 |
|---|---|---|
| OHLCV | 自架 yfinance 代理 → Stooq CSV | — |
| 基本面（總經） | FRED `fredgraph.csv`（免金鑰，資料與官方 API 相同） | `FRED_API_KEY` |
| WTI 原油庫存 | FRED `WCESTUS1`（EIA 原始資料，FRED 轉載） | `EIA_API_KEY` |
| 新聞面 | GDELT 2.0 DOC API | `FINNHUB_API_KEY`（另加財報日曆） |
| 籌碼面 | CFTC Socrata COT | — |
| 資金流 | SPDR GLD 持倉 XML + CFTC 未平倉量 | — |

### 連 AI 金鑰都沒有的話

三個 AI 環節各有本地備援，訊號依然完整：

| AI 環節 | 無金鑰時的備援 | 損失 |
|---|---|---|
| 新聞情緒評分 | 本地關鍵字表 (`lib/analysis/news-lexicon.ts`) | 讀不出語境（分不出 "gold rallies" 和 "gold rally fades"），權重上限降為 1 |
| AI 綜合敘述 | 本地組裝的衝突提示文字 | 沒有跨面向的綜合判讀 |
| AI 交易計畫 | 預設規則（各取第一個候選、風報比 <1:1 則觀望） | 沒有「哪個進場點最好」的判斷 |

六個面向都有分數、訊號完整可用，只是少了 AI 的判斷品質。卡片會顯示「預設規則」
而非「AI 判斷」，關鍵字評分的來源也會標明「非 AI 評分」。

一個運作中的備援來源不會被記成 `data_gaps` —— 只有當某個面向的**所有**來源都失敗時才會。
唯一例外是 stale 通知：資料已經三小時舊是使用者必須知道的事實，不管後面有沒有來源救得回來。

## 申請免費金鑰的步驟

全部免費、全部不用信用卡。**兩把就夠**（Gemini + Groq），其餘可以完全不管。

拿到金鑰後直接開網站的 `/settings` 貼上按儲存，立即生效 —— 不用碰 Vercel，
也不用重新部署。細節見「[在網站裡直接貼金鑰](#在網站裡直接貼金鑰--settings)」。

### 1. Google Gemini（AI 主力，最值得申請）

1. 開 https://aistudio.google.com/apikey
2. 用 Google 帳號登入（不用另外註冊、不用信用卡）
3. 按 **Create API key**，選一個 Google Cloud 專案（沒有就讓它新建）
4. 複製 `AIza...` 開頭那串，貼進 `/settings` 的 **Google Gemini** 欄位

免費額度 1500 次/日。新聞情緒、綜合敘述、交易計畫三個環節都靠它。

### 2. Groq（AI 備援，速度最快）

1. 開 https://console.groq.com/keys
2. 用 Google 或 GitHub 帳號登入
3. 按 **Create API Key**，取個名字
4. 複製 `gsk_...` 開頭那串，貼進 **Groq** 欄位

免費 30 次/分。Gemini 額度用完或掛掉時自動接手，**強烈建議兩把都申請** ——
一天跑 6 次刷新 × 9 商品 × 3 次呼叫 = 162 次，單靠 Gemini 的每分鐘限制會擠。

### 3. OpenRouter（第二備援，選填）

1. 開 https://openrouter.ai/keys，用 Google/GitHub 登入
2. **Create Key**，複製 `sk-or-...`
3. 貼進 **OpenRouter** 欄位

走 `:free` 模型。前兩個都掛掉才會用到，優先度低。免費模型偶爾會下架，
真的掛了就到 https://openrouter.ai/models?q=free 挑一個填進「進階 → OpenRouter 模型」。

### 4. Finnhub（選填）

1. 開 https://finnhub.io/register，Email 註冊
2. 登入後 Dashboard 直接顯示 **API Key**

免費 60 次/分。新聞已由 GDELT 免金鑰供應，加它只是多一個來源＋美股財報日曆
（權重 0 的參考項目）。**注意**：它的 K 線資料是付費功能，所以幫不上行情。

### 5. FRED（總經）／ 6. EIA（原油庫存）—— 通常不需要

兩者現在都走免金鑰路徑（FRED 用 `fredgraph.csv`、原油庫存用 FRED 的 `WCESTUS1`），
資料完全相同。真的要申請：

- FRED：https://fredaccount.stlouisfed.org/apikey → 註冊 → Request API Key → 立即取得
- EIA：https://www.eia.gov/opendata/register.php → 填 Email → 金鑰寄到信箱

### 不需要申請的

行情（yfinance 代理、Stooq）、新聞（GDELT）、籌碼（CFTC）、資金流（SPDR GLD）
全部免金鑰，什麼都不用做。

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
   若兩者都被擋，`/api/diagnostics` 的 `verdict` 會直說沒有可用的行情來源。
2. **Serverless 逾時。** 預設只有 10 秒，這條 pipeline 一定超過。兩個 API route
   都已宣告 `maxDuration = 60`（Hobby 方案上限；更高需要 Pro）。

即使所有來源都失敗，`/api/signal/[symbol]` 也會回 **HTTP 200 + `grade: "no-trade"`**
的訊號（價格欄位為 0 並標明無資料，不是猜的價格），畫面一定看得到東西而不是空白。

### 排程沒跑？

排程在 GitHub Actions，不在 Vercel。到 repo 的 **Actions → Refresh signals** 看執行紀錄。
最常見的是 `APP_URL` 或 `CRON_SECRET` secret 沒設 —— 前者會讓步驟直接失敗並印出訊息，
後者會讓每個商品收到 401。

## APIs used

| API | Auth | Used for | Notes |
|---|---|---|---|
| Yahoo Finance chart endpoint (`query1.finance.yahoo.com/v8/finance/chart/...`), proxied by `/api/proxy/ohlcv` | none | OHLCV, primary | What `yfinance` wraps. No native 4h interval — H4 candles are resampled from real fetched 1h candles, not fabricated. Undocumented endpoint, no SLA; commonly rate-limits datacenter IPs. 30-min cache, self-imposed 60/min + 2000/day budget. |
| [Finnhub](https://finnhub.io) `/stock/candle` | `FINNHUB_API_KEY` | OHLCV, fallback | Skipped for all 9 built-ins: forex/commodity/index candles are a paid feature, so `finnhubSymbol` is `null` for them. Usable for user-added US equities. |
| [Stooq](https://stooq.com) `q/d/l/` CSV | none | OHLCV, last-resort fallback (daily/weekly only) | Used when the proxy is blocked. Tickers in `CommodityMeta.stooqSymbol` are unverified live; a wrong one yields no rows and falls through. |
| [FRED](https://fred.stlouisfed.org) `graph/fredgraph.csv` | **none** | DXY (`DTWEXBGS`), DGS10, DGS2, T10YIE, VIX (`VIXCLS`), crude stocks (`WCESTUS1`) | Keyless CSV download serving the same observations as the API. `FRED_API_KEY` switches to the JSON API but changes no data. Endpoint shape not live-verified from the build sandbox. |
| [Finnhub](https://finnhub.io) `/calendar/economic`, `/news`, `/calendar/earnings` | `FINNHUB_API_KEY` | Economic calendar, market news, earnings season (Stage 2) | No commodity-specific "company-news" for gold/indices, so `/news?category=general` is filtered by keyword instead. |
| [GDELT 2.0 DOC API](https://api.gdeltproject.org/api/v2/doc/doc) | none | News, last 48h | Free, no key. |
| [CFTC Socrata](https://publicreporting.cftc.gov) `resource/6dca-aqww.json` | none | Weekly COT (legacy futures-only report) | Contract codes per symbol in `config/fundamentals.ts`; only Gold (`088691`) was validated in Stage 1, the other 7 codes are best-recollection and **unverified live** (see caveat below) — `null` for GER40 (Eurex, no CFTC data). |
| [EIA Open Data](https://www.eia.gov/opendata/) `v2/petroleum/stoc/wstk/data` | `EIA_API_KEY` (optional) | WTI weekly crude inventory | Falls back to FRED's `WCESTUS1`, which mirrors the same EIA series without a key, so this key is never required. |
| SPDR Gold Shares (`spdrgoldshares.com/assets/dynamic/GLD/GLD_US_ProductDetails.xml`) | none | GLD bullion holdings | **Unverified in this build** — outbound network in this sandbox is restricted to an allowlist (npm/PyPI/Anthropic/GitHub) so this endpoint's exact XML schema could not be live-tested here; the parser fails safe to `data_gaps` on any mismatch. |
| [Gemini](https://aistudio.google.com) `generateContent` | `GEMINI_API_KEY` | News sentiment, AI綜合 narrative, trade-plan selection | Primary AI provider, free 1500/day. `thinkingBudget: 0` — 2.5 Flash otherwise spends the output budget on reasoning tokens and can return empty text. |
| [Groq](https://console.groq.com) `/chat/completions` | `GROQ_API_KEY` | Same three, as fallback | Free 30 req/min. OpenAI-compatible shape, shared implementation with OpenRouter. |
| [OpenRouter](https://openrouter.ai) `/chat/completions` | `OPENROUTER_API_KEY` | Same three, third fallback | `:free` models. Model ids get retired periodically — override with `OPENROUTER_MODEL`. |
| Anthropic Messages API | `ANTHROPIC_API_KEY` | Same three, opt-in paid | Last in the chain, never reached when a free provider works. Called via plain `fetch`; the SDK dependency was removed. |
| Neon / any Postgres | `DATABASE_URL` | Signal history persistence | HTTP driver, not a TCP pool — serverless functions are too short-lived for pooling and free tiers cap connections. |
| Supabase | `NEXT_PUBLIC_SUPABASE_URL` + anon/service-role keys | Signal history persistence (when `DATABASE_URL` is unset) | Anon key is read-only via RLS, service-role key (server-only) writes from `/api/refresh`. |

### Example responses

This sandbox's network policy blocks every host above, so live verification
isn't possible here. The response shapes each provider is parsed against are
documented inline in `lib/ai/providers/*.ts` and `lib/data-sources/*.ts`.

Instead of live calls, every non-trivial module has known-answer tests:
quota exhaustion and exponential backoff, the four-tier `fetchFree` fallback
including the stale path, H4 resampling arithmetic, schema parsing (including
JSON buried in a markdown fence), the provider fallback chain with a stubbed
`fetch` (order, skipping unconfigured providers, 429 fall-through), and the
trade-plan index constraint — including that a model returning a raw price,
an out-of-range index, or a string index all fall back to the deterministic
plan rather than reaching the output.

## 測試

```bash
npm test
```

沙箱連不到任何一個金融 API，所以驗證靠的是 known-answer 測試 + stub 過的
`fetch`，不是真的打上去。12 個套件、189 項斷言，每個套件跑在自己的行程裡
（好幾個會替換 `global.fetch` 並重設模組層快取，共用行程會讓前一個的 stub
汙染後一個）。

| 套件 | 守的是什麼 |
|---|---|
| `providers` | 供應商鏈順序、跳過沒金鑰的、429 換下一家、**以及 AI 永遠給不出程式沒算過的價位** |
| `journal` | severity 公式、干涉觸發門檻、窮舉 160 種組合證明等級不可能被調高 |
| `free-stack` | 額度耗盡、指數退避、`fetchFree` 四層 fallback 含 stale 路徑、H4 聚合算術 |
| `ohlcv` | 來源鏈；**能用的備援不准報缺口，但 stale 一定要報** |
| `keys` | 允許清單擋掉 service-role / cron secret；併發請求不互相看見 |
| `data-gaps` | 「本次失敗」與「先天限制」分類；沒見過的訊息不准被消音 |
| `bt` `lv` `oi` `lex` `fred` `plan` | 回測幾何、結構聚類、未平倉四象限、關鍵字情緒、CSV 解析、計畫組裝 |

測試用的斷言器會設定 non-zero exit code。原本有幾個舊檔案用 `console.assert`
—— 那個印完就繼續跑，套件會在實際失敗的情況下回報成功，已經全部換掉。

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
