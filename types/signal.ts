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
  | "高成交量節點";

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
  timeouts: number;
  hitRate: number | null;
  expectancyR: number | null;
  horizonBars: number;
  lookbackBars: number;
  hadAmbiguousBars: boolean;
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
  data_gaps: string[];
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
  category: "forex" | "metal" | "index" | "energy";
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
    implemented: true,
  },
  {
    symbol: "USDJPY",
    label: "USD/JPY",
    category: "forex",
    yfinanceSymbol: "JPY=X",
    stooqSymbol: "usdjpy",
    implemented: true,
  },
  {
    symbol: "GBPUSD",
    label: "GBP/USD",
    category: "forex",
    yfinanceSymbol: "GBPUSD=X",
    stooqSymbol: "gbpusd",
    implemented: true,
  },
  {
    symbol: "XAUUSD",
    label: "XAU/USD (黃金)",
    category: "metal",
    yfinanceSymbol: "GC=F",
    stooqSymbol: "xauusd",
    implemented: true,
  },
  {
    symbol: "NAS100",
    label: "NAS100 (那斯達克)",
    category: "index",
    yfinanceSymbol: "NQ=F",
    stooqSymbol: "^ndx",
    implemented: true,
  },
  {
    symbol: "GER40",
    label: "GER40 (DAX)",
    category: "index",
    yfinanceSymbol: "^GDAXI",
    stooqSymbol: "^dax",
    implemented: true,
  },
  {
    symbol: "US30",
    label: "US30 (道瓊)",
    category: "index",
    yfinanceSymbol: "^DJI",
    stooqSymbol: "^dji",
    implemented: true,
  },
  {
    symbol: "WTI",
    label: "WTI (美國原油)",
    category: "energy",
    yfinanceSymbol: "CL=F",
    stooqSymbol: "cl.f",
    implemented: true,
  },
  {
    symbol: "SPX500",
    label: "SPX500",
    category: "index",
    yfinanceSymbol: "^GSPC",
    stooqSymbol: "^spx",
    implemented: true,
  },
];
