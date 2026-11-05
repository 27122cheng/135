/**
 * 程序層級的護欄 — for the case where a PC is the host.
 *
 * On Vercel a function instance is disposable and nothing here matters. On
 * a PC running `next start` for days, the process has to survive what a
 * serverless instance never lives long enough to meet:
 *
 *  - An unhandled promise rejection. Node 15+ exits the process on one by
 *    default. Every route here catches its own errors, but a rejection in a
 *    detached chain anywhere — a library, a timer, a cache write — would
 *    take the whole server down with it, silently, "一段時間後跳掉". Logged
 *    with its stack, not fatal.
 *  - An uncaught exception. Logged the same way. The process keeps serving;
 *    a crashed request already got its 500.
 *  - Memory drift. One line every ten minutes with RSS and heap, so the log
 *    the supervisor keeps (scripts/serve.mjs) can show a leak before the OS
 *    kills the process and after, which it is.
 *
 * Runs once per server start (Next's instrumentation hook), Node runtime only.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const stamp = () => new Date().toISOString();

  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error(`[${stamp()}] unhandledRejection (kept running): ${detail}`);
  });
  process.on("uncaughtException", (err) => {
    console.error(`[${stamp()}] uncaughtException (kept running): ${err.stack ?? err.message}`);
  });

  const mb = (n: number) => Math.round(n / 1024 / 1024);
  const tick = () => {
    const m = process.memoryUsage();
    console.log(
      `[${stamp()}] memory rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB external=${mb(m.external)}MB uptime=${Math.round(process.uptime() / 60)}min`,
    );
  };
  tick();
  const timer = setInterval(tick, 10 * 60_000);
  // Never the reason the process stays alive.
  timer.unref();
}
