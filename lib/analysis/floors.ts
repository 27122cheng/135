/**
 * The trade floor's constants, in a leaf module with no imports.
 *
 * They live here rather than in trade-plan.ts because the UI prints them —
 * the two-tier 無交易 copy on the card and the board — and a client
 * component importing trade-plan drags the AI provider chain and the data
 * sources (AsyncLocalStorage and all) into the browser bundle, where webpack
 * rightly refuses `node:async_hooks`. trade-plan re-exports them, so server
 * code keeps its import path.
 *
 * The bar a measured edge must clear to trade. Was 0.75R — the arithmetic
 * translation of "70% at 1:1.5" — and at that height the system produced one
 * trade a month across nine symbols. The refusal that ended it: an A+ setup,
 * 124 resolved samples, measured +0.69R per trade, turned away for missing
 * the bar by 0.06R — when the sampling error on a 124-trade expectancy is
 * itself about ±0.1R. A floor set at the aspiration level does not deliver
 * the aspiration; it just refuses trades whose true edge it cannot
 * statistically distinguish from passing, and flaps enter/wait on every
 * rescan for the ones near it.
 *
 * 0.35R is the *economic* floor: costs are already charged inside the
 * backtest, so anything positive is worth taking in principle, and 0.35R
 * demands the measured edge exceed zero by roughly three sampling errors —
 * a real edge requirement, not a wish. The self-correcting side is the
 * 實績校準 audit: when realized outcomes fall short of what the backtests
 * promised, the hit-rate bump tightens new entries automatically. Start
 * permissive and let measured reality tighten, rather than starting at a
 * height reality can never reach.
 *
 * A second live collapse taught the companion lesson: the floor is only as
 * meaningful as the measurement under it. When scale-out was first applied
 * to *every* target (including sub-1R shelves) and breakeven washes counted
 * as losses, every symbol's best combination read ≈0R at 19–38% "勝率" and
 * this floor refused all eleven symbols at once. The fixes live in the
 * engine and the accounting (SCALE_OUT_MIN_R and SCRATCH_R in
 * lab-manage.ts), not in this number: the hit-rate floors elsewhere are now
 * scratch-excluded, and the 55% they demand is the rate among trades that
 * actually decided something.
 *
 * ## The third lesson — role, not value（操作者的架構指令）
 *
 * Two measurement repairs later the sweeps were still 0-for-11, and the
 * operator named the design fault: the statistical check had become the
 * PRIMARY arbiter while the analysis — six dimensions, structure, trend,
 * the thing this whole site computes — queued behind it. The geometry
 * backtest's own card admits it measures "這組距離配置的可行性…不是這個
 * 訊號的勝率"; a supplementary check with veto power over the primary
 * judgment is an inverted architecture.
 *
 * So the roles are now explicit. The ANALYSIS decides. Statistics VETO only
 * what is measurably bad (the two constants below), and the 實績校準 audit
 * keeps tightening the veto when realized results disappoint — win rate as
 * after-the-fact correction, which is the job it was always suited for.
 * This constant survives as the "強" tier label: a plan clearing it is
 * marked strong, but not clearing it no longer stands aside.
 */
export const TRADE_MIN_EXPECTANCY_R = 0.35;

/**
 * 統計否決線（期望值腿）— a geometry the managed backtest measures at
 * BELOW this loses money net of costs on the instrument's own history:
 * that is a fact worth a veto, whatever the analysis thinks. At or above
 * zero, the statistic has nothing disqualifying to say and the analysis's
 * verdict stands.
 */
export const TRADE_VETO_EXPECTANCY_R = 0;

/**
 * 統計否決線（跟單性腿）— scratch-excluded. Below 40% the real losses come
 * so often that no one follows the system through them (the random-walk
 * baseline at the 1:1.5 payoff floor sits near this), so the veto keeps its
 * one legitimate job. The 實績校準 bump adds on top of this line, so a
 * system whose realized results lag its promises tightens itself.
 */
export const TRADE_VETO_HIT_RATE = 0.4;
