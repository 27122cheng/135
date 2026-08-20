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

  // 1. Healthy grade, good payoff — but no candles, so the floor cannot be
  // demonstrated. 未達門檻一律觀望 applies to "unverifiable" too: an
  // expectancy that cannot be measured is not an expectancy.
  const p1 = await buildTradePlan(
    { ...base, grade: "A", bias_score: 6, entry_structure_score: 5, total_score: 11, gradeForcesWait: false },
    gaps,
  );
  console.log("1 stance:", p1.stance, "|", p1.summary.slice(0, 60));
  check("1 an unverifiable floor waits", p1.stance === "wait" && p1.entry === null, p1.summary);
  check("1 and names the expectancy floor", p1.summary.includes("0.75R"), p1.summary);

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
  // The best combination here is the pullback entry at 1.25R — which used to
  // clear the old 1:1 floor. The operator's floor is now 1:1.5, so this whole
  // menu is a refusal, and the summary says which floor refused it.
  check("3 a 1.25R best is below the 1.5R floor", p3.stance === "wait", p3.summary);
  check("3 and the floor is named", p3.summary.includes("1.5"), p3.summary);

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
  check("4 refuses when no combination clears 1:1.5", p4.stance === "wait" && p4.entry === null,
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
    check("without history the floor is unverifiable, so it waits",
      blind.stance === "wait", blind.summary);

    // With history the oscillation resolves plenty of samples, but nothing
    // near 70% — the menu waits and the summary carries the measured number.
    const informed = await buildTradePlan({ ...menu, candles }, gaps);
    check("a measurable market below the floor also waits",
      informed.stance === "wait", informed.summary);
    check("with the measured hit rate in the refusal",
      informed.summary.includes("勝率"), informed.summary);
  }

  // ── the floor is passable, not decorative ────────────────────────
  //
  // A steady trend with a stop outside the daily noise: the same rules that
  // refuse everything above must let this one through, or the floor is not a
  // floor but a shutdown. (A sub-ATR stop here would fail honestly — the
  // managed walk scratches it at breakeven over and over, exactly as the
  // monitor would live.)
  {
    const trend = Array.from({ length: 400 }, (_, i) => {
      const p = 53000 + i * 40 + Math.sin(i / 7) * 150;
      return {
        time: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
        open: p, high: p + 260, low: p - 260, close: p, volume: 1000,
      };
    });
    const last = trend[trend.length - 1].close;
    const p = await buildTradePlan(
      {
        ...base,
        grade: "A" as const,
        bias_score: 6, entry_structure_score: 5, total_score: 11,
        gradeForcesWait: false,
        entryCandidates: [{ price: last, label: "現價" }],
        slCandidates: [{ price: last - 800, label: "結構外" }],
        tpCandidates: [{ price: last + 1200, label: "前高" }],
        candles: trend,
        atr: 700,
      },
      gaps,
    );
    check("a demonstrated managed edge still enters", p.stance === "enter", p.summary);
    check("at the operator's minimum payoff or better", (p.risk_reward ?? 0) >= 1.5,
      p.risk_reward);
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