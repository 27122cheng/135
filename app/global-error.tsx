"use client";

/**
 * The last net: an error in the root layout itself. Next.js renders this in
 * place of the whole document, so it carries its own html/body. One button,
 * because the only thing that reliably fixes a layout-level crash on a
 * long-open tab is a fresh load of the current build.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="zh-Hant">
      <body style={{ background: "#0a0a0a", color: "#e5e5e5", fontFamily: "system-ui, sans-serif", padding: 24 }}>
        <h1 style={{ fontSize: 16, fontWeight: 700 }}>頁面出錯了</h1>
        <p style={{ fontSize: 13, color: "#a3a3a3", marginTop: 8 }}>
          多半是網站已更新而這個分頁還是舊版。重新載入通常就好。
        </p>
        <pre style={{ fontSize: 12, color: "#fca5a5", marginTop: 12, whiteSpace: "pre-wrap" }}>
          {error.message || "（沒有錯誤訊息）"}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ marginTop: 16, padding: "6px 12px", fontSize: 13, border: "1px solid #404040", borderRadius: 8, background: "transparent", color: "#e5e5e5" }}
        >
          重新載入
        </button>
      </body>
    </html>
  );
}
