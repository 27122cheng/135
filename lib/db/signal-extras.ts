import type { SignalRow, TradeSignal } from "@/types/signal";

/**
 * 歷史列補遺 — the gate-evidence fields the history table did not originally
 * store, packed into one `extras` jsonb column.
 *
 * The history insert writes named columns, and the fields the signal type
 * grew later — confidence, lab_gate, downgrades, reference_plan, graded_as,
 * then thesis, forward_evidence, direction_tie and the rest listed below —
 * were never added to it. Nothing noticed until the blocker census switched
 * from latestPerSymbol (the full payload) to a week of history rows: on those
 * rows classifyBlocker could never see the confidence gate, the lab gate, the
 * trend gate or an intervention, so the census silently under-reported the
 * exact tunable gates it exists to expose.
 *
 * One jsonb column rather than five: a single idempotent migration, and the
 * next field the signal type grows rides along without another one. Both
 * stores write it via {@link signalExtras} and unpack it via
 * {@link unpackSignalRow}; rows written before the migration have no extras
 * and unpack to themselves, which classifyBlocker already treats as "gate not
 * observable" rather than an error.
 *
 * Its own module (not lib/db/index.ts) because both store implementations
 * need it as a value and index imports the stores — helpers in index would
 * close an import cycle that only works by accident of hoisting.
 */
export function signalExtras(signal: TradeSignal): Record<string, unknown> {
  return {
    confidence: signal.confidence ?? null,
    lab_gate: signal.lab_gate ?? null,
    downgrades: signal.downgrades ?? null,
    reference_plan: signal.reference_plan ?? null,
    graded_as: signal.graded_as ?? null,
    // The second wave of column-less fields. Each one had a reader that could
    // never see it on a history row: `thesis` feeds the monitor's regime
    // snapshot (and so the thesis exit) when the board falls back to the
    // history table; `forward_evidence` is what the card's recomputed
    // confidence reads, so without it the recomputed score differs from the
    // one the gate used; `direction_tie` is the 中性 label /history renders
    // and could never render; the rest were being defaulted to empty by
    // completeSignal, which is a loss of record, not a correction.
    thesis: signal.thesis ?? null,
    forward_evidence: signal.forward_evidence ?? null,
    direction_tie: signal.direction_tie ?? false,
    chart_patterns: signal.chart_patterns ?? [],
    news_digest: signal.news_digest ?? null,
    interventions: signal.interventions ?? [],
    market_closed: signal.market_closed ?? false,
    market_closed_reason: signal.market_closed_reason ?? null,
  };
}

/**
 * A timestamp column as an ISO string, whatever the driver handed back.
 *
 * The Neon HTTP driver returns `timestamptz` as a JS `Date`, and every
 * consumer in this codebase treats these fields as the strings their types
 * declare — `.slice(0, 10)` for a date label, `localeCompare` to sort, both
 * of which throw or silently misorder on a Date. Postgres-REST (Supabase)
 * hands back JSON strings, so the same code worked there and the mismatch
 * only surfaced on the deployment that actually runs.
 */
export function isoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  return "";
}

/** A numeric column as a number: Postgres `numeric` arrives as a string. */
export function numberOf(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function unpackSignalRow(row: Record<string, unknown>): SignalRow {
  const { extras, ...rest } = row;
  const merged =
    !extras || typeof extras !== "object" || Array.isArray(extras)
      ? rest
      : // Named fields win over the packed copy on collision — the columns are
        // the table's own contract; extras only fills what they never carried.
        { ...(extras as Record<string, unknown>), ...rest };
  // Timestamps are declared as strings on SignalRow and are read as strings
  // everywhere (Date.parse, .slice, comparison); normalise rather than let a
  // driver's Date leak into code that cannot see it coming.
  if (merged.generated_at !== undefined) merged.generated_at = isoString(merged.generated_at);
  if (merged.created_at !== undefined) merged.created_at = isoString(merged.created_at);
  return merged as unknown as SignalRow;
}
