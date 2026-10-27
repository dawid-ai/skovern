import { DevLinkMailer, ResendMailer, type Mailer, type SendMeter } from "../auth/mailer.js";
import { DevWelcomeMailer, ResendWelcomeMailer, type WelcomeMailer } from "../waitlist/mail.js";
import { ConfigError, type ServerConfig } from "./config.js";

// Which mail delivery the server uses: Resend with a key, or the dev mailers
// that PRINT full single-use links to the console (never in production).

/** `signins` counts sign-in links against the shared Resend quota. */
export function pickMailers(cfg: ServerConfig, signins?: SendMeter): { magic: Mailer; welcome: WelcomeMailer } {
  // loadConfig already refuses a production boot without a key; this is the
  // second lock on the door, because the dev mailers print full single-use links.
  if (cfg.production && !cfg.resendKey) throw new ConfigError("RESEND_API_KEY is required in production.");
  if (cfg.resendKey) {
    return {
      magic: new ResendMailer(cfg.resendKey, cfg.mailFrom, cfg.resendUrl, signins),
      welcome: new ResendWelcomeMailer(cfg.resendKey, cfg.mailFrom, cfg.resendUrl),
    };
  }
  return { magic: new DevLinkMailer(), welcome: new DevWelcomeMailer() };
}
