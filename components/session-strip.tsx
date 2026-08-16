"use client";

import { useEffect, useState } from "react";
import { SESSIONS, formatCountdown, sessionState } from "@/lib/analysis/sessions";
import { cn } from "@/lib/utils";

/**
 * 交易時段列 — site-wide, because a 24-hour market has no opening bell.
 *
 * The equities version of this system could say "closed" and be understood.
 * FX cannot: it is always open somewhere, and the same setup means different
 * things in Tokyo's range and in the London–New York overlap. Without this
 * strip a reader has no way to know which liquidity environment the numbers
 * on screen were produced in — and the maintenance hour, where spreads widen
 * and stops get picked off, looks identical to any other hour.
 *
 * Renders on the client and ticks once a minute. Server-rendering it would
 * bake the build time into the page and then quietly disagree with the
 * reader's clock; `mounted` gates the first paint so the server and client
 * markup cannot differ (a hydration mismatch here would be an error overlay
 * on every page in the app).
 */
export function SessionStrip() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  if (!now) {
    // Same height as the real strip, so the page does not jump when it fills.
    return <div className="mb-3 h-[26px]" aria-hidden />;
  }

  const state = sessionState(now);

  if (state.weekendClosed) {
    return (
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-neutral-800 bg-neutral-950/60 px-2.5 py-1 text-[11px]">
        <span className="font-medium text-neutral-400">週末休市</span>
        <span className="text-neutral-600">
          外匯自週五 21:00 UTC 收盤至週日 22:00 UTC 開盤，期間報價停更
        </span>
      </div>
    );
  }

  const liquidityTone = {
    high: "text-emerald-400",
    medium: "text-neutral-300",
    low: "text-amber-400",
  }[state.current.liquidity];

  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-neutral-800 bg-neutral-950/60 px-2.5 py-1 text-[11px]">
      {/* The five windows as a bar, so "where are we in the day" is spatial
          rather than something to read and decode. */}
      <span className="flex items-center gap-0.5" aria-hidden>
        {SESSIONS.map((w) => (
          <span
            key={w.id}
            title={`${w.label}（${w.startHour}:00–${w.endHour}:00 UTC）`}
            className={cn(
              "h-1.5 w-4 rounded-full",
              w.id === state.current.id
                ? w.liquidity === "low"
                  ? "bg-amber-500"
                  : "bg-emerald-500"
                : "bg-neutral-800",
            )}
          />
        ))}
      </span>
      <span className={cn("font-medium", liquidityTone)}>{state.current.label}</span>
      <span className="text-neutral-600">{state.current.note}</span>
      <span className="ml-auto shrink-0 text-neutral-500">
        {state.next.label}開盤還有 {formatCountdown(state.minutesToNext)}
      </span>
    </div>
  );
}
