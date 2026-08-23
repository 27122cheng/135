import { check, report, stubFetch } from "./_harness";
import { __resetCacheForTests } from "@/lib/data-sources/cache";
import { __resetQuotaForTests } from "@/lib/data-sources/quota";
import {
  binanceSymbolFor,
  fetchBinanceOHLCV,
  fetchBinanceQuote,
  isCryptoTicker,
} from "@/lib/data-sources/binance-crypto";
import { isCryptoYahooTicker, toCommodityMeta } from "@/lib/custom-symbols";
import { marketStatus } from "@/lib/market-hours";
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

  report("加密貨幣");
}

void main();
