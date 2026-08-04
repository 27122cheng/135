import { check, report } from "./_harness";
// Exercise the CSV parsing path by stubbing global fetch, since the sandbox
// can't reach fred.stlouisfed.org.
const CSV = `observation_date,DGS10
2026-07-28,4.21
2026-07-29,.
2026-07-30,4.25
2026-07-31,4.19
2026-08-01,4.30
`;

global.fetch = (async (url: string) => {
  if (String(url).includes("fredgraph.csv")) {
    return { ok: true, status: 200, text: async () => CSV } as unknown as Response;
  }
  return { ok: false, status: 404, text: async () => "" } as unknown as Response;
}) as typeof fetch;

async function main() {
  delete process.env.FRED_API_KEY;
  const { fetchFredSeries } = await import("@/lib/data-sources/fred");
  const gaps: string[] = [];
  const r = await fetchFredSeries("DGS10", gaps);
  console.log("points:", r?.points.length, "latest:", r?.latest);
  console.log("gaps:", gaps);
  check("should parse", r !== null);
  check("'.' should parse to null", r!.points.length === 5, `FAIL expected 5 points, got ${r!.points.length}`);
  // The "." row must become null, not 0 or NaN.
  console.assert(r!.points[1].value === null);
  // latest must skip nulls and be the most recent real value.
  check("latest", r!.latest!.value === 4.3 && r!.latest!.date === "2026-08-01");
  check("should report no gaps", gaps.length === 0);
  }
void main().then(() => report("fred"));