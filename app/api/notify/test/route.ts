import { notifyAll, notifyStatus } from "@/lib/notify";
import { configuredMinGrade } from "@/lib/notify/alert";
import { json } from "@/lib/json-response";

export const dynamic = "force-dynamic";

/**
 * Sends a test alert, so a Telegram or Discord setup can be verified in ten
 * seconds instead of waiting up to four hours for the next scheduled run that
 * happens to clear the grade floor.
 *
 * Gated the same way as /api/setup: a bearer token when `CRON_SECRET` is set,
 * otherwise open — the worst an unauthenticated caller can do is send *the
 * owner* a message saying the channel works, which is noise, not a leak.
 */
export async function GET() {
  return json({
    channels: await notifyStatus(),
    minGrade: await configuredMinGrade(),
    hint: "POST 到這個網址會發送一則測試訊息。",
  });
}

export async function POST(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const configured = (await notifyStatus()).filter((c) => c.configured);
  if (configured.length === 0) {
    return json(
      {
        error:
          "未設定任何通知管道。請在 Vercel 環境變數加上 TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID，或 DISCORD_WEBHOOK_URL，然後 Redeploy。",
        channels: await notifyStatus(),
      },
      { status: 501 },
    );
  }

  const results = await notifyAll(
    [
      "<b>測試訊息</b>",
      "多商品交易訊號的通知管道設定成功。",
      "",
      `<i>實際警報只會在評等達到 ${await configuredMinGrade()} 以上、且建議進場時發送。</i>`,
    ].join("\n"),
  );

  const sent = results.filter((r) => r.ok);
  return json(
    { sent: sent.map((r) => r.channel), results },
    { status: sent.length > 0 ? 200 : 502 },
  );
}
