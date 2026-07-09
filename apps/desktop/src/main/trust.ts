export interface TrustOptions {
  devServerUrl: string | undefined;
  rendererIndexUrl: string;
}

// The IPC door: only the bundled renderer (exact file URL) or, in dev,
// the electron-vite dev server origin may call into main.
export function isTrustedSender(frameUrl: string | undefined, options: TrustOptions): boolean {
  if (frameUrl === undefined) return false;
  try {
    const url = new URL(frameUrl);
    if (url.protocol === "file:") return url.href === options.rendererIndexUrl;
    if (options.devServerUrl !== undefined) {
      return url.origin === new URL(options.devServerUrl).origin;
    }
    return false;
  } catch {
    return false;
  }
}
