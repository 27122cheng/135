# 多商品交易訊號網站 — Stage 2

Next.js 14 (App Router) + TypeScript + TailwindCSS. All 9 symbols
(EURUSD/USDJPY/GBPUSD/XAUUSD/NAS100/GER40/US30/WTI/SPX500) are wired
end-to-end. A Vercel Cron job refreshes every 4h into Supabase, and
`/history` lets you browse past signals by symbol/grade/date.

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in whichever keys you have — see below
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
| 技術面 | `lib/analysis/technical.ts` | Twelve Data / yfinance OHLCV → swing HH/HL/LH/LL, EMA20/50/200 排列, RSI(14) 背離, MACD histogram, 整數關卡 |
| 基本面 | `lib/analysis/fundamental.ts` | Config-driven per symbol: 實質利率(DGS10−T10YIE，僅XAUUSD), DXY 趨勢, VIX, EIA 原油庫存(僅WTI), Finnhub 財報日曆(僅美股指數) |
| 籌碼面 | `lib/analysis/positioning.ts` | CFTC COT (Socrata, legacy futures-only report) 非商業淨部位、52週極值、週變化，依 config 合約代碼與方向反轉設定 |
| 新聞面 | `lib/analysis/news.ts` | GDELT 2.0 DOC API + Finnhub `/news` → Claude 評 -1~+1 情緒分並摘要，關鍵字依 config 逐商品設定 |
| 資金流 | `lib/analysis/fundflow.ts` | SPDR GLD 持倉快照(僅XAUUSD)、COT 未平倉量週變化、DXY 方向、VIX |
| AI綜合 | `lib/analysis/ai-narrative.ts` | 上述五面向的結構化 JSON → Claude 產生 `narrative`（prompt 明確禁止補充未提供的事實） |

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

Nine symbols × the full analysis pipeline (several sequential external
calls including an Anthropic completion) can run past Vercel's default
serverless timeout on some plans — `maxDuration = 300` is declared on the
route, which requires a plan that allows it.

## APIs used

| API | Auth | Used for | Notes |
|---|---|---|---|
| [Twelve Data](https://twelvedata.com) `/time_series` | `TWELVE_DATA_API_KEY` | OHLCV, primary | Free tier 800 req/day; local daily counter in `lib/data-sources/cache.ts` prevents exceeding it — now shared across 9 symbols so budget accordingly. |
| Yahoo Finance chart endpoint (`query1.finance.yahoo.com/v8/finance/chart/...`) | none | OHLCV, fallback (what `yfinance` wraps) | No native 4h interval — H4 candles are resampled from real fetched 1h candles, not fabricated. |
| [FRED](https://fred.stlouisfed.org/docs/api/) `/series/observations` | `FRED_API_KEY` | DXY (`DTWEXBGS`), DGS10, DGS2, T10YIE, VIX (`VIXCLS`) | Free, instant key. |
| [Finnhub](https://finnhub.io) `/calendar/economic`, `/news`, `/calendar/earnings` | `FINNHUB_API_KEY` | Economic calendar, market news, earnings season (Stage 2) | No commodity-specific "company-news" for gold/indices, so `/news?category=general` is filtered by keyword instead. |
| [GDELT 2.0 DOC API](https://api.gdeltproject.org/api/v2/doc/doc) | none | News, last 48h | Free, no key. |
| [CFTC Socrata](https://publicreporting.cftc.gov) `resource/6dca-aqww.json` | none | Weekly COT (legacy futures-only report) | Contract codes per symbol in `config/fundamentals.ts`; only Gold (`088691`) was validated in Stage 1, the other 7 codes are best-recollection and **unverified live** (see caveat below) — `null` for GER40 (Eurex, no CFTC data). |
| [EIA Open Data](https://www.eia.gov/opendata/) `v2/petroleum/stoc/wstk/data` | `EIA_API_KEY` | WTI weekly crude inventory | **New in Stage 2** — not in the original Stage 1 approved list, but explicitly required by the spec's WTI 基本面 breakdown and is a free/public API, so added here. Unverified in this sandbox (see below). |
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
