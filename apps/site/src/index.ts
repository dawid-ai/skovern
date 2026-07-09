// Project site + cloud API. Auth is the first cloud surface; more (news, DM,
// publish) hang off the same store as later loops land.
export const SITE_NAME = "deskhand";

export { AuthService, AuthStore, ConsoleMailer, normalizeEmail } from "./auth/service.js";
export type { AuthConfig, Session } from "./auth/service.js";
export { DevLinkMailer, ResendMailer } from "./auth/mailer.js";
export type { Mailer } from "./auth/mailer.js";
export { handleRequestLink, handleVerify } from "./auth/handlers.js";
export type { HttpResult } from "./auth/handlers.js";
export { startAuthServer } from "./auth/server.js";
export type { RunningServer } from "./auth/server.js";
