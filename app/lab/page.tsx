"use client";

import { useCallback, useEffect, useState } from "react";
import { COMMODITIES } from "@/types/signal";
import type { LabFinding, LabReport } from "@/lib/analysis/lab";
import type { LabAdoption } from "@/lib/analysis/lab-adoption";
import type { ForwardStat } from "@/lib/analysis/lab-forward";
import type { LabTradeRow } from "@/lib/db";
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

interface ForwardResponse {
  stats?: ForwardStat[];
  recent?: LabTradeRow[];
  total?: number;
  open?: number;
  since?: string | null;
  error?: string;
}

interface LiveStatus {
  symbol: string;
  direction: "long" | "short";
  met: boolean | null;
  blocked: boolean;
  detail: string | null;
  checkedAt: string | null;
}

interface AdoptResponse {
  adoptions?: LabAdoption[];
  live?: LiveStatus[];
  error?: string;
}

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;
}

function sameCombo(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join("+") === [...b].sort().join("+");
}

function FindingRow({
  f,
  floor,
  adopted,
  busy,
  onAdopt,
}: {
  f: LabFinding;
  floor: number;
  adopted: boolean;
  busy: boolean;
  onAdopt: (ids: string[]) => void;
}) {
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
        {/* 採用 only ever appears on a combination the hold-out confirmed —
            and the server re-verifies before believing this click anyway. */}
        {f.verified &&
          (adopted ? (
            <span className="ml-1.5 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-400">
              已採用
            </span>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAdopt(f.ids)}
              className="ml-1.5 rounded border border-emerald-500/40 px-1.5 py-0.5 text-[10px] text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-40"
            >
              採用
            </button>
          ))}
      </td>
      <td
        className={`py-2 text-right font-mono text-[11px] ${
          inRate >= floor ? "text-emerald-400" : "text-neutral-400"
        }`}
      >
        {pct(f.inSample.hitRate)}
        <span
          className="ml-1 text-[10px] text-neutral-600"
          title={`${f.inSample.trades} 筆結算／${f.inSample.entries} 次進場（${f.inSample.unresolved} 筆在 20 根內未觸及停損停利）`}
        >
          n={f.inSample.trades}/{f.inSample.entries}
        </span>
      </td>
      <td
        className={`py-2 text-right font-mono text-[11px] ${
          outRate >= floor ? "text-emerald-400" : "text-red-400/70"
        }`}
      >
        {pct(f.outOfSample.hitRate)}
        <span
          className="ml-1 text-[10px] text-neutral-600"
          title={`${f.outOfSample.trades} 筆結算／${f.outOfSample.entries} 次進場`}
        >
          n={f.outOfSample.trades}/{f.outOfSample.entries}
        </span>
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

function Table({
  rows,
  floor,
  adoptedIds,
  busy,
  onAdopt,
}: {
  rows: LabFinding[];
  floor: number;
  adoptedIds: string[] | null;
  busy: boolean;
  onAdopt: (ids: string[]) => void;
}) {
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
            <FindingRow
              key={f.ids.join("+")}
              f={f}
              floor={floor}
              adopted={adoptedIds !== null && sameCombo(adoptedIds, f.ids)}
              busy={busy}
              onAdopt={onAdopt}
            />
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
  const [adopt, setAdopt] = useState<AdoptResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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

  const [forward, setForward] = useState<ForwardResponse | null>(null);
  const [advancing, setAdvancing] = useState(false);

  const loadForward = useCallback(async () => {
    try {
      const res = await fetch(`/api/lab/forward?symbol=${symbol}&direction=${direction}`, {
        cache: "no-store",
      });
      setForward(await res.json());
    } catch (err) {
      setForward({ error: err instanceof Error ? err.message : String(err) });
    }
  }, [symbol, direction]);

  const advance = useCallback(async () => {
    setAdvancing(true);
    try {
      await fetch(`/api/lab/forward?symbol=${symbol}`, { method: "POST" });
      await loadForward();
    } finally {
      setAdvancing(false);
    }
  }, [symbol, loadForward]);

  const loadAdoptions = useCallback(async () => {
    try {
      const res = await fetch("/api/lab/adopt", { cache: "no-store" });
      setAdopt(await res.json());
    } catch (err) {
      setAdopt({ error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  useEffect(() => {
    void loadAdoptions();
  }, [loadAdoptions]);

  useEffect(() => {
    void loadForward();
  }, [loadForward]);

  const onAdopt = useCallback(
    async (ids: string[]) => {
      setBusy(true);
      setNotice(null);
      try {
        const res = await fetch("/api/lab/adopt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ symbol, direction, ids }),
        });
        const body = (await res.json()) as AdoptResponse & { error?: string };
        if (!res.ok) {
          setNotice(body.error ?? "採用失敗");
        } else {
          setAdopt(body);
          setNotice("已採用。從下一次掃描起，這個商品這個方向的進場都要先通過這組條件。");
          void loadAdoptions();
        }
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [symbol, direction, loadAdoptions],
  );

  const onRevoke = useCallback(
    async (s: string, d: "long" | "short") => {
      setBusy(true);
      setNotice(null);
      try {
        const res = await fetch(`/api/lab/adopt?symbol=${s}&direction=${d}`, { method: "DELETE" });
        const body = (await res.json()) as AdoptResponse & { error?: string };
        if (!res.ok) setNotice(body.error ?? "撤銷失敗");
        else {
          setNotice("已撤銷，這組條件不再擋下進場。");
          void loadAdoptions();
        }
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [loadAdoptions],
  );

  const r = data?.report;
  const adoptions = adopt?.adoptions ?? [];
  const current = adoptions.find((a) => a.symbol === symbol && a.direction === direction) ?? null;
  const adoptedIds = current ? current.ids : null;

  return (
    <main className="mx-auto max-w-2xl px-4 py-5">
      <SiteNav title="實驗室" />

      <p className="mb-3 text-[11px] leading-relaxed text-neutral-500">
        進場條件不靠講理決定，靠量。兩條腿：
        <span className="text-neutral-300">前進實驗</span>讓每個條件從今天起各自下單、各自結算，事前登記、事後不能改；
        <span className="text-neutral-300">回測</span>則把同一套條件放到十年日線上重跑一次，先單獨測，
        表現勝過基準的再層層疊加（兩個、三個、四個都試），全部扣掉交易成本。
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

      {notice && (
        <div className="mb-3 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3 text-xs leading-relaxed text-sky-300">
          {notice}
        </div>
      )}

      {/* 已採用 — first, because this is the part that touches real trades.
          Everything below it is research; this is what the scanner obeys. */}
      <section className="mb-4 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
        <h2 className="mb-1.5 text-xs font-medium text-sky-300">
          已採用的進場條件（{adoptions.length}）
        </h2>
        {adopt?.error && <p className="text-[11px] text-amber-400">{adopt.error}</p>}
        {adoptions.length === 0 ? (
          <p className="text-[10px] leading-relaxed text-neutral-500">
            目前沒有任何條件被採用，交易建議照原本的規則產生。
            通過驗證的組合按下「採用」後，該商品該方向的每一次進場都必須先滿足它，不滿足就只給參考價位。
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {adoptions.map((a) => {
              const status = adopt?.live?.find(
                (l) => l.symbol === a.symbol && l.direction === a.direction,
              );
              return (
                <li
                  key={`${a.symbol}:${a.direction}`}
                  className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-2"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[11px] font-medium text-neutral-100">{a.symbol}</span>
                    <span className="text-[10px] text-neutral-400">
                      {a.direction === "long" ? "做多" : "做空"}
                    </span>
                    <span className="text-[11px] text-neutral-300">{a.labels.join(" ＋ ")}</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void onRevoke(a.symbol, a.direction)}
                      className="ml-auto rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:bg-neutral-800 disabled:opacity-40"
                    >
                      撤銷
                    </button>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-neutral-500">
                    <span>
                      採用時：樣本內{" "}
                      <span className="font-mono text-neutral-300">{pct(a.inSample.hitRate)}</span>
                      （n={a.inSample.trades}）．樣本外{" "}
                      <span className="font-mono text-neutral-300">
                        {pct(a.outOfSample.hitRate)}
                      </span>
                      （n={a.outOfSample.trades}）
                    </span>
                    <span>{a.adoptedAt.slice(0, 16).replace("T", " ")} UTC</span>
                  </div>
                  {/* The proof it is actually running: what the newest stored
                      signal's own gate recorded, not a re-derivation here. */}
                  <div className="mt-1 text-[10px] leading-relaxed">
                    {status?.met === null || !status ? (
                      <span className="text-neutral-600">
                        最新掃描狀態：{status?.detail ?? "尚無資料"}
                      </span>
                    ) : status.met ? (
                      <span className="text-emerald-400">
                        最新掃描：條件成立（{status.detail}），沒有擋下任何進場
                        {status.checkedAt ? `．${status.checkedAt.slice(0, 16).replace("T", " ")} UTC` : ""}
                      </span>
                    ) : (
                      <span className="text-amber-400">
                        最新掃描：條件未成立（{status.detail}）
                        {status.blocked ? "，已擋下一次進場建議" : "，當時本來也沒有進場建議"}
                        {status.checkedAt ? `．${status.checkedAt.slice(0, 16).replace("T", " ")} UTC` : ""}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 前進實驗 — the ledger. Above the backtest because it is the harder
          evidence: these trades were registered before the outcome existed. */}
      <section className="mb-4 rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <h2 className="text-xs font-medium text-neutral-300">
            前進實驗 · {symbol} {direction === "long" ? "做多" : "做空"}
          </h2>
          {forward?.total !== undefined && (
            <span className="text-[10px] text-neutral-500">
              累計 {forward.total} 筆．進行中 {forward.open ?? 0}
            </span>
          )}
          <button
            type="button"
            onClick={() => void advance()}
            disabled={advancing}
            className="ml-auto rounded-lg border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          >
            {advancing ? "推進中…" : "立即推進"}
          </button>
        </div>
        <p className="mb-2 text-[10px] leading-relaxed text-neutral-500">
          每個條件<span className="text-neutral-300">各自獨立</span>下單：條件成立就以當根收盤價進場，
          停損 1×ATR、停利 1.5×ATR、最多持有 20 根，同一個條件同時只留一筆未結倉。
          進出場條件在開倉當下就寫進資料庫，之後只能結算、不能修改 ——
          這是<span className="text-neutral-300">事前登記</span>，和回測「事後翻歷史」是兩件事。
          每 4 小時的自動掃描會推進一次。
        </p>
        {forward?.error && <p className="text-[11px] text-amber-400">{forward.error}</p>}
        {forward?.stats && forward.stats.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-[10px] text-neutral-600">
                  <th className="py-1 font-normal">條件</th>
                  <th className="py-1 text-right font-normal">前進勝率</th>
                  <th className="py-1 text-right font-normal">勝／敗</th>
                  <th className="py-1 text-right font-normal">逾時</th>
                  <th className="py-1 text-right font-normal">進行中</th>
                </tr>
              </thead>
              <tbody>
                {forward.stats.map((s) => (
                  <tr key={`${s.direction}:${s.conditionId}`} className="border-t border-neutral-800">
                    <td className="py-1.5 pr-2 text-[11px] text-neutral-300">{s.label}</td>
                    <td
                      className={`py-1.5 text-right font-mono text-[11px] ${
                        s.hitRate === null
                          ? "text-neutral-600"
                          : s.hitRate >= 0.8
                            ? "text-emerald-400"
                            : "text-neutral-400"
                      }`}
                    >
                      {pct(s.hitRate)}
                      <span className="ml-1 text-[10px] text-neutral-600">n={s.resolved}</span>
                    </td>
                    <td className="py-1.5 text-right font-mono text-[11px] text-neutral-500">
                      {s.wins}／{s.losses}
                    </td>
                    <td className="py-1.5 text-right font-mono text-[11px] text-neutral-600">
                      {s.expired}
                    </td>
                    <td className="py-1.5 text-right font-mono text-[11px] text-neutral-500">
                      {s.open}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !forward?.error && (
            <p className="text-[10px] leading-relaxed text-neutral-600">
              還沒有前進紀錄。第一次推進之後，每根新的日線都會讓條件各自開倉、結算，
              數字會從零開始累積 —— 這段等待正是它比回測可信的原因：它沒辦法作弊。
            </p>
          )
        )}
        {forward?.recent && forward.recent.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[10px] text-neutral-600">
              最近 {forward.recent.length} 筆逐筆紀錄
            </summary>
            <ul className="mt-1 flex flex-col gap-0.5">
              {forward.recent.map((t) => (
                <li key={t.id} className="font-mono text-[10px] text-neutral-500">
                  {t.entryBarTime.slice(0, 10)} {t.conditionId} {t.direction === "long" ? "多" : "空"}{" "}
                  進 {t.entry.toFixed(2)} 損 {t.stop.toFixed(2)} 利 {t.target.toFixed(2)}{" "}
                  <span
                    className={
                      t.status === "win"
                        ? "text-emerald-400"
                        : t.status === "loss"
                          ? "text-red-400"
                          : "text-neutral-600"
                    }
                  >
                    {t.status === "open"
                      ? "進行中"
                      : t.status === "win"
                        ? `停利（持有 ${t.barsHeld} 根）`
                        : t.status === "loss"
                          ? `停損（持有 ${t.barsHeld} 根）`
                          : `逾時出場 ${t.exitPrice?.toFixed(2)}`}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

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
                <span className="text-neutral-600">
                  {" "}
                  n={r.baseline.inSample.trades}/{r.baseline.inSample.entries}
                </span>
              </span>
              <span>
                樣本外{" "}
                <span className="font-mono text-neutral-200">
                  {pct(r.baseline.outOfSample.hitRate)}
                </span>
                <span className="text-neutral-600">
                  {" "}
                  n={r.baseline.outOfSample.trades}/{r.baseline.outOfSample.entries}
                </span>
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
                這些是目前唯一有資格被納入交易條件的組合。按<span className="text-emerald-300">採用</span>
              就會生效 —— 伺服器會當場重跑一次驗證，通過才寫入。
              </p>
              <Table
                rows={r.verified}
                floor={r.floor}
                adoptedIds={adoptedIds}
                busy={busy}
                onAdopt={onAdopt}
              />
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
            <Table
              rows={r.solo}
              floor={r.floor}
              adoptedIds={adoptedIds}
              busy={busy}
              onAdopt={onAdopt}
            />
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
            <Table
              rows={r.pairs}
              floor={r.floor}
              adoptedIds={adoptedIds}
              busy={busy}
              onAdopt={onAdopt}
            />
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
