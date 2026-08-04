/**
 * Fetch wrapper shared by every data source: hard timeout, never throws.
 * Callers must push a human-readable reason to `gaps` on a null result —
 * this module only guarantees the process doesn't crash and no data
 * is fabricated on failure.
 */
export async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  timeoutMs = 10000,
): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchText(
  url: string,
  init?: RequestInit,
  timeoutMs = 10000,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
