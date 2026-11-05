#!/usr/bin/env node
/**
 * 自架主機用的守護程序 — `npm run serve`.
 *
 * Runs the production server and brings it back when it dies, writing why
 * to logs/server.log. The two facts a dead host never left behind were
 * "when did it exit" and "with what" — an exit code, a signal (SIGKILL is
 * the OS reclaiming memory), or a thrown error. Now they are in the log
 * next to the memory lines instrumentation.ts prints every ten minutes.
 *
 * Builds first when there is no build: `next dev` is a development tool —
 * it recompiles routes on demand, watches every file, and is not meant to
 * run for days. A PC acting as the host runs the production build.
 *
 * Restarts with backoff (2 s, doubling to 60 s), reset after the server
 * has stayed up for five minutes, so a build that cannot start does not
 * spin, and a one-off crash comes back in seconds.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const logDir = join(root, "logs");
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, "server.log");
const log = (line) => {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(text);
  try {
    appendFileSync(logFile, text);
  } catch {
    // A log that cannot be written must not stop the server.
  }
};

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const port = process.env.PORT ?? "3000";

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(npx, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env, shell: process.platform === "win32" });
    const pipe = (stream) =>
      stream.on("data", (chunk) => {
        const text = String(chunk);
        process.stdout.write(text);
        try {
          appendFileSync(logFile, text.endsWith("\n") ? text : `${text}\n`);
        } catch {
          // see above
        }
      });
    pipe(child.stdout);
    pipe(child.stderr);
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", (err) => {
      log(`spawn error: ${err.message}`);
      resolve({ code: -1, signal: null });
    });
  });
}

async function main() {
  if (!existsSync(join(root, ".next", "BUILD_ID"))) {
    log("no production build found — running `next build` first");
    const built = await run(["next", "build"]);
    if (built.code !== 0) {
      log(`build failed (exit ${built.code}); fix the build before serving`);
      process.exit(1);
    }
  }
  let backoff = 2000;
  for (;;) {
    const startedAt = Date.now();
    log(`starting next start -p ${port}`);
    const { code, signal } = await run(["next", "start", "-p", port]);
    const upFor = Math.round((Date.now() - startedAt) / 1000);
    log(
      `server exited after ${upFor}s — code=${code} signal=${signal ?? "none"}` +
        (signal === "SIGKILL" ? " (SIGKILL: the OS or a user killed it — usually memory pressure or sleep/logout)" : "") +
        (code === 0 && !signal ? " (clean exit)" : ""),
    );
    if (upFor > 300) backoff = 2000;
    log(`restarting in ${Math.round(backoff / 1000)}s`);
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 60_000);
  }
}

main().catch((err) => {
  log(`supervisor crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
