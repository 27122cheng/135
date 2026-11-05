"use client";

import { useEffect } from "react";

/**
 * 版本換了就自己重新載入 — the fix for 「網頁一段時間後會自動崩潰」.
 *
 * The site deploys several times a day. A tab left open keeps the chunks of
 * the build it loaded; after the next deploy those files are gone, and the
 * next navigation or lazy chunk fetch fails — a dead page until someone
 * presses refresh. Two detectors, both ending in one reload:
 *
 *  1. The build id. Polled while the tab is visible and checked the moment
 *     it becomes visible again (the case that actually bites: come back to
 *     the phone an hour later). A different id than the one this page
 *     loaded with means reload.
 *  2. The failure itself. A ChunkLoadError or a failed dynamic import on
 *     the window is the skew showing up before the poll did; reload once.
 *
 * Once, guarded in sessionStorage per build id, so a broken deploy cannot
 * put the tab in a reload loop.
 */

const POLL_MS = 3 * 60_000;
const KEY = "build-watch:reloaded-for";

function isChunkError(message: string): boolean {
  return /ChunkLoadError|Loading chunk|Loading CSS chunk|dynamically imported module|Importing a module script failed/i.test(message);
}

function reloadOnce(reason: string) {
  try {
    if (sessionStorage.getItem(KEY) === reason) return;
    sessionStorage.setItem(KEY, reason);
  } catch {
    // Storage blocked: still reload — a loop is less likely than a dead tab.
  }
  window.location.reload();
}

export function BuildWatch() {
  useEffect(() => {
    let loadedBuild: string | null = null;
    let cancelled = false;

    const check = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/build", { cache: "no-store" });
        if (!res.ok) return;
        const { build } = (await res.json()) as { build?: string };
        if (!build || cancelled) return;
        if (loadedBuild === null) {
          loadedBuild = build;
          return;
        }
        if (build !== loadedBuild) reloadOnce(`build:${build}`);
      } catch {
        // Offline or a transient failure: nothing to decide this round.
      }
    };

    const onError = (e: ErrorEvent) => {
      if (isChunkError(String(e.message ?? ""))) reloadOnce("chunk");
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const msg = e.reason instanceof Error ? `${e.reason.name} ${e.reason.message}` : String(e.reason ?? "");
      if (isChunkError(msg)) reloadOnce("chunk");
    };

    void check();
    const timer = setInterval(() => void check(), POLL_MS);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
