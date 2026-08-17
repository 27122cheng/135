import { COMMODITIES } from "@/types/signal";
import { fetchOHLCV } from "@/lib/data-sources/ohlcv";
import { VERIFY_FLOOR, runLab } from "@/lib/analysis/lab";
import {
  ADOPTED_KEY,
  adoptionFromFinding,
  evaluateAdoption,
  loadAdoptions,
  parseAdoptions,
  removeAdoption,
  serializeAdoptions,
  upsertAdoption,
  type LabAdoption,
} from "@/lib/analysis/lab-adoption";
import { getSignalStore } from "@/lib/db";
import { clearSettingsCache } from "@/lib/settings";
import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 採用／撤銷 the lab's verified condition combinations.
 *
 * ## The server does not take the client's word for anything
 *
 * A POST names a symbol, a direction and a set of condition ids — and nothing
 * else. Every number stored with the adoption is measured here, by re-running
 * the lab and locating that exact combination among the findings that passed
 * out-of-sample verification. A combination the fresh run does not verify is
 * refused, whatever the page that submitted it believed.
 *
 * That matters beyond the usual "never trust the client" reflex: the lab page
 * may be showing a report computed minutes or hours ago, and the adoption is
 * about to gate real trades. Re-measuring at the moment of adoption is the
 * difference between "this passed when I looked" and "this passes".
 */

interface Live {
  symbol: string;
  direction: "long" | "short";
  /** What the newest stored signal's gate said, if that signal has one. */
  met: boolean | null;
  blocked: boolean;
  detail: string | null;
  checkedAt: string | null;
}

/**
 * GET — the adoptions, plus what each one is doing to live signals.
 *
 * The second half is the point. An adoption that is stored but never consulted
 * is indistinguishable, from the page, from one that is gating every trade, so
 * the newest signal for each adopted symbol is read back and its own recorded
 * gate reported: whether the condition held at the last scan, and whether it
 * withheld a trade. That is the evidence the gate is actually running, taken
 * from the signal the board and the alerts are built from rather than
 * re-derived here.
 */
export async function GET() {
  const store = getSignalStore();
  if (!store) {
    return json({ adoptions: [], live: [], error: "未設定資料庫，無法儲存或讀取採用紀錄" }, { status: 501 });
  }
  try {
    const adoptions = await loadAdoptions();
    const live: Live[] = [];
    if (adoptions.length > 0) {
      const rows = await store.latestPerSymbol();
      for (const a of adoptions) {
        const row = rows.find((r) => r.symbol === a.symbol);
        const gate = row?.lab_gate ?? null;
        // A signal in the other direction is not evidence about this adoption.
        const applies = row?.direction === a.direction && gate !== null;
        live.push({
          symbol: a.symbol,
          direction: a.direction,
          met: applies ? gate!.met : null,
          blocked: applies ? gate!.blocked : false,
          detail: applies
            ? (gate!.unevaluable ??
              `${gate!.checks.filter((c) => c.met).length}/${gate!.checks.length} 項符合`)
            : row
              ? `最新訊號為${row.direction === "long" ? "做多" : "做空"}，這組條件不適用`
              : "尚無已儲存的訊號",
          checkedAt: row?.generated_at ?? null,
        });
      }
    }
    return json({ adoptions, live });
  } catch (err) {
    return json(
      { adoptions: [], live: [], error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

async function persist(list: LabAdoption[]): Promise<void> {
  const store = getSignalStore();
  if (!store) throw new Error("未設定資料庫，無法儲存採用紀錄");
  await store.saveSetting(ADOPTED_KEY, serializeAdoptions(list));
  clearSettingsCache();
  // A write that cannot be read back is not a write — the same rule the
  // settings page learned the hard way. Neon's HTTP reads can trail a commit
  // by a beat, so the check gets one retry before it is called lost.
  const fingerprint = (l: LabAdoption[]) =>
    l
      .map((a) => `${a.symbol}:${a.direction}:${[...a.ids].sort().join("+")}`)
      .sort()
      .join("|");
  const want = fingerprint(list);
  for (const wait of [0, 800]) {
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const echo = parseAdoptions((await store.listSettings()).get(ADOPTED_KEY) ?? null);
    if (fingerprint(echo) === want) return;
  }
  throw new Error("採用紀錄寫入後讀不回，資料庫收下了寫入卻沒有留住");
}

/** POST /api/lab/adopt — body { symbol, direction, ids }. */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "請求格式錯誤" }, { status: 400 });
  }

  const symbol = typeof body.symbol === "string" ? body.symbol.toUpperCase() : "";
  const direction = body.direction === "short" ? "short" : "long";
  const meta = COMMODITIES.find((c) => c.symbol === symbol);
  if (!meta) return json({ error: `未知的商品 ${symbol}` }, { status: 400 });
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return json({ error: "沒有指定條件" }, { status: 400 });
  }
  const ids = body.ids.filter((id): id is string => typeof id === "string");
  if (ids.length !== body.ids.length || new Set(ids).size !== ids.length) {
    return json({ error: "條件清單格式錯誤" }, { status: 400 });
  }

  const gaps: string[] = [];
  try {
    // Re-measure. The report the page is showing may be stale, and this is the
    // moment the combination starts governing real entries.
    const d1 = await fetchOHLCV(meta, "D1", gaps);
    if (!d1?.candles?.length) {
      return json({ error: "取不到 K 棒，無法在採用前重新驗證", gaps }, { status: 502 });
    }
    const report = runLab(meta, d1.candles, direction, VERIFY_FLOOR);
    if (!report) {
      return json({ error: "K 棒不足，無法重新驗證", gaps }, { status: 422 });
    }
    const key = [...ids].sort().join("+");
    const finding = report.verified.find((f) => [...f.ids].sort().join("+") === key);
    if (!finding) {
      return json(
        {
          error:
            "這組條件在剛剛重跑的實驗中沒有通過樣本外驗證，因此不予採用。" +
            "實驗室的結果會隨新的 K 棒改變，畫面上的報告可能已經過時 —— 請重跑實驗再看一次。",
          gaps,
        },
        { status: 422 },
      );
    }

    const adoption = adoptionFromFinding(
      meta.symbol,
      direction,
      finding,
      report.floor,
      report.bars,
    );
    const next = upsertAdoption(await loadAdoptions(), adoption);
    await persist(next);
    return json({
      adoption,
      adoptions: next,
      // Checked against the same candles the verification just used, so the
      // operator sees immediately whether the condition holds right now.
      now: evaluateAdoption(adoption, d1.candles),
      gaps,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err), gaps }, { status: 502 });
  }
}

/** DELETE /api/lab/adopt?symbol=&direction= — 撤銷. Always allowed: removing a gate cannot create a trade the other gates would refuse. */
export async function DELETE(request: Request) {
  const params = new URL(request.url).searchParams;
  const symbol = params.get("symbol")?.toUpperCase() ?? "";
  const direction = params.get("direction") === "short" ? "short" : "long";
  try {
    const next = removeAdoption(await loadAdoptions(), symbol, direction);
    await persist(next);
    return json({ adoptions: next });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
