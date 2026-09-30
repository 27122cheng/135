import { check, report } from "./_harness";
import {
  CONTEXT_MIN_TRADES,
  confidenceBand,
  contextBuckets,
  contextMarker,
  contextVerdict,
  parseContext,
} from "@/lib/journal/context-record";
import type { JournalEntry } from "@/types/journal";

/** 情境實績 — the marker, the buckets, and a veto that only ever withdraws. */

let seq = 0;
function row(over: Partial<JournalEntry> = {}): JournalEntry {
  seq++;
  return {
    id: `j-${seq}`, signal_id: null, symbol: "XAUUSD", direction: "long", grade: "B",
    entry_price: 2000, exit_price: 1980, result: "loss", pnl_pct: -1,
    closed_at: "2026-09-01T00:00:00.000Z", stop_reason_tag: null, severity: null,
    review_note: "[自動追蹤][情境 信心:62 行情:trending 時段:主] 觸及停損",
    created_at: "2026-09-01T00:00:00.000Z", ...over,
  };
}

check("bands: <45", confidenceBand(30) === "<45");
check("bands: 45-59", confidenceBand(59) === "45-59");
check("bands: 60-74", confidenceBand(60) === "60-74");
check("bands: 75+", confidenceBand(80) === "75+");
check("no score, no band", confidenceBand(null) === null);

const marker = contextMarker({ confidenceScore: 62.4, regime: "ranging", mainSession: false });
check("the marker carries score, regime and session", marker === "[情境 信心:62 行情:ranging 時段:非主]", marker);
check("a missing regime reads unknown", contextMarker({ confidenceScore: null, regime: null, mainSession: true }) === "[情境 行情:unknown 時段:主]");
const parsed = parseContext(row({ review_note: `[自動追蹤]${marker} 觸及停損`, grade: "A" }));
check("and parses back", parsed.confidenceBand === "60-74" && parsed.regime === "ranging" && parsed.session === "非主時段" && parsed.grade === "A", parsed);
check("a row without a marker has no context but keeps its grade",
  parseContext(row({ review_note: "[自動追蹤] x" })).confidenceBand === null && parseContext(row({ review_note: "[自動追蹤] x" })).grade === "B");

{
  const rows = [
    row({ result: "win", pnl_pct: 2 }),
    row({ result: "loss", pnl_pct: -1 }),
    row({ result: "win", pnl_pct: 1, review_note: "[自動追蹤][情境 信心:40 行情:ranging 時段:非主] 停利", grade: "A" }),
    row({ review_note: "[自動追蹤][參考價位紙上追蹤][情境 信心:62 行情:trending 時段:主] 停損", pnl_pct: -5 }),
    row({ review_note: "手寫" }),
  ];
  const b = contextBuckets(rows);
  const conf = b.find((x) => x.dimension === "confidence" && x.key === "60-74");
  check("a confidence bucket pools its real rows", conf?.trades === 2 && conf.wins === 1 && conf.losses === 1, conf);
  check("with a realised expectancy", conf?.expectancyPct === 0.5, conf);
  check("paper rows are not in it (the -5% is absent)", conf?.expectancyPct === 0.5);
  check("hand-written rows are not in it", !b.some((x) => x.dimension === "grade" && x.trades === 3));
  check("the regime bucket is labelled in words", b.find((x) => x.dimension === "regime" && x.key === "trending")?.label === "行情 趨勢");
}

{
  const losing = Array.from({ length: CONTEXT_MIN_TRADES }, () => row({ result: "loss", pnl_pct: -0.8 }));
  const v = contextVerdict(losing, { confidenceBand: "60-74", regime: "trending", session: "主時段", grade: "B" });
  check("a losing bucket with a real sample vetoes", v.veto, v);
  check("and names the bucket and its numbers", v.reason?.includes("信心 60–74") === true && v.reason.includes("-0.8%"), v.reason);
  check("the lines read biggest sample first", v.lines.length === 4 && v.lines[0].includes("12 筆"), v.lines);
  const short = contextVerdict(losing.slice(0, CONTEXT_MIN_TRADES - 1), { confidenceBand: "60-74", regime: "trending", session: "主時段", grade: "B" });
  check("one short of the sample floor does not veto", !short.veto);
  const other = contextVerdict(losing, { confidenceBand: "75+", regime: "ranging", session: "非主時段", grade: "A" });
  check("a signal in a different situation is untouched", !other.veto && other.lines.length === 0, other);
  const winning = Array.from({ length: CONTEXT_MIN_TRADES }, () => row({ result: "win", pnl_pct: 1.5 }));
  const w = contextVerdict(winning, { confidenceBand: "60-74", regime: "trending", session: "主時段", grade: "B" });
  check("a winning bucket never vetoes, and only reports", !w.veto && w.lines[0].includes("+1.5%"), w);
  const paperOnly = losing.map((e) => ({ ...e, review_note: e.review_note!.replace("[自動追蹤]", "[自動追蹤][參考價位紙上追蹤]") }));
  check("paper losses cannot veto", !contextVerdict(paperOnly, { confidenceBand: "60-74", regime: "trending", session: "主時段", grade: "B" }).veto);
}

{
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const builder = readFileSync(join(__dirname, "..", "lib", "signal-builder.ts"), "utf8");
  const autoLog = readFileSync(join(__dirname, "..", "lib", "journal", "auto-log.ts"), "utf8");
  check("auto-log stamps the context on every row", autoLog.includes("contextMarker({") && autoLog.includes("+ context;"));
  check("the builder attaches the record and vetoes on it", builder.includes("signal.context_record = record") && builder.includes("record.veto && record.reason"));
  const veto = builder.indexOf("contextVerdict(bookJournal");
  const guard = builder.indexOf("stopCooldown(symbolJournal");
  check("the context veto runs before the book-level guards", veto > 0 && guard > veto);
}

report("context record");
