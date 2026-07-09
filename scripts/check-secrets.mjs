#!/usr/bin/env node
// Pre-commit secret + junk guard. Blocks the commit (exit 1) if a staged file
// looks like a credential or is build/loop junk that must never reach the public repo.
// Deliberately dependency-free so it runs in a git hook with zero install.
import { execSync } from "node:child_process";

const staged = execSync("git diff --cached --name-only --diff-filter=ACM", { encoding: "utf8" })
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

// Paths that must never be committed (build output, local loop/agent state, env, keys).
const FORBIDDEN_PATHS = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)out\//,
  /(^|\/)dist\//,
  /(^|\/)node_modules\//,
  /(^|\/)test-results\//,
  /(^|\/)playwright-report\//,
  /\.(pem|key|pfx|p12|keystore|jks)$/i,
  /(^|\/)\.claude\/loop\/state/i, // local loop working state, if we ever add it
];

// Content patterns that look like real secrets. Kept conservative to avoid false alarms.
const SECRET_PATTERNS = [
  { name: "AWS access key id", re: /AKIA[0-9A-Z]{16}/ },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: "OpenAI key", re: /sk-[A-Za-z0-9]{20,}/ },
  { name: "Anthropic key", re: /sk-ant-[A-Za-z0-9-]{20,}/ },
  { name: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "Slack token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "private key block", re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "generic secret assignment", re: /(api[_-]?key|secret|token|password|passwd)\s*[:=]\s*['"][A-Za-z0-9/+_-]{16,}['"]/i },
];

const problems = [];

for (const file of staged) {
  if (FORBIDDEN_PATHS.some((re) => re.test(file))) {
    problems.push(`  ${file} — forbidden path (build output, secret, or local state)`);
    continue;
  }
  let content = "";
  try {
    content = execSync(`git show :${JSON.stringify(file)}`, { encoding: "utf8" });
  } catch {
    continue; // binary or unreadable — skip content scan
  }
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(content)) problems.push(`  ${file} — looks like a ${name}`);
  }
}

if (problems.length > 0) {
  console.error("\n✖ commit blocked — sensitive or junk content staged:\n");
  console.error(problems.join("\n"));
  console.error(
    "\nIf this is a false positive (e.g. a regex in this very script), commit with --no-verify" +
      " ONLY after you're certain. Otherwise unstage it and put real secrets in the OS keychain.\n",
  );
  process.exit(1);
}
