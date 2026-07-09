import { ipcMain } from "electron";
import { isTrustedSender, type TrustOptions } from "./trust.js";

// Loop-001 carry-forward: validate every ipcMain sender in ONE place and log
// the rejects (seeds the future egress/receipts log). Handlers registered
// through here can assume the caller is the real renderer.
export function registerTrusted(
  trust: TrustOptions,
  channel: string,
  fn: (...args: unknown[]) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!isTrustedSender(event.senderFrame?.url, trust)) {
      console.warn(`[ipc] rejected ${channel} from an untrusted sender`);
      throw new Error(`${channel} called from untrusted sender`);
    }
    return fn(...args);
  });
}
