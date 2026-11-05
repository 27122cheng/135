import type { DailyReport } from "./daily-report";

/**
 * The report as a standalone SVG — the image a trading room posts.
 * Pure string assembly; no browser, no canvas, so the same bytes come from
 * the API on the server and from the download button on the page.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function reportSvg(report: DailyReport): string {
  const W = 900;
  const rowH = 26;
  const real = report.rows.filter((r) => !r.paper);
  const tableTop = 330 + Math.ceil(report.bySymbol.length / 3) * 26;
  const H = tableTop + 40 + Math.max(1, real.length) * rowH + 90;
  const s = report.summary;
  const period = report.range === "day" ? report.from : `${report.from} ～ ${report.to}`;
  const gold = "#d4a84b";
  const tile = (x: number, label: string, value: string, tone: string) =>
    `<rect x="${x}" y="130" width="200" height="70" rx="8" fill="#101826" stroke="#1f2a3a"/>` +
    `<text x="${x + 100}" y="152" font-size="12" fill="#9b9891" text-anchor="middle">${esc(label)}</text>` +
    `<text x="${x + 100}" y="184" font-size="24" font-weight="700" fill="${tone}" text-anchor="middle">${esc(value)}</text>`;
  const symbols = report.bySymbol
    .map((b, i) => {
      const x = 40 + (i % 3) * 280;
      const y = 300 + Math.floor(i / 3) * 26;
      return `<text x="${x}" y="${y}" font-size="13" fill="#e7e5e0">${esc(b.label)}</text>` +
        `<text x="${x + 130}" y="${y}" font-size="13" fill="#f87171">盈 ${b.winPoints}</text>` +
        `<text x="${x + 200}" y="${y}" font-size="13" fill="#34d399">損 ${Math.abs(b.lossPoints)}</text>`;
    })
    .join("");
  const header = ["商品", "方向", "進場", "出場", "點數", "％", "出場方式"];
  const colX = [40, 230, 300, 420, 540, 640, 740];
  const rows = real.length === 0
    ? `<text x="40" y="${tableTop + 60}" font-size="13" fill="#9b9891">本期沒有結算的正式訊號。</text>`
    : real
        .map((r, i) => {
          const y = tableTop + 60 + i * rowH;
          const win = r.points > 0;
          return `<rect x="30" y="${y - 17}" width="${W - 60}" height="${rowH}" fill="${i % 2 ? "#0d1420" : "#0a0f18"}"/>` +
            `<text x="${colX[0]}" y="${y}" font-size="13" fill="#e7e5e0">${esc(r.label)}</text>` +
            `<text x="${colX[1]}" y="${y}" font-size="13" fill="${r.direction === "long" ? "#f87171" : "#34d399"}">${r.direction === "long" ? "多" : "空"}</text>` +
            `<text x="${colX[2]}" y="${y}" font-size="13" fill="#e7e5e0">${r.entry}</text>` +
            `<text x="${colX[3]}" y="${y}" font-size="13" fill="#e7e5e0">${r.exit}</text>` +
            `<text x="${colX[4]}" y="${y}" font-size="13" fill="${win ? "#f87171" : "#34d399"}">${r.points > 0 ? "+" : ""}${r.points}</text>` +
            `<text x="${colX[5]}" y="${y}" font-size="13" fill="${r.pnlPct >= 0 ? "#f87171" : "#34d399"}">${r.pnlPct > 0 ? "+" : ""}${r.pnlPct}%</text>` +
            `<text x="${colX[6]}" y="${y}" font-size="12" fill="#9b9891">${esc(r.exitKind)}</text>`;
        })
        .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,'PingFang TC','Noto Sans TC',sans-serif">
<rect width="${W}" height="${H}" fill="#0b0f16"/>
<rect x="0" y="0" width="${W}" height="100" fill="#111827"/>
<rect x="30" y="34" width="150" height="32" rx="4" fill="${gold}"/>
<text x="105" y="56" font-size="18" font-weight="700" fill="#0b0f16" text-anchor="middle">${esc(period)}</text>
<text x="200" y="58" font-size="24" font-weight="700" fill="#e7e5e0">盤中策略與交易紀錄</text>
<text x="${W - 30}" y="58" font-size="12" fill="#9b9891" text-anchor="end">正式訊號，監控自動結算</text>
<text x="40" y="118" font-size="14" font-weight="600" fill="#e7e5e0">${report.range === "day" ? "今日" : report.range === "week" ? "本週" : "本月"}策略表現摘要</text>
${tile(40, "有效記錄", `${s.trades} 筆`, "#e7e5e0")}
${tile(255, "勝率", s.winRate === null ? "—" : `${s.winRate}%`, "#f87171")}
${tile(470, "盈虧比", s.profitFactor === null ? "—" : `${s.profitFactor}:1`, gold)}
${tile(685, "最大回撤", `${s.maxDrawdownPct}%`, "#34d399")}
<text x="40" y="222" font-size="12" fill="#9b9891">95% 區間 ${s.winRateLow ?? "—"}–${s.winRateHigh ?? "—"}%｜淨 ${s.netPct > 0 ? "+" : ""}${s.netPct}%｜歷史參考 ${report.historical.trades} 筆：勝率 ${report.historical.winRate ?? "—"}%，盈虧比 ${report.historical.profitFactor ?? "—"}，最大回撤 ${report.historical.maxDrawdownPct}%</text>
<text x="40" y="270" font-size="14" font-weight="600" fill="#e7e5e0">所選商品完整點數</text>
<text x="${W - 30}" y="270" font-size="11" fill="#9b9891" text-anchor="end">進出場價差，各商品單位不同，不代表實際收益</text>
${symbols}
<text x="40" y="${tableTop + 20}" font-size="14" font-weight="600" fill="#e7e5e0">完整交易明細</text>
<rect x="30" y="${tableTop + 28}" width="${W - 60}" height="24" fill="#1f2a3a"/>
${header.map((h, i) => `<text x="${colX[i]}" y="${tableTop + 45}" font-size="12" fill="${gold}">${h}</text>`).join("")}
${rows}
<text x="40" y="${H - 40}" font-size="11" fill="#9b9891">${esc(report.notes[0])}</text>
<text x="40" y="${H - 22}" font-size="11" fill="#9b9891">${esc(report.notes[1])}</text>
</svg>`;
}
