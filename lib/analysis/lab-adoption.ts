import type { Candle } from "../data-sources/ohlcv";
import type { BiasItem, LabGate } from "@/types/signal";
import { CONDITIONS, WARMUP, buildContext, type LabFinding, type LabTimeframe } from "./lab";
import { readInternalSetting } from "../settings";

/**
 * 採用 — the one door between the lab and the live signal.
 *
 * The lab measures entry conditions; on its own that is a page of numbers.
 * This is what makes a measured condition actually govern a trade: an operator
 * presses 採用 on a combination that passed out-of-sample verification, it is
 * stored, and from then on the signal builder checks it on the live bar before
 * any plan of that symbol and direction is allowed to enter.
 *
 * ## Why adoption is a deliberate act and not an automatic one
 *
 * The obvious version of this feature promotes the search's best result by
 * itself. That is the standard route by which over-fitting reaches production:
 * a beam search over one price series will always return a winner, the
 * hold-out catches most but not all of the luck, and nothing downstream can
 * tell a genuine edge from the survivor of seventy hypotheses. A human
 * pressing a button is not a great filter, but it is a filter that exists, and
 * it puts the decision where the consequences land.
 *
 * ## The gate only ever subtracts
 *
 * An adopted condition can hold a trade back. It cannot create one, raise a
 * grade, relax a floor, or vouch for anything — every existing gate still runs
 * exactly as before, and this one runs after them. That asymmetry is the whole
 * safety argument: the worst a bad adoption can do is cost trades, which is
 * visible and reversible, rather than authorise trades, which is neither.
 *
 * ## Unevaluable is never "met"
 *
 * If the candles are too short to check a condition, the gate reports
 * `met: false` with the reason. Treating "we couldn't look" as "it passed"
 * would make the gate silently disappear on exactly the runs where data is
 * thin — the runs that need it most.
 */

/**
 * The `app_settings` key holding every adoption, as JSON.
 *
 * Deliberately absent from `SETTABLE_KEYS`: the settings API writes whatever
 * key it is handed from an allowlist, and this is not a setting an operator
 * types — it is state the server derives from a verified lab run. It is written
 * by /api/lab/adopt, which re-runs the lab before believing anything.
 */
export const ADOPTED_KEY = "LAB_ADOPTED_CONDITIONS";

/** The most conditions that may be stacked in one adoption — the lab's own MAX_DEPTH. */
const MAX_IDS = 4;

export interface LabAdoption {
  symbol: string;
  direction: "long" | "short";
  ids: string[];
  labels: string[];
  /**
   * The bar size the evidence was measured on. The live gate checks the
   * condition on the same bars — D1 evidence gates on D1, H4 on H4. Records
   * written before timeframes existed read as D1, which is what they were.
   */
  timeframe: LabTimeframe;
  /** Measured by the server at adoption time. Never taken from the client. */
  inSample: { trades: number; hitRate: number };
  outOfSample: { trades: number; hitRate: number };
  /** The floor the combination had to clear on both halves. */
  floor: number;
  /** How many candles the verifying run saw. */
  bars: number;
  adoptedAt: string;
}

function isDirection(v: unknown): v is "long" | "short" {
  return v === "long" || v === "short";
}

function half(v: unknown): { trades: number; hitRate: number } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const trades = o.trades;
  const hitRate = o.hitRate;
  if (typeof trades !== "number" || !Number.isFinite(trades)) return null;
  if (typeof hitRate !== "number" || !Number.isFinite(hitRate)) return null;
  return { trades, hitRate };
}

/**
 * Parses the stored JSON, dropping anything that no longer makes sense.
 *
 * Tolerant on purpose, and in one direction only: a record that cannot be
 * fully understood is discarded rather than partially honoured. The case that
 * matters is a condition id that no longer exists — the condition list is code
 * and a deploy can remove one, and a gate that quietly skips the half of itself
 * it can no longer evaluate is worse than no gate at all.
 */
export function parseAdoptions(raw: string | null): LabAdoption[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const known = new Set(CONDITIONS.map((c) => c.id));
  const out: LabAdoption[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    if (typeof o.symbol !== "string" || !o.symbol) continue;
    if (!isDirection(o.direction)) continue;
    if (!Array.isArray(o.ids) || o.ids.length === 0 || o.ids.length > MAX_IDS) continue;
    const ids = o.ids.filter((id): id is string => typeof id === "string");
    if (ids.length !== o.ids.length) continue;
    if (new Set(ids).size !== ids.length) continue;
    // An id this build no longer defines: drop the whole record.
    if (!ids.every((id) => known.has(id))) continue;
    const inSample = half(o.inSample);
    const outOfSample = half(o.outOfSample);
    if (!inSample || !outOfSample) continue;
    out.push({
      symbol: o.symbol,
      direction: o.direction,
      ids,
      labels: ids.map((id) => CONDITIONS.find((c) => c.id === id)!.label),
      timeframe: o.timeframe === "H4" ? "H4" : "D1",
      inSample,
      outOfSample,
      floor: typeof o.floor === "number" && Number.isFinite(o.floor) ? o.floor : 0,
      bars: typeof o.bars === "number" && Number.isFinite(o.bars) ? o.bars : 0,
      adoptedAt: typeof o.adoptedAt === "string" ? o.adoptedAt : new Date(0).toISOString(),
    });
  }
  return out;
}

export function serializeAdoptions(list: LabAdoption[]): string {
  return JSON.stringify(list);
}

export function findAdoption(
  list: LabAdoption[],
  symbol: string,
  direction: "long" | "short",
): LabAdoption | null {
  return list.find((a) => a.symbol === symbol && a.direction === direction) ?? null;
}

/**
 * One adoption per symbol and direction. Adopting a second combination for the
 * same pair replaces the first rather than stacking with it: two independent
 * gates on one trade is a requirement nobody chose and nobody measured.
 */
export function upsertAdoption(list: LabAdoption[], next: LabAdoption): LabAdoption[] {
  return [...list.filter((a) => !(a.symbol === next.symbol && a.direction === next.direction)), next];
}

export function removeAdoption(
  list: LabAdoption[],
  symbol: string,
  direction: "long" | "short",
): LabAdoption[] {
  return list.filter((a) => !(a.symbol === symbol && a.direction === direction));
}

/**
 * Turns a lab finding into an adoption — and refuses anything unverified.
 *
 * The check is here, in the shared helper, rather than only in the route: the
 * route's job is to re-run the lab so the numbers are the server's own, and
 * this is the invariant that says only a combination which cleared both halves
 * may ever become a gate.
 */
export function adoptionFromFinding(
  symbol: string,
  direction: "long" | "short",
  finding: LabFinding,
  floor: number,
  bars: number,
  now: Date = new Date(),
  timeframe: LabTimeframe = "D1",
): LabAdoption {
  if (!finding.verified) {
    throw new Error("這組條件沒有通過樣本外驗證，不能採用");
  }
  if (finding.inSample.hitRate === null || finding.outOfSample.hitRate === null) {
    throw new Error("這組條件沒有勝率可記錄，不能採用");
  }
  return {
    symbol,
    direction,
    ids: [...finding.ids],
    labels: [...finding.labels],
    timeframe,
    inSample: { trades: finding.inSample.trades, hitRate: finding.inSample.hitRate },
    outOfSample: { trades: finding.outOfSample.trades, hitRate: finding.outOfSample.hitRate },
    floor,
    bars,
    adoptedAt: now.toISOString(),
  };
}

/**
 * Checks an adoption against the newest bar.
 *
 * The conditions were measured on entries taken at a bar's close, so they are
 * checked at the close of the last completed bar — the same instant the lab
 * used, not an intrabar reading the backtest never saw.
 */
export function evaluateAdoption(adoption: LabAdoption, candles: Candle[] | undefined): LabGate {
  const base: LabGate = {
    ids: [...adoption.ids],
    labels: [...adoption.labels],
    timeframe: adoption.timeframe,
    met: false,
    checks: [],
    unevaluable: null,
    adopted_at: adoption.adoptedAt,
    in_sample_hit_rate: adoption.inSample.hitRate,
    in_sample_trades: adoption.inSample.trades,
    out_of_sample_hit_rate: adoption.outOfSample.hitRate,
    out_of_sample_trades: adoption.outOfSample.trades,
    blocked: false,
  };

  if (!candles || candles.length <= WARMUP) {
    return {
      ...base,
      unevaluable:
        `${adoption.timeframe} K 棒只有 ${candles?.length ?? 0} 根，不足 ${WARMUP + 1} 根，` +
        "無法在與實驗室相同的條件下檢查（指標尚未暖機），本次不放行",
    };
  }

  const i = candles.length - 1;
  const ctx = buildContext(candles, [i]);
  const checks = adoption.ids.map((id) => {
    const condition = CONDITIONS.find((c) => c.id === id)!;
    let met = false;
    try {
      met = condition.test(ctx, i, adoption.direction);
    } catch {
      // A throwing condition is an unmet condition, never a passing one.
      met = false;
    }
    return { id, label: condition.label, met };
  });

  return { ...base, checks, met: checks.every((c) => c.met) };
}

/**
 * 實測證據 — adopted conditions feeding the score, not only the gate.
 *
 * The gate can only subtract: an adopted combination that is NOT met blocks
 * an entry. But when it IS met, the system was throwing that information
 * away — a combination that demonstrated its hit rate on 100+ in-sample
 * trades, survived out-of-sample verification, and was deliberately adopted
 * by the operator, firing on the current bar, is *evidence about direction*,
 * and stronger evidence than most of the hand-weighted heuristics already
 * voting. This turns it into a bias item.
 *
 * The boundaries that keep this honest:
 *  - **Adopted only.** The lab's raw findings never vote — a beam search's
 *    survivors reaching the score without a human pressing 採用 would be the
 *    over-fitting-to-production pipeline this file's header warns about.
 *  - **Both directions.** A short adoption firing while the analysis leans
 *    long votes against it — measured evidence has no obligation to agree.
 *  - **Capped at weight 2**, the same ceiling every other single fact has;
 *    passing verification does not make it more than one fact.
 *  - The gate still runs afterwards and can still only subtract.
 */
export function adoptionEvidence(
  adoptions: LabAdoption[],
  candles: { D1?: Candle[]; H4?: Candle[] },
): BiasItem[] {
  const items: BiasItem[] = [];
  for (const adoption of adoptions) {
    const gate = evaluateAdoption(adoption, candles[adoption.timeframe]);
    if (!gate.met) continue;
    const oosPct = Math.round(adoption.outOfSample.hitRate * 100);
    items.push({
      dimension: "技術面",
      direction: adoption.direction,
      weight: 2,
      factor: `實驗室已驗證條件於 ${adoption.timeframe} 成立：${adoption.labels.join("＋")}`,
      evidence:
        `樣本外 ${adoption.outOfSample.trades} 筆勝率 ${oosPct}%、` +
        `樣本內 ${adoption.inSample.trades} 筆通過驗證，當前 K 棒全數條件成立`,
      source: `實驗室採用紀錄（${adoption.adoptedAt.slice(0, 10)} 採用）`,
      key: `lab-adopted:${adoption.direction}:${[...adoption.ids].sort().join("+")}`,
    });
  }
  return items;
}

/** Every adoption, from the shared per-invocation settings cache. */
export async function loadAdoptions(): Promise<LabAdoption[]> {
  return parseAdoptions(await readInternalSetting(ADOPTED_KEY));
}

/**
 * The adoptions that apply to one symbol. A missing or failing database means
 * no adoptions, which means no extra gate — the signal is still produced.
 */
export async function loadAdoptionsFor(symbol: string, gaps: string[]): Promise<LabAdoption[]> {
  try {
    return (await loadAdoptions()).filter((a) => a.symbol === symbol);
  } catch (err) {
    gaps.push(
      `讀取實驗室已採用條件失敗，本次未套用（${err instanceof Error ? err.message : String(err)}）`,
    );
    return [];
  }
}

/** One line summarising what the gate did, for the plan's wait_for text. */
export function describeGate(gate: LabGate): string {
  if (gate.unevaluable) return gate.unevaluable;
  const unmet = gate.checks.filter((c) => !c.met).map((c) => c.label);
  if (unmet.length === 0) {
    return `已採用條件全數符合（${gate.labels.join(" ＋ ")}）`;
  }
  return `尚未符合：${unmet.join("、")}`;
}
