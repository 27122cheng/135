import type { SignalStore } from "@/lib/db";
import type { JournalEntry } from "@/types/journal";
import { computeTrackRecord, type TrackBucket } from "@/lib/journal/stats";
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

/** Pure formatter, so the message is testable without a store or a clock. */
export function buildWeeklyDigest(entries: JournalEntry[], weekLabel: string): string {
  const record = computeTrackRecord(entries);
  const lines: string[] = [`<b>週結摘要 ${weekLabel}</b>`];

  if (entries.length === 0) {
    lines.push("本週 0 筆結算 —— 門檻未放行任何交易，觀望也是一種紀錄。");
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
  const entries = (await store.listJournal({ limit: 500 }).catch(() => [])).filter(
    (e) => Date.parse(e.closed_at) >= weekAgo,
  );

  const text = buildWeeklyDigest(entries, week) + (appUrl ? `\n${appUrl}/review` : "");
  await notifyAll(text);
  return { sent: true, reason: `已發送（${entries.length} 筆結算）` };
}
