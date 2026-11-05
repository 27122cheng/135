import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, report } from "./_harness";

/** 版本換了就自己重新載入 — the wiring that ends the "refresh me" page. */

const root = join(__dirname, "..");
const layout = readFileSync(join(root, "app", "layout.tsx"), "utf8");
const watch = readFileSync(join(root, "components", "build-watch.tsx"), "utf8");
const errorPage = readFileSync(join(root, "app", "error.tsx"), "utf8");
const globalError = readFileSync(join(root, "app", "global-error.tsx"), "utf8");
const buildRoute = readFileSync(join(root, "app", "api", "build", "route.ts"), "utf8");

check("the watcher is mounted on every page", layout.includes("<BuildWatch />"));
check("it polls the build id while visible and on becoming visible",
  watch.includes('fetch("/api/build"') && watch.includes('addEventListener("visibilitychange", check)'));
check("a changed build reloads", watch.includes("if (build !== loadedBuild) reloadOnce("));
check("a chunk error on the window reloads", watch.includes('addEventListener("error", onError)') && watch.includes("ChunkLoadError"));
check("reloads are guarded against loops", watch.includes("sessionStorage.getItem(KEY) === reason"));
check("every listener and timer is removed on unmount",
  watch.includes("clearInterval(timer)") && watch.includes('removeEventListener("visibilitychange"') && watch.includes('removeEventListener("error"'));
check("the error page reloads on skew instead of showing a stack", errorPage.includes("網站已更新，重新載入中") && errorPage.includes("window.location.reload()"));
check("and offers a reload button otherwise", errorPage.includes("重新載入"));
check("a layout-level crash has a net", globalError.includes("export default function GlobalError") && globalError.includes("window.location.reload()"));
check("the build route answers from the deployment's own sha", buildRoute.includes("VERCEL_GIT_COMMIT_SHA"));

report("build watch");
