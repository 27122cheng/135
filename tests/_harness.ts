/**
 * Minimal assertion harness.
 *
 * `console.assert` prints and carries on, so a suite built on it reports
 * "passed" while failing. This one tracks failures and sets a non-zero exit
 * code, which is the only reason a test run is worth anything in CI.
 */

let failures = 0;
let checks = 0;

export function check(name: string, condition: boolean, detail?: unknown): void {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}`);
  if (detail !== undefined) console.log(`       got: ${JSON.stringify(detail)}`);
}

export function equal(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/** Call once at the end of a file. Exits non-zero if anything failed. */
export function report(suite: string): void {
  if (failures === 0) {
    console.log(`PASS ${suite} (${checks} checks)`);
  } else {
    console.log(`FAIL ${suite} (${failures}/${checks} failed)`);
    process.exitCode = 1;
  }
}

/**
 * Replaces global.fetch for a test. Returns the list of URLs requested so a
 * test can assert which upstreams were (and were not) contacted.
 */
export function stubFetch(
  handler: (url: string) => { status: number; body: string } | { status: number; json: unknown },
): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const res = handler(url);
    const body = "body" in res ? res.body : JSON.stringify(res.json);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      text: async () => body,
      json: async () => JSON.parse(body),
    } as unknown as Response;
  }) as typeof fetch;
  return seen;
}
