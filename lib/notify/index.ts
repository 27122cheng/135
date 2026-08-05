import { postJson } from "@/lib/ai/http";
import { getSetting } from "@/lib/settings";

/**
 * Outbound alerts.
 *
 * These cannot ride in a request header the way the AI keys do: the alert fires
 * from a scheduled run with no browser attached, so a token in localStorage
 * would be unreadable at exactly the moment it is needed. They come instead
 * from `lib/settings` — a Vercel environment variable when one is set,
 * otherwise the `app_settings` table written from /setup. Same server-side
 * guarantee, no redeploy to change a channel.
 *
 * Both channels are free and need nothing installed server-side — a bot token
 * or a webhook URL and one POST.
 */

export interface NotifyChannel {
  readonly name: string;
  configured: boolean;
  send(text: string): Promise<{ ok: boolean; detail: string }>;
}

/** Telegram — free, works on a phone, setup is a chat with @BotFather. */
function telegramChannel(token: string | null, chatId: string | null): NotifyChannel {
  return {
    name: "telegram",
    configured: Boolean(token && chatId),
    async send(text) {
      if (!token || !chatId) return { ok: false, detail: "未設定 TELEGRAM_BOT_TOKEN / CHAT_ID" };
      const res = await postJson(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {},
        {
          chat_id: chatId,
          text,
          // HTML rather than Markdown: prices contain characters Telegram's
          // legacy Markdown parser chokes on, and a parse error means no message.
          parse_mode: "HTML",
          disable_web_page_preview: true,
        },
        10000,
      );
      return { ok: res.ok, detail: res.ok ? "sent" : `HTTP ${res.status} ${res.detail}` };
    },
  };
}

/** Discord (and anything Discord-compatible) — one webhook URL, no account plumbing. */
function discordChannel(url: string | null): NotifyChannel {
  return {
    name: "discord",
    configured: Boolean(url),
    async send(text) {
      if (!url) return { ok: false, detail: "未設定 DISCORD_WEBHOOK_URL" };
      // Discord renders plain text; strip the Telegram tags rather than
      // shipping literal <b> markers into the message.
      const plain = text.replace(/<\/?[a-z]+>/gi, "");
      const res = await postJson(url, {}, { content: plain.slice(0, 1900) }, 10000);
      return { ok: res.ok, detail: res.ok ? "sent" : `HTTP ${res.status} ${res.detail}` };
    },
  };
}

export async function channels(): Promise<NotifyChannel[]> {
  const [token, chatId, webhook] = await Promise.all([
    getSetting("TELEGRAM_BOT_TOKEN"),
    getSetting("TELEGRAM_CHAT_ID"),
    getSetting("DISCORD_WEBHOOK_URL"),
  ]);
  return [telegramChannel(token, chatId), discordChannel(webhook)];
}

export interface NotifyResult {
  channel: string;
  ok: boolean;
  detail: string;
}

/**
 * Sends to every configured channel. Returns per-channel results rather than
 * throwing: a failed alert must never abort the refresh that produced it.
 */
export async function notifyAll(text: string): Promise<NotifyResult[]> {
  const configured = (await channels()).filter((c) => c.configured);
  if (configured.length === 0) return [];
  return Promise.all(
    configured.map(async (c) => {
      try {
        const res = await c.send(text);
        return { channel: c.name, ...res };
      } catch (err) {
        return {
          channel: c.name,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

/** For /api/diagnostics and /setup. Never exposes the token itself. */
export async function notifyStatus(): Promise<Array<{ name: string; configured: boolean }>> {
  return (await channels()).map((c) => ({ name: c.name, configured: c.configured }));
}
