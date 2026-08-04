#!/usr/bin/env node
/**
 * Test runner.
 *
 * Each suite runs in its own process because several of them replace
 * `global.fetch` and reset module-level caches — sharing one process would let
 * one suite's stub leak into the next and produce results that depend on file
 * order.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();

let failed = 0;
for (const file of files) {
  console.log(`\n▶ ${file}`);
  const run = spawnSync("npx", ["tsx", join(here, file)], {
    stdio: "inherit",
    cwd: join(here, ".."),
  });
  if (run.status !== 0) failed += 1;
}

console.log(
  failed === 0
    ? `\n✔ all ${files.length} suites passed`
    : `\n✘ ${failed} of ${files.length} suites failed`,
);
process.exit(failed === 0 ? 0 : 1);
