import { check, report, stubFetch } from "./_harness";
import { __resetCacheForTests } from "@/lib/data-sources/cache";
import { __resetQuotaForTests } from "@/lib/data-sources/quota";

/**
 * 「拿不到資料，還是有更好的來源免費的」— the third witness.
 *
 * Yahoo and Stooq both went dark at once on the live deployment, which two
 * witnesses cannot survive. These sources are a third family — FRED for the
 * US index closes and WTI, ER-API for daily FX fixes, gold-api for spot gold
 * — and the property pinned throughout is honesty about time: every price
 * carries the timestamp it actually printed, and a price that cannot prove
 * when it printed is rejected rather than stamped "now".
 */

const reset = () => {
  __resetCacheForTests();
  __resetQuotaForTests();
};

async function main() {
  const { fetchBackupPrice } = await import("@/lib/data-sources/backup-price");
  delete process.env.FRED_API_KEY;
  const now = Date.now();
  const yesterday = new Date(now - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // ── FRED carries the US index closes ────────────────────────────
  {
    reset();
    stubFetch((url) =>
      url.includes("fred.stlouisfed.org")
        ? { status: 200, body: `DATE,NASDAQ100\n2026-08-01,23100.2\n${yesterday},23750.5\n` }
        : { status: 500, body: "no" },
    );
    const gaps: string[] = [];
    const p = await fetchBackupPrice("NAS100", gaps);
    check("NAS100 gets FRED's official close", p?.source === "fred", p);
    check("the latest observation wins", p?.price === 23750.5, p?.price);
    check("stamped at the close, not at fetch time", p?.at === `${yesterday}T20:00:00Z`, p?.at);
  }

  // ── one ER-API call serves all three FX pairs ───────────────────
  {
    reset();
    const seen = stubFetch((url) =>
      url.includes("open.er-api.com")
        ? {
            status: 200,
            json: {
              result: "success",
              time_last_update_unix: Math.floor((now - 3600 * 1000) / 1000),
              rates: { EUR: 0.9, GBP: 0.78, JPY: 157.3 },
            },
          }
        : { status: 500, body: "no" },
    );
    const gaps: string[] = [];
    const eur = await fetchBackupPrice("EURUSD", gaps);
    check("EURUSD is the inverted USD rate", eur?.price === 1.11111, eur?.price);
    const jpy = await fetchBackupPrice("USDJPY", gaps);
    check("USDJPY is the direct rate", jpy?.price === 157.3, jpy?.price);
    check("and the second pair came from cache, not a second call",
      seen.filter((u) => u.includes("er-api")).length === 1, seen);
    check("the timestamp is the upstream's, not ours",
      (now - new Date(eur!.at).getTime()) / 60000 > 30, eur?.at);
  }

  // ── gold needs a timestamp to testify ───────────────────────────
  {
    reset();
    stubFetch((url) =>
      url.includes("gold-api.com")
        ? {
            status: 200,
            json: { price: 2650.2, updatedAt: new Date(now - 10 * 60 * 1000).toISOString() },
          }
        : { status: 500, body: "no" },
    );
    const p = await fetchBackupPrice("XAUUSD", []);
    check("spot gold comes from gold-api", p?.source === "gold-api" && p.price === 2650.2, p);

    reset();
    stubFetch((url) =>
      url.includes("gold-api.com")
        ? { status: 200, json: { price: 2650.2 } }
        : { status: 500, body: "no" },
    );
    const unstamped = await fetchBackupPrice("XAUUSD", []);
    check("a price that cannot prove when it printed is rejected",
      unstamped === null, unstamped);
  }

  // ── symbols with no third source say so cheaply ─────────────────
  {
    reset();
    const seen = stubFetch(() => ({ status: 500, body: "no" }));
    const p = await fetchBackupPrice("GER40", []);
    check("GER40 has no third witness", p === null);
    check("and finding that out costs zero requests", seen.length === 0, seen);
  }

  report("backup price");
}

void main();
