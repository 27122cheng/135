"use client";

import { useEffect } from "react";

/**
 * What the reader sees when a page throws during render.
 *
 * Without this file Next.js shows its default: a black screen reading
 * "Application error: a client-side exception has occurred (see the browser
 * console for more information)". On a phone there *is* no browser console, so
 * that message is unactionable — the real one cost a round trip and a
 * screenshot before it could even be identified as a render crash rather than
 * a blank board.
 *
 * The error's `message` is React's, not a user's, and can name an internal
 * field. That is the point: this app has one reader, who is also the person who
 * has to report the fault. Hiding the only sentence that identifies it would be
 * protecting nobody.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-base font-bold text-neutral-100">頁面出錯了</h1>
      <p className="mt-2 text-sm text-neutral-400">
        這是畫面繪製時丟出的錯誤，不是資料抓取失敗。下面是原始訊息，回報時附上這段就夠了。
      </p>
      <pre className="mt-3 overflow-x-auto rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-xs leading-relaxed text-red-300">
        {error.message || "（沒有錯誤訊息）"}
        {error.digest ? `\n\ndigest: ${error.digest}` : ""}
      </pre>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          重試
        </button>
        <a
          href="/board"
          className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          回總覽
        </a>
      </div>
    </main>
  );
}
