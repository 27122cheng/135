# 多商品交易訊號網站 — Stage 1

Next.js 14 (App Router) + TypeScript + TailwindCSS. Stage 1 wires the full
pipeline end-to-end for **XAUUSD only**; the other 8 symbols are visible in
the UI as disabled stubs (see `types/signal.ts#COMMODITIES`).

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in whichever keys you have — see below
npm run dev
```

Open http://localhost:3000. The left panel lists all 9 symbols; only XAUUSD
is clickable and calls `GET /api/signal/xauusd`, which runs the whole
fetch → analyze → score → grade → AI-narrative pipeline server-side.

**No key is required to run the app.** Every external call is wrapped in
try/catch; on failure it logs a human-readable reason to the signal's
`data_gaps[]` instead of fabricating a value. With zero keys configured you
will see a populated `data_gaps` list and, typically, `grade: "no-trade"`
(scoring rules force `no-trade` whenever no protecting structure or no
per-obstacle profit target can be found) rather than a crash or placeholder
numbers.

## Data contracts

`types/signal.ts` — `Timeframe`, `BiasItem`, `EntryStructure`, `PathObstacle`,
`TradeSignal`, `CommodityMeta` — field names/values match the spec exactly.

## Scoring — hard rules (`lib/scoring.ts`, `lib/entry-exit.ts`)

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

## Six dimensions → `bias_items`

| 面向 | 檔案 | 資料來源 |
|---|---|---|
| 技術面 | `lib/analysis/technical.ts` | Twelve Data / yfinance OHLCV → swing HH/HL/LH/LL, EMA20/50/200 排列, RSI(14) 背離, MACD histogram, 整數關卡 |
| 基本面 | `lib/analysis/fundamental.ts` | FRED: 實質利率(DGS10−T10YIE), DXY(DTWEXBGS) 趨勢, VIX |
| 籌碼面 | `lib/analysis/positioning.ts` | CFTC COT (Socrata, legacy futures-only report) 非商業淨部位、52週極值、週變化 |
| 新聞面 | `lib/analysis/news.ts` | GDELT 2.0 DOC API + Finnhub `/news` → Claude 評 -1~+1 情緒分並摘要 |
| 資金流 | `lib/analysis/fundflow.ts` | SPDR GLD 持倉快照、COT 未平倉量週變化、DXY 方向、VIX |
| AI綜合 | `lib/analysis/ai-narrative.ts` | 上述五面向的結構化 JSON → Claude 產生 `narrative`（prompt 明確禁止補充未提供的事實） |

## APIs used

| API | Auth | Used for | Notes |
|---|---|---|---|
| [Twelve Data](https://twelvedata.com) `/time_series` | `TWELVE_DATA_API_KEY` | OHLCV, primary | Free tier 800 req/day; local daily counter in `lib/data-sources/cache.ts` prevents exceeding it. |
| Yahoo Finance chart endpoint (`query1.finance.yahoo.com/v8/finance/chart/...`) | none | OHLCV, fallback (what `yfinance` wraps) | No native 4h interval — H4 candles are resampled from real fetched 1h candles, not fabricated. |
| [FRED](https://fred.stlouisfed.org/docs/api/) `/series/observations` | `FRED_API_KEY` | DXY (`DTWEXBGS`), DGS10, DGS2, T10YIE, VIX (`VIXCLS`) | Free, instant key. |
| [Finnhub](https://finnhub.io) `/calendar/economic`, `/news` | `FINNHUB_API_KEY` | Economic calendar, market news | No commodity-specific "company-news" for gold, so `/news?category=general` is filtered by keyword instead. |
| [GDELT 2.0 DOC API](https://api.gdeltproject.org/api/v2/doc/doc) | none | News, last 48h | Free, no key. |
| [CFTC Socrata](https://publicreporting.cftc.gov) `resource/6dca-aqww.json` | none | Weekly COT (legacy futures-only report), COMEX Gold contract code `088691` | Public dataset, no key required. |
| SPDR Gold Shares (`spdrgoldshares.com/assets/dynamic/GLD/GLD_US_ProductDetails.xml`) | none | GLD bullion holdings | **Unverified in this build** — outbound network in this sandbox is restricted to an allowlist (npm/PyPI/Anthropic/GitHub) so this endpoint's exact XML schema could not be live-tested here; the parser fails safe to `data_gaps` on any mismatch. Verify against a live response after deploying. |
| Anthropic Messages API | `ANTHROPIC_API_KEY` | News sentiment scoring, AI綜合 narrative | Both prompts explicitly restrict the model to reasoning over the JSON/headlines provided — no outside facts. |

### Example responses

This sandbox's network policy blocks every host above except through the
app itself (see `data_gaps` output), so responses below are the documented
shapes each fetcher is coded against — confirm against a live call once
you have keys/outbound access:

**Twelve Data** `/time_series?symbol=XAU/USD&interval=1day&outputsize=2`
```json
{
  "meta": { "symbol": "XAU/USD", "interval": "1day", "currency_base": "Gold", "currency_quote": "US Dollar" },
  "values": [
    { "datetime": "2026-08-03", "open": "2415.10", "high": "2428.30", "low": "2409.50", "close": "2421.80", "volume": "0" },
    { "datetime": "2026-08-02", "open": "2402.40", "high": "2418.00", "low": "2398.10", "close": "2415.10", "volume": "0" }
  ],
  "status": "ok"
}
```

**FRED** `/series/observations?series_id=T10YIE&...&limit=2`
```json
{
  "observations": [
    { "date": "2026-08-01", "value": "2.31" },
    { "date": "2026-07-31", "value": "2.29" }
  ]
}
```

**CFTC Socrata** `/resource/6dca-aqww.json?$where=cftc_contract_market_code='088691'&$limit=1`
```json
[
  {
    "report_date_as_yyyy_mm_dd": "2026-07-29T00:00:00.000",
    "noncomm_positions_long_all": "215430",
    "noncomm_positions_short_all": "48210",
    "open_interest_all": "512300"
  }
]
```

**GDELT 2.0** `/doc/doc?query=gold%20price&mode=artlist&format=json&timespan=48h`
```json
{
  "articles": [
    { "url": "https://example.com/gold-fed-rate-cut", "title": "Gold hits new high as Fed signals rate cut", "domain": "example.com", "seendate": "20260804T081500Z" }
  ]
}
```

**Claude news sentiment call** — response is plain text constrained to JSON by prompt:
```json
{ "score": 0.42, "summary": "近期新聞偏多：市場預期降息，避險買盤升溫，但部分報導提及獲利了結賣壓。" }
```

## Known Stage-1 limitations (all surfaced via `data_gaps`, never silently faked)

- 央行購金 (central bank gold purchases) has no free API in the approved
  source list, so it's intentionally excluded from 基本面 scoring.
- GLD holdings is a single snapshot (no persisted history yet — that's
  what the later Supabase stage is for), so "持倉變化" can't be computed;
  the raw level is shown with weight 0.
- SPDR GLD XML schema is unverified in this sandbox (see APIs table).

## Next steps (not in Stage 1)

Supabase persistence, Vercel Cron scheduling, lightweight-charts price
chart, and the other 8 symbols are intentionally left as UI stubs pending
your review of this stage.
