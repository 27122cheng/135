/**
 * How a journal row says who wrote it.
 *
 * Its own module because both the writer (auto-log) and the quarantine gate
 * that filters the writer's output need them, and auto-log imports the gate —
 * putting the constants in either one closes an import cycle.
 *
 * Conventions in the note rather than columns: adding a column to a live table
 * needs a migration path this deployment does not have, and the marker has to
 * be visible to the reader anyway. An entry the system wrote about a position
 * nobody actually held is a different kind of evidence from one a human
 * reviewed, and the review page must not present them as the same thing.
 */

/** Prefix on every auto-written review note. Also how the UI recognises them. */
export const AUTO_MARKER = "[自動追蹤]";

/** Additional marker for a plan nobody was ever told to take. */
export const PAPER_MARKER = "[參考價位紙上追蹤]";

/**
 * 已干涉 — the trade was taken under rules the stop-loss review had already
 * tightened (`[已干涉 S2,S3]`, the tags that fired). Written so the book can
 * later be split into trades the learning touched and trades it did not:
 * without that split 「學習有沒有用」 has no control group and stays an
 * opinion. See lib/journal/performance.ts.
 */
export const INTERVENED_MARKER = "[已干涉";

export function intervenedMarker(tags: Array<string | null | undefined>): string {
  const named = Array.from(new Set(tags.filter((t): t is string => typeof t === "string" && t.length > 0)));
  return named.length > 0 ? `${INTERVENED_MARKER} ${named.join(",")}]` : "";
}
