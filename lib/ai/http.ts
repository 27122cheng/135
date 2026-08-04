/**
 * POST helper shared by the provider implementations.
 *
 * Unlike lib/data-sources/http.ts (which swallows everything into null), this
 * one keeps the status code and body snippet: a 429 from a free tier means
 * "back off", a 401 means "the key is wrong", and telling those apart is the
 * difference between a useful data_gap message and a shrug.
 */

export interface PostResult {
  ok: boolean;
  status: number;
  /** Parsed JSON when the response was JSON, otherwise null. */
  json: unknown;
  /** Short text snippet, for error messages. */
  detail: string;
}

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<PostResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return {
      ok: res.ok,
      status: res.status,
      json,
      detail: text.slice(0, 200),
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      status: 0,
      json: null,
      detail: aborted ? `逾時 ${timeoutMs}ms` : err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}
