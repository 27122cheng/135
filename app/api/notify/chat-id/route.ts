import { json } from "@/lib/json-response";
import { fetchJson } from "@/lib/data-sources/http";

export const dynamic = "force-dynamic";

/**
 * Finds the Telegram chat id to put in `TELEGRAM_CHAT_ID`.
 *
 * This is the step that stalls a Telegram setup. The token comes straight from
 * @BotFather, but the chat id is not shown anywhere in the app — the documented
 * route is to call `getUpdates` by hand and read a number out of raw JSON, or to
 * trust a third-party "what is my id" bot with your account. Neither is a
 * reasonable thing to ask of someone who just wants price alerts.
 *
 * So: set the token, send the bot any message, open this. It reads the id back.
 *
 * The token is server-side only (see lib/notify) — this route never accepts one
 * as a parameter and never returns it, so the id can be looked up without the
 * secret ever travelling anywhere it isn't already.
 */
export async function GET() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    return json(
      {
        error: "尚未設定 TELEGRAM_BOT_TOKEN",
        next: "先在 Vercel 環境變數加上 TELEGRAM_BOT_TOKEN 並 Redeploy，再回到這頁。",
      },
      { status: 501 },
    );
  }

  const data = await fetchJson<{
    ok?: boolean;
    description?: string;
    result?: Array<{
      message?: { chat?: { id?: number; type?: string; title?: string; first_name?: string } };
      channel_post?: {
        chat?: { id?: number; type?: string; title?: string; first_name?: string };
      };
    }>;
  }>(`https://api.telegram.org/bot${token}/getUpdates`, undefined, 10000);

  if (!data) {
    return json(
      { error: "連不上 Telegram API。請確認 TELEGRAM_BOT_TOKEN 是否正確。" },
      { status: 502 },
    );
  }
  if (data.ok !== true) {
    // Telegram's own message ("Unauthorized") is more useful than anything
    // this route could invent.
    return json({ error: `Telegram 回應：${data.description ?? "未知錯誤"}` }, { status: 502 });
  }

  const chats = new Map<number, { id: number; type: string; name: string }>();
  for (const update of data.result ?? []) {
    const chat = update.message?.chat ?? update.channel_post?.chat;
    if (!chat || typeof chat.id !== "number") continue;
    chats.set(chat.id, {
      id: chat.id,
      type: chat.type ?? "unknown",
      name: chat.title ?? chat.first_name ?? "",
    });
  }

  const found = [...chats.values()];
  if (found.length === 0) {
    return json({
      chats: [],
      // getUpdates only returns recent unconsumed updates, so "no chats" almost
      // always means the bot has never been messaged rather than a broken setup.
      next: "機器人還沒收過任何訊息。在 Telegram 裡打開你的機器人，按「開始」或隨便傳一句話，再重新整理這頁。",
    });
  }

  return json({
    chats: found,
    chatId: found[0].id,
    next: `把 ${found[0].id} 填進 Vercel 環境變數 TELEGRAM_CHAT_ID，Redeploy 之後就會收到通知。`,
  });
}
