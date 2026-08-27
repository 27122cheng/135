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
 */
export const TRADE_MIN_EXPECTANCY_R = 0.35;
