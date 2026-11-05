import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, report } from "./_harness";
import { __resetCacheForTests, cacheSize, getCached, MAX_ENTRIES, setCached } from "@/lib/data-sources/cache";

/** 自架主機的護欄 — bounded memory cache, process guards, supervisor. */

{
  __resetCacheForTests();
  for (let i = 0; i < MAX_ENTRIES + 500; i++) setCached(`k:${i}`, i, 60_000, 60_000);
  check("the memory cache never exceeds its cap", cacheSize() <= MAX_ENTRIES, cacheSize());
  check("the newest entries survive", getCached<number>(`k:${MAX_ENTRIES + 499}`) === MAX_ENTRIES + 499);
  check("the oldest were the ones dropped", getCached<number>("k:0") === undefined);

  __resetCacheForTests();
  // Expired-past-stale entries are swept on write, even when never read.
  // Sweeps run every 50 writes: 100 dead writes cross two boundaries.
  for (let i = 0; i < 100; i++) setCached(`dead:${i}`, i, -10_000, 1);
  setCached("live", 1, 60_000, 60_000);
  check("expired entries are swept without being read", cacheSize() <= 1, cacheSize());
}

{
  const root = join(__dirname, "..");
  const inst = readFileSync(join(root, "instrumentation.ts"), "utf8");
  const cfg = readFileSync(join(root, "next.config.mjs"), "utf8");
  const serve = readFileSync(join(root, "scripts", "serve.mjs"), "utf8");
  const pkg = readFileSync(join(root, "package.json"), "utf8");
  check("unhandled rejections are logged, not fatal", inst.includes('process.on("unhandledRejection"') && inst.includes("kept running"));
  check("uncaught exceptions too", inst.includes('process.on("uncaughtException"'));
  check("a memory line every ten minutes, and the timer never keeps the process alive", inst.includes("setInterval(tick, 10 * 60_000)") && inst.includes("timer.unref()"));
  check("the hook is enabled", cfg.includes("instrumentationHook: true"));
  check("the supervisor restarts with backoff and logs the exit reason", serve.includes("code=${code} signal=") && serve.includes("backoff = Math.min(backoff * 2, 60_000)"));
  check("it builds when there is no build, and never runs next dev", serve.includes('run(["next", "build"])') && !serve.includes('"dev"'));
  check("npm run serve is wired", pkg.includes('"serve": "node scripts/serve.mjs"'));
}

report("host guards");
