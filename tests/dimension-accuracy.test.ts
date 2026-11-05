import { check, report } from "./_harness";
import {
  DIMENSION_MIN_TRADES,
  applyDimensionScales,
  dimensionAccuracy,
  dimensionMarker,
  parseDimensions,
} from "@/lib/journal/dimension-accuracy";
import type { BiasItem } from "@/types/signal";
import type { JournalEntry } from "@/types/journal";

/** 面向準確率 — the marker, the record, and a weight that can only fall. */

const item = (dimension: BiasItem["dimension"], direction: BiasItem["direction"], weight: 0 | 1 | 2 = 1): BiasItem =>
  ({ dimension, direction, weight, factor: "f", evidence: "e", source: "s" }) as BiasItem;

let seq = 0;
function row(over: Partial<JournalEntry> = {}): JournalEntry {
  seq++;
  return {
    id: `j-${seq}`, signal_id: null, symbol: "XAUUSD", direction: "long", grade: "B",
    entry_price: 2000, exit_price: 1980, result: "loss", pnl_pct: -1,
    closed_at: "2026-09-01T00:00:00.000Z", stop_reason_tag: null, severity: null,
    review_note: "[自動追蹤][面向 技術:+ 基本:- 籌碼:0 新聞:+ 資金:0 AI:+] 觸及停損",
    created_at: "2026-09-01T00:00:00.000Z", ...over,
  };
}

{
  const m = dimensionMarker("long", [item("技術面", "long", 2), item("基本面", "short"), item("新聞面", "neutral")]);
  check("the marker records each dimension's stance on the direction",
    m === "[面向 技術:+ 基本:- 籌碼:0 新聞:0 資金:0 AI:0]", m);
  check("a short trade reads agreement the other way",
    dimensionMarker("short", [item("技術面", "short")]).startsWith("[面向 技術:+"));
  const p = parseDimensions(row());
  check("and parses back", p["技術面"] === 1 && p["基本面"] === -1 && p["籌碼面"] === 0 && p["AI綜合"] === 1, p);
  check("no marker, no stances", Object.keys(parseDimensions(row({ review_note: "[自動追蹤] x" }))).length === 0);
}

{
  // 技術面 agreed on every one of these and they all lost; 新聞面 agreed on
  // winners and disagreed on losers.
  const rows = [
    ...Array.from({ length: DIMENSION_MIN_TRADES }, () => row({ result: "loss", pnl_pct: -1 })),
    ...Array.from({ length: DIMENSION_MIN_TRADES }, () =>
      row({ result: "win", pnl_pct: 2, review_note: "[自動追蹤][面向 技術:0 基本:+ 籌碼:0 新聞:+ 資金:0 AI:0] 停利" })),
    ...Array.from({ length: DIMENSION_MIN_TRADES }, () =>
      row({ result: "loss", pnl_pct: -1, review_note: "[自動追蹤][面向 技術:0 基本:0 籌碼:0 新聞:- 資金:0 AI:0] 停損" })),
  ];
  const rec = dimensionAccuracy(rows);
  const tech = rec.find((r) => r.dimension === "技術面")!;
  const news = rec.find((r) => r.dimension === "新聞面")!;
  check("a dimension whose agreement only ever lost is halved", tech.scale === 0.5 && tech.note?.includes("權重減半") === true, tech);
  check("a dimension whose agreement wins and disagreement loses keeps full weight", news.scale === 1 && (news.edgePct ?? 0) > 0, news);
  // 新聞 agreed on the first 12 losers too: 24 agree rows at (12×2 + 12×−1)/24 = 0.5, oppose −1.
  check("the edge is agree minus oppose", news.edgePct === 1.5, news.edgePct);
  const few = dimensionAccuracy(rows.slice(0, DIMENSION_MIN_TRADES - 1));
  check("one short of the sample floor never scales", few.every((r) => r.scale === 1));
  const paper = rows.map((e) => ({ ...e, review_note: e.review_note!.replace("[自動追蹤]", "[自動追蹤][參考價位紙上追蹤]") }));
  check("paper rows teach nothing", dimensionAccuracy(paper).length === 0);

  const items = [item("技術面", "long", 2), item("技術面", "long", 1), item("新聞面", "long", 2), item("技術面", "neutral", 0)];
  const scaled = applyDimensionScales(items, rec);
  check("a halved dimension's items drop one weight step",
    scaled.items[0].weight === 1 && scaled.items[1].weight === 0 && scaled.items[2].weight === 2 && scaled.items[3].weight === 0, scaled.items.map((i) => i.weight));
  check("and say so on the factor", scaled.items[0].factor.includes("權重減半") && !scaled.items[2].factor.includes("減半"));
  check("the learning names the dimension", scaled.learning.scaled.includes("技術面") && scaled.learning.notes.length >= 1);
  check("no records, identity", applyDimensionScales(items, []).items === items);
}

{
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const builder = readFileSync(join(__dirname, "..", "lib", "signal-builder.ts"), "utf8");
  const autoLog = readFileSync(join(__dirname, "..", "lib", "journal", "auto-log.ts"), "utf8");
  check("auto-log stamps the dimension stances on every row", autoLog.includes("dimensionMarker(signal.direction"));
  const scaledAt = builder.indexOf("applyDimensionScales(deduped.items");
  const pickAt = builder.indexOf("pickDirection(biasItems)");
  check("the builder scales before the direction is picked, so side and score read the same evidence", scaledAt > 0 && scaledAt < pickAt);
  const card = readFileSync(join(__dirname, "..", "components", "signal-card.tsx"), "utf8");
  check("the card carries one learning strip", card.includes("<LearningStrip signal={signal} />") && card.includes("學習狀態"));
  check("and the working is collapsed under one section", card.includes('title="深入分析'));
}

report("dimension accuracy");
