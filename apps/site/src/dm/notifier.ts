// Where a new DM goes so the founder actually sees it. This is the server's
// first real outbound call — keep it dumb: plain text, no markup that Telegram
// could interpret, a hard length cap, and never let a delivery failure lose the
// user's message (main handler saves first, notifies second, swallows errors).
//
// ponytail: Telegram-only for now; add email/SMS notifiers if the founder wants
// another channel. When the egress-receipts log lands, this call is the first
// thing that must appear in it (carried-forward from 002/004).

export interface DmNotification {
  email: string;
  body: string;
}

export interface Notifier {
  notify(msg: DmNotification): Promise<void>;
}

/** Dev/default channel: print to the server console. No egress. The address is
 *  redacted to its domain — same rule the console mailer follows (never log a
 *  full address). The founder's real Telegram channel gets the full email. */
export class ConsoleNotifier implements Notifier {
  async notify(msg: DmNotification): Promise<void> {
    const domain = msg.email.slice(msg.email.indexOf("@") + 1);
    console.log(`[dm] new message from …@${domain}: ${msg.body}`);
  }
}

/** Forwards to a Telegram chat via the Bot API. Plain text only. */
export class TelegramNotifier implements Notifier {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
  ) {}

  async notify(msg: DmNotification): Promise<void> {
    const text = `New Deskhand DM from ${msg.email}:\n\n${msg.body}`;
    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // No parse_mode → Telegram treats the body as literal text, so a message
      // containing markdown/HTML can't be interpreted or injected.
      body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`telegram sendMessage failed: ${res.status}`);
  }
}

/** Telegram if configured, else the console. Secrets come from env only. */
export function pickNotifier(): Notifier {
  const botToken = process.env["TELEGRAM_BOT_TOKEN"];
  const chatId = process.env["TELEGRAM_CHAT_ID"];
  if (botToken && chatId) return new TelegramNotifier(botToken, chatId);
  return new ConsoleNotifier();
}
