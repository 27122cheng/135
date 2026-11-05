import { findInstrument } from "@/lib/server-symbols";
import { fetchDeepD1, fetchDeepH4 } from "@/lib/data-sources/deep-history";
import { runLab } from "@/lib/analysis/lab";
import {
  ADOPTED_KEY,
  adoptionFromFinding,
  adoptionHealth,
  decideAutoAdoption,
  findAdoption,
  loadAdoptions,
  parseAdoptions,
  removeAdoption,
  serializeAdoptions,
  upsertAdoption,
  type LabAdoption,
} from "@/lib/analysis/lab-adoption";
import { getSignalStore } from "@/lib/db";
import { applyStoredTradingCosts, clearSettingsCache, getSetting } from "@/lib/settings";
import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 自動採用與嚴格模式.
 *
 * GET  — the two settings and a count of what is adopted.
 * POST — body { strict?, floor? } saves the settings;
 *        ?symbol=&direction=&timeframe=&run=1 runs the lab for that slot and
 *        applies decideAutoAdoption. One slot per request: a lab run is a
 *        deep-history fetch plus a beam search, and two directions do not
 *        fit inside the function ceiling. The weekly workflow loops them.
 */

const LAST_RUN_KEY = "LAB_AUTO_LAST_RUN";

async function readFloor(): Promise<number> {
  const raw = Number(await getSetting("LAB_AUTO_FLOOR").catch(() => null));
  return Number.isFinite(raw) && raw >= 0.5 && raw <= 0.95 ? raw : 0.55;
}

export async function GET() {
  const store = getSignalStore();
  if (!store) return json({ error: "未設定資料庫" }, { status: 501 });
  try {
    const adoptions = await loadAdoptions();
    const settings = await store.listSettings().catch(() => new Map<string, string>());
    return json({
      strict: (await getSetting("LAB_STRICT").catch(() => null)) === "1",
      floor: await readFloor(),
      adoptions: adoptions.length,
      auto: adoptions.filter((a) => a.adoptedBy === "auto").length,
      probation: 0,
      lastRun: settings.get(LAST_RUN_KEY) ?? null,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}

async function persist(store: NonNullable<ReturnType<typeof getSignalStore>>, list: LabAdoption[]) {
  await store.saveSetting(ADOPTED_KEY, serializeAdoptions(list));
  clearSettingsCache();
}

export async function POST(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const url = new URL(request.url);
  const run = url.searchParams.get("run") === "1";
  if (run && cronSecret && request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  const store = getSignalStore();
  if (!store) return json({ error: "未設定資料庫" }, { status: 501 });

  if (!run) {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "請求格式錯誤" }, { status: 400 });
    }
    if (typeof body.strict === "boolean") await store.saveSetting("LAB_STRICT", body.strict ? "1" : "0");
    if (typeof body.floor === "number" && body.floor >= 0.5 && body.floor <= 0.95) {
      await store.saveSetting("LAB_AUTO_FLOOR", String(body.floor));
    }
    clearSettingsCache();
    return json({ ok: true });
  }

  const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase();
  const direction = url.searchParams.get("direction") === "short" ? "short" : "long";
  const timeframe = url.searchParams.get("timeframe") === "H4" ? "H4" : "D1";
  const meta = await findInstrument(symbol);
  if (!meta) return json({ error: `未知的商品 ${symbol}` }, { status: 400 });

  const gaps: string[] = [];
  try {
    await applyStoredTradingCosts();
    const floor = await readFloor();
    const deep = timeframe === "H4" ? await fetchDeepH4(meta, gaps) : await fetchDeepD1(meta, gaps);
    if (!deep?.candles?.length) return json({ error: "取不到 K 棒", gaps }, { status: 502 });
    const report = runLab(meta, deep.candles, direction, floor, timeframe);
    if (!report) return json({ error: "K 棒不足", gaps }, { status: 422 });

    const list = parseAdoptions((await store.listSettings()).get(ADOPTED_KEY) ?? null);
    const current = findAdoption(list, symbol, direction) ?? null;
    const sameTf = current && current.timeframe === timeframe ? current : null;
    const labTrades = await store.listLabTrades({ symbol, limit: 4000 }).catch(() => []);
    const decision = decideAutoAdoption({
      current: sameTf,
      health: sameTf ? adoptionHealth(sameTf, labTrades) : null,
      verified: report.verified,
    });

    let next = list;
    if (decision.action === "adopt") {
      const adoption = adoptionFromFinding(symbol, direction, decision.finding, floor, report.bars, new Date(), timeframe);
      adoption.adoptedBy = "auto";
      next = upsertAdoption(list, adoption);
    } else if (decision.action === "remove" && sameTf) {
      next = removeAdoption(list, symbol, direction);
    }
    if (next !== list) await persist(store, next);
    await store.saveSetting(LAST_RUN_KEY, new Date().toISOString()).catch(() => undefined);
    return json({
      symbol,
      direction,
      timeframe,
      floor,
      decision: decision.action,
      reason: decision.reason,
      verified: report.verified.length,
      adopted: decision.action === "adopt" ? decision.finding.labels : null,
      gaps,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err), gaps }, { status: 502 });
  }
}
