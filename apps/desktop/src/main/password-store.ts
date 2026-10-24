// Unpackaged test seam: Playwright's Electron launcher appends `--password-store=basic`, which
// leaves safeStorage unavailable on Linux, so a CI e2e run can't store a key or a session.
// `SKOVERN_PASSWORD_STORE` re-selects a real keychain after it. Only a real keychain backend is
// accepted — never `basic` — and a packaged app never reads it.
const REAL_KEYCHAINS = new Set(["gnome-libsecret"]);

/** The `--password-store` value to append, or null to leave Electron's own choice alone. */
export function testPasswordStore(isPackaged: boolean, env: NodeJS.ProcessEnv): string | null {
  if (isPackaged) return null;
  const value = env["SKOVERN_PASSWORD_STORE"];
  return value !== undefined && REAL_KEYCHAINS.has(value) ? value : null;
}
