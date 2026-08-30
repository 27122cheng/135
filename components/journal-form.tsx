"use client";

import { useEffect, useState } from "react";
import { COMMODITIES } from "@/types/signal";
import { loadCustomSymbols } from "@/lib/custom-symbols";
import { STOP_REASON_LABELS, STOP_REASON_TAGS, type StopReasonTag } from "@/types/journal";

/**
 * Logs one closed trade.
 *
 * Deliberately has no severity field: the server computes it from the tag, the
 * loss and the stored history. Letting a person type it would make the per-tag
 * averages that drive interventions measure mood rather than mistakes.
 */

interface SeverityBreakdown {
  severity: number;
  preventable: boolean;
  averageLossPct: number | null;
  isOutsizedLoss: boolean;
  sameTagInLast20: number;
  isRepeatOffender: boolean;
}

const INPUT =
  "w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-700";
const LABEL = "mb-1 block text-[11px] text-neutral-500";

export function JournalForm({
  defaultSymbol,
  onSaved,
}: {
  defaultSymbol: string;
  onSaved: () => void;
}) {
  const [symbol, setSymbol] = useState(defaultSymbol);
  // 全部標的，含自訂 —— the picker listed COMMODITIES alone, so a BTC/ETH
  // row could be scanned, settled and journalled and still be unselectable
  // here. Read on mount like every other client roster (see app/page.tsx).
  const [roster, setRoster] = useState<{ symbol: string; label: string }[]>(
    () => COMMODITIES.map((c) => ({ symbol: c.symbol, label: c.label })),
  );
  useEffect(() => {
    setRoster([
      ...COMMODITIES.map((c) => ({ symbol: c.symbol, label: c.label })),
      ...loadCustomSymbols().map((c) => ({ symbol: c.symbol, label: c.label })),
    ]);
  }, []);

  const [direction, setDirection] = useState<"long" | "short">("long");
  const [grade, setGrade] = useState("B");
  const [entryPrice, setEntryPrice] = useState("");
  const [exitPrice, setExitPrice] = useState("");
  const [result, setResult] = useState<"win" | "loss" | "breakeven">("loss");
  const [tag, setTag] = useState<StopReasonTag>("S1");
  const [note, setNote] = useState("");
  const [closedAt, setClosedAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [breakdown, setBreakdown] = useState<SeverityBreakdown | null>(null);

  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  // Derived rather than typed, so the sign always matches the direction.
  const pnlPct =
    Number.isFinite(entry) && Number.isFinite(exit) && entry > 0
      ? ((direction === "long" ? exit - entry : entry - exit) / entry) * 100
      : null;

  async function submit() {
    if (pnlPct === null) {
      setMessage("進場價與出場價必須是有效數字");
      return;
    }
    setSaving(true);
    setMessage(null);
    setBreakdown(null);
    try {
      const res = await fetch("/api/journal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          signal_id: null,
          symbol,
          direction,
          grade,
          entry_price: entry,
          exit_price: exit,
          result,
          pnl_pct: Math.round(pnlPct * 10000) / 10000,
          closed_at: new Date(closedAt).toISOString(),
          stop_reason_tag: result === "loss" ? tag : null,
          review_note: note || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setBreakdown(data.severity_breakdown ?? null);
      setMessage("已記錄");
      setEntryPrice("");
      setExitPrice("");
      setNote("");
      onSaved();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL} htmlFor="j-symbol">
            標的
          </label>
          <select id="j-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} className={INPUT}>
            {roster.map((c) => (
              <option key={c.symbol} value={c.symbol}>
                {c.symbol}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL} htmlFor="j-direction">
            方向
          </label>
          <select
            id="j-direction"
            value={direction}
            onChange={(e) => setDirection(e.target.value as "long" | "short")}
            className={INPUT}
          >
            <option value="long">做多</option>
            <option value="short">做空</option>
          </select>
        </div>
        <div>
          <label className={LABEL} htmlFor="j-entry">
            進場價
          </label>
          <input
            id="j-entry"
            inputMode="decimal"
            value={entryPrice}
            onChange={(e) => setEntryPrice(e.target.value)}
            className={INPUT}
            placeholder="2000"
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="j-exit">
            出場價
          </label>
          <input
            id="j-exit"
            inputMode="decimal"
            value={exitPrice}
            onChange={(e) => setExitPrice(e.target.value)}
            className={INPUT}
            placeholder="1980"
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="j-grade">
            當時評等
          </label>
          <select id="j-grade" value={grade} onChange={(e) => setGrade(e.target.value)} className={INPUT}>
            {["A+", "A", "B", "C", "no-trade"].map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL} htmlFor="j-result">
            結果
          </label>
          <select
            id="j-result"
            value={result}
            onChange={(e) => setResult(e.target.value as "win" | "loss" | "breakeven")}
            className={INPUT}
          >
            <option value="loss">虧損</option>
            <option value="win">獲利</option>
            <option value="breakeven">平手</option>
          </select>
        </div>
      </div>

      <div>
        <label className={LABEL} htmlFor="j-closed">
          平倉時間
        </label>
        <input
          id="j-closed"
          type="datetime-local"
          value={closedAt}
          onChange={(e) => setClosedAt(e.target.value)}
          className={INPUT}
        />
      </div>

      {result === "loss" && (
        <div>
          <label className={LABEL} htmlFor="j-tag">
            停損原因（必填）
          </label>
          <select
            id="j-tag"
            value={tag}
            onChange={(e) => setTag(e.target.value as StopReasonTag)}
            className={INPUT}
          >
            {STOP_REASON_TAGS.map((t) => (
              <option key={t} value={t}>
                {t} {STOP_REASON_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className={LABEL} htmlFor="j-note">
          復盤筆記（選填）
        </label>
        <textarea
          id="j-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className={INPUT}
          placeholder="當下在想什麼、事後看該怎麼做"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={saving}
          className="rounded-lg bg-neutral-100 px-5 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
        >
          {saving ? "儲存中…" : "記錄"}
        </button>
        {pnlPct !== null && (
          <span className={`text-xs tabular-nums ${pnlPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            損益 {pnlPct >= 0 ? "+" : ""}
            {pnlPct.toFixed(2)}%
          </span>
        )}
        {message && <span className="text-xs text-neutral-400">{message}</span>}
      </div>

      {breakdown && (
        <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-3 text-[11px] leading-relaxed text-neutral-400">
          <p className="mb-1 text-neutral-200">severity = {breakdown.severity}（公式算出，非人工評分）</p>
          <ul className="space-y-0.5">
            <li>可事前預防：{breakdown.preventable ? "是 +2" : "否 +0"}</li>
            <li>
              本次虧損 &gt; 平均虧損 ×1.5：{breakdown.isOutsizedLoss ? "是 +1" : "否 +0"}
              {breakdown.averageLossPct !== null && `（平均 ${breakdown.averageLossPct.toFixed(2)}%）`}
            </li>
            <li>
              近 20 筆同 tag ≥3 次：{breakdown.isRepeatOffender ? "是 +2" : "否 +0"}（目前{" "}
              {breakdown.sameTagInLast20} 次）
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
