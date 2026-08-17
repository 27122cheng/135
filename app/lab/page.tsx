"use client";

import { useCallback, useEffect, useState } from "react";
import { COMMODITIES } from "@/types/signal";
import type { LabFinding, LabReport } from "@/lib/analysis/lab";
import { SiteNav } from "@/components/site-nav";

/**
 * 實驗室 — the page where entry conditions have to prove themselves.
 *
 * The layout follows the method rather than the results: baseline first
 * (nothing means anything without it), then conditions alone, then the pairs
 * built from the ones that survived, and only at the end the handful that
 * cleared the floor on data the search never saw. The multiple-testing count
 * sits next to the findings, not in a footnote — it is the reason most
 * "discoveries" here are not discoveries.
 */

interface LabResponse {
  report?: LabReport;
  error?: string;
  gaps?: string[];
}

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;
}

function FindingRow({ f, floor }: { f: LabFinding; floor: number }) {
  const inRate = f.inSample.hitRate ?? 0;
  const outRate = f.outOfSample.hitRate ?? 0;
  return (
    <tr className="border-t border-neutral-800">
      <td className="py-2 pr-2">
        <span className="text-[11px] leading-relaxed text-neutral-200">
          {f.labels.join(" ＋ ")}
        </span>
        {f.verified && (
          <span className="ml-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-400">
            通過
          </span>
        )}
      </td>
      <td
        className={`py-2 text-right font-mono text-[11px] ${
          inRate >= floor ? "text-emerald-400" : "text-neutral-400"
        }`}
      >
        {pct(f.inSample.hitRate)}
        <span className="ml-1 text-[10px] text-neutral-600">n={f.inSample.trades}</span>
      </td>
      <td
        className={`py-2 text-right font-mono text-[11px] ${
          outRate >= floor ? "text-emerald-400" : "text-red-400/70"
        }`}
      >
        {pct(f.outOfSample.hitRate)}
        <span className="ml-1 text-[10px] text-neutral-600">n={f.outOfSample.trades}</span>
      </td>
      <td
        className={`py-2 text-right font-mono text-[11px] ${
          (f.lift ?? 0) > 0 ? "text-emerald-400" : "text-neutral-600"
        }`}
      >
        {f.lift === null ? "—" : `${f.lift > 0 ? "+" : ""}${f.lift}`}
      </td>
    </tr>
  );
}

function Table({ rows, floor }: { rows: LabFinding[]; floor: number }) {
  if (rows.length === 0) {
    return <p className="py-3 text-center text-[11px] text-neutral-600">樣本不足，沒有可報告的結果</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="text-left text-[10px] text-neutral-600">
            <th className="py-1 font-normal">條件</th>
            <th className="py-1 text-right font-normal">樣本內勝率</th>
            <th className="py-1 text-right font-normal">樣本外勝率</th>
            <th className="py-1 text-right font-normal">相對基準</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <FindingRow key={f.ids.join("+")} f={f} floor={floor} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function LabPage() {
  const [symbol, setSymbol] = useState("XAUUSD");
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [data, setData] = useState<LabResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    setData(null);
    try {
      const res = await fetch(`/api/lab?symbol=${symbol}&direction=${direction}`, {
        cache: "no-store",
      });
      setData(await res.json());
    } catch (err) {
      setData({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }, [symbol, direction]);

  useEffect(() => {
    void run();
  }, [run]);

  const r = data?.report;

  return (
    <main className="mx-auto max-w-2xl px-4 py-5">
      <SiteNav title="實驗室" />

      <p className="mb-3 text-[11px] leading-relaxed text-neutral-500">
        進場條件不靠講理決定，靠量。每個條件<span className="text-neutral-300">單獨測</span>，
        表現勝過基準的再<span className="text-neutral-300">層層疊加</span>（兩個、三個、四個都試，
        疊到樣本數不足為止），全部扣掉交易成本。
        採用標準：<span className="text-neutral-300">樣本數 ≥100 筆、勝率 ≥80%</span>，
        而且只用最舊的 70% 歷史搜尋 —— 最新的 30% 完全不參與搜尋，只用來驗證，兩邊都要達標。
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <select
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          className="rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1 text-xs text-neutral-100"
        >
          {COMMODITIES.map((c) => (
            <option key={c.symbol} value={c.symbol}>
              {c.label}
            </option>
          ))}
        </select>
        {(["long", "short"] as const).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDirection(d)}
            className={`rounded-full px-3 py-1 text-xs ${
              direction === d
                ? "bg-neutral-100 text-neutral-900"
                : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {d === "long" ? "做多條件" : "做空條件"}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void run()}
          disabled={loading}
          className="ml-auto rounded-lg border border-neutral-700 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
        >
          {loading ? "實驗中…" : "重跑實驗"}
        </button>
      </div>

      {loading && <p className="py-8 text-center text-sm text-neutral-500">回測所有條件與組合中…</p>}

      {data?.error && (
        <div className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-400">
          {data.error}
        </div>
      )}

      {r && (
        <div className="flex flex-col gap-4">
          {/* Baseline first: no number below means anything without it. */}
          <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
            <h2 className="mb-1.5 text-xs font-medium text-neutral-300">基準線（不加任何條件）</h2>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-neutral-400">
              <span>
                樣本內{" "}
                <span className="font-mono text-neutral-200">{pct(r.baseline.inSample.hitRate)}</span>
                <span className="text-neutral-600"> n={r.baseline.inSample.trades}</span>
              </span>
              <span>
                樣本外{" "}
                <span className="font-mono text-neutral-200">
                  {pct(r.baseline.outOfSample.hitRate)}
                </span>
                <span className="text-neutral-600"> n={r.baseline.outOfSample.trades}</span>
              </span>
              <span className="text-neutral-600">
                門檻 {pct(r.floor)}．已扣成本 {r.costPct}%．{r.bars} 根 K 棒
              </span>
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-neutral-600">
              固定幾何：停損 1×ATR、停利 1.5×ATR、最多持有 20 根。
              所有條件都用同一組幾何測，比較的才是「條件」而不是「條件配上剛好適合它的價位」。
            </p>
          </section>

          {r.verified.length > 0 ? (
            <section className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-3">
              <h2 className="mb-1.5 text-xs font-medium text-emerald-300">
                通過樣本外驗證（{r.verified.length}）
              </h2>
              <p className="mb-2 text-[10px] leading-relaxed text-neutral-400">
                樣本內 ≥100 筆、樣本外 ≥43 筆，且兩邊勝率都達到 {pct(r.floor)}。
                這些是目前唯一有資格被納入交易條件的組合。
              </p>
              <Table rows={r.verified} floor={r.floor} />
            </section>
          ) : (
            <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
              <h2 className="mb-1.5 text-xs font-medium text-amber-300">沒有條件通過驗證</h2>
              <p className="text-[11px] leading-relaxed text-amber-400/80">
                這是結論，不是失敗。代表在這段歷史上，沒有任何條件或組合能穩定把勝率推過門檻 ——
                硬把樣本內表現最好的那個拿來用，就是過度擬合，也正是多數策略上線後失效的原因。
              </p>
            </section>
          )}

          <section>
            <h2 className="mb-1.5 text-xs font-medium text-neutral-300">
              單一條件（{r.solo.length}）
            </h2>
            <Table rows={r.solo} floor={r.floor} />
          </section>

          <section>
            <h2 className="mb-1.5 text-xs font-medium text-neutral-300">
              條件組合（{r.pairs.length}）
            </h2>
            <p className="mb-1.5 text-[10px] leading-relaxed text-neutral-600">
              只用單獨測試時勝過基準的條件去疊加，從兩個一路試到四個。
              每多疊一個條件，符合的 K 棒就更少 —— 掉到 100 筆以下的組合會直接被剔除，
              這正是擋掉「十一筆交易 100% 勝率」這種假發現的機制。
            </p>
            <Table rows={r.pairs} floor={r.floor} />
          </section>

          <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
            <h2 className="mb-1.5 text-xs font-medium text-neutral-300">這份實驗的誠實限制</h2>
            <ul className="flex flex-col gap-1.5">
              {r.notes.map((n, i) => (
                <li key={i} className="text-[10px] leading-relaxed text-neutral-500">
                  · {n}
                </li>
              ))}
              <li className="text-[10px] leading-relaxed text-neutral-500">
                · 測試的是「什麼時候進場」，不是「停損停利放哪裡」——
                後者由結構決定，在別的地方處理。
              </li>
              <li className="text-[10px] leading-relaxed text-neutral-500">
                · 一個商品的結果不能套用到另一個。外匯與原油的行為不同，
                條件要各自驗證。
              </li>
            </ul>
          </section>
        </div>
      )}
    </main>
  );
}
