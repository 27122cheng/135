import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, report, stubFetch } from "./_harness";
import { __resetCacheForTests } from "@/lib/data-sources/cache";
import { __resetQuotaForTests } from "@/lib/data-sources/quota";
import {
  binanceSymbolFor,
  fetchBinanceOHLCV,
  fetchBinanceQuote,
  isCryptoTicker,
} from "@/lib/data-sources/binance-crypto";
import { fetchKrakenOHLCV, krakenPairFor } from "@/lib/data-sources/kraken-crypto";
import { fetchEconomicCalendar } from "@/lib/data-sources/finnhub";
import {
  MAX_CUSTOM_SYMBOLS,
  isCryptoYahooTicker,
  parseCustomSymbols,
  toCommodityMeta,
} from "@/lib/custom-symbols";
import { marketStatus } from "@/lib/market-hours";
import { categoryOf } from "@/lib/analysis/symbol-category";
import { defaultTradingCostFor } from "@/config/trading-costs";

/**
 * 加密貨幣 — a user-added BTCUSD must behave like the 24/7 instrument it is.
 *
 * The live failure this pins against: BTC/ETH added via /symbols inherited
 * the index category, so a Saturday scan said 週末休市 about a market that
 * never closes, and the data came through Yahoo's flaky mirror while the
 * venue's own keyless API sat unused ("D1 K 棒不足" on the most liquid
 * instrument on earth).
 */

function reset() {
  __resetQuotaForTests();
  __resetCacheForTests();
}

async function main() {
  // ── ticker detection and mapping ────────────────────────────────
  {
    check("BTC-USD maps to the USDT book", binanceSymbolFor("BTC-USD") === "BTCUSDT");
    check("ETH-USD too", binanceSymbolFor("ETH-USD") === "ETHUSDT");
    check("an exchange-form ticker passes through", binanceSymbolFor("SOLUSDT") === "SOLUSDT");
    check("FX is not crypto", !isCryptoTicker("EURUSD=X") && binanceSymbolFor("EURUSD=X") === null);
    check("futures are not crypto", !isCryptoTicker("GC=F"));
    check("indices are not crypto", !isCryptoTicker("^GSPC"));
    check("the browser-side detector agrees",
      isCryptoYahooTicker("BTC-USD") && !isCryptoYahooTicker("EURUSD=X") &&
      !isCryptoYahooTicker("^N225"));
  }

  // ── the server-side custom-symbol roster parses defensively ─────
  //
  // Custom symbols now live in app_settings so the board, the hourly sweep
  // and the monitor can see them without a browser. The stored JSON is
  // whatever the settings endpoint accepted, so parsing drops anything
  // invalid and caps the count — the customs share one 60-second sweep
  // invocation, and an unbounded list would starve the later ones hourly.
  {
    const good = { symbol: "BTCUSD", label: "比特幣", yahooSymbol: "BTC-USD",
      stooqSymbol: "", cotContractCode: "", gdeltQuery: "bitcoin" };
    const parsed = parseCustomSymbols(JSON.stringify([
      good,
      { ...good, symbol: "bad symbol!" }, // invalid id → dropped
      { ...good, symbol: "ETHUSD", yahooSymbol: "ETH-USD" },
    ]));
    check("valid entries survive, invalid ones are dropped individually",
      parsed.length === 2 && parsed[0].symbol === "BTCUSD" && parsed[1].symbol === "ETHUSD",
      parsed.map((s) => s.symbol));
    check("garbage parses to an empty roster, never a crash",
      parseCustomSymbols("not json").length === 0 &&
      parseCustomSymbols(JSON.stringify({ a: 1 })).length === 0 &&
      parseCustomSymbols(null).length === 0);
    const many = Array.from({ length: 10 }, (_, i) => ({ ...good, symbol: `C${i}` }));
    check(`the roster caps at ${MAX_CUSTOM_SYMBOLS}`,
      parseCustomSymbols(JSON.stringify(many)).length === MAX_CUSTOM_SYMBOLS);
  }

  // ── a user-added crypto symbol gets the crypto category ─────────
  {
    const btc = toCommodityMeta({
      symbol: "BTCUSD", label: "比特幣", yahooSymbol: "BTC-USD",
      stooqSymbol: "", cotContractCode: "", gdeltQuery: "bitcoin",
    });
    check("BTC-USD becomes category crypto", btc.category === "crypto", btc.category);
    const nikkei = toCommodityMeta({
      symbol: "N225", label: "日經", yahooSymbol: "^N225",
      stooqSymbol: "", cotContractCode: "", gdeltQuery: "nikkei",
    });
    check("everything else stays index", nikkei.category === "index", nikkei.category);
  }

  // ── crypto never closes ─────────────────────────────────────────
  {
    const saturday = new Date("2026-08-22T12:00:00Z"); // a Saturday
    check("Saturday closes FX/metals", marketStatus(saturday, 5, 5, "forex").closed === false
      ? marketStatus(saturday, 5, 5, "metal").closed // forex has its own 24/5 rule…
      : true); // …but the weekend clock fires first for everyone non-crypto
    check("Saturday does not close crypto",
      marketStatus(saturday, 5, 5, "crypto").closed === false,
      marketStatus(saturday, 5, 5, "crypto"));
    // Even a dark feed is a data gap, not a closed market.
    check("a stale crypto feed reads as open-with-gaps",
      marketStatus(new Date("2026-08-25T12:00:00Z"), 999, 999, "crypto").closed === false);
  }

  // ── crypto pays crypto costs ────────────────────────────────────
  {
    const cost = defaultTradingCostFor("crypto");
    check("a crypto cost row exists and is nonzero",
      cost.roundTripPct > 0 && cost.perBarPct > 0, cost);
  }

  // ── klines become candles ───────────────────────────────────────
  {
    reset();
    const t0 = Date.UTC(2026, 7, 20);
    stubFetch(() => ({
      status: 200,
      json: [
        [t0, "60000", "61000", "59500", "60500", "123.4", t0 + 86_400_000 - 1],
        [t0 + 86_400_000, "60500", "62000", "60400", "61800", "150.1", t0 + 2 * 86_400_000 - 1],
      ],
    }));
    const candles = await fetchBinanceOHLCV(
      { symbol: "BTCUSD", yfinanceSymbol: "BTC-USD" }, "D1", [], { ttlMs: 60_000 },
    );
    check("klines parse oldest-first with numeric OHLC",
      candles?.length === 2 && candles[0].close === 60500 && candles[1].close === 61800,
      candles);
    check("volume is carried — crypto genuinely reports it",
      candles?.[0].volume === 123.4, candles?.[0].volume);

    reset();
    stubFetch(() => ({ status: 200, json: { code: -1121, msg: "Invalid symbol." } }));
    check("an error body is a failure, not a series",
      (await fetchBinanceOHLCV(
        { symbol: "X", yfinanceSymbol: "NOPE-USD" }, "D1", [], { ttlMs: 60_000 },
      )) === null);

    check("a non-crypto meta never reaches the network", await (async () => {
      reset();
      const seen = stubFetch(() => ({ status: 200, json: [] }));
      const r = await fetchBinanceOHLCV(
        { symbol: "US30", yfinanceSymbol: "^DJI" }, "D1", [], { ttlMs: 60_000 },
      );
      return r === null && seen.length === 0;
    })());
  }

  // ── the quote is a real print with a real timestamp ─────────────
  {
    reset();
    const barOpen = Date.now() - 40_000;
    stubFetch(() => ({
      status: 200,
      json: [[barOpen, "61800", "61850", "61790", "61840", "3.2", barOpen + 59_999]],
    }));
    const q = await fetchBinanceQuote({ symbol: "BTCUSD", yfinanceSymbol: "BTC-USD" }, []);
    check("the quote carries the venue's price", q?.price === 61840, q?.price);
    check("stamped with the bar's open, not the local clock",
      q !== null && Math.abs(new Date(q.at).getTime() - barOpen) < 1000, q?.at);
    check("labelled as its own source", q?.source === "binance", q?.source);
  }

  // ── every route resolves symbols against the full roster ────────
  //
  // Structural, like the driver pins in db.test: BTCUSD could be scanned,
  // monitored and boarded, and still 404 from the lab, because five routes
  // each kept their own `COMMODITIES.find`. And registration must not depend
  // on the /symbols page being revisited after a deploy — scanning a custom
  // symbol registers it server-side as a side effect.
  {
    const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
    for (const route of [
      "app/api/lab/route.ts",
      "app/api/lab/adopt/route.ts",
      "app/api/signal/[symbol]/route.ts",
    ]) {
      check(`${route} resolves via the roster`, read(route).includes("findInstrument"), route);
    }
    check("the forward route sweeps the full roster",
      read("app/api/lab/forward/route.ts").includes("allInstruments"));
    check("scanning a custom symbol registers it server-side",
      read("app/api/signal/custom/route.ts").includes("registerCustomSymbol"));
    check("the lab falls back to the ordinary candle chain before giving up",
      read("app/api/lab/route.ts").includes("fetchOHLCV(meta, timeframe"));
    check("deep H4 tries smaller ranges before declaring failure",
      read("lib/data-sources/deep-history.ts").includes('"365d"'));

    // 自訂標的到處都要在 —— the live report was a BTCUSD position the monitor
    // had entered, was managing and had already pushed to Telegram, while
    // /positions reported nothing: that read iterated COMMODITIES. Same class
    // of omission in five more places. Structural pins, like the driver ones
    // in db.test: each names the file that must resolve through the roster.
    for (const [route, marker] of [
      ["app/api/positions/route.ts", "allInstruments"],
      ["app/api/correlation/route.ts", "allInstruments"],
      ["app/api/scan/route.ts", "findInstrument"],
    ] as const) {
      check(`${route} resolves the full roster`, read(route).includes(marker), route);
    }
    check("no server route iterates the nine built-ins for positions",
      !/COMMODITIES\.map\(async/.test(read("app/api/positions/route.ts")));
    for (const page of [
      "app/review/page.tsx",
      "app/history/page.tsx",
      "components/journal-form.tsx",
      "app/ranking/page.tsx",
    ]) {
      check(`${page} offers the custom symbols too`,
        read(page).includes("loadCustomSymbols"), page);
    }

    // Costs: the two synchronous lookups that used to answer wrong for a
    // custom symbol — the ledger charged it NOTHING and the backtest charged
    // crypto an index spread.
    check("a crypto id resolves to crypto costs", categoryOf("BTCUSD") === "crypto");
    check("exchange-form ids too", categoryOf("ETHUSDT") === "crypto");
    check("a built-in keeps its declared category", categoryOf("XAUUSD") === "metal");
    check("FX majors ending in USD are NOT crypto",
      categoryOf("EURUSD") === "forex" && categoryOf("GBPUSD") === "forex");
    check("an unknown symbol falls back to a cost, never to free",
      categoryOf("WHATEVER") === "index");
    check("the forward ledger no longer charges custom symbols zero",
      !read("lib/analysis/lab-forward.ts").includes("r.horizonBars / 2)\n    : 0"));
  }

  // ── 免費方案現況：Kraken 替補與 Finnhub 付費端點 ────────────────
  //
  // Two live facts about the free stack, pinned so they stay handled:
  // api.binance.com geo-blocks US IPs (451) and this deployment's functions
  // run in the US — Kraken is the venue leg that actually answers there.
  // Finnhub's /calendar/economic is a *paid* endpoint: a free key gets 403
  // forever, which must read as a plan limitation, never as an outage.
  {
    check("BTC-USD maps to Kraken's XBT book", krakenPairFor("BTC-USD") === "XBTUSD");
    check("ETH-USD maps to a real-USD pair", krakenPairFor("ETH-USD") === "ETHUSD");
    check("exchange-form tickers drop the stablecoin quote", krakenPairFor("SOLUSDT") === "SOLUSD");
    check("FX is not crypto on Kraken either", krakenPairFor("EURUSD=X") === null);

    reset();
    const t0 = Math.floor(Date.UTC(2026, 7, 20) / 1000);
    stubFetch(() => ({
      status: 200,
      json: {
        error: [],
        result: {
          XXBTZUSD: [
            [t0, "60000", "61000", "59500", "60500", "60200", "12.5", 100],
            [t0 + 86_400, "60500", "62000", "60400", "61800", "61000", "9.1", 80],
          ],
          last: t0 + 86_400,
        },
      },
    }));
    const kc = await fetchKrakenOHLCV(
      { symbol: "BTCUSD", yfinanceSymbol: "BTC-USD" }, "D1", [], { ttlMs: 60_000 },
    );
    check("Kraken OHLC rows parse under the aliased pair key",
      kc?.length === 2 && kc[0].close === 60500 && kc[1].close === 61800, kc);
    check("Kraken volume is carried", kc?.[1].volume === 9.1, kc?.[1].volume);

    reset();
    stubFetch(() => ({ status: 200, json: { error: ["EQuery:Unknown asset pair"] } }));
    check("a Kraken error envelope is a failure, not a series",
      (await fetchKrakenOHLCV(
        { symbol: "X", yfinanceSymbol: "NOPE-USD" }, "D1", [], { ttlMs: 60_000 },
      )) === null);

    const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
    check("the candle chain tries Kraken after Binance",
      read("lib/data-sources/ohlcv.ts").includes("fetchKrakenOHLCV"));
    check("the deep fetch has the Kraken leg",
      read("lib/data-sources/deep-history.ts").includes("fetchKrakenDeep"));
    check("the quote chain has the Kraken leg",
      read("lib/data-sources/yfinance.ts").includes("fetchKrakenQuote"));

    // Finnhub economic calendar on a free key: 403 → empty calendar + one
    // honest note, cached as a success so it cannot spam 取得失敗 hourly.
    reset();
    process.env.FINNHUB_API_KEY = "free-key";
    try {
      stubFetch(() => ({ status: 403, json: { error: "premium" } }));
      const calGaps: string[] = [];
      const cal = await fetchEconomicCalendar(calGaps);
      check("a 403 calendar reads as an empty calendar, not a failure",
        Array.isArray(cal) && cal.length === 0, cal);
      check("and the note names the plan limitation",
        calGaps.some((g) => g.includes("付費端點") && g.includes("方案限制")), calGaps);
      check("without the 取得失敗 wording",
        !calGaps.some((g) => g.includes("取得失敗")), calGaps);
    } finally {
      delete process.env.FINNHUB_API_KEY;
    }
  }

  report("加密貨幣");
}

void main();
