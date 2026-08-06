import { NextResponse } from "next/server";

/**
 * `NextResponse.json` with the character set spelled out.
 *
 * JSON is UTF-8 by definition, so `content-type: application/json` *should* be
 * unambiguous — but a browser opening the URL directly gets no charset and
 * falls back to guessing from the system locale. On a zh-TW phone that guess is
 * Big5, and every Chinese label in the response comes back as CJK gibberish
 * (中國人民銀行 → 鉢剖?鉴箸???錦?). The API clients never noticed because
 * `fetch().json()` is required to decode as UTF-8 regardless.
 *
 * Used everywhere rather than only on the routes someone is likely to open by
 * hand: which routes those are changes, and this costs nothing.
 */
export function json(data: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(data, init);
  response.headers.set("content-type", "application/json; charset=utf-8");
  // Every route in this app returns live state — signals, quota, settings,
  // scan results. None of it is cacheable, and a cached copy is actively
  // harmful: the board's first response (an empty board, taken before anything
  // had been scanned) was being replayed to every later reload, so scans wrote
  // rows nobody ever saw and the header read 已掃描 0/9 indefinitely.
  //
  // `dynamic = "force-dynamic"` on the route governs the *server's* rendering.
  // It says nothing about the browser or an intermediary, which is what this
  // header is for.
  response.headers.set("cache-control", "no-store, must-revalidate");
  return response;
}
