import { check, report } from "./_harness";
import { clearSettingsCache, isSecretSetting, isSettableKey } from "@/lib/settings";
import { formatAlert, MIN_CONSENSUS_DIMENSIONS, shouldAlert } from "@/lib/notify/alert";
import { notifyStatus } from "@/lib/notify";
import type { SignalRow, TradeSignal, Grade } from "@/types/signal";

/**
 * The alert rule is "change, not state": the refresh runs every 4 hours, so a
 * setup that stays valid all day must not fire six identical notifications.
 */

function signal(over: Partial<TradeSignal> = {}): TradeSignal {
  return {
    symbol: "XAUUSD",
    direction: "long",
    generated_at: "2026-08-04T12:00:00.000Z",
    bias_score: 8,
    entry_structure_score: 5,
    total_score: 13,
    grade: "A",
    entry_zone: { low: 1990, high: 2010, reason: "r" },
    stop_loss: { price: 1980, structure: "s", reason: "r", invalidation: "i" },
    take_profits: [],
    // Three dimensions agreeing — the consensus the push threshold requires.
    // The old fixtures had no bias_items at all, which now correctly reads as
    // "an indicator, not a case" and stays off the phone.
    bias_items: [
      { dimension: "技術面", factor: "f", direction: "long", weight: 2, evidence: "e", source: "s" },
      { dimension: "基本面", factor: "f", direction: "long", weight: 1, evidence: "e", source: "s" },
      { dimension: "籌碼面", factor: "f", direction: "long", weight: 1, evidence: "e", source: "s" },
    ],
    entry_structures: [],
    path_obstacles: [],
    news_digest: null,
    narrative: "n",
    trade_plan: {
      stance: "enter",
      entry: 2000,
      stop_loss: 1980,
      take_profit: 2050,
      entry_reason: "e",
      stop_loss_reason: "s",
      take_profit_reason: "t",
      risk_reward: 2.5,
      confidence: "medium",
      summary: "順勢做多。",
      add_ons: [],
      wait_for: null,
      decided_by: "ai",
    },
    plan_backtest: null,
    interventions: [],
    data_gaps: [],
    ...over,
  };
}

function stored(s: TradeSignal): SignalRow {
  return { ...s, id: "row-1", created_at: s.generated_at };
}

// ── one trade at a time ───────────────────────────────────────────
//
// 「同一個商品的交易，必須要先結束，止盈或止損後再加入復盤」— while the
// monitor holds an unresolved position, new entries and level updates stay
// off the phone. The stream of same-symbol pushes came from every rescan
// re-announcing a trade that had never finished.
{
  const open = { openTrade: true };
  const gated = shouldAlert(signal(), null, "A", open);
  check("an open tracked trade silences a new entry", !gated.alert, gated);
  check("and names the rule", gated.reason.includes("未平倉"), gated.reason);

  const prev = stored(signal());
  const updated = signal({
    trade_plan: { ...signal().trade_plan, stop_loss: 1985 },
  });
  check("a moved stop stays quiet too while the trade runs",
    !shouldAlert(updated, prev, "A", open).alert);

  // The thesis behind the open trade dying is exactly what a push is for.
  const withdrawn = signal({ trade_plan: { ...signal().trade_plan, stance: "wait" } });
  check("a withdrawal still passes while the trade is open",
    shouldAlert(withdrawn, prev, "A", open).alert);

  check("with no open trade the same signal alerts",
    shouldAlert(signal(), null, "A", { openTrade: false }).alert);
}

// ── the floor ─────────────────────────────────────────────────────
{
  check("a fresh actionable signal alerts", shouldAlert(signal(), null).alert);
  check("觀望 never alerts",
    !shouldAlert(signal({ trade_plan: { ...signal().trade_plan, stance: "wait" } }), null).alert);
  check("below the grade floor stays quiet", !shouldAlert(signal({ grade: "B" }), null).alert);
  check("C stays quiet", !shouldAlert(signal({ grade: "C" }), null).alert);
  check("A+ alerts", shouldAlert(signal({ grade: "A+" }), null).alert);
  check("the floor is configurable",
    shouldAlert(signal({ grade: "B" }), null, "B" as Grade).alert);

  // "enter" with missing levels is a bug upstream; pushing it would send an
  // unusable recommendation to a lock screen.
  const broken = signal();
  broken.trade_plan = { ...broken.trade_plan, stop_loss: null };
  check("enter without a full set of levels is refused", !shouldAlert(broken, null).alert);
  check("and it says why", shouldAlert(broken, null).reason.includes("缺少價位"));
}

// ── the anti-spam rule ────────────────────────────────────────────
{
  const first = signal();
  const prev = stored(first);

  check("an identical repeat is suppressed", !shouldAlert(signal(), prev).alert);
  check("the suppression is explained",
    shouldAlert(signal(), prev).reason.includes("不重複發送"));

  // Small drift between runs is noise, not news.
  const drifted = signal();
  drifted.trade_plan = { ...drifted.trade_plan, entry: 2001, stop_loss: 1981, take_profit: 2052 };
  check("a 0.05% drift is still the same call", !shouldAlert(drifted, prev).alert, drifted.trade_plan);

  // A real move in the levels is worth knowing about.
  const moved = signal();
  moved.trade_plan = { ...moved.trade_plan, entry: 2000, stop_loss: 1950, take_profit: 2050 };
  check("a moved stop re-alerts", shouldAlert(moved, prev).alert, moved.trade_plan);

  check("wait → enter alerts",
    shouldAlert(signal(), stored(signal({
      trade_plan: { ...first.trade_plan, stance: "wait" },
    }))).alert);

  // The flipped signal's evidence must flip with it — a short whose factors
  // all point long is exactly what the consensus gate exists to keep quiet.
  check("a direction flip alerts",
    shouldAlert(signal({
      direction: "short",
      bias_items: [
        { dimension: "技術面", factor: "f", direction: "short", weight: 2, evidence: "e", source: "s" },
        { dimension: "基本面", factor: "f", direction: "short", weight: 1, evidence: "e", source: "s" },
        { dimension: "籌碼面", factor: "f", direction: "short", weight: 1, evidence: "e", source: "s" },
      ],
    }), prev).alert);

  check("a grade upgrade alerts",
    shouldAlert(signal({ grade: "A+" }), prev).alert);

  // A downgrade that still clears the floor is not new information — the same
  // trade is already on the table.
  const fromAplus = stored(signal({ grade: "A+" }));
  check("a downgrade within the floor stays quiet",
    !shouldAlert(signal({ grade: "A" }), fromAplus).alert);
}

// ── message ───────────────────────────────────────────────────────
{
  const s = signal({
    news_digest: {
      score: 0.5,
      summary: "sum",
      key_points: [
        { point: "空頭消息", impact: "short", sources: [] },
        { point: "實質利率轉負，利多黃金", impact: "long", sources: [0] },
      ],
      headline_count: 12,
      sources: [],
      analyzed_by: "gemini",
    },
    data_gaps: ["缺口一"],
  });
  const text = formatAlert(s, "首次出現可執行訊號", "https://example.app");

  check("names the symbol, direction and grade", text.includes("XAUUSD") && text.includes("做多") && text.includes("A"));
  check("carries all three prices", text.includes("2000") && text.includes("1980") && text.includes("2050"));
  check("carries the risk/reward", text.includes("1:2.5"));
  check("includes the plan summary", text.includes("順勢做多"));
  // Only the news point that agrees with the trade direction is worth the space.
  check("quotes a same-direction news point", text.includes("實質利率轉負"));
  check("skips the opposing news point", !text.includes("空頭消息"));
  check("mentions the data gap count", text.includes("資料缺口 1 項"));
  check("states the trigger", text.includes("首次出現可執行訊號"));
  check("links back to the site", text.includes("https://example.app"));

  // FX needs more decimals than an index does.
  const fx = signal({ symbol: "EURUSD" });
  fx.trade_plan = { ...fx.trade_plan, entry: 1.08234, stop_loss: 1.07891, take_profit: 1.09102 };
  check("FX keeps 5 decimals", formatAlert(fx, "r").includes("1.08234"), formatAlert(fx, "r"));

  check("no app url means no trailing link", !formatAlert(signal(), "r").includes("http"));
}

// ── channels ──────────────────────────────────────────────────────
//
// Env vars still win over stored settings, so this block also pins the
// precedence: a deployment-level choice must not be silently overridden by
// something typed into a web form.
async function channelTests() {
  for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "DISCORD_WEBHOOK_URL"]) {
    delete process.env[k];
  }
  clearSettingsCache();
  check("nothing configured by default", (await notifyStatus()).every((c) => !c.configured));

  process.env.TELEGRAM_BOT_TOKEN = "t";
  clearSettingsCache();
  check("a token alone is not enough for telegram",
    (await notifyStatus()).find((c) => c.name === "telegram")?.configured === false);
  process.env.TELEGRAM_CHAT_ID = "c";
  clearSettingsCache();
  check("token + chat id configures telegram",
    (await notifyStatus()).find((c) => c.name === "telegram")?.configured === true);

  process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/x";
  clearSettingsCache();
  check("a webhook url configures discord",
    (await notifyStatus()).find((c) => c.name === "discord")?.configured === true);

  // The allowlist is the security boundary — the same rule as the API keys.
  // A settings endpoint that accepts any name is one that accepts DATABASE_URL.
  check("telegram token is settable", isSettableKey("TELEGRAM_BOT_TOKEN"));
  check("alert threshold is settable", isSettableKey("ALERT_MIN_GRADE"));
  check("DATABASE_URL is not settable from a browser", !isSettableKey("DATABASE_URL"));
  check("CRON_SECRET is not settable from a browser", !isSettableKey("CRON_SECRET"));
  check("the service-role key is not settable", !isSettableKey("SUPABASE_SERVICE_ROLE_KEY"));
  check("an unknown name is rejected", !isSettableKey("ANYTHING_ELSE"));

  // The AI keys are settable server-side so the scheduler has providers; the
  // per-request header path is unchanged and still wins.
  check("the AI keys are settable for the scheduler", isSettableKey("GEMINI_API_KEY"));
  check("and so is the fallback provider", isSettableKey("GROQ_API_KEY"));
  check("an AI key is a secret and never echoed", isSecretSetting("GEMINI_API_KEY"));
  // Model names and provider order are configuration, not credentials —
  // showing them back is how you confirm what is in force.
  check("a model name is not a secret", !isSecretSetting("GEMINI_MODEL"));
  check("the provider order is not a secret", !isSecretSetting("AI_PROVIDER_ORDER"));

  // Secrets must never be echoed back, even to whoever stored them.
  check("the bot token is marked secret", isSecretSetting("TELEGRAM_BOT_TOKEN"));
  check("the discord webhook is marked secret", isSecretSetting("DISCORD_WEBHOOK_URL"));
  // The chat id is not a credential — showing it is how you confirm the setup.
  check("the chat id is not a secret", !isSecretSetting("TELEGRAM_CHAT_ID"));
  check("the alert threshold is not a secret", !isSecretSetting("ALERT_MIN_GRADE"));
}

void channelTests().then(() => report("alerts"));
