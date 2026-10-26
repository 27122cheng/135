/**
 * 建表失敗時，說出是哪一種失敗.
 *
 * /setup reported 「43 個語句失敗」 — every statement, which means the
 * connection itself, not the SQL. The route had the driver's message in
 * its response the whole time and the page threw it away for a count.
 * This turns the first failure into the one sentence that says what to
 * do, in the vocabulary of the mistakes people actually make with
 * DATABASE_URL.
 */

export function classifyConnectionFailure(url: string | null, message: string): string {
  const m = message.toLowerCase();
  let host = "";
  try {
    host = url ? new URL(url).hostname : "";
  } catch {
    return `DATABASE_URL 不是合法的連線字串（無法解析）。原始錯誤：${message}`;
  }
  if (host && !host.endsWith(".neon.tech")) {
    return (
      `DATABASE_URL 指向 ${host}，不是 Neon。這個站的 Postgres 驅動只能透過 Neon 的 HTTP 端點執行 SQL；` +
      `用 Supabase 請改設 SUPABASE_URL／SUPABASE_SERVICE_ROLE_KEY 並在 Supabase SQL Editor 手動執行 supabase/schema.sql；` +
      `用其他 Postgres 則需要換驅動。原始錯誤：${message}`
    );
  }
  if (m.includes("exceeded the quota") || m.includes("402")) {
    return (
      `Neon 免費額度已用完（本月運算時數或流量），所有查詢都會被拒到月初重置。` +
      `到 Neon 控制台的 Usage 確認是哪一項；可以等重置、升級方案，或在 Neon 開一個新專案換連線字串。` +
      `吃額度的主因是網頁開著每分鐘輪詢讓資料庫停不下來，這版已降到五分鐘一次。原始錯誤：${message}`
    );
  }
  if (m.includes("password authentication failed") || m.includes("authentication")) {
    return `資料庫拒絕登入：DATABASE_URL 的帳號或密碼錯誤（Neon 重設密碼後連線字串會變）。原始錯誤：${message}`;
  }
  if (m.includes("endpoint") && (m.includes("disabled") || m.includes("not found") || m.includes("suspended"))) {
    return `Neon 的運算端點已停用或不存在：免費專案閒置會被暫停或刪除，到 Neon 控制台確認專案還在、端點是 Active。原始錯誤：${message}`;
  }
  if (m.includes("enotfound") || m.includes("getaddrinfo") || m.includes("fetch failed") || m.includes("econnrefused")) {
    return `連不到資料庫主機 ${host || "（未知）"}：主機名稱打錯、專案已刪除，或部署環境無法對外連線。原始錯誤：${message}`;
  }
  if (m.includes("permission denied") || m.includes("must be owner")) {
    return `資料庫帳號沒有建表權限：DATABASE_URL 要用擁有者角色（Neon 預設的 neondb_owner）。原始錯誤：${message}`;
  }
  if (m.includes("too many connections") || m.includes("rate limit")) {
    return `資料庫連線數或速率已達上限，稍後再按一次。原始錯誤：${message}`;
  }
  return `資料庫連線或執行失敗。原始錯誤：${message}`;
}
