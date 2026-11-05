import { check, report } from "./_harness";
import { SOURCE_FAMILIES, firstThreeFree, freeFirst } from "@/lib/data-sources/registry";

/** 資料來源登記簿 — free first, three free first choices per family. */

for (const f of SOURCE_FAMILIES) {
  const ordered = freeFirst(f);
  check(`${f.id}: a keyless free rung leads`, ordered[0].free && ordered[0].keyName === null || f.id === "ai", ordered[0]);
  const three = firstThreeFree(f);
  check(`${f.id}: the free first choices are all free`, three.every((e) => e.free) && three.length <= 3, three.map((e) => e.id));
  check(`${f.id}: ids are unique`, new Set(f.ladder.map((e) => e.id)).size === f.ladder.length);
}
const ohlcv = SOURCE_FAMILIES.find((f) => f.id === "ohlcv")!;
check("OHLCV leads with Yahoo then Stooq", firstThreeFree(ohlcv).slice(0, 2).map((e) => e.id).join(",") === "yahoo-proxy,stooq");
const valuation = SOURCE_FAMILIES.find((f) => f.id === "valuation")!;
check("valuation has exactly three keyless rungs", valuation.ladder.length === 3 && valuation.ladder.every((e) => e.keyName === null));
const ai = SOURCE_FAMILIES.find((f) => f.id === "ai")!;
check("the paid AI rung sorts last", freeFirst(ai)[freeFirst(ai).length - 1].id === "anthropic");
check("every family says what it answers", SOURCE_FAMILIES.every((f) => f.answers.length > 0));
report("registry");
