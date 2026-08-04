"use client";

import type { SeverityPoint, TagDistribution } from "@/lib/journal/stats";
import type { StopReasonTag } from "@/types/journal";

/**
 * Hand-rolled SVG rather than a charting library: two small charts don't
 * justify a dependency, and inline SVG keeps the page working with no client
 * JS beyond React itself.
 */

/** Fixed per-tag colours so a tag keeps its colour across both charts. */
export const TAG_COLORS: Record<StopReasonTag, string> = {
  S1: "#f87171",
  S2: "#fb923c",
  S3: "#fbbf24",
  S4: "#a3e635",
  S5: "#34d399",
  S6: "#22d3ee",
  S7: "#818cf8",
  S8: "#e879f9",
};

const RADIUS = 45;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function StopReasonDonut({ data }: { data: TagDistribution[] }) {
  if (data.length === 0) {
    return <p className="py-6 text-center text-xs text-neutral-600">尚無已分類的停損紀錄</p>;
  }

  let offset = 0;
  const segments = data.map((d) => {
    const length = (d.sharePct / 100) * CIRCUMFERENCE;
    const segment = { ...d, length, offset };
    offset += length;
    return segment;
  });

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
      <svg viewBox="0 0 120 120" className="h-36 w-36 shrink-0 -rotate-90">
        {segments.map((s) => (
          <circle
            key={s.tag}
            cx="60"
            cy="60"
            r={RADIUS}
            fill="none"
            stroke={TAG_COLORS[s.tag]}
            strokeWidth="14"
            strokeDasharray={`${s.length} ${CIRCUMFERENCE - s.length}`}
            strokeDashoffset={-s.offset}
          />
        ))}
      </svg>
      <ul className="w-full space-y-1.5">
        {data.map((d) => (
          <li key={d.tag} className="flex items-baseline gap-2 text-[11px]">
            <span
              className="mt-1 h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: TAG_COLORS[d.tag] }}
            />
            <span className="font-mono text-neutral-300">{d.tag}</span>
            <span className="min-w-0 flex-1 truncate text-neutral-500">{d.label}</span>
            <span className="shrink-0 tabular-nums text-neutral-400">
              {d.count} 次 · {d.sharePct}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SeverityTrend({ points }: { points: SeverityPoint[] }) {
  if (points.length < 2) {
    return (
      <p className="py-6 text-center text-xs text-neutral-600">
        需要至少 2 筆有 severity 的紀錄才畫得出趨勢
      </p>
    );
  }

  const W = 300;
  const H = 90;
  const PAD = 6;
  // severity is clamped to 1-5 by the formula, so the axis is fixed rather
  // than fitted to the data — a flat series shouldn't look like a full swing.
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - 1) / 4) * (H - PAD * 2);

  const raw = points.map((p, i) => `${x(i)},${y(p.severity)}`).join(" ");
  const mean = points.map((p, i) => `${x(i)},${y(p.rollingMean)}`).join(" ");

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
        {[1, 2, 3, 4, 5].map((v) => (
          <line
            key={v}
            x1={PAD}
            x2={W - PAD}
            y1={y(v)}
            y2={y(v)}
            stroke={v === 3 ? "#525252" : "#262626"}
            strokeWidth="1"
            strokeDasharray={v === 3 ? "3 3" : undefined}
          />
        ))}
        <polyline points={raw} fill="none" stroke="#525252" strokeWidth="1.5" />
        <polyline points={mean} fill="none" stroke="#f87171" strokeWidth="2" />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-neutral-600">
        <span>{points[0].closedAt.slice(0, 10)}</span>
        <span>{points[points.length - 1].closedAt.slice(0, 10)}</span>
      </div>
      <p className="mt-1.5 text-[10px] leading-relaxed text-neutral-600">
        <span className="text-neutral-500">灰＝單筆</span> ·{" "}
        <span className="text-red-400">紅＝5 筆移動平均</span> · 虛線＝干涉門檻 3
        （某 tag 平均 severity 超過 3 且出現 ≥3 次就會開始加嚴訊號）
      </p>
    </div>
  );
}
