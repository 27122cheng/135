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
