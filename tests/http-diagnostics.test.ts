import { check, report } from "./_harness";
import { describeFailure, fetchJson, fetchText, type HttpFailure } from "@/lib/data-sources/http";
import { parseGdeltBody } from "@/lib/data-sources/gdelt";

/**
 * Every fetch failure used to collapse to `null`, so a data_gaps line could
 * only ever say 取得失敗 — which is not something anyone can act on. A 429, a
 * timeout and a body that isn't JSON need three different fixes.
 */

const realFetch = global.fetch;

function stub(impl: () => Promise<Response> | Promise<never>) {
  global.fetch = impl as unknown as typeof fetch;
}

// ── the failure sink ──────────────────────────────────────────────
async function sinkTests() {
  {
    let seen: HttpFailure | null = null;
    const sink = (f: HttpFailure) => {
      seen = f;
    };

    stub(async () => new Response("nope", { status: 429 }));
    check("a rejected request reports null", (await fetchText("https://x", undefined, 100, sink)) === null);
    check("and names the status", (seen as HttpFailure | null)?.kind === "http");
    check("with the code", (seen as HttpFailure | null)?.status === 429);
    check("described for a human", describeFailure(seen) === "HTTP 429");

    seen = null;
    stub(async () => new Response("<html>down</html>", { status: 200 }));
    check("a 200 that isn't JSON is a parse failure",
      (await fetchJson("https://x", undefined, 100, sink)) === null);
    check("classified as parse", (seen as HttpFailure | null)?.kind === "parse");
    check("and described as such", describeFailure(seen)?.startsWith("回應不是有效 JSON") === true);

    seen = null;
    stub(async () => {
      throw new TypeError("fetch failed");
    });
    check("a connection error is reported", (await fetchText("https://x", undefined, 100, sink)) === null);
    check("classified as network", (seen as HttpFailure | null)?.kind === "network");
    check("carrying the message", describeFailure(seen)?.includes("fetch failed") === true);

    seen = null;
    stub(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("aborted")), 50);
        }) as Promise<never>,
    );
    check("a slow response times out", (await fetchText("https://x", undefined, 10, sink)) === null);
    check("classified as timeout", (seen as HttpFailure | null)?.kind === "timeout");

    // Success must not touch the sink.
    seen = null;
    stub(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const parsed = await fetchJson<{ ok: number }>("https://x", undefined, 100, sink);
    check("a good response parses", parsed?.ok === 1);
    check("and reports no failure", seen === null);

    check("nothing to describe is null", describeFailure(null) === null);
  }
  global.fetch = realFetch;
}

// ── GDELT's not-quite-JSON ────────────────────────────────────────
{
  const ok = parseGdeltBody(JSON.stringify({ articles: [{ title: "t", domain: "d", url: "u", seendate: "20260804T113000Z" }] }));
  check("valid JSON parses", "articles" in ok && ok.articles?.length === 1);

  // The real reason GDELT looked broken: titles are copied from the source page
  // and carry raw control characters, which JSON.parse rejects outright.
  const withControl = `{"articles":[{"title":"Gold${String.fromCharCode(7)}rallies","domain":"d","url":"u","seendate":"20260804T113000Z"}]}`;
  const cleaned = parseGdeltBody(withControl);
  check("a control character no longer kills the whole response",
    "articles" in cleaned && cleaned.articles?.length === 1, cleaned);
  check("and the headline survives",
    "articles" in cleaned && cleaned.articles?.[0].title.includes("Gold") === true);

  // GDELT answers a query it dislikes with a sentence and HTTP 200. That
  // sentence is the most useful diagnostic available, so it must reach the gap.
  const plain = parseGdeltBody("Your query was too short or too long.");
  check("a plain-text refusal becomes the reason",
    "error" in plain && plain.error.includes("too short"), plain);

  const empty = parseGdeltBody("   ");
  check("an empty body is an error, not empty results", "error" in empty);

  const broken = parseGdeltBody('{"articles":[');
  check("genuinely broken JSON still fails", "error" in broken);

  // An object with no articles key means "nothing matched" — not a failure.
  const none = parseGdeltBody("{}");
  check("no articles key is a valid empty answer", "error" in none === false);
}

void sinkTests().then(() => report("http diagnostics"));
