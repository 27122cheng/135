import { check, report } from "./_harness";
import { buildTradePlan } from "@/lib/analysis/trade-plan";

const cands = {
  entryCandidates: [{ price: 4120, label: "現價" }, { price: 4100, label: "回測" }],
  slCandidates: [{ price: 4080, label: "結構外" }],
  tpCandidates: [{ price: 4200, label: "前高" }],
};

const base = {
  symbol: "XAUUSD",
  direction: "long" as const,
  bias_items: [],
  narrative: "test",
  knownGaps: [],
  ...cands,
};

async function main() {
  const gaps: string[] = [];
  delete process.env.ANTHROPIC_API_KEY;

  // 1. Healthy grade, good R:R -> enter.
  const p1 = await buildTradePlan(
    { ...base, grade: "A", bias_score: 6, entry_structure_score: 5, total_score: 11, gradeForcesWait: false },
    gaps,
  );
  console.log("1 stance:", p1.stance, p1.entry, p1.stop_loss, p1.take_profit, "RR", p1.risk_reward);
  check("1", p1.stance === "enter" && p1.risk_reward === 2);

  // 2. no-trade grade -> must be wait, with a wait_for.
  const p2 = await buildTradePlan(
    { ...base, grade: "no-trade", bias_score: 3, entry_structure_score: 11, total_score: 14, gradeForcesWait: true },
    gaps,
  );
  console.log("2 stance:", p2.stance, "| wait_for:", p2.wait_for);
  check("2", p2.stance === "wait" && p2.entry === null && !!p2.wait_for);

  // 3. Bad risk:reward (risk 40, reward 5) -> wait even though grade is fine.
  const p3 = await buildTradePlan(
    {
      ...base,
      grade: "B",
      bias_score: 4,
      entry_structure_score: 4,
      total_score: 8,
      gradeForcesWait: false,
      tpCandidates: [{ price: 4125, label: "很近的前高" }],
    },
    gaps,
  );
  console.log("3 stance:", p3.stance, "|", p3.summary.slice(0, 40));
  check("3 should refuse bad R:R", p3.stance === "wait" && p3.entry === null);

  console.log("\nall assertions passed if no FAIL above");
}
void main().then(() => report("plan"));