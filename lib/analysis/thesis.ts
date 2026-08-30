import type { BiasItem, EntryStructure } from "@/types/signal";
import { summariseRegime, type RegimeSummary } from "./regime-summary";

/**
 * 論點 — the reasoning layer between the evidence and the plan.
 *
 * ## What was missing
 *
 * The analyzers produced a weighted sum of six dimensions and a grade. That
 * is a *score*, not an analysis, and four things a working trader does were
 * absent from it:
 *
 * 1. **行情性質**. The system computed the efficiency ratio and the daily
 *    structure and then applied one playbook regardless of the answer.
 *    Trend-following entries in a range are precisely what gets chopped up;
 *    reading the regime and not changing behaviour is worse than not reading
 *    it, because it looks like diligence.
 * 2. **面向互相制約**. Six votes were summed in parallel. But a rate
 *    differential pointing against the daily tape is usually already in the
 *    price, positioning data published three days late is systematically
 *    wrong at exactly the turns that matter, and a news score decays within
 *    hours unless a release is imminent. Summing them flat lets weak,
 *    stale evidence cancel strong, fresh evidence — the live symptom being
 *    「六面向淨方向票數為 0（多空因子權重相抵）」 on symbol after symbol.
 * 3. **反證條件**. Every signal argued its case and none stated what would
 *    prove it wrong. Half of professional analysis is writing the
 *    invalidation down *before* the position exists, because afterwards
 *    the mind negotiates.
 * 4. **推理過程**. The card showed conclusions and scores. A reader could
 *    not follow "because A and B, therefore C, unless D".
 *
 * ## What this module is, and is not
 *
 * Pure and defensive, like regime-summary.ts: it renders from rows written
 * by older builds, so every input is treated as unknown-shaped and a missing
 * field produces a smaller thesis rather than a crash.
 *
 * It never invents evidence. Every claim it makes quotes a factor that an
 * analyzer actually emitted, or a level that actually exists. Where the
 * evidence is absent the step says so instead of reasoning past it.
 *
 * It can only *subtract* conviction — the established rule for every gate in
 * this codebase. A context that erodes the case produces a stated penalty; a
 * context that flatters it produces nothing, because the flattering case is
 * already fully counted in the raw score.
 */

export type Regime = "trending" | "ranging" | "transitional" | "unknown";

/**
 * The same thresholds lib/analysis/technical.ts already prints in its own
 * factor text (ER < 0.18 盤整, ER ≥ 0.35 趨勢行進中). Reused rather than
 * re-chosen so the regime label and the technical factor can never disagree
 * on screen about the same number.
 */
export const ER_RANGING = 0.18;
export const ER_TRENDING = 0.35;

export interface Playbook {
  regime: Regime;
  /** 行情性質, in words. */
  regimeLabel: string;
  /** What to do in this regime — the playbook name. */
  label: string;
  entryStyle: "pullback" | "fade" | "stand-aside";
  /** Why this playbook belongs to this regime. */
  rationale: string;
  /**
   * How far a target may reasonably sit, in ATR, under this regime. A range
   * has a ceiling by definition; a trend does not.
   */
  maxTargetAtr: number;
  /** True when the signal's direction fights the regime it is trading in. */
  fightsRegime: boolean;
  fightNote: string | null;
  /** Suggested size treatment, in words — never a number of lots. */
  sizeNote: string | null;
}

export interface ConditionalWeight {
  dimension: string;
  factor: string;
  /** The vote as the scorer counted it, signed toward the signal direction. */
  raw: number;
  multiplier: number;
  effective: number;
  /** Why this context raised or lowered it. Always populated. */
  why: string;
}

export interface Invalidation {
  kind: "price" | "structure" | "regime" | "event";
  /** The observable thing that would happen. */
  trigger: string;
  /** What its happening would prove. */
  meaning: string;
}

export interface ReasoningStep {
  /** 行情性質 / 方向 / 打法 / 進場 / 風險 */
  step: string;
  claim: string;
  evidence: string[];
}

export interface Thesis {
  playbook: Playbook;
  conditional: ConditionalWeight[];
  /** Raw net vote toward the direction, before context. */
  rawBias: number;
  /** Net vote after the context multipliers. */
  adjustedBias: number;
  /**
   * Downgrade-only: how much conviction the context removed, rounded. Zero
   * when context confirmed or was neutral — a flattering context adds
   * nothing, because it is already counted in the raw score.
   */
  convictionPenalty: number;
  invalidations: Invalidation[];
  reasoning: ReasoningStep[];
}

export interface ThesisInput {
  direction: "long" | "short";
  directionTie: boolean;
  biasItems: readonly BiasItem[] | null | undefined;
  entryStructures?: readonly EntryStructure[] | null;
  /** D1 ATR, for expressing invalidation distances in the risk unit. */
  atr?: number | null;
  price?: number | null;
  /** The plan's own levels, when one exists — invalidations quote them. */
  plan?: { entry: number | null; stopLoss: number | null; takeProfit: number | null } | null;
  /** Minutes to the next clock-derivable high-impact release, when inside one. */
  eventMinutesAway?: number | null;
  eventLabel?: string | null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** ER as a number, parsed out of the factor text the analyzer emitted. */
function efficiencyOf(regime: RegimeSummary): number | null {
  const parsed = Number.parseFloat(regime.efficiency.label);
  return Number.isFinite(parsed) ? parsed : null;
}

export function classifyRegime(regime: RegimeSummary): Regime {
  const er = efficiencyOf(regime);
  if (er === null) return "unknown";
  if (er < ER_RANGING) return "ranging";
  // A high efficiency ratio with no structural direction is a straight line
  // nobody can name the side of — that is not a trend to follow.
  if (er >= ER_TRENDING && regime.structure.tone !== "neutral") return "trending";
  return "transitional";
}

const REGIME_LABEL: Record<Regime, string> = {
  trending: "趨勢行進中",
  ranging: "盤整（區間來回）",
  transitional: "過渡帶（趨勢未成形）",
  unknown: "無法判定（缺趨勢資料）",
};

function buildPlaybook(
  input: ThesisInput,
  regime: RegimeSummary,
  kind: Regime,
): Playbook {
  const withTrend = regime.structure.tone === input.direction;
  const against = regime.structure.tone !== "neutral" && !withTrend;
  const base = { regime: kind, regimeLabel: REGIME_LABEL[kind] };

  if (kind === "trending") {
    if (against) {
      return {
        ...base,
        label: "逆勢 —— 不該用順勢打法",
        entryStyle: "stand-aside",
        rationale:
          "日線結構有明確方向，而這個訊號站在它的對面。趨勢中的逆勢單面對的是" +
          "順勢資金的持續買賣盤，回踩支撐在趨勢裡通常會被穿越。",
        maxTargetAtr: 2,
        fightsRegime: true,
        fightNote:
          `日線結構為${regime.structure.label}，訊號方向為${input.direction === "long" ? "做多" : "做空"}` +
          `——逆勢單需要更強的證據，且目標要收得比順勢更近。`,
        sizeNote: "逆勢單倉位應明顯小於順勢單，或直接等結構翻轉再做。",
      };
    }
    return {
      ...base,
      label: "順勢回踩進場",
      entryStyle: "pullback",
      rationale:
        "趨勢行進中的邊際買賣盤在同一個方向，回踩到結構是加入的機會而不是反轉訊號。" +
        "目標可以放遠，因為趨勢沒有天花板；追高則沒有必要，回踩會來。",
      maxTargetAtr: 5,
      fightsRegime: false,
      fightNote: null,
      sizeNote: null,
    };
  }

  if (kind === "ranging") {
    return {
      ...base,
      label: "區間兩端反轉，不追中間",
      entryStyle: "fade",
      rationale:
        "效率比落在盤整區，價格在區間內來回。這種行情裡順勢突破多是假突破，" +
        "而區間兩端的反轉有真實的對手盤。目標必須收在區間內 —— 盤整市的天花板是區間本身。",
      maxTargetAtr: 2,
      fightsRegime: false,
      fightNote: null,
      sizeNote: "盤整市的獲利空間受限於區間寬度，倉位與目標都該比趨勢市小。",
    };
  }

  if (kind === "transitional") {
    return {
      ...base,
      label: "過渡帶 —— 等方向確立",
      entryStyle: "stand-aside",
      rationale:
        "效率比在盤整與趨勢之間：既沒有區間兩端可以反轉，也沒有成形的趨勢可以跟隨。" +
        "這是唯一一種「兩套打法都不適用」的行情，最好的處理是減碼或等待。",
      maxTargetAtr: 2,
      fightsRegime: false,
      fightNote: null,
      sizeNote: "過渡帶的訊號應以較小倉位處理，或等結構明確再進場。",
    };
  }

  return {
    ...base,
    label: "行情性質不明",
    entryStyle: "stand-aside",
    rationale: "缺少趨勢效率比或日線結構資料，無法判定行情性質，也就無法選定打法。",
    maxTargetAtr: 2,
    fightsRegime: false,
    fightNote: null,
    sizeNote: "行情性質未知時，倉位應保守處理。",
  };
}

/**
 * 面向互相制約 — the context multipliers.
 *
 * Each rule states the market reason it exists. These are discounts only:
 * no rule multiplies above 1 except the event-window rule for news, where a
 * scheduled release genuinely does make the same headline move size — and
 * even that is bounded, and the aggregate result is only ever used to
 * *subtract* conviction (see `convictionPenalty`).
 *
 * Deliberately separate from `CORROBORATING_CAP` in lib/scoring.ts, which is
 * an aggregate ceiling on the lagging dimensions. That cap answers "how much
 * may stale data ever matter"; this answers "does this particular vote
 * deserve its weight in *this* market". Both can be true at once.
 */
function conditionalWeights(
  input: ThesisInput,
  regime: RegimeSummary,
  kind: Regime,
): ConditionalWeight[] {
  const list = Array.isArray(input.biasItems) ? input.biasItems.filter(Boolean) : [];
  const trendTone = regime.structure.tone;
  const inEvent = typeof input.eventMinutesAway === "number" && input.eventMinutesAway >= 0;

  return list.map((item) => {
    const dimension = str((item as { dimension?: unknown }).dimension);
    const factor = str((item as { factor?: unknown }).factor);
    const dir = str((item as { direction?: unknown }).direction);
    const weight = num((item as { weight?: unknown }).weight);
    // Signed toward the signal's own direction: a vote for the other side is
    // negative, a neutral reading is zero.
    const raw = dir === input.direction ? weight : dir === "long" || dir === "short" ? -weight : 0;

    let multiplier = 1;
    let why = "此面向在目前行情下按原權重計算";

    // 利差 is emitted *inside* 基本面 (its factor is the spread's own label,
    // e.g. 「2Y 德美利差」), so it is identified by the factor text rather
    // than by a dimension that does not exist. Keying on a dimension name
    // the analyzers never emit is a rule that silently never fires — which
    // is exactly what the first cut of this function did.
    const isRateSpread = dimension === "基本面" && /利差/.test(factor);

    if (isRateSpread && trendTone !== "neutral" && dir !== "" && dir !== trendTone) {
      multiplier = 0.5;
      why =
        "利差方向與日線趨勢相反 —— 日線級別的利差差異多半已反映在價格上，" +
        "它是未來均值回歸的理由，不是現在對抗盤面的理由";
    } else if (dimension === "基本面" && kind === "ranging") {
      multiplier = 0.5;
      why = "盤整行情：基本面決定的是幾週後的方向，不負責挑進場點，此處降權";
    } else if ((dimension === "籌碼面" || dimension === "資金流") && kind === "trending") {
      multiplier = 0.5;
      why =
        "趨勢行進中：這類部位資料落後三天以上，在趨勢剛轉向時系統性地站在錯的一邊，" +
        "此處降權（與 scoring 的佐證層上限是兩件事：那是總量天花板，這是情境折扣）";
    } else if (dimension === "新聞面" && !inEvent) {
      multiplier = 0.7;
      why = "非數據窗口：新聞情緒衰減得快，沒有排程事件推動時降權";
    } else if (dimension === "新聞面" && inEvent) {
      multiplier = 1.2;
      why = `數據窗口內（${input.eventLabel ?? "排程數據"}），同一則消息的影響力放大`;
    } else if (dimension === "技術面" && kind === "ranging" && /EMA|主趨勢|結構/.test(factor)) {
      multiplier = 0.6;
      why = "盤整市：均線與結構訊號會被區間反覆穿越，是這種行情裡最常見的假訊號來源";
    }

    return {
      dimension,
      factor,
      raw: Math.round(raw * 100) / 100,
      multiplier,
      effective: Math.round(raw * multiplier * 100) / 100,
      why,
    };
  });
}

/**
 * 反證條件 — what would prove this wrong, written before the position exists.
 *
 * Only from things that actually exist: a level the plan already carries, a
 * structure the analyzer already found, a regime number already computed, a
 * release whose time is arithmetic. Nothing here is a guess about the future.
 */
function buildInvalidations(
  input: ThesisInput,
  regime: RegimeSummary,
  kind: Regime,
): Invalidation[] {
  const out: Invalidation[] = [];
  const long = input.direction === "long";
  const fmt = (n: number) => (Math.abs(n) < 10 ? n.toFixed(5) : n.toFixed(2));

  const stop = input.plan?.stopLoss;
  if (typeof stop === "number" && Number.isFinite(stop)) {
    out.push({
      kind: "price",
      trigger: `日線收盤${long ? "跌破" : "站上"} ${fmt(stop)}`,
      meaning:
        "進場所依據的保護結構已經失效 —— 不是「再等等」，是這個論點的前提沒有了。" +
        "監控會在這裡出場，不需要人工判斷。",
    });
  }

  out.push({
    kind: "structure",
    trigger: `日線出現反向 CHoCH（${long ? "跌破前一個低點" : "站上前一個高點"}確認結構翻轉）`,
    meaning:
      "技術面的看法本身改變了。管理規則會以市價出場，不等停損 —— " +
      "回測量的也是這條規則，所以這不是臨時決定。",
  });

  const er = efficiencyOf(regime);
  if (kind === "trending" && er !== null) {
    out.push({
      kind: "regime",
      trigger: `趨勢效率比 ER(20) 由 ${er} 跌破 ${ER_RANGING}`,
      meaning:
        "行情從趨勢轉入盤整，順勢回踩的打法失去前提：盤整市裡回踩支撐會被反覆穿越。" +
        "此時應收緊目標或退出。",
    });
  }
  if (kind === "ranging" && er !== null) {
    out.push({
      kind: "regime",
      trigger: `趨勢效率比 ER(20) 由 ${er} 升破 ${ER_TRENDING}`,
      meaning:
        "區間被真突破，行情轉入趨勢。區間兩端反轉的打法失效 —— " +
        "在趨勢裡做反轉，就是站在持續買賣盤的對面。",
    });
  }

  if (regime.weekly.tone !== "neutral") {
    const weeklyAgainst = regime.weekly.tone !== input.direction;
    out.push({
      kind: "regime",
      trigger: `週線方向由${regime.weekly.label}翻向另一側（W1 EMA20 與週線擺動同時改變）`,
      meaning: weeklyAgainst
        ? "週線本來就與這個方向相反；若它進一步確立，逆勢的代價會變大。"
        : "大方向的支撐消失，這筆交易從順勢變成逆勢，理由的強度會明顯下降。",
    });
  }

  if (typeof input.eventMinutesAway === "number" && input.eventMinutesAway >= 0) {
    out.push({
      kind: "event",
      trigger: `${input.eventLabel ?? "排程數據"}公布（${input.eventMinutesAway} 分鐘後）`,
      meaning:
        "數據可以在幾分鐘內重設整個格局，技術結構在那幾根 K 棒上沒有預測力。" +
        "系統在公布前 2 小時內不建立新倉。",
    });
  }

  return out;
}

function buildReasoning(
  input: ThesisInput,
  regime: RegimeSummary,
  playbook: Playbook,
  conditional: ConditionalWeight[],
  rawBias: number,
  adjustedBias: number,
): ReasoningStep[] {
  const steps: ReasoningStep[] = [];
  const dirWord = input.directionTie
    ? "中性"
    : input.direction === "long"
      ? "做多"
      : "做空";

  // 1. 行情性質 — read first, because it decides which playbook applies.
  const regimeEvidence: string[] = [];
  if (regime.efficiency.label !== "—") {
    regimeEvidence.push(
      `趨勢效率比 ER(20) = ${regime.efficiency.label}${regime.efficiency.detail ? `（${regime.efficiency.detail}）` : ""}`,
    );
  }
  if (regime.structure.label !== "—") {
    regimeEvidence.push(`日線結構：${regime.structure.label}${regime.structure.detail ? `，${regime.structure.detail}` : ""}`);
  }
  if (regime.weekly.label !== "—") regimeEvidence.push(`週線：${regime.weekly.label}`);
  steps.push({
    step: "① 行情性質",
    claim: `${playbook.regimeLabel}`,
    evidence: regimeEvidence.length > 0 ? regimeEvidence : ["缺少趨勢效率比與日線結構資料"],
  });

  // 2. 打法 — follows from the regime, not from the direction.
  steps.push({
    step: "② 該用什麼打法",
    claim: playbook.label,
    evidence: [playbook.rationale, ...(playbook.sizeNote ? [playbook.sizeNote] : [])],
  });

  // 3. 方向 — with the context adjustment made explicit.
  const supporting = conditional
    .filter((c) => c.effective > 0)
    .sort((a, b) => b.effective - a.effective)
    .slice(0, 3)
    .map((c) => `${c.dimension}：${c.factor}`);
  const opposing = conditional
    .filter((c) => c.effective < 0)
    .sort((a, b) => a.effective - b.effective)
    .slice(0, 2)
    .map((c) => `（反向）${c.dimension}：${c.factor}`);
  const discounted = conditional
    .filter((c) => c.multiplier < 1 && c.raw !== 0)
    .slice(0, 3)
    .map((c) => `${c.dimension} ×${c.multiplier}：${c.why}`);
  steps.push({
    step: "③ 方向與強度",
    claim: input.directionTie
      ? "多空因子相抵，沒有方向可言"
      : `${dirWord}，情境調整後淨分 ${adjustedBias}${
          adjustedBias !== rawBias ? `（原始 ${rawBias}）` : ""
        }`,
    evidence: [...supporting, ...opposing, ...discounted].length > 0
      ? [...supporting, ...opposing, ...discounted]
      : ["沒有任何面向給出方向票"],
  });

  // 4. 進場 — the concrete level, when the plan produced one.
  if (input.plan?.entry != null) {
    const fmt = (n: number) => (Math.abs(n) < 10 ? n.toFixed(5) : n.toFixed(2));
    const nearby = (input.entryStructures ?? [])
      .filter((s) => {
        const role = str((s as { role?: unknown }).role);
        return input.direction === "long" ? role === "support" : role === "resistance";
      })
      .slice(0, 2)
      .map((s) => `${str((s as { timeframe?: unknown }).timeframe)} ${str((s as { type?: unknown }).type)} @ ${fmt(num((s as { price?: unknown }).price))}`);
    steps.push({
      step: "④ 進場與保護",
      claim:
        `進場 ${fmt(input.plan.entry)}` +
        (input.plan.stopLoss != null ? `，停損 ${fmt(input.plan.stopLoss)}` : "") +
        (input.plan.takeProfit != null ? `，停利 ${fmt(input.plan.takeProfit)}` : ""),
      evidence:
        nearby.length > 0
          ? [`保護結構：${nearby.join("、")}`, `打法：${playbook.entryStyle === "pullback" ? "等回踩，不追價" : playbook.entryStyle === "fade" ? "在區間端點反手" : "本行情不建議主動進場"}`]
          : ["進場價位由結構搜尋選出，附近沒有可引用的保護結構"],
    });
  }

  return steps;
}

/**
 * Just the playbook, for callers that need it *before* a plan exists — the
 * geometry search asks "how far may a target sit in this market" and the
 * answer depends only on the regime and the direction, never on the levels
 * the search is about to pick.
 */
export function playbookFor(input: ThesisInput): Playbook {
  const regime = summariseRegime(input.biasItems);
  return buildPlaybook(input, regime, classifyRegime(regime));
}

export function buildThesis(input: ThesisInput): Thesis {
  const regime = summariseRegime(input.biasItems);
  const kind = classifyRegime(regime);
  const playbook = buildPlaybook(input, regime, kind);
  const conditional = conditionalWeights(input, regime, kind);

  const rawBias = Math.round(conditional.reduce((s, c) => s + c.raw, 0) * 100) / 100;
  const adjustedBias = Math.round(conditional.reduce((s, c) => s + c.effective, 0) * 100) / 100;
  // Subtract-only, the rule every gate in this codebase follows: context that
  // erodes the case costs conviction, context that flatters it costs nothing
  // because the flattering reading is already fully counted in the raw score.
  const convictionPenalty = Math.max(0, Math.round((rawBias - adjustedBias) * 100) / 100);

  return {
    playbook,
    conditional,
    rawBias,
    adjustedBias,
    convictionPenalty,
    invalidations: buildInvalidations(input, regime, kind),
    reasoning: buildReasoning(input, regime, playbook, conditional, rawBias, adjustedBias),
  };
}
