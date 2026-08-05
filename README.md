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
npm test                     # 19 個測試套件，438 項斷言
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
| 基本面 | `lib/analysis/fundamental.ts` + `rate-spread.ts` + `gold-flows.ts` | Config-driven per symbol: **兩國利差**、**央行購金／黃金流向**（皆見下）, 實質利率(DGS10−T10YIE，僅XAUUSD), DXY 趨勢, VIX, EIA 原油庫存(僅WTI), Finnhub 財報日曆(僅美股指數) |
| 籌碼面 | `lib/analysis/positioning.ts` | CFTC COT (Socrata, legacy futures-only report) 非商業淨部位、52週極值、週變化，依 config 合約代碼與方向反轉設定 |
| 新聞面 | `lib/analysis/news.ts` | GDELT 2.0 DOC API + Finnhub `/news` → AI 評 -1~+1 情緒分並摘要（走 `lib/ai` 的供應商鏈），關鍵字依 config 逐商品設定 |
| 資金流 | `lib/analysis/fundflow.ts` + `lib/analysis/open-interest.ts` | GLD 成交量資金流代理(僅XAUUSD，見下)、SPDR GLD 持倉快照、DXY 方向、VIX、**未平倉量分析**（價量未平倉四象限、52週水位、異常變化偵測） |
| AI綜合 | `lib/analysis/ai-narrative.ts` | 上述五面向的結構化 JSON → AI 產生 `narrative`（prompt 明確禁止補充未提供的事實） |

## 央行購金／黃金流向 — `lib/analysis/gold-flows.ts`

原本這裡寫著「央行購金數據不在免費 API 清單內」，被歸類成先天限制。
**現在不是了** —— DBnomics 一個免金鑰 API 就打通了。

### 統一層：DBnomics

`https://api.db.nomics.world/v22/` 免認證、免金鑰，一個 API 前面接了 90+ 個
統計機構（IMF、BIS、ECB、OECD、世界銀行、各國央行與統計局）。

**先做這一層，可以省掉大半工作**：DBnomics 已經把每個機構正規化成同一種 JSON，
所以 IMF IFS 的貨幣性黃金持有量跟某國央行的儲備序列拿回來長得一模一樣 ——
不必為每個機構各寫一個 SDMX parser。

只有 DBnomics **沒有涵蓋**的才值得自寫 scraper（瑞士海關、SGE、香港統計處、
HMRC、LBMA）。這些目前列在 `SCRAPER_ONLY_SOURCES` 裡，是刻意留白不是漏掉。

### 每個來源帶多個候選代碼

`series` 是一組候選，依序試，**第一個「查得到而且是即時的」勝出**。

這不是為了保險而保險。第一版每個來源只寫一個 `IMF/IFS/...`，全部都查得到、
全部都回傳資料 —— 但那個資料集停在 2025-06，落後 400 天，於是五個因子每次
掃描都被新鮮度閘門擋掉。**「查得到」不等於「是對的」**：一個停更的資料集，
從程式的角度看跟一個健康的來源完全一樣。所以候選要試到有一個真的新鮮為止，
而 IRFCL（各國每月申報儲備用的範本）排在 IFS 前面，因為同一批數字它早幾週出。

全部候選都失敗仍然是安全的：該因子跳過並寫進 `data_gaps`，
不會拿舊值或假值頂替。

> **序列代碼未經驗證。** 沙箱連不到 api.db.nomics.world，`config/gold-fundamentals.ts`
> 裡的 id 是照各機構文件的命名規則寫的。
> 開 `/api/proxy/dbnomics` 一次看完全部候選：`resolved=false` 是代碼錯，
> `fresh=false` 是資料集停更（會附 `latestPeriod`、`ageDays`、`limitDays`），
> `usingSeries` 是這個來源實際會用哪一個。
> 用 `?search=關鍵字` 找替代代碼再回填 config。

### 權重依頻率分層

月頻的央行儲備數字和日頻的 GLD 持倉不是同一種證據：前者告訴你某國央行五週前
做了什麼，後者告訴你錢昨天做了什麼。給它們一樣的權重，等於讓過期的月報
蓋過今天的資金流。

| 頻率 | 來源 | 權重上限 |
|---|---|---|
| 日頻 | GLD 持倉、CFTC COT、未平倉量 | **2** |
| 週頻 | 週度公布的央行儲備 | **2** |
| 月頻 | 中國 PBoC、印度 RBI、土耳其 TCMB、俄羅斯 CBR、瑞士海關、SGE、LBMA | **1** |
| 季／年頻 | WGC 彙總 | **0**（只做圖表背景，永不計分） |

**頻率以資料實際的節奏為準，不以 config 宣告的為準。**
印度 RBI 原本宣告成週頻，但 DBnomics 給的是月度觀測 —— 於是它被一把 21 天的
週頻尺量，明明準時公布卻每次掃描都被判過期。現在頻率由序列自己的期間推斷
（`inferFrequency`）：**新鮮度上限用實際頻率**，**權重上限取兩者中較粗的那個**，
所以月頻資料不會因為 config 寫了週頻就拿到週頻的權重。

### 兩條硬性規則

**每個來源都記 `as_of` 與 `release_lag_days`，過期即停用。**
判斷新鮮度是從**期間結束日**算起，不是從標籤 —— 標成 `2026-07` 的月度觀測在
8 月 1 日不是「31 天舊」，而是「剛過期一天」。上限是「一個週期 + 公布落後天數
+ 7 天寬限」。IMF 彙總本來就慢 45 天，不會因為它慢就被懲罰；但一個停更四個月的
序列會被丟掉並寫進 `data_gaps`，而不是拿它最後一個值當現值計分。

**嚴禁把不同頻率的資料混在同一個 BiasItem 裡加總。**
做法是根本不去產生合併數字：每個來源產出**自己的** BiasItem，各自帶頻率標籤與
權重上限。混頻在型別上就是不可表達的，不是靠寫程式的時候小心。

## 交易總覽 — `/board`

一頁看完九個商品哪幾個有交易。點開一列只有**進場／止損／止盈／加倉**，沒有別的。

### 為什麼要另開一頁

原本每切換一個商品就重跑一次完整管線（K 線、COT、殖利率、新聞、AI），
一次 10–30 秒，九個商品就是輪流等九次。而且大部分時候你想知道的只是
「今天有沒有事要做」，不是六個面向的推導。

所以這頁**不做分析**，只讀 4 小時排程已經寫進資料庫的結果 —— 一次查詢、
九列全部到齊。`latestPerSymbol()` 在 Postgres 是一句 `distinct on (symbol)`，
不是九次 `limit 1`（那是九個網路來回）。

回傳的欄位刻意很窄：方向、等級、三個價位、有沒有加倉。
一筆 signal row 還帶著 bias items、結構、路徑障礙、敘述、缺口清單 ——
把那些全丟給一個只顯示清單的頁面，會讓「即開即有」比它取代的東西還慢。

### 進場與否由計分規則決定，不是 AI

`trade_plan.stance` 原本由 AI 回傳。這代表**同樣的分數可以給出相反的決定**：
截圖裡 SPX500 在總覽有完整進場價位、在詳細頁同一分鐘寫著「觀望」，
兩份都是真的，都不可複現。

修法不是叫模型變成確定性的（做不到），是把決定權拿回來。
`decideStance()` 是純函式，依序檢查：

1. 評等 `no-trade` → 觀望
2. 評等低於 `MIN_ENTRY_GRADE`（**B**）→ 觀望
3. 沒有可用的進場／停損／停利結構 → 觀望
4. 清單裡**任何組合**都達不到 1:1 風報比 → 觀望

判定觀望時**完全不呼叫 AI** —— 它已經沒有東西可決定，一次站在場外的掃描
不該花額度去被告知這件事。

AI 剩下的工作是「從固定選單裡挑哪一個結構、以及把理由寫出來」。
挑不同的點會改變價位，不會改變你在不在場內。`stance` 欄位已從 schema 移除：
模型看不到可以回答「要不要交易」的欄位。

**為什麼門檻是 B。** C 級（總分 3–5）原本可以產生完整進場點，但系統其他地方
都不當它一回事：警報預設 A 以上才發、加倉只給 A/A+。
呈現一個系統自己不願意行動的建議，比不呈現更糟。

順帶修掉一個真的 bug：**AI 路徑沒有風報比下限**。fallback 會拒絕 rr<1，
AI 路徑不會，所以模型可以交出一筆「賠率不划算但照做」的交易。現在兩條路
用同一個 `MIN_RISK_REWARD` 常數。

### 一筆訊號，兩個畫面 —— 不是各算各的

原本總覽和詳細分析頁**各自建立自己的那份**。同一個商品前後兩次建立會給出不同
答案：總覽顯示完整的進場價位，詳細頁同一分鐘寫著「觀望」。

不是壞掉，也不是舊資料。原因是 `trade_plan.stance` 由 AI 決定
（`lib/analysis/trade-plan.ts`），而同一個問題問 AI 兩次，它沒有義務給同樣的答案。

修法不是叫模型變成確定性的（做不到），而是**不要把同一筆訊號算兩次**：

- `/api/scan?symbol=X` 建立**並寫入**，是瀏覽器發起掃描的唯一入口
- 總覽掃描完會重讀資料庫，顯示的一定是寫進去的那筆
- 詳細分析頁**先讀資料庫**（即開即有），要重算得按「重新分析」，而那也走
  `/api/scan`，所以算完兩邊還是同一筆

一致性變成結構性的，不是靠巧合。

### 兩張表，因為問的是兩個問題

| 表 | 寫入者 | 頻率 | 誰讀 |
|---|---|---|---|
| `signals` | 只有 4 小時排程 | 九筆／4 小時，約 54 筆/日 | `/history`、回測 |
| `latest_signal` | 排程**與**瀏覽器掃描，upsert | 每商品恆一列 | 總覽、詳細分析頁 |

分開是因為寫入率差了兩個數量級。儀表板開著時每 5 分鐘重掃九個商品；
如果那也走 append，一天會寫進約 2,600 筆完整訊號（每筆都帶著全部
bias items、結構與敘述），三週左右就能塞爆免費方案的資料庫，
還會把真正的歷史埋在底下。

`/api/scan` 不發 Telegram：發通知是**排程**掃描的職責，一個按了就推播到自己
手機的按鈕，只會訓練你忽略那個本來要打斷你的頻道。

### 自動掃描：兩個時鐘

| 動作 | 間隔 | 成本 |
|---|---|---|
| 重讀資料庫 | 60 秒 | 一次查詢 |
| 重跑分析 | 5 分鐘，且只跑**超過 5 分鐘沒更新**的商品 | 九條完整管線，吃免費 AI 額度 |

分頁切到背景兩個都暫停 —— 一個開在背景整晚的儀表板會把一天的額度燒光在
沒人看的畫面上。可以用畫面上的勾選框關掉。

### 「尚未掃描」與「觀望」是兩個答案

列表由 `COMMODITIES` 驅動而不是由查詢結果驅動，所以一個從沒被掃過的商品會
顯示成空列，而不是直接消失。沒資料和沒交易不是同一件事。

## 即時數據公布 — `lib/analysis/data-release.ts`

財經日曆本來就有在抓，`actual` / `estimate` / `previous` 三個欄位也本來就跟著
回來 —— 然後三個全部被丟掉。只有時間戳被拿去回答「未來 24 小時內有沒有高影響
數據」（S4 扣分用）。也就是說系統知道數據**要來**，卻對數據**來了之後**沒有
任何反應，而那正是真正推動價格的那一半。

### 兩件事要分開

| | 做什麼 | 為什麼不能合併 |
|---|---|---|
| `ingestReleases` | 偵測「有沒有出現沒看過的新數據」 | FRED 給的是觀測值，**沒有公布時間**。標成 `2026-07-01` 的 CPI 可能任何一天才出現，標籤完全不代表市場何時知道 |
| `analyzeDataReleases` | 把還在影響窗內的數據變成因子 | 讀資料表的 `first_seen_at`，**不重算**新鮮度 |

「第一次被掃到的時間」是唯一誠實的答案，寫進 `data_release` 一次就不再改。
沒有資料庫時兩件事都做不了，這時候寫進 `data_gaps` 而不是猜 ——
若用「最新那筆大概是新的」來判斷，一筆 CPI 會連續一個月每次掃描都當成剛公布。

**寫入是原子的。** 4 小時掃描與 5 分鐘監控都會呼叫 `ingestReleases`，
用 `on conflict do nothing ... returning` 讓「這筆是新的」只會回給真正插入那次，
所以同一筆 CPI 不會被兩個排程各通知一遍。

### 方向用「通道」，不用對照表

9 個商品 × 十幾個數據 = 一百多個要手寫的方向，錯一個沒人會發現。
但這些數據幾乎都走同一條路：改變市場對美國利率的預期 → 推動美元 →
推動所有以美元計價的東西。

所以每個數據只宣告一件事：**高於基準的數字會讓美元偏強還是偏弱**。
再由各商品既有的 `dxyInverted`（DXY 趨勢因子已經在用、已經有測試）換算成方向。
兩段程式碼各自決定「美元走強對這個商品是什麼意思」，遲早會不一致。

| 數據 | 高於基準 → 美元 | 影響窗 | 權重 |
|---|---|---|---|
| 美國 CPI | 偏強 | 48h | 2 |
| 核心 PCE | 偏強 | 48h | 2 |
| 非農就業 | 偏強 | 48h | 2 |
| 聯準會政策利率 | 偏強 | 72h | 2 |
| 失業率 | **偏弱** | 48h | 1 |
| 初領失業金 | **偏弱** | 24h | 1 |
| 零售銷售 | 偏強 | 24h | 1 |

後兩個是反向的：失業惡化＝經濟轉弱＝降息預期上升＝美元偏空。
方向兩可的數據（營建許可、貿易帳）**不列入**，寧可少一個因子也不要擲硬幣。

### 沒有市場預期時，不准假裝有

免費、免金鑰的來源裡沒有市場共識值。FRED 給得出實際值、給不出預期。所以：

- 有 Finnhub 金鑰且日曆回傳了 `estimate` → 跟**市場預期**比，這才是真正的意外
- 否則 → 跟**前值**比，而且 evidence 裡明寫
  「無市場預期可比，此為與前值比較，**不代表優於／劣於預期**」

「通膨上升」跟「通膨超預期」是兩件完全不同的事，`basis` 欄位把這個區別一路帶到
畫面上，不讓數字暗示一個從來沒被測量過的意外。（順帶修掉日曆的查詢區間 ——
原本從「今天」開始，所以回傳的永遠是還沒發生的事件，`actual` 與 `estimate`
永遠是 null。現在往前抓 3 天。）

### 過期就整個丟掉，不做衰減

超出影響窗就完全不計，不是降權。一筆三天前的 CPI 就算只剩一半權重，
它在總分裡跟雜訊分不出來，卻還是會動到等級。

### 即時性

5 分鐘監控也會跑偵測，所以晚上 8:30 公布的 CPI 不用等到下一次 4 小時掃描
才被發現（最糟會慢 4 小時，行情早走完了）。偵測到就**立刻發通知**，
但通知只講數字與美元方向，**不給交易建議** —— 重新評分 9 個商品是另一件慢的事，
訊息裡寫「黃金做空」會是計分引擎根本還沒做出的推薦。因子會在下一次
建立訊號時進入計分，影響窗的長度就是照這個設計的。

## 兩國利差 — `lib/analysis/rate-spread.ts`

FRED 的核准清單只有美債，外國公債走的是 OECD `IRLTLT01` 系列：**月頻，而且部分
已停更**。月頻數字產生不了交易訊號，所以外國腳改用免金鑰的日線來源。

### 資料來源（兩層）

| 層 | 來源 | 用在哪 |
|---|---|---|
| 1 | **Stooq 日線 CSV** `https://stooq.com/q/d/l/?s={code}&i=d` | 外國公債殖利率主來源，免金鑰 |
| 2 | **ECB Data Portal**（`format=csvdata`） | 歐元區 AAA 殖利率曲線，Stooq 掛掉時的備援 |
| — | **FRED** | 美債腳（`DGS2` / `DGS10`），本專案唯一驗證過的來源 |

Stooq 代號：`10yusy.b` 美國、`10ydey.b` 德國、`10yjpy.b` 日本、`10yuky.b` 英國。
2Y 代號依同樣命名規則推得（`2ydey.b` 等），**沙箱無法連外驗證** —— 代號錯只會
拿到空回應並往下一層掉，不會產生錯的數字。其餘代號查 https://stooq.com/t/?i=536

自架代理在 `/api/proxy/yield?symbol=EURUSD`，快取 TTL 6 小時。

### 看短端，不是長端

匯率主要由 **2Y** 利差驅動 —— 那是市場對政策路徑的定價。10Y 反映的是成長與期限
溢酬預期，對匯率的傳導間接得多。

| 商品 | 利差 | 為什麼 |
|---|---|---|
| EURUSD | 2Y 德美（DE2Y − US2Y） | 德債相對走高 → 偏好歐元 |
| GBPUSD | 2Y 英美 | 同上 |
| USDJPY | **10Y** 美日 | 例外：BOJ 直接控制 JGB 長端，政策分歧顯示在 10Y |
| XAUUSD | 不用利差 | 已有更貼切的美國實質利率（DGS10 − T10YIE） |
| 美股指數 / WTI | 不套用 | 本來就不是利差驅動的商品 |

`config/rate-spreads.ts` 的兩隻腳**刻意排列成「利差上升永遠等於做多」**。
USDJPY 是最容易寫反的那個，所以它把美債放在減數位置而不是直覺的日債。

### 訊號是 20 日變化，不是水位

一個已經寬了一年的利差早就反映在價格裡；一個月內走了 30bp 的利差才是讓匯率
重新定價的那件事。

- 權重：20 日變化 **>25bp → 2**、**10–25bp → 1**、**<10bp → 0**
- 方向：利差朝有利於該貨幣的方向移動則同向（權重 0 時記 neutral，不硬給方向）
- evidence 一定寫出當前數值與 20 日變化，例
  `-1.30%（德國 2Y 2.70% − 美國 2Y 4.00%），20日擴大 30bp，as_of 2026-08-04`

### 兩條硬性規則

**不准內插或用前值填補。** 兩隻腳的交易日曆不同（各國假期不一樣）。如果各自取
「最新一筆」，就會拿週五的德債配週四的美債，然後叫它今天的利差。所以利差**只在
兩隻腳都真的有印出數值的日期上計算** —— 缺一邊的日子直接不產生資料點。

**落後超過 3 個交易日就不計分。** EOD 資料落後 1–2 個交易日是正常的，超過就寫進
`data_gaps` 並且不產生因子，而不是當成當前值呈現。

## 新聞重點 — 看得到 AI 讀了什麼

原本新聞面只算出一個 -1~+1 的情緒分就丟進計分，**AI 讀到的標題和推論完全沒有
顯示出來** —— 一個數字在動評等，而沒有人能檢查它。

現在 `analyzeNews` 除了分數，還要 AI 歸納 2-4 個重點，每個標明偏多／偏空／中性，
並且**用編號指出它是根據哪幾則標題**。訊號卡上的「新聞重點」區塊會顯示：

- 整體摘要與情緒分
- 每個重點 + 方向標籤 + 可點的來源連結
- 展開後是模型看到的全部原始標題（附時間與媒體）
- 分析者是誰（哪家供應商，或「本地關鍵字表（非 AI）」）

### 引用不可能造假

跟交易計畫用編號選價位是同一招：**模型只能引用我們給它的標題編號**。
schema 在解析時就對照標題數量做範圍檢查，越界或負數的引用直接丟掉。
所以一個重點永遠不可能被歸因到一篇不存在的報導。

這也表示模型沒有辦法「補充」標題以外的事實 —— prompt 明講不准，
而引用機制讓任何超出範圍的宣稱都無處掛載。

沒設 AI 金鑰時一樣會產生 digest：標題照列，但 `key_points` 是空的，
`analyzed_by` 標成「本地關鍵字表（非 AI）」。關鍵字統計只能數次數，
生不出重點 —— 與其包裝成看起來像分析的句子，不如誠實留白。

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
- **先天限制** — GER40 在 Eurex 交易所以 CFTC 沒資料、外國短端公債沒有免金鑰來源。
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

## 加倉與部位監控

### 加倉的四條規則，全部是拒絕條件

**1. 方向要有信心 —— 只有 A / A+ 提供加倉點。**
加倉是押注既有方向會繼續有效。B 或 C 的訊號，原本那筆進場本身就已經是投機的部分了，
再加一倍只會更糟。A / A+ 正好是 `lib/scoring.ts` 裡方向分通過門檻的那兩級。

**2. 加倉點本身必須有支撐（做多）／壓力（做空）。**
一個價位要等價格站上去之後才會變成支撐，所以加倉是**回測**：價格突破該位、
往前走、再回來，而該位撐住。

這裡有個容易踩的坑：`EntryStructure.role` 是**相對當前價格**指派的 ——
做多時進場價上方的東西一律被標成 resistance，沒有任何一個會是 support。
所以判斷「有沒有支撐」不能看 role 欄位，要看該價位**自身的強度**。

**3. 結構強度必須 ≥2。**
強度 2 代表至少被觸及兩次、或位於日線／週線、或跨時框共振（見 `lib/analysis/levels.ts`）。
強度 1 是只被碰過一次的 swing —— 那不是支撐，那是有人畫過一次的線。
路徑上全是強度 1 時，**不提供加倉點**並說明原因。

**4. 不能用幾 R 來分配。**
「在 +1R 加碼 0.5R」是把算術包裝成分析：那個價格市場從來沒有交易過，
也沒有理由尊重它。每一段都落在分析已經找到的結構上。

最多三段（規格上限），彼此至少相隔 0.5×ATR —— 差 0.1% 的兩段其實是同一段，
而且會在同一根 K 棒一起成交。

### 每一段都帶調整後的停損

**加倉時一定要調整停損。** 加大部位卻讓停損留在原地，等於在一筆已經開始獲利的
交易上加大風險 —— 那正是加倉唯一不能做的事。

每段的新停損同樣錨定真實結構（該段後方最近的保護結構，外加 0.5×ATR buffer）。
三條硬性檢查，全部有測試釘住：

- 新停損必須**優於**原停損，否則這段加倉直接不提供（不會為了湊三段而放寬風險）
- 新停損不能高於加倉點本身，否則一成交就被掃掉
- 找不到可錨定的結構 → **不提供這一段**，而不是編一個數字

### 5 分鐘監控 — `/api/monitor`

`.github/workflows/monitor.yml` 每 5 分鐘打一次。它**不重跑分析** ——
九條完整管線的輸入（H4/D1/W1 K 棒、每週 COT、日線殖利率）五分鐘內不會變。
它只問「最新價格對已經在檯面上的計畫做了什麼」：

| 狀態 | 觸發 |
|---|---|
| `waiting` → `entered` | 價格觸及進場價 |
| `entered` → `added` | 到達第 N 段加倉點 → 同時通知停損上移 |
| → `stop_hit` | 觸及**當前**停損（含加倉後上移的） |
| → `target_hit` | 觸及停利 |

狀態存在 `plan_monitor` 表，**同一個狀態不會重複通知** —— 否則一個開著一整天的
部位會產生 288 則推播。已結束的交易不再回報。

三個刻意的取捨：

1. **同一根 K 棒同時觸及停損與停利時，一律報停損。** 5 分鐘延遲資料看不出
   K 棒內的先後順序，悲觀的讀法是唯一誠實的。
2. **價格是延遲的**（免費層約 15 分鐘）。每一則通知都寫出延遲幾分鐘，
   並註明只適用 H4/D1 級別的部位管理 —— 它不是、也不可能是日內執行工具。
3. **GitHub Actions 的 5 分鐘只是下限。** 排程在高負載時會被延遲，實際約
   5–15 分鐘。這對於價位相隔數小時的 H4/D1 計畫可以接受。

## 自動發送交易建議

### 關掉網頁還會繼續分析嗎？

**會 —— 但要先把排程接起來。** 分析全部在伺服器端跑，瀏覽器只是看結果的視窗。

| 情況 | 關掉網頁後 |
|---|---|
| 沒設 GitHub Actions secrets | **完全不會跑**。網站只在你打開頁面時現算 |
| 設好了 | 每 4 小時自動跑完 9 個商品，寫進資料庫，達標就推播 |

**不需要設定任何東西就會跑。** `APP_URL` 是公開網址不是憑證，
把它做成必填的 secret 只換來一件事：workflow 在發出任何請求之前就 `exit 1`，
於是排程加上去之後每一次都失敗、而且失敗得很安靜。現在它在 workflow 裡有預設值，
repository secret 或 variable 仍然可以覆寫。

`CRON_SECRET` 是選填的鎖：沒設就是開放的（排程照跑，但別人也能觸發你的
`/api/refresh` 和改 `/setup` 的設定），要設的話同一組字串要填兩個地方 ——
GitHub repository secret 與 Vercel 環境變數。細節見「[排程與儲存](#排程與儲存)」。

### 設定通知（Telegram，免費）

**全部在網站上做完，不用碰 Vercel、不用重新部署。** 開 `/setup`：

0. 按「建立資料表」—— 設定要存資料庫，表不存在的話儲存會失敗（會顯示缺哪幾張）
1. Telegram 搜尋 **@BotFather** → 傳 `/newbot` → 拿到 token → 貼進第 1 步存檔
2. 對你的新 bot 傳一句話（Telegram 規定：使用者沒先開口，bot 不能主動傳訊）
3. 按「查出我的 Chat ID」→ 自動填好 → 存檔
4. 按「發送測試訊息」確認

### 為什麼是資料庫，不是 localStorage 也不是環境變數

AI 金鑰可以放瀏覽器，因為它們只在請求進行中需要，跟著 header 走一趟就結束。
通知設定是相反的情況：**警報是凌晨四點由 GitHub Actions 發的，附近沒有任何瀏覽器**，
localStorage 裡的東西在真正需要它的那一刻讀不到。

環境變數可以，但每改一次就要重新部署，而且得再開一個後台。所以存進 `app_settings`：
網頁寫、排程讀，token 存進去之後**不會再送回瀏覽器**，這頁只看得到「有沒有設定」。

- **同名環境變數優先。** 部署層級的決定不該被網頁表單無聲蓋掉。
- **`app_settings` 沒有 public read policy。** 其他表都有；這張表放 token，
  所以 RLS 擋掉匿名讀取，只有 service-role 或直連 `DATABASE_URL` 看得到值。
- **允許清單就是安全邊界**（`lib/settings.ts`），和 API 金鑰同一套規矩。
  `DATABASE_URL`、`CRON_SECRET`、`SUPABASE_SERVICE_ROLE_KEY` 刻意不在裡面 ——
  一個「客戶端說什麼就寫什麼」的端點就是一個會寫入 `DATABASE_URL` 的端點。

### AI 金鑰也可以存在這裡，而且非存不可

`/settings` 的金鑰只存在瀏覽器，**排程讀不到**。後果不是「排程壞掉」，
而是更難發現的那種：四小時掃描一路用本地規則產生訊號，跟你手動打開同一個商品
看到的不是同一份分析，而且沒有任何地方會說這件事。

所以 `/setup` 第 5 步可以把 AI 金鑰存進 `app_settings`，排程才有供應商可用。
**瀏覽器送來的 header 仍然優先** —— 存在伺服器的那份只在沒有 header 時
（也就是排程）才會用到，帶著自己金鑰的瀏覽器不會被部署端的設定蓋掉。
- 寫入沿用 `/api/setup` 的同一道門：設了 `CRON_SECRET` 就需要它，沒設就是開放的
  —— 這件事寫在 `/setup` 頁面上，不留給人自己發現。
- **讀取失敗與「沒設定」必須分得開。** `getSetting` 一定要吞掉錯誤（凌晨的排程
  不能因為少一張表就整個掛掉），但**無聲**吞掉的後果是：儲存時老實報出
  「app_settings 不存在」，讀取時卻回報「沒有任何管道」，兩邊講不同的故事。
  所以錯誤原因會被留下來交給 `settingsStatus`，設定頁看得到真正的原因。

`/setup` 同時會產生一組 `CRON_SECRET`，排程的設定也在同一頁交代完。

### 「5 分鐘監控」實際上不是 5 分鐘

實測這個 repo 前 14 小時：monitor 只跑了 8 次，間隔 1～2.7 小時。
GitHub 對高頻排程降級降得很兇，低流量的 repo 尤其嚴重。
（4 小時的 refresh 倒是準時 —— 21:12、02:33、06:28、10:35。）

cron 保持 `*/5`，因為要多給少不花成本、限流也可能鬆綁。但真的需要 5 分鐘
監控的話，用外部 pinger（cron-job.org、UptimeRobot 都有免費方案）打
`/api/monitor`。那個端點是冪等的，兩邊同時打沒有副作用。

Discord 更簡單：伺服器設定 → 整合 → 建立 Webhook，把網址填進 `DISCORD_WEBHOOK_URL`。

### 什麼時候會收到通知

只有同時滿足才發：**建議進場**（不是觀望）、**評等 ≥ `ALERT_MIN_GRADE`**（預設 A）、
且三個價位齊全。

### 不會被洗版

排程每 4 小時跑一次。一個維持整天有效的黃金訊號會產生 6 次一模一樣的推播，
第七次之後你就不看了，連帶錯過真的重要的那次。所以規則是**看變化，不看狀態**：

| 情況 | 發送？ |
|---|---|
| 首次出現可執行訊號 | ✅ |
| 由觀望轉為進場 | ✅ |
| 方向翻轉（多↔空） | ✅ |
| 評等提升（A → A+） | ✅ |
| 停損／停利價位實質變動 | ✅ |
| 跟上次完全一樣 | ❌ |
| 價位只飄動 <0.2% | ❌（市場本來就會動，不是新資訊） |
| 評等下降但仍在門檻上 | ❌（同一筆交易已經在檯面上了） |

判斷邏輯是 `lib/notify/alert.ts` 的純函式，不碰資料庫也不碰網路，所以門檻
與去重規則都能直接測 —— `tests/alert.test.ts` 有 31 項。

### 通知內容

商品、方向、評等、三個價位、風報比、計畫摘要，加上**與交易方向一致**的那條
新聞重點（反向的那條不佔版面，你要看細節就點連結回網站）。
有套用干涉或有資料缺口也會標出來。

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

**最簡單：先做完步驟 3（Redeploy），然後開 `/review` 按「建立資料表」。**
網站會自己對 `DATABASE_URL` 指向的資料庫套用結構，不用開任何 SQL 編輯器 ——
在手機上尤其省事。

想手動做也可以：Neon 專案頁面左側 **SQL Editor**，把 `supabase/schema.sql`
的整個檔案內容貼進去按 Run。

不管哪一種，跑的都是同一份 SQL，會建 `signals`（歷史訊號）與
`trade_journal`（交易日誌）兩張表。可以重複執行 —— 全部都是
`create table if not exists`，不會破壞既有資料。

> `/api/setup` 的存取控制：設了 `CRON_SECRET` 就必須帶對應的 Bearer token；
> 沒設的話只在資料表還不存在時可用，建完就自動鎖起來。
> Supabase 使用者走自己的 SQL Editor（anon/service key 不是 Postgres 連線）。

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
`fetch`，不是真的打上去。21 個套件、541 項斷言，每個套件跑在自己的行程裡
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
| `gold-flows` | 權重依頻率設上限；序列停更就停用該因子；不同頻率不得併成一個因子 |
| `monitor` | 加倉四條拒絕規則（方向信心、支撐/壓力、強度 ≥2、非 R 倍數）；停損只能收緊；監控狀態機不重複通知、模糊 K 棒一律報停損 |
| `rate-spread` | 利差不得跨缺漏日內插；20 日變化決定方向與權重；資料落後 >3 交易日就拒絕計分 |
| `alert` | 通知門檻與去重：一樣的建議不重發、價位飄動不算變化、方向翻轉一定發；設定允許清單擋掉 DATABASE_URL / CRON_SECRET，token 不得被回讀 |
| `news` | 新聞重點的引用只能指向真的存在的標題；越界／負數引用會被丟掉 |
| `gdelt` | 零結果與真失敗要分得開；查詢失敗會退回單一詞再試 |
| `data-releases` | 影響窗過期就整個丟掉；與前值比較不得被寫成超預期；方向必須與 DXY 因子對美元的解讀一致 |
| `http diagnostics` | 逾時／HTTP 狀態碼／回應不是 JSON 要能分辨並寫進 `data_gaps`；GDELT 標題裡的控制字元不得害整包回應被丟掉 |
| `db` | 首次設定錯誤翻譯、schema 常數與 .sql 檔不得漂移、DATABASE_URL 不可由瀏覽器設定 |
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
- 央行購金 (central bank gold purchases) now comes from DBnomics, but the
  series codes are unverified and the first set turned out to point at a dataset
  that had stopped updating in 2025-06. Each source carries several candidates
  and the freshness gate rejects a dormant one, so this fails safe — but until
  `/api/proxy/dbnomics` reports `brokenCount: 0`, treat the factor as absent.
- GLD holdings is still a single snapshot; "持倉變化" can't be computed.
- EIA and SPDR endpoints are unverified in this sandbox (see APIs table).

## Next steps

Stage 3 (trade journal + stop-loss postmortem tagging + severity scoring +
grade-intervention rules + `/review` analytics) is queued pending your
review of this stage — not started yet.
