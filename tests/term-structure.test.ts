import { check, report, stubFetch } from "./_harness";
import { __resetCacheForTests } from "@/lib/data-sources/cache";
import { __resetQuotaForTests } from "@/lib/data-sources/quota";
import { candidateContracts, contractSymbol, fetchWtiTermStructure } from "@/lib/data-sources/term-structure";

/**
 * WTI 期限結構.
 *
 * Backwardation (front above deferred) is physical tightness and reads
 * bullish; contango is oversupply and reads bearish; a flat curve says
 * nothing and must not vote. The ladder of dated contracts exists so a roll
 * cannot silently compare a contract against itself — an expired leg stops
 * printing and drops out on freshness alone.
 */

function chart(close: number, daysAgo = 0) {
  const ts = Math.floor((Date.now() - daysAgo * 86_400_000) / 1000);
  return {
    status: 200,
    json: {
      chart: {
        result: [
          { timestamp: [ts - 86_400, ts], indicators: { quote: [{ close: [close - 1, close] }] } },
        ],
      },
    },
  };
}

function reset() {
  __resetCacheForTests();
  __resetQuotaForTests();
}

// ── contract symbols ──────────────────────────────────────────────
{
  check("September 2026 is CLU26", contractSymbol(2026, 8) === "CLU26.NYM", contractSymbol(2026, 8));
  check("January uses F", contractSymbol(2026, 0) === "CLF26.NYM");
  check("December uses Z", contractSymbol(2026, 11) === "CLZ26.NYM");
  // Month overflow must roll the year, or December scans would ask for a
  // contract that does not exist.
  check("month 12 rolls into next January",
    contractSymbol(2026, 12) === "CLF27.NYM", contractSymbol(2026, 12));

  const ladder = candidateContracts(new Date("2026-08-14T00:00:00Z"));
  check("the ladder starts at the current delivery month",
    ladder[0] === "CLQ26.NYM", ladder);
  check("and runs four deep in delivery order",
    ladder.length === 4 && ladder[3] === "CLX26.NYM", ladder);
}

async function main() {
  // ── backwardation ───────────────────────────────────────────────
  {
    reset();
    // First two contracts answer; front is dearer than next.
    const seen = stubFetch((url) =>
      url.includes("CLQ26") ? chart(70) : url.includes("CLU26") ? chart(69) : chart(68),
    );
    const gaps: string[] = [];
    const ts = await fetchWtiTermStructure(gaps, new Date("2026-08-14T00:00:00Z"));
    check("two live legs are enough", ts !== null, gaps);
    check("front over next reads backwardation", ts?.shape === "backwardation", ts);
    check("the spread is signed the front-minus-next way", ts?.spread === 1, ts?.spread);
    check("only the legs it needed were fetched", seen.length === 2, seen);
  }

  // ── contango ────────────────────────────────────────────────────
  {
    reset();
    stubFetch((url) => (url.includes("CLQ26") ? chart(68) : chart(69.5)));
    const ts = await fetchWtiTermStructure([], new Date("2026-08-14T00:00:00Z"));
    check("front under next reads contango", ts?.shape === "contango", ts);
    check("and the spread goes negative", (ts?.spread ?? 0) < 0, ts?.spread);
  }

  // ── a flat curve says nothing ───────────────────────────────────
  {
    reset();
    // 0.05 on 70 is 0.07% — inside the noise band.
    stubFetch((url) => (url.includes("CLQ26") ? chart(70) : chart(69.95)));
    const ts = await fetchWtiTermStructure([], new Date("2026-08-14T00:00:00Z"));
    check("a tiny spread is flat, not a signal", ts?.shape === "flat", ts);
  }

  // ── an expired front leg drops out ──────────────────────────────
  {
    reset();
    // CLQ26 last printed a fortnight ago (expired); the next two are live.
    stubFetch((url) =>
      url.includes("CLQ26")
        ? chart(70, 14)
        : url.includes("CLU26")
          ? chart(69)
          : chart(68.5),
    );
    const ts = await fetchWtiTermStructure([], new Date("2026-08-14T00:00:00Z"));
    check("a stale contract is skipped", ts?.frontSymbol === "CLU26.NYM", ts?.frontSymbol);
    check("and the pair shifts one month out", ts?.nextSymbol === "CLV26.NYM", ts?.nextSymbol);
  }

  // ── nothing trading at all ──────────────────────────────────────
  {
    reset();
    stubFetch(() => ({ status: 404, body: "no" }));
    const gaps: string[] = [];
    const ts = await fetchWtiTermStructure(gaps, new Date("2026-08-14T00:00:00Z"));
    check("no live legs yields null rather than a guess", ts === null);
    check("and the failure is reported", gaps.length > 0, gaps);
  }

  report("WTI 期限結構");
}

void main();
