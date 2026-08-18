import { check, report, stubFetch } from "./_harness";
import { __resetCacheForTests } from "@/lib/data-sources/cache";
import { __resetQuotaForTests } from "@/lib/data-sources/quota";
import { fetchFmpQuote, fmpSymbol } from "@/lib/data-sources/fmp";
import {
  driftWarning,
  fetchWitness,
  hasWitness,
  refineClosedReason,
  type WitnessReading,
} from "@/lib/data-sources/binance-witness";
import { COMMODITIES } from "@/types/signal";

/**
 * The fourth quote source, and the witness that is not a quote source.
 *
 * FMP's contract is the same as every other optional vendor here: no key means
 * no call, an error body behind HTTP 200 is a failure, and a quote with no
 * timestamp is refused rather than stamped with now().
 *
 * The Binance witness has a different and stricter contract — it must never
 * become a price. What it exists to do is answer the two questions a
 * timestamp cannot: whether 休市中 is the market or our feeds, and whether a
 * quote that reports itself as fresh has actually frozen.
 */

function reset() {
  __resetQuotaForTests();
  __resetCacheForTests();
  delete process.env.FMP_API_KEY;
}

const reading = (over: Partial<WitnessReading> = {}): WitnessReading => ({
  price: 2000,
  at: new Date().toISOString(),
  ageMinutes: 1,
  label: "PAXG/USDT（代幣化黃金）",
  tolerancePct: 2,
  ...over,
});

async function main() {
  // ── FMP ─────────────────────────────────────────────────────────
  {
    const unmapped = COMMODITIES.filter((c) => fmpSymbol(c.symbol) === null);
    check("every built-in symbol maps to an FMP ticker",
      unmapped.length === 0, unmapped.map((c) => c.symbol));

    reset();
    const seen = stubFetch(() => ({ status: 200, json: [{ price: 1, timestamp: 1 }] }));
    check("without a key FMP returns null",
      (await fetchFmpQuote({ symbol: "EURUSD" }, [])) === null);
    check("and makes no request", seen.length === 0, seen);

    reset();
    process.env.FMP_API_KEY = "k";
    const at = Math.floor(Date.now() / 1000) - 60;
    stubFetch(() => ({ status: 200, json: [{ symbol: "EURUSD", price: 1.0851, timestamp: at }] }));
    const q = await fetchFmpQuote({ symbol: "EURUSD" }, []);
    check("a quote comes back with the vendor's price", q?.price === 1.0851, q);
    check("stamped with the vendor's print time",
      Math.abs(new Date(q!.at).getTime() - at * 1000) < 1000, q?.at);
    check("and labelled as its own source", q?.source === "fmp");

    // The error shape is an object, not an array — the only reliable tell.
    reset();
    process.env.FMP_API_KEY = "k";
    stubFetch(() => ({
      status: 200,
      json: { "Error Message": "Exclusive Endpoint: This endpoint is not available under your current subscription" },
    }));
    const gaps: string[] = [];
    check("a plan-limited answer is not a price",
      (await fetchFmpQuote({ symbol: "NAS100" }, gaps)) === null);
    check("and is reported as a plan limit, in the vendor's words",
      gaps.some((g) => g.includes("Exclusive Endpoint") && g.includes("免費方案")), gaps);

    reset();
    process.env.FMP_API_KEY = "k";
    stubFetch(() => ({ status: 200, json: [{ symbol: "EURUSD", price: 1.08 }] }));
    check("a quote with no timestamp is refused",
      (await fetchFmpQuote({ symbol: "EURUSD" }, [])) === null);
  }

  // ── the witness only exists where a 24/7 proxy does ──────────────
  {
    check("gold has a 24-hour proxy", hasWitness("XAUUSD"));
    check("and so do the two USD-quoted majors",
      hasWitness("EURUSD") && hasWitness("GBPUSD"));
    check("USDJPY does not — there is no honest pair, so none is invented",
      !hasWitness("USDJPY"));
    check("nor do the indices", !hasWitness("NAS100") && !hasWitness("GER40"));

    reset();
    const seen = stubFetch(() => ({ status: 200, json: [[Date.now(), "1", "1", "1", "1"]] }));
    check("a symbol with no proxy makes no request",
      (await fetchWitness("US30", [])) === null && seen.length === 0, seen);

    reset();
    const now = Date.now() - 30_000;
    stubFetch(() => ({ status: 200, json: [[now, "1990", "2010", "1985", "2005", "12"]] }));
    const w = await fetchWitness("XAUUSD", []);
    check("a kline gives the proxy's close and its bar time",
      w?.price === 2005 && Math.abs(new Date(w!.at).getTime() - now) < 1000, w);
    check("and it carries the tolerance for that instrument's basis",
      w!.tolerancePct === 2, w?.tolerancePct);
  }

  // ── 休市中 vs 我們的來源掛了 ──────────────────────────────────────
  {
    const original = "最後成交距今 9.9 小時（報價與 K 棒都沒有更新的跡象），市場休市中或所有價格來源停更，不發送進場通知";

    const noWitness = refineClosedReason(original, null);
    check("with no witness the verdict is left exactly as it was",
      noWitness.reason === original && noWitness.feedDark === false);

    const quiet = refineClosedReason(original, reading({ ageMinutes: 90 }));
    check("a proxy that has also gone quiet changes nothing",
      quiet.reason === original && quiet.feedDark === false);

    const live = refineClosedReason(original, reading({ ageMinutes: 2 }));
    check("a proxy trading right now rewrites the sentence", live.feedDark === true);
    check("saying explicitly that this is not a market closure",
      live.reason.includes("這不是休市"), live.reason);
    check("and still refusing to notify — no trustworthy price, no plan",
      live.reason.includes("不發送進場通知"), live.reason);
    check("pointing at the diagnostics page rather than at the calendar",
      live.reason.includes("diagnostics"), live.reason);
  }

  // ── a frozen feed that still reports itself as fresh ─────────────
  //
  // The case no staleness check can catch: the timestamp is current, the price
  // is hours old. An instrument that never stops trading is the only witness
  // that can tell.
  {
    check("prices inside the instrument's basis raise nothing",
      driftWarning(2010, reading({ price: 2000 })) === null);
    check("even at the edge of tolerance",
      driftWarning(2040, reading({ price: 2000 })) === null);

    const drifted = driftWarning(2100, reading({ price: 2000 }));
    check("a 5% gap on a 2%-basis instrument is reported", drifted !== null);
    check("with both numbers, so the reader can check it",
      drifted!.includes("2100") && drifted!.includes("2000"), drifted);
    check("and it says which side is the more likely liar",
      drifted!.includes("我們的報價來源停在舊價位"), drifted);

    check("a stale witness cannot accuse anyone",
      driftWarning(2100, reading({ price: 2000, ageMinutes: 60 })) === null);
    check("and neither can a missing one", driftWarning(2100, null) === null);
    check("a nonsense price raises nothing rather than dividing by zero",
      driftWarning(0, reading()) === null);
  }

  report("報價證人");
}

void main();
