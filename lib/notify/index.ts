import { postJson } from "@/lib/ai/http";

/**
 * Outbound alerts.
 *
 * Deliberately env-var only: the alert fires from the scheduled refresh, which
 * runs with no browser attached, so a token living in someone's localStorage
 * would never be readable at the moment it's needed. Same reason DATABASE_URL
 * isn't user-settable.
 *
 * Both channels are free and need nothing installed server-side — a bot token
 * or a webhook URL and one POST.
 */

export interface NotifyChannel {
  readonly name: string;
  isConfigured(): boolean;
  send(text: string): Promise<{ ok: boolean; detail: string }>;
}

/** Telegram — free, works on a phone, setup is a chat with @BotFather. */
function telegramChannel(): NotifyChannel {
  return {
    name: "telegram",
    isConfigured: () =>
      Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHAT_ID?.trim()),
    async send(text) {
      const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
      const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
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
function discordChannel(): NotifyChannel {
  return {
    name: "discord",
    isConfigured: () => Boolean(process.env.DISCORD_WEBHOOK_URL?.trim()),
    async send(text) {
      const url = process.env.DISCORD_WEBHOOK_URL?.trim();
      if (!url) return { ok: false, detail: "未設定 DISCORD_WEBHOOK_URL" };
      // Discord renders plain text; strip the Telegram tags rather than
      // shipping literal <b> markers into the message.
      const plain = text.replace(/<\/?[a-z]+>/gi, "");
      const res = await postJson(url, {}, { content: plain.slice(0, 1900) }, 10000);
      return { ok: res.ok, detail: res.ok ? "sent" : `HTTP ${res.status} ${res.detail}` };
    },
  };
}

export function channels(): NotifyChannel[] {
  return [telegramChannel(), discordChannel()];
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
  const configured = channels().filter((c) => c.isConfigured());
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

/** For /api/diagnostics — never exposes the token itself. */
export function notifyStatus(): Array<{ name: string; configured: boolean }> {
  return channels().map((c) => ({ name: c.name, configured: c.isConfigured() }));
}
