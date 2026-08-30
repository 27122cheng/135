/**
 * Core data contracts for the trading-signal engine.
 * Field names/values mirror the Stage 1 spec exactly — do not rename.
 */

import type { AppliedIntervention } from "./journal";

/**
 * H4 / D1 / W1 only. Intraday below 4h is deliberately out of scope: the free
 * data tier is end-of-day or 15-minute-delayed, and a 15-minute-old M15 candle
 * is worse than useless for a decision — it looks current and isn't.
 */
export type Timeframe = "H4" | "D1" | "W1";

export type BiasDimension =
  | "技術面"
  | "基本面"
  | "籌碼面"
  | "新聞面"
  | "資金流"
  | "AI綜合";

export interface BiasItem {
  dimension: BiasDimension;
  /** e.g. "H4 結構高點抬升" */
  factor: string;
  direction: "long" | "short" | "neutral";
  /** 2=強 1=一般 0=僅參考 */
  weight: 0 | 1 | 2;
  /** 必須是具體數值，不准寫空話 */
  evidence: string;
  /** 哪個 API / 哪根 K棒 */
  source: string;
  /**
   * What is being *measured*, not where it was measured from.
   *
   * Two items sharing a key are one fact and collapse to one vote — see
   * lib/analysis/evidence.ts. This exists because 基本面 and 資金流 were both
   * reading the same VIX print, with the same thresholds and the same direction
   * rule, and `bias_score` counted it twice.
   *
   * Optional so signals written before it are still readable; an item without
   * one falls back to dimension+factor, which can only ever merge with itself.
   */
  key?: string;
}

export type EntryStructureType =
  | "前低"
  | "前高"
  | "供給區"
  | "需求區"
  | "日線S/R"
  | "週線S/R"
  | "整數關卡"
  | "VWAP"
  | "EMA"
  | "趨勢線"
  | "未填缺口"
  | "高成交量節點"
  // 圖形交易: the neckline of a confirmed pattern, which by definition has been
  // broken and retested — that is exactly what a protecting structure is.
  | "型態頸線";

/** 進場點的「同向」結構 — 這是加分項 */
export interface EntryStructure {
  price: number;
  type: EntryStructureType;
  role: "support" | "resistance";
  timeframe: Timeframe;
  /** 被測試次數決定 */
  strength: 1 | 2 | 3;
  /** 距進場價百分比 */
  distance_pct: number;
}

/** 進場到停利路徑上的「反向」障礙 — 只用來擺 TP，不影響等級 */
export interface PathObstacle {
  price: number;
  type: string;
  timeframe: Timeframe;
  strength: 1 | 2 | 3;
}

/** 圖形交易 — the classical chart patterns the engine looks for. */
export type PatternName =
  | "頭肩頂"
  | "頭肩底"
  | "雙重頂"
  | "雙重底"
  | "三重頂"
  | "三重底"
  | "圓頂"
  | "圓底"
  // A V's neckline is the swing before the final leg — the base the spike
  // launched from. It is a level like any other, so a V confirms like any other.
  | "V頂"
  | "V底"
  | "對稱三角形"
  | "上升三角形"
  | "下降三角形"
  | "擴散三角形"
  | "上升楔形"
  | "下降楔形"
  | "菱形"
  | "矩形"
  | "通道"
  | "旗形"
  | "尖旗形";

/** One confirmation gate and whether this pattern has cleared it. */
export interface PatternCheck {
  label: string;
  passed: boolean;
  /** The arithmetic, so the verdict can be argued with rather than trusted. */
  detail: string;
}

export interface ChartPattern {
  name: PatternName;
  /** Whether the shape turns the trend or continues it. */
  kind: "reversal" | "continuation" | "either";
  /** Where it points if it breaks as the shape suggests. */
  direction: "long" | "short";
  timeframe: Timeframe;
  /** The neckline or boundary a close must clear. */
  breakout_level: number;
  /** Beyond this the shape is wrong — the head, or the far boundary. */
  invalidation_level: number;
  /**
   * Measured move: the pattern's own height projected from the broken line.
   * For 頭肩頂/底 the head sets that height; for a reversal triangle the
   * triangle's extreme does.
   */
  target: number;
  /** How `target` was arrived at, in full. */
  target_basis: string;
  /**
   * `confirmed` is the only status that may produce a trade — it means the
   * break closed beyond the line, carried volume (or range, where the
   * instrument has no volume), and the retest came back and held.
   */
  status: "forming" | "broken_out" | "confirmed" | "failed";
  checks: PatternCheck[];
  /** First and last bar of the shape. */
  from: string;
  to: string;
  bars: number;
  strength: 1 | 2 | 3;
  note: string;
}

export type Grade = "A+" | "A" | "B" | "C" | "no-trade";

/** One headline the analysis actually read. */
export interface NewsSource {
  headline: string;
  domain: string;
  url: string;
  datetime: string;
}

/**
 * A takeaway the AI drew from the headlines.
 *
 * `sources` holds indices into `NewsDigest.sources`, validated against the list
 * the model was shown — same constraint as the trade plan's price indices. The
 * model can only cite headlines we actually gave it, so a point can never be
 * attributed to an article that doesn't exist.
 */
export interface NewsKeyPoint {
  point: string;
  impact: "long" | "short" | "neutral";
  sources: number[];
}

/** What the news dimension read, concluded, and scored — surfaced to the user. */
export interface NewsDigest {
  /** -1..+1 sentiment; drives the 新聞面 bias item's weight and direction. */
  score: number;
  summary: string;
  key_points: NewsKeyPoint[];
  headline_count: number;
  sources: NewsSource[];
  /** Provider that read the headlines, or the local keyword table. */
  analyzed_by: string;
}

/**
 * The single actionable recommendation: one entry, one stop, one target.
 * Every price here is copied from a real computed structure — the AI only
 * ever picks *which* candidate to use (by index), never a raw number, so
 * the spec's "SL/TP must be anchored to real structure" rule still holds.
 */
export interface TradePlan {
  /**
   * 進場 or 觀望. Standing aside is a first-class outcome, not a failure —
   * when "wait", the price fields are null and `wait_for` says what would
   * change the answer.
   */
  stance: "enter" | "wait";
  entry: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  entry_reason: string;
  stop_loss_reason: string;
  take_profit_reason: string;
  /** Derived from the three prices above, for display only — never used to place them. */
  risk_reward: number | null;
  confidence: "high" | "medium" | "low";
  /** Plain-language summary of the whole plan. */
  summary: string;
  /**
   * 加倉點，最多三筆，依序遠離進場價。Empty when no structure supports adding —
   * an empty list is the honest answer, not a reason to invent a level.
   */
  add_ons: AddOnLevel[];
  /** 觀望時要等的條件（進場時為 null）。 */
  wait_for: string | null;
  /** Whether Claude chose the levels, or the deterministic fallback did. */
  decided_by: "ai" | "fallback";
  /**
   * When `decided_by` is "fallback", *why* — in words, and specific.
   *
   * The old summary said "未設定 AI 金鑰、額度用盡或呼叫失敗", three
   * possibilities in one sentence with the one that blames the reader first.
   * A message listing what might be wrong sends someone to check a setting
   * that was never the problem.
   */
  fallback_reason?: string | null;
  /**
   * 波段變體 — the same analysis at the larger horizon, offered beside the
   * 當沖 plan rather than replacing it. Levels with their own backtest, not a
   * second monitored trade; absent when the larger timeframe's trend does not
   * agree with the direction, or when it would pick the identical geometry.
   */
  swing?: SwingVariant | null;
}

/** The 波段 plan's levels. See TradePlan.swing. */
export interface SwingVariant {
  entry: number;
  stop_loss: number;
  take_profit: number;
  risk_reward: number;
  /** Local backtest hit rate for this geometry; null when unmeasurable. */
  hit_rate: number | null;
  /** The same how-it-was-chosen sentence the day plan carries. */
  summary: string;
}

/**
 * 加倉 — one scale-in level.
 *
 * Anchored to a real structure the price would have to reach, never to an
 * R-multiple: "add 0.5R at +1R" is arithmetic dressed as analysis, and it
 * places orders at prices the market has no reason to respect. Same rule the
 * spec already imposes on the entry, stop and target.
 *
 * Every add-on carries the stop the whole position moves to once it fills.
 * Adding size without tightening the stop increases risk on a trade that has
 * already paid you — the one thing scaling in must never do.
 */
export interface AddOnLevel {
  /** 1-3; the spec caps scaling in at three. */
  sequence: 1 | 2 | 3;
  price: number;
  /** The real structure this level sits on. */
  structure: string;
  reason: string;
  /** Where the stop for the *whole* position moves when this fills. */
  new_stop_loss: number;
  new_stop_reason: string;
  /** True once this level protects the original entry (stop at or beyond it). */
  locks_in_entry: boolean;
}

/** Local historical check on the plan's stop/target geometry — see lib/analysis/backtest.ts. */
export interface PlanBacktest {
  resolved: number;
  wins: number;
  losses: number;
  /**
   * |net R| ≤ 0.1 washes — the managed rules manufacture these (breakeven
   * pullbacks, trailing steps). In expectancy, out of the hit rate.
   * Optional: rows written before scratch accounting lack it.
   */
  scratches?: number;
  timeouts: number;
  /** wins / (wins + losses), scratches excluded. */
  hitRate: number | null;
  expectancyR: number | null;
  horizonBars: number;
  lookbackBars: number;
  hadAmbiguousBars: boolean;
  /** True when the sample was restricted to bars trending the signal's way. */
  conditioned?: boolean;
  /** How the sample was drawn, in words — shown wherever the numbers are. */
  basis?: string;
  /**
   * Round-trip trading cost charged against every sampled trade, as a
   * percentage of entry. Never absent and never zero: a hit rate measured
   * without spread is a different strategy's hit rate. Shown so the
   * assumption can be argued with rather than believed.
   */
  costPct?: number;
}

export interface TradeSignal {
  symbol: string;
  direction: "long" | "short";
  generated_at: string;
  /** 見下方計分規則 */
  bias_score: number;
  /** 見下方計分規則 */
  entry_structure_score: number;
  total_score: number;
  grade: Grade;
  entry_zone: { low: number; high: number; reason: string };
  stop_loss: {
    price: number;
    /** 貼在哪個結構之外 */
    structure: string;
    reason: string;
    /** 打到這裡代表哪個假設被推翻 */
    invalidation: string;
  };
  take_profits: Array<{
    price: number;
    structure: string;
    reason: string;
    allocation_pct: number;
  }>;
  bias_items: BiasItem[];
  entry_structures: EntryStructure[];
  path_obstacles: PathObstacle[];
  /**
   * The news the analysis read and what it concluded, with links. Null when no
   * headlines were available. Shown before the narrative so the reasoning can
   * be checked against the source material.
   */
  news_digest: NewsDigest | null;
  narrative: string;
  /** The one recommendation to act on — see TradePlan. */
  trade_plan: TradePlan;
  /** Historical feasibility check on trade_plan's geometry; null when not computable. */
  plan_backtest: PlanBacktest | null;
  /**
   * Stage 3 — tightenings applied to this signal because of past stop-losses,
   * with the entries that justified each. Empty when no journal history meets
   * the trigger thresholds. Interventions only ever downgrade or tighten.
   */
  interventions: AppliedIntervention[];
  /**
   * True when the weighted bias items netted to exactly zero, so `direction`
   * is a placeholder rather than a finding. The UI must say 中性 — showing
   * 做多 for a coin-flip is the single most misleading thing this card can do.
   */
  direction_tie?: boolean;
  /**
   * 信心度 — computed by lib/analysis/confidence.ts and stored, so the number
   * shown is provably the number the entry gate used. Optional because signals
   * written before this existed are still readable.
   */
  confidence?: {
    score: number;
    level: "high" | "medium" | "low";
    factors: string[];
  };
  /**
   * 圖形交易 — classical chart patterns found on the chart, in every state.
   * Optional because signals written before this existed are still readable.
   */
  chart_patterns?: ChartPattern[];
  /**
   * The grade the scoring table produced, before any force-downgrade.
   *
   * Equal to `grade` on a normal signal. When they differ, `downgrades` says
   * why — and that difference is what made the card self-contradictory: it
   * announced "評等 no-trade（總分 12）未達可進場門檻 B" while 12 points is an
   * A by the very table it was quoting.
   */
  /**
   * 市場休市時仍會分析，但不會通知。
   *
   * The system announced "US30 做多 ▲ A+" at 00:36 on a Sunday into an exchange
   * that had been shut since Friday and would not reopen for a day and a half.
   * Knowing where the levels are while the market is closed is useful; pushing
   * a notification to take a trade nobody can place is not.
   */
  market_closed?: boolean;
  /** Why the market is considered closed. Null when it is open. */
  market_closed_reason?: string | null;
  graded_as?: Grade;
  /**
   * 參考價位 — the geometry that *would* have been taken, chosen the same way
   * the traded plan is chosen.
   *
   * Present only when the rules stood aside. Before this, the reference block
   * showed the raw computed levels: the mid of the entry zone, the nearest
   * protecting structure, the nearest obstacles. Nothing had chosen among them,
   * so the one part of the card without any sizing screen, backtest or hit rate
   * was the part being read as an analysis.
   */
  reference_plan?: {
    entry: number;
    stop_loss: number;
    take_profit: number;
    risk_reward: number;
    entry_reason: string;
    stop_reason: string;
    target_reason: string;
    /** How it was chosen — the same sentence the traded plan carries. */
    basis: string;
    backtest: PlanBacktest | null;
    /**
     * 這組價位有沒有通過統計附加審查。
     *
     * The paper tier used to be withheld entirely when the veto fired — and
     * that made it useless for the one job it exists to do. Its purpose is
     * to answer "is the gate costing money?", which is unanswerable if the
     * gate also decides what gets tracked: the monitor then paper-trades
     * only the trades the rules already approved, and the review page's
     * paper bucket can never disagree with the real one. False here means
     * "the rules refused this; we are tracking it anyway to find out
     * whether they were right", and every renderer labels it as such.
     * Optional: rows written before this field lack it and read as passed.
     */
    vetoed?: boolean;
    /** When vetoed, the measured reason — quoted, never invented. */
    vetoNote?: string | null;
  } | null;
  /** Every reason the computed grade was overruled, in the order applied. */
  downgrades?: string[];
  /**
   * 實驗室已採用條件 — the measured entry requirement checked on this bar.
   *
   * Present only when a condition combination has been adopted for this symbol
   * and direction (see lib/analysis/lab-adoption.ts). It can hold a plan back
   * and can never let one through: `blocked` is true exactly when this gate is
   * what turned an entry into a wait.
   */
  lab_gate?: LabGate | null;
  data_gaps: string[];
}

/** The live check of an adopted lab condition combination. */
export interface LabGate {
  ids: string[];
  labels: string[];
  /** Bar size the adoption's evidence came from — the gate checks on the same. */
  timeframe?: "D1" | "H4";
  /** Every adopted condition holds on the latest bar. */
  met: boolean;
  checks: { id: string; label: string; met: boolean }[];
  /**
   * Why the gate could not be checked at all; null when it was checked.
   * Unevaluable always means `met: false` — "we couldn't look" is not a pass.
   */
  unevaluable: string | null;
  adopted_at: string;
  /** The numbers the combination was adopted on, so the card can show its provenance. */
  in_sample_hit_rate: number;
  in_sample_trades: number;
  out_of_sample_hit_rate: number;
  out_of_sample_trades: number;
  /** True when this gate is what withdrew an otherwise-enterable plan. */
  blocked: boolean;
}

/** Shape of a row in the Supabase `signals` table (see supabase/schema.sql). */
export interface SignalRow extends TradeSignal {
  id: string;
  created_at: string;
}

/** All 9 symbols are wired end-to-end as of Stage 2 (see config/fundamentals.ts). */
export type SupportedSymbol =
  | "EURUSD"
  | "USDJPY"
  | "GBPUSD"
  | "XAUUSD"
  | "NAS100"
  | "GER40"
  | "US30"
  | "WTI"
  | "SPX500";

export interface CommodityMeta {
  /** Built-ins use SupportedSymbol; user-added targets supply their own id. */
  symbol: string;
  label: string;
  category: "forex" | "metal" | "index" | "energy" | "crypto";
  /** Primary OHLCV ticker, served through our own yfinance proxy. */
  yfinanceSymbol: string;
  /** Stooq ticker — keyless fallback (daily/weekly only). Unverified live. */
  stooqSymbol: string;
  /**
   * Finnhub ticker, when the free tier actually covers it. Null for all nine
   * built-ins: Finnhub gates candle data for forex, commodities and indices
   * behind a paid plan, so a request would only spend a round-trip to get a
   * 403. Left in place for user-added US equities, which the free tier does serve.
   */
  finnhubSymbol?: string | null;
  /**
   * 這個代號講的是期貨還是現貨。
   *
   * Declared rather than implied, because the sources disagree and the
   * difference is real money: gold was mapped to the COMEX futures contract
   * while every fallback served spot, so the site quoted 4,448 against a
   * broker's 4,391 — above a spot high that day of 4,436. See
   * lib/data-sources/instrument-basis.ts.
   */
  contractBasis: "spot" | "futures";
  /** Whether the signal pipeline is wired for this symbol (all true as of Stage 2). */
  implemented: boolean;
}

export const COMMODITIES: CommodityMeta[] = [
  {
    symbol: "EURUSD",
    label: "EUR/USD",
    category: "forex",
    yfinanceSymbol: "EURUSD=X",
    stooqSymbol: "eurusd",
    contractBasis: "spot",
    implemented: true,
  },
  {
    symbol: "USDJPY",
    label: "USD/JPY",
    category: "forex",
    yfinanceSymbol: "JPY=X",
    stooqSymbol: "usdjpy",
    contractBasis: "spot",
    implemented: true,
  },
  {
    symbol: "GBPUSD",
    label: "GBP/USD",
    category: "forex",
    yfinanceSymbol: "GBPUSD=X",
    stooqSymbol: "gbpusd",
    contractBasis: "spot",
    implemented: true,
  },
  {
    symbol: "XAUUSD",
    label: "XAU/USD (黃金)",
    category: "metal",
    // Spot, not GC=F. The futures contract was quoting 1.28% above spot — a
    // number above the day's actual high — while Stooq, Twelve Data and
    // gold-api all served spot, so which instrument you saw depended on which
    // source answered. Gold trades 24/5 as spot, so none of the "the cash
    // market goes silent overnight" reasoning that justifies futures for the
    // index CFDs applies here.
    yfinanceSymbol: "XAUUSD=X",
    stooqSymbol: "xauusd",
    contractBasis: "spot",
    implemented: true,
  },
  {
    symbol: "NAS100",
    label: "NAS100 (那斯達克)",
    category: "index",
    yfinanceSymbol: "NQ=F",
    stooqSymbol: "^ndx",
    contractBasis: "futures",
    implemented: true,
  },
  {
    symbol: "GER40",
    label: "GER40 (DAX)",
    category: "index",
    yfinanceSymbol: "^GDAXI",
    stooqSymbol: "^dax",
    contractBasis: "futures",
    implemented: true,
  },
  {
    symbol: "US30",
    label: "US30 (道瓊)",
    category: "index",
    // Futures, not the cash index (^DJI). NAS100 always used NQ=F and never
    // read 休市 overnight; ^DJI only prints during the NYSE session, so US30
    // spent every pre-market labelled closed while its CFD traded happily.
    // The futures contract is also what a CFD actually tracks.
    yfinanceSymbol: "YM=F",
    stooqSymbol: "^dji",
    contractBasis: "futures",
    implemented: true,
  },
  {
    symbol: "WTI",
    label: "WTI (美國原油)",
    category: "energy",
    yfinanceSymbol: "CL=F",
    stooqSymbol: "cl.f",
    contractBasis: "futures",
    implemented: true,
  },
  {
    symbol: "SPX500",
    label: "SPX500",
    category: "index",
    // Futures for the same reason as US30: ^GSPC goes silent outside the
    // NYSE session and read as a closed market for two thirds of every day.
    yfinanceSymbol: "ES=F",
    stooqSymbol: "^spx",
    contractBasis: "futures",
    implemented: true,
  },
];
