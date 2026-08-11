/**
 * Fetch wrapper shared by every data source: hard timeout, never throws.
 * Callers must push a human-readable reason to `gaps` on a null result —
 * this module only guarantees the process doesn't crash and no data
 * is fabricated on failure.
 *
 * Every failure mode collapsing to `null` was costing more than it saved.
 * "GDELT 取得失敗" is not a diagnosis: a 429, a 25-second timeout and a body
 * that isn't JSON all need different fixes, and from the outside they looked
 * identical. So a caller may now pass a sink and learn which one happened,
 * without any existing call site changing.
 */

export interface HttpFailure {
  kind: "timeout" | "http" | "parse" | "network";
  status?: number;
  detail?: string;
}

/** Short Chinese description, suitable for a data_gaps line. */
export function describeFailure(f: HttpFailure | null | undefined): string | null {
  if (!f) return null;
  switch (f.kind) {
    case "timeout":
      return `逾時${f.detail ? `（${f.detail}）` : ""}`;
    case "http":
      return `HTTP ${f.status ?? "?"}`;
    case "parse":
      return `回應不是有效 JSON${f.detail ? `（${f.detail}）` : ""}`;
    case "network":
      return `連線失敗${f.detail ? `（${f.detail}）` : ""}`;
  }
}

type Sink = (failure: HttpFailure) => void;

function classify(error: unknown, timeoutMs: number, aborted: boolean): HttpFailure {
  if (aborted) return { kind: "timeout", detail: `${Math.round(timeoutMs / 1000)}s` };
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "network", detail: message.slice(0, 120) };
}

export async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  timeoutMs = 6000,
  onFailure?: Sink,
): Promise<T | null> {
  const text = await fetchText(url, init, timeoutMs, onFailure);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    onFailure?.({
      kind: "parse",
      detail: error instanceof Error ? error.message.slice(0, 120) : undefined,
    });
    return null;
  }
}

export async function fetchText(
  url: string,
  init?: RequestInit,
  timeoutMs = 6000,
  onFailure?: Sink,
): Promise<string | null> {
  // A connection-level failure ("fetch failed": a DNS miss, a reset, a broken
  // TLS handshake) gets one immediate retry. It is the only kind worth
  // retrying here: an HTTP status is the server's actual answer, a timeout has
  // already cost its full budget, and a parse error will parse the same way
  // twice. Live deployments showed GDELT and Stooq failing on exactly this
  // kind — transient egress hiccups where the second attempt succeeds — and a
  // single retry inside the call is far cheaper than losing the whole
  // four-hour scan cycle to it.
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    let aborted = false;
    const timeout = setTimeout(() => {
      aborted = true;
      controller.abort();
    }, timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        onFailure?.({ kind: "http", status: res.status });
        return null;
      }
      return await res.text();
    } catch (error) {
      const failure = classify(error, timeoutMs, aborted);
      if (failure.kind === "network" && attempt === 0) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      onFailure?.(failure);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
