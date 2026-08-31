import type { SignalStore } from "@/lib/db";
import { COMMODITIES } from "@/types/signal";
import { allInstruments } from "@/lib/server-symbols";
import type { JournalEntry } from "@/types/journal";
import { usableJournal } from "@/lib/journal/quarantine";
import { computeEquityCurve, computeTrackRecord, type TrackBucket } from "@/lib/journal/stats";
import { notifyAll } from "@/lib/notify";

/**
 * 週結摘要 — the system grading itself, delivered.
 *
 * The expectancy machinery答案都在 /review, but a page nobody opens teaches
 * nobody anything. Once a week the numbers walk to the phone instead: how
 * many trades resolved, the win rate against the breakeven bar its payoff
 * ratio demands, the expectancy, and the costliest stop-reason tag. Sent
 * even on a quiet week — "0 筆結算" from a system that stood aside is a
 * result, and silence is indistinguishable from a dead scheduler.
 *
 * ## Once means once
 *
 * The sender runs inside the monitor sweep (the most frequent schedule), so
 * idempotence lives in the database: an `app_settings` marker records the
 * ISO week last delivered, written through the store directly — this is an
 * internal key, deliberately NOT in the settings API's allowlist, so it can
 * be neither read as a credential nor set from outside.
 */

const MARKER_KEY = "WEEKLY_DIGEST_SENT_WEEK";
/** Sunday 22:00 UTC = Monday 06:00 Taipei — the week is over, coffee time. */
const SEND_DOW = 0;
const SEND_HOUR_UTC = 22;

/** ISO-8601 week label, e.g. "2026-W33" — the dedupe token. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Shift to the Thursday of this week; its year owns the week.
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function inSendWindow(now: Date): boolean {
  return now.getUTCDay() === SEND_DOW && now.getUTCHours() >= SEND_HOUR_UTC;
}

function bucketLine(label: string, b: TrackBucket): string | null {
  if (b.trades === 0) return null;
  const win =
    b.winRate === null
      ? "—"
      : `${b.winRate}%${b.breakevenWinRate !== null ? `（損益兩平需 ${b.breakevenWinRate}%）` : ""}`;
  const exp = b.expectancyPct === null ? "—" : `${b.expectancyPct}%`;
  return `${label}：${b.trades} 筆，勝率 ${win}，期望值 ${exp}/筆`;
}

export interface OpenPositionSummary {
  symbol: string;
  direction: "long" | "short";
  entry: number | null;
  /** ISO time of the signal that opened it. */
  since: string | null;
}

export interface AllTimeSummary {
  totalPct: number;
  maxDrawdownPct: number;
  trades: number;
}

/** Pure formatter, so the message is testable without a store or a clock. */
export function buildWeeklyDigest(
  entries: JournalEntry[],
  weekLabel: string,
  openPositions: OpenPositionSummary[] = [],
  allTime: AllTimeSummary | null = null,
): string {
  const record = computeTrackRecord(entries);
  const lines: string[] = [`<b>週結摘要 ${weekLabel}</b>`];

  // A settled count of zero is not the same claim as "nothing traded". The
  // week this bit: XAUUSD entered on the 21st and was still in flight when
  // the digest said 門檻未放行任何交易 — false, and exactly the sentence
  // that made the next add-on alert read as coming from nowhere.
  const held = openPositions
    .map(
      (p) =>
        `${p.symbol} ${p.direction === "long" ? "做多" : "做空"}` +
        (p.entry != null ? `（進場 ${Math.abs(p.entry) < 10 ? p.entry.toFixed(5) : p.entry.toFixed(2)}` +
          (p.since ? `，${p.since.slice(5, 10)} 的訊號）` : "）") : ""),
    )
    .join("、");

  if (entries.length === 0) {
    lines.push(
      openPositions.length > 0
        ? `本週 0 筆結算，${openPositions.length} 筆持倉中：${held} —— 尚未觸及停損或停利，未結算不等於沒有交易。`
        : "本週 0 筆結算 —— 門檻未放行任何交易，觀望也是一種紀錄。",
    );
  } else {
    for (const [label, bucket] of [
      ["正式訊號", record.real],
      ["紙上追蹤", record.paper],
      ["人工記錄", record.manual],
    ] as const) {
      const line = bucketLine(label, bucket);
      if (line) lines.push(line);
    }
    // The costliest lesson of the week, by stop-reason tag.
    const tagLoss = new Map<string, number>();
    for (const e of entries) {
      if (e.result === "loss" && e.stop_reason_tag) {
        tagLoss.set(e.stop_reason_tag, (tagLoss.get(e.stop_reason_tag) ?? 0) + Math.abs(e.pnl_pct));
      }
    }
    const worst = [...tagLoss.entries()].sort((a, b) => b[1] - a[1])[0];
    if (worst) {
      lines.push(`本週最痛的停損原因：${worst[0]}（合計 -${Math.round(worst[1] * 100) / 100}%）`);
    }
    if (openPositions.length > 0) {
      lines.push(`另有 ${openPositions.length} 筆持倉中：${held}`);
    }
  }

  // The running score, not just this week's inning: where the whole book
  // stands and the deepest drawdown it has been through. A weekly number
  // without the cumulative one invites overreacting to one week's noise.
  if (allTime && allTime.trades > 0) {
    lines.push(
      `累計（實際交易 ${allTime.trades} 筆）：${allTime.totalPct > 0 ? "+" : ""}${allTime.totalPct}%，` +
        `最大回撤 ${allTime.maxDrawdownPct}%`,
    );
  }

  lines.push("", "<i>勝率高於「損益兩平需 x%」才是正期望；詳情見 /review</i>");
  return lines.join("\n");
}

export async function maybeSendWeeklyDigest(
  store: SignalStore,
  appUrl: string,
  now = new Date(),
): Promise<{ sent: boolean; reason: string }> {
  if (!inSendWindow(now)) return { sent: false, reason: "不在發送時窗（週日 22:00 UTC 後）" };
  const week = isoWeek(now);

  const settings = await store.listSettings().catch(() => new Map<string, string>());
  if (settings.get(MARKER_KEY) === week) return { sent: false, reason: "本週已發送" };

  // Mark BEFORE sending — the no-memory-no-mouth rule in reverse: a marker
  // that fails to persist would replay the digest every five minutes for two
  // hours, and one missed weekly digest is far cheaper than that.
  await store.saveSetting(MARKER_KEY, week);

  const weekAgo = Date.now() - 7 * 24 * 3600_000;
  const allEntries = usableJournal(await store.listJournal({ limit: 500 }).catch(() => []));
  const entries = allEntries.filter((e) => Date.parse(e.closed_at) >= weekAgo);
  // 累計權益 over real trades only — paper 參考價位 rows would flatter it.
  const realAllTime = allEntries.filter((e) => !e.review_note?.includes("[參考價位紙上追蹤]"));
  const curve = computeEquityCurve(realAllTime);
  const allTime =
    realAllTime.length > 0
      ? { totalPct: curve.totalPct, maxDrawdownPct: curve.maxDrawdownPct, trades: realAllTime.length }
      : null;

  // Real positions still in flight — read from the monitor's own state, the
  // same rows the 5-minute sweep manages. Paper trackers live under
  // `${symbol}:ref` keys and are deliberately not counted here. Customs
  // included: the monitor watches them, so the digest must count them.
  const open: OpenPositionSummary[] = [];
  const roster = await allInstruments().catch(() => [...COMMODITIES]);
  for (const meta of roster) {
    const row = await store.getMonitorState(meta.symbol).catch(() => null);
    if (
      row &&
      (row.state === "entered" || row.state === "added" || row.state === "scaled") &&
      row.tracked?.plan
    ) {
      open.push({
        symbol: meta.symbol,
        direction: row.tracked.direction,
        entry: row.tracked.plan.entry,
        since: row.tracked.generatedAt ?? null,
      });
    }
  }

  const text = buildWeeklyDigest(entries, week, open, allTime) + (appUrl ? `\n${appUrl}/review` : "");
  await notifyAll(text);
  return { sent: true, reason: `已發送（${entries.length} 筆結算、${open.length} 筆持倉中）` };
}
