import type { TradeSignal } from "@/types/signal";
import { PENDING_ENTRY_MAX_HOURS } from "@/lib/monitor/plan-state";

/**
 * 執行單 — the recommendation as the orders a broker ticket needs.
 *
 * The card explained the trade; nobody had written it as the three or four
 * orders a trader actually types. This maps the plan to them, in the
 * instrument's own price precision, with the order type that matches the
 * entry style and the expiry the monitor itself applies.
 */

export interface OrderLine {
  label: string;
  value: string;
  note?: string;
}

export interface OrderTicket {
  headline: string;
  lines: OrderLine[];
  steps: string[];
  validUntil: string | null;
}

const fmt = (n: number) => (Math.abs(n) < 10 ? n.toFixed(4) : n.toFixed(2));

export function buildOrderTicket(signal: TradeSignal): OrderTicket | null {
  const p = signal.trade_plan;
  if (p.stance !== "enter" || p.entry === null || p.stop_loss === null || p.take_profit === null) return null;
  const long = signal.direction === "long";
  const side = long ? "買進" : "賣出";
  const close = long ? "賣出" : "買進";
  const t = Date.parse(signal.generated_at);
  const validUntil = Number.isFinite(t) ? new Date(t + PENDING_ENTRY_MAX_HOURS * 3_600_000).toISOString() : null;
  const risk = Math.abs(p.entry - p.stop_loss);
  const reward = Math.abs(p.take_profit - p.entry);
  const scaleOut = risk > 0 && reward / risk >= 2;
  const confirm = p.entry_style === "confirm";

  const lines: OrderLine[] = [
    {
      label: "進場單",
      value: confirm ? `${side} 市價（觸及 ${fmt(p.entry)} 後，H4 收回同側才進）` : `${side} 限價 ${fmt(p.entry)}`,
      note: confirm ? "不要預掛限價：確認進場要等收盤，Telegram 會在成交條件成立時通知" : "掛在價位上等回踩；建議發出 60 秒內不進場",
    },
    { label: "停損單", value: `${close} 停損 ${fmt(p.stop_loss)}`, note: `距進場 ${fmt(risk)}（${Math.round((risk / p.entry) * 10000) / 100}%）` },
    {
      label: "停利單",
      value: scaleOut ? `${close} 限價 ${fmt(p.take_profit)}（半倉）` : `${close} 限價 ${fmt(p.take_profit)}`,
      note: scaleOut ? "剩餘半倉改追蹤停損，等結構翻轉或論點失效再出" : "整筆出場",
    },
    { label: "有效期限", value: validUntil ? validUntil.slice(0, 16).replace("T", " ") + " UTC" : "—", note: `${PENDING_ENTRY_MAX_HOURS} 小時未成交自動撤單；目標先到或跑太遠也會撤` },
  ];
  if (p.add_ons.length > 0) {
    lines.push({
      label: "加倉單",
      value: p.add_ons.map((a) => `${side} ${fmt(a.price)} → 停損移到 ${fmt(a.new_stop_loss)}`).join("；"),
      note: "到達時另行通知；加倉後停損一律跟著移",
    });
  }
  const steps = [
    confirm ? "等通知：價格觸及進場價並收回後，以市價進場" : "掛限價單於進場價，同時掛停損單",
    "成交後立刻確認停損單在位，Telegram 會發「已進場」",
    "+2R 時停損移到保本（監控自動提醒）；事件前 1 小時也移到保本",
    scaleOut ? "觸及停利先平一半，剩餘半倉跟著追蹤停損走" : "觸及停利整筆出場",
    "收到「結構翻轉」或「論點失效」通知時，立即市價出場",
  ];
  return {
    headline: `${signal.symbol} ${side}${p.swing ? "（當沖主計畫）" : ""}`,
    lines,
    steps,
    validUntil,
  };
}
