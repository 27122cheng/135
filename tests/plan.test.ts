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
  // 5, not 2. The fallback used to take entryCandidates[0] — the current price
  // — giving 80/40. It now searches every combination, and the pullback entry
  // at 4100 against the same stop is 100/20. Both are real structures the
  // analysis produced; the old rule simply never looked at the better one.
  check("1 picks the best available payoff", p1.stance === "enter" && p1.risk_reward === 5,
    p1.risk_reward);
  check("1 uses the pullback entry that earned it", p1.entry === 4100, p1.entry);

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
  // This used to be a wait, and that was the bug rather than the feature:
  // entering at the current price gives 5/40, but the pullback entry at 4100
  // against the same stop gives 25/20 = 1.25, which clears the floor. The old
  // fallback refused a workable plan because it only ever examined one of the
  // three combinations — and `decideStance`, which does check them all, was
  // meanwhile saying "enter". The two now agree.
  check("3 finds the combination that clears 1:1", p3.stance === "enter", p3.summary);
  check("3 uses the pullback entry", p3.entry === 4100, p3.entry);
  check("3 reports the real ratio", p3.risk_reward === 1.25, p3.risk_reward);

  // A menu where *nothing* clears the floor must still refuse.
  const p4 = await buildTradePlan(
    {
      ...base,
      grade: "B",
      bias_score: 4,
      entry_structure_score: 4,
      total_score: 8,
      gradeForcesWait: false,
      entryCandidates: [{ price: 4120, label: "現價" }],
      tpCandidates: [{ price: 4125, label: "很近的前高" }],
    },
    gaps,
  );
  check("4 refuses when no combination clears 1:1", p4.stance === "wait" && p4.entry === null,
    p4.summary);

  // ── geometry is chosen on expectancy, not on the ratio ───────────
  //
  // The live board is what forced this: NAS100 came back at 1:9.38 with a local
  // hit rate of 13% — 30 wins in 230 — because maximising the ratio always
  // drifts to the furthest target. Nothing pushed back, so the plan read
  // beautifully and got stopped out six times in seven.
  {
    // A market that oscillates ±2% and never travels 10%: a near target fills
    // constantly, a far one essentially never does.
    const candles = Array.from({ length: 400 }, (_, i) => {
      const p = 4100 + Math.sin(i / 3) * 80;
      return {
        time: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
        open: p,
        high: p + 12,
        low: p - 12,
        close: p,
        volume: 1000,
      };
    });

    const menu = {
      ...base,
      grade: "A" as const,
      bias_score: 6,
      entry_structure_score: 5,
      total_score: 11,
      gradeForcesWait: false,
      entryCandidates: [{ price: 4100, label: "現價" }],
      slCandidates: [{ price: 4060, label: "結構外" }],
      tpCandidates: [
        { price: 4180, label: "近的前高" }, // 1:2, reachable
        { price: 4600, label: "很遠的前高" }, // 1:12.5, almost never
      ],
    };

    const blind = await buildTradePlan(menu, gaps);
    check("without history it still takes the best ratio", blind.risk_reward === 12.5,
      blind.risk_reward);
    check("and says that is why", blind.summary.includes("K 棒不足"), blind.summary);

    const informed = await buildTradePlan({ ...menu, candles }, gaps);
    check("with history it refuses the unreachable target", informed.take_profit === 4180,
      [informed.take_profit, informed.risk_reward]);
    check("the summary reports the win rate it chose on",
      informed.summary.includes("勝率"), informed.summary);
    check("and names the ratio it passed over",
      informed.summary.includes("賠率最高的一組是 1:12.5"), informed.summary);
  }

  // ── the fallback says why the AI was skipped ─────────────────────
  //
  // It used to say "未設定 AI 金鑰、額度用盡或呼叫失敗" — three guesses in one
  // sentence, leading with the one that blames the reader. The owner had set
  // the keys correctly; the cause was a spent free tier, and the message sent
  // them to check a setting that was never the problem.
  {
    const p = await buildTradePlan(
      { ...base, grade: "A", bias_score: 6, entry_structure_score: 5, total_score: 11,
        gradeForcesWait: false },
      gaps,
    );
    check("the fallback records a reason", typeof p.fallback_reason === "string",
      p.fallback_reason);
    check("and it is not the old three-guess sentence",
      !p.summary.includes("未設定 AI 金鑰、額度用盡或呼叫失敗"), p.summary);
    check("with no key configured it says exactly that",
      p.fallback_reason?.includes("未設定") === true, p.fallback_reason);
  }

  console.log("\nall assertions passed if no FAIL above");
}
void main().then(() => report("plan"));