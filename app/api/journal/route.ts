import { getSignalStore } from "@/lib/db";
import { partitionJournal, quarantineNote, usableJournal } from "@/lib/journal/quarantine";
import { computeSeverity } from "@/lib/journal/severity";
import { json } from "@/lib/json-response";
import {
  STOP_REASON_TAGS,
  type JournalEntryInput,
  type StopReasonTag,
  type TradeResult,
} from "@/types/journal";

export const dynamic = "force-dynamic";

const RESULTS: TradeResult[] = ["win", "loss", "breakeven"];
const SYMBOL_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;
const GRADES = ["A+", "A", "B", "C", "no-trade"];
const UUID_PATTERN = /^[0-9a-fA-F-]{36}$/;

/** GET /api/journal?symbol=&limit= — newest first. */
export async function GET(request: Request) {
  const store = getSignalStore();
  if (!store) {
    return json({ error: "未設定資料庫，交易日誌無法使用", entries: [] }, { status: 501 });
  }
  const params = new URL(request.url).searchParams;
  try {
    const stored = await store.listJournal({
      symbol: params.get("symbol"),
      limit: Math.min(Number(params.get("limit") ?? "100") || 100, 500),
    });
    // The raw list stays available — quarantined rows are hidden from
    // statistics, not from the reader — but it says which rows those are, so
    // nothing downstream can count them by accident.
    const partition = partitionJournal(stored);
    return json({
      entries: partition.usable,
      quarantined: {
        fabricated: partition.fabricated,
        duplicates: partition.duplicates,
        note: quarantineNote(partition),
      },
    });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : "讀取交易日誌失敗", entries: [] },
      { status: 502 },
    );
  }
}

interface Body {
  [key: string]: unknown;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * POST /api/journal — logs one closed trade.
 *
 * `severity` is deliberately **not** accepted from the request body. It is
 * recomputed here from the tag, the loss, and the stored history, so the number
 * the intervention rules average over is always the formula's output and never
 * something a caller typed.
 */
export async function POST(request: Request) {
  const store = getSignalStore();
  if (!store) {
    return json({ error: "未設定資料庫，無法寫入交易日誌" }, { status: 501 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ error: "請求內容不是有效的 JSON" }, { status: 400 });
  }

  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!SYMBOL_PATTERN.test(symbol)) {
    return json({ error: "symbol 格式不正確" }, { status: 400 });
  }

  const direction = body.direction === "long" || body.direction === "short" ? body.direction : null;
  if (!direction) {
    return json({ error: "direction 必須是 long 或 short" }, { status: 400 });
  }

  const grade = typeof body.grade === "string" ? body.grade : "";
  if (!GRADES.includes(grade)) {
    return json({ error: `grade 必須是 ${GRADES.join(" / ")}` }, { status: 400 });
  }

  const result = RESULTS.includes(body.result as TradeResult) ? (body.result as TradeResult) : null;
  if (!result) {
    return json({ error: `result 必須是 ${RESULTS.join(" / ")}` }, { status: 400 });
  }

  const entryPrice = num(body.entry_price);
  const exitPrice = num(body.exit_price);
  const pnlPct = num(body.pnl_pct);
  if (entryPrice === null || exitPrice === null || pnlPct === null) {
    return json(
      { error: "entry_price / exit_price / pnl_pct 必須是數字" },
      { status: 400 },
    );
  }

  const closedAtRaw = typeof body.closed_at === "string" ? body.closed_at : "";
  const closedAt = new Date(closedAtRaw);
  if (!closedAtRaw || Number.isNaN(closedAt.getTime())) {
    return json({ error: "closed_at 不是有效的時間" }, { status: 400 });
  }

  const rawTag = typeof body.stop_reason_tag === "string" ? body.stop_reason_tag : null;
  const tag = rawTag && STOP_REASON_TAGS.includes(rawTag as StopReasonTag)
    ? (rawTag as StopReasonTag)
    : null;
  if (rawTag && !tag) {
    return json(
      { error: `stop_reason_tag 必須是 ${STOP_REASON_TAGS.join(" / ")}` },
      { status: 400 },
    );
  }
  // Mirrors the table's loss_needs_tag constraint, so the caller gets a useful
  // message instead of a database error.
  if (result === "loss" && !tag) {
    return json({ error: "虧損的交易必須指定 stop_reason_tag（S1–S8）" }, { status: 400 });
  }

  const signalId = typeof body.signal_id === "string" && UUID_PATTERN.test(body.signal_id)
    ? body.signal_id
    : null;

  const reviewNote = typeof body.review_note === "string" ? body.review_note.slice(0, 2000) : null;

  const entry: JournalEntryInput = {
    signal_id: signalId,
    symbol,
    direction,
    grade,
    entry_price: entryPrice,
    exit_price: exitPrice,
    result,
    pnl_pct: pnlPct,
    closed_at: closedAt.toISOString(),
    stop_reason_tag: tag,
    review_note: reviewNote,
  };

  try {
    // Severity needs the history *before* this entry, so it is read first.
    let severity: number | null = null;
    let breakdown = null;
    if (tag) {
      const history = usableJournal(await store.listJournal({ symbol, limit: 20 }));
      const computed = computeSeverity({ tag, pnlPct, history });
      severity = computed.severity;
      breakdown = computed;
    }
    const saved = await store.insertJournalEntry(entry, severity);
    // The breakdown goes back so the UI can show why the number came out as it
    // did — a severity nobody can explain is a severity nobody trusts.
    return json({ entry: saved, severity_breakdown: breakdown }, { status: 201 });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : "寫入交易日誌失敗" },
      { status: 502 },
    );
  }
}
