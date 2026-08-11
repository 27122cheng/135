import { STOP_REASON_LABELS, type StopReasonTag, type TagStat } from "@/types/journal";

/**
 * 風控與停損建議 — the journal's history turned into instructions.
 *
 * The stop-review loop already *acts* on repeated failure causes (see
 * interventions.ts: repeated S3 widens every future stop, repeated S7 forces
 * no-trade on macro conflict). What it never did was *say* anything a person
 * could carry to the next trade. The donut chart showed that S3 dominated;
 * nobody was told "your stops are structurally too tight, and the engine has
 * already moved its buffer to 1×ATR — stop overriding it downward."
 *
 * So each line here pairs the two: what the trader should do differently, and
 * what the engine already does automatically once the pattern crosses the
 * intervention thresholds. Rule-generated from the same TagStats the
 * interventions read — same inputs, same answer, no AI in the loop.
 */

export interface RiskAdvice {
  /** Which failure cause this addresses; null for the always-on baseline rules. */
  tag: StopReasonTag | null;
  title: string;
  /** What to do about it, addressed to the person following the signals. */
  detail: string;
  /** The observed history that earned this line a place on the page. */
  basedOn: string | null;
  /** What the engine already enforces for this cause once thresholds trip. */
  automated: string | null;
  /** True when that automatic tightening is live right now. */
  active: boolean;
}

/** Per-cause guidance. `automated` mirrors interventions.ts exactly — if the
 * effects there change, these strings are the user-facing contract to update. */
const TAG_GUIDANCE: Record<StopReasonTag, { detail: string; automated: string | null }> = {
  S1: {
    detail:
      "方向判斷本身出錯的比例偏高。進場前檢查卡片上的反向因子清單：同向面向少於 3 個、或有任何面向明確反向時，把部位減半或放棄這筆。",
    automated: "bias_score 門檻整體 +2 — 方向證據不夠強的訊號自動降等。",
  },
  S2: {
    detail:
      "追價進場是可事前預防的虧損。只在進場區間內掛單，價格跑掉就讓它跑掉 — 錯過的交易成本是零，追進去的交易成本是整筆停損。",
    automated: "進場區間收窄 30%，且強制要求回測確認因子後才給進場。",
  },
  S3: {
    detail:
      "結構抓對但停損放在雜訊裡被掃。停損永遠放在結構外加緩衝，不要因為想縮小虧損金額而手動往回移 — 縮風險的正確做法是減部位，不是縮停損。",
    automated: "停損的結構外緩衝由 0.5×ATR 自動放寬到 1.0×ATR。",
  },
  S4: {
    detail:
      "數據公布前後的行情不是技術面能預測的。重大數據（CPI、非農、利率決議）前 24 小時內不開新倉，已有部位考慮先減半。",
    automated: "24 小時內有高影響力數據時，新訊號評等自動降一級。",
  },
  S5: {
    detail:
      "滑價與點差在流動性差的時段會吃掉停損的精度。只在倫敦與紐約主時段（UTC 07:00–21:00）執行訊號，亞洲深夜時段的訊號當參考就好。",
    automated: "非主要交易時段產生的訊號自動降一級。",
  },
  S6: {
    detail:
      "沒照規則進場的虧損，系統救不了。這一類的每一筆都值得寫下當時為什麼偏離 — 通常答案是前一筆的情緒還沒結清。",
    automated: null,
  },
  S7: {
    detail:
      "技術面訊號跟總經方向對撞時，總經通常贏。卡片上基本面那一列反向時，這筆最多只做半倉，或等基本面轉向。",
    automated: "基本面方向與訊號明確相反時，直接改為 no-trade。",
  },
  S8: {
    detail:
      "COT 極端部位是市場用真金白銀投的票。籌碼面反向時降低槓桿，尤其在部位擁擠的極端讀數附近不要逆勢加倉。",
    automated: "COT 處於極端且方向相反時，直接改為 no-trade。",
  },
};

/** Always shown — the floor that doesn't depend on what went wrong lately. */
const BASELINE: RiskAdvice[] = [
  {
    tag: null,
    title: "單筆風險上限",
    detail:
      "每筆交易的停損金額不超過帳戶的 1–2%。系統給的是價位，部位大小是你的事：部位 = 可承受虧損 ÷（進場價 − 停損價）。",
    basedOn: null,
    automated: null,
    active: false,
  },
  {
    tag: null,
    title: "停損只進不退",
    detail:
      "進場後停損只能往獲利方向收緊（加倉規則會給新停損價），永遠不往虧損方向放寬。想給交易多一點空間的正確時機是進場前，不是被套之後。",
    basedOn: null,
    automated: "加倉點都附帶收緊後的新停損價，且引擎的干涉規則只會收緊、不會放寬。",
    active: true,
  },
  {
    tag: null,
    title: "訊號失效就出場",
    detail:
      "每個停損都寫了失效條件（哪個結構破了代表判斷錯了）。條件成立就出場，不等價格碰到停損價 — 停損價是最後防線，不是目標。",
    basedOn: null,
    automated: null,
    active: false,
  },
];

/**
 * Turns the recent tag history into an ordered advice list: baseline rules
 * first, then one line per failure cause actually observed, worst first.
 * A cause that never happened produces nothing — advice about hypothetical
 * mistakes is noise wearing a safety vest.
 */
export function buildRiskAdvice(
  recentTagStats: TagStat[],
  activeInterventions: TagStat[],
): RiskAdvice[] {
  const activeTags = new Set(activeInterventions.map((t) => t.tag));
  const observed = [...recentTagStats]
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count || b.avgSeverity - a.avgSeverity);

  const lines: RiskAdvice[] = observed.map((s) => {
    const g = TAG_GUIDANCE[s.tag];
    return {
      tag: s.tag,
      title: `${s.tag} ${STOP_REASON_LABELS[s.tag]}`,
      detail: g.detail,
      basedOn: `近 30 筆內出現 ${s.count} 次，平均 severity ${s.avgSeverity}，累積虧損 ${s.cumulativeLossPct}%`,
      automated: g.automated,
      active: activeTags.has(s.tag),
    };
  });

  return [...BASELINE, ...lines];
}
