# Releasing Skovern

A release is a pushed `v0.x.y` tag. The release workflow (`.github/workflows/release.yml`)
checks it, builds the Windows installer, runs the packaged-app checks, and publishes it to
GitHub Releases. Installed copies of Skovern find it from there and offer the update.

## Versions

- One version: `apps/desktop/package.json` `version`. The other workspace packages don't carry
  the product version.
- Each release adds 1 to the last number: `0.1.0` → `0.1.1` → `0.1.2`. Raise the middle number
  for a bigger step when you want to mark one.
- The first number stays `0` until the first official beta. The release check refuses `1.x`.

## Cut a release

Run these after a loop merges to `main`, from an up-to-date `main`. The very first release is
`v0.1.0`, exactly as merged: skip step 1 and tag it.

The release commit changes only the version and `UPDATES.md` and goes straight to `main`
(admin bypass of "main: CI must pass"). It isn't an unchecked change: the release workflow's
`check` job runs every CI gate on that exact commit before anything is published.

1. Set the new version in `apps/desktop/package.json`.
2. Add an entry at the top of `UPDATES.md`, in plain words for the people using Skovern:

   ```markdown
   ## v0.1.1 — 2026-10-26

   - What changed, one line each.
   ```

   The release fails without it. The app shows this text when it offers the update.
3. Check locally:

   ```bash
   node apps/desktop/scripts/release-check.ts v0.1.1
   ```

4. Commit, tag, and push. No AI attribution in the commit or the notes.

   ```bash
   git commit -am "Release v0.1.1"
   git tag v0.1.1
   git push origin main
   git push origin v0.1.1
   ```

5. Watch the run: `gh run watch -R dawid-ai/skovern` (or `gh run list -w Release`).
6. Verify the release:

   ```bash
   gh release view v0.1.1 -R dawid-ai/skovern --json assets --jq '.assets[].name'
   # Skovern-Setup.exe, Skovern-Setup.exe.blockmap, latest.yml
   curl -sIL https://github.com/dawid-ai/skovern/releases/latest/download/Skovern-Setup.exe | grep -i -E '^(HTTP|content-length)'
   gh attestation verify Skovern-Setup.exe -R dawid-ai/skovern   # after downloading it
   ```

If the run fails before `publish`, nothing was published: fix it on `main`, delete the tag
(`git push origin :refs/tags/v0.1.1`, admin only), and tag again. A published release can't be
changed (immutable releases); ship the next version instead.

## What the workflow does

| job | runs on | token | does |
|---|---|---|---|
| `check` | Ubuntu | read | tag = version, major 0, `UPDATES.md` entry, tag on `main`, then every CI gate |
| `build-win` | Windows | read | builds `Skovern-Setup.exe` with `--publish never`, runs `packaging.spec.ts` P1–P5 |
| `publish` | Ubuntu | write + attestations | runs no repository or npm code: checks the installer's sha512 against `latest.yml`, attests it, creates a draft release, uploads, publishes |

A pull request that touches the release files, or a manual run (`gh workflow run release.yml`),
runs `check` and `build-win` only. `apps/desktop/scripts/verify-release-workflow.ts` enforces
the shape (it runs in the unit tests and in `check`).

## Trust, until the beta

Builds are unsigned until the first beta (ledger `code-signing-notarization`). Windows shows
"unknown publisher" once, at first install (**More info** → **Run anyway**).

**Who can ship code to every installed Skovern today:** any credential that can create a
release on `dawid-ai/skovern` (today that's Dawid's account, including any `gh` or git session
or agent running with it), and any npm dependency that runs in `build-win`. Nothing on the
installed side checks a signature, so that's the trust root until signing lands (ledger
`update-feed-trust-0x`).

What narrows it:

- only admins can create, move, or delete any tag (ruleset "Tags: admins only");
- a published release can't change (immutable releases);
- the app refuses an offered update unless its tag is exactly `v<version>`, and refuses any
  that asks for admin rights (Skovern installs per user);
- `publish` refuses a release that already exists unless it's its own draft, and sets the notes
  and files itself.

What doesn't: electron-updater's sha512 check and the build attestation only show the
download matches the release and came from this workflow run. They catch corruption, not a
forged release, and the app doesn't verify the attestation.

Local sessions (people or agents) only tag and push. They never run `gh release create`,
`upload`, or `edit`; only the workflow publishes.

## Where the installed app keeps things

- Data: `%APPDATA%\Skovern` (the same folder the dev app uses).
- Update log: `%APPDATA%\Skovern\logs\updates.log`.
- The installed app talks to the server at `SKOVERN_API_URL`, or `http://127.0.0.1:8787` when
  it isn't set (ledger `api-url-override-packaged`).

## Deploy skovern.com (Railway)

The website and the cloud api run on Railway, project `skovern`, environment `production`.
Each service builds a Dockerfile from the repo root and listens on port 8080, which is the
port the custom domains target.

| Service | Domain | Dockerfile | Config file |
|---|---|---|---|
| `www` | `skovern.com`, `www.skovern.com` | `apps/www/Dockerfile` (static build served by Caddy) | `apps/www/railway.json` |
| `api` | `api.skovern.com` | `apps/site/Dockerfile` | `apps/site/railway.json` |
| `Postgres` | none (private network) | Railway plugin | none |

### One-time setup

1. In each service's **Settings**, set **Config-as-code path** to the file in the table, and
   keep **Root directory** at `/` so the Dockerfile sees the pnpm workspace.
2. Connect the service to the GitHub repo and the `main` branch. The `watchPatterns` in each
   `railway.json` skip a rebuild when only the other app changed.
3. Variables on `api`:
   - `NODE_ENV=production`, `PORT=8080`, `TRUST_PROXY=1`
   - `APP_URL=https://api.skovern.com`, `SITE_URL=https://skovern.com`
   - `CORS_ORIGINS=https://skovern.com,https://www.skovern.com`
   - `MAIL_FROM=Skovern <hi@skovern.com>`
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}` (a Railway reference)
   - Secrets: `RESEND_API_KEY`, `SKOVERN_ADMIN_TOKEN` (32 characters or more). Set them with
     `railway variables --service api --set-from-stdin <NAME>`, never on the command line.
     `RESEND_API_KEY` needs **Full access**: inbox forwarding reads received email, which a
     sending-only key can't.
   - Optional: `WELCOME_MAX_PER_HOUR` (default 20) and `WELCOME_MAX_PER_DAY` (default 50) cap
     welcome emails across all signups. Over the cap, or over the shared Resend budget (see
     [The Resend budget](#the-resend-budget)), signups are still saved and the welcome goes
     out later, newest first.
   - Optional: `RESEND_DAILY_QUOTA` (default 100, Resend's free plan) and `RESEND_RESERVE`
     (default 15).
   - Inbox forwarding (optional, see [Inbox forwarding](#inbox-forwarding)):
     `RESEND_WEBHOOK_SECRET` (secret), `FORWARD_TO`, `FORWARD_MAX_PER_DAY` (default 15),
     `FLAGGED_MAX_PER_DAY` (default 5), `INBOX_FROM_DOMAIN` (default `in.skovern.com`), and
     `INBOX_FROM_FALLBACK`.
   - Leave `ACCOUNT_ROUTES` unset until the beta. In production it defaults to off, so the api
     serves only `/healthz`, the waitlist, the remove page, and the waitlist admin view.
4. Variables on `www`: `PORT=8080`. The api origin is baked in at build time
   (`PUBLIC_API_URL`, default `https://api.skovern.com`).

The api refuses to boot in production without `RESEND_API_KEY`, `APP_URL`, or
`DATABASE_URL`, with an admin token under 32 characters, or with a non-https
`RESEND_API_URL`, and says which setting is wrong in the deploy log. With
`RESEND_WEBHOOK_SECRET` set, it also refuses a secret that isn't `whsec_...`, a
missing `FORWARD_TO`, a `FORWARD_TO` that isn't one plain address, or one at
`skovern.com`, or an `INBOX_FROM_DOMAIN` that isn't a subdomain of `skovern.com`.
It refuses a `RESEND_RESERVE` that isn't smaller than `RESEND_DAILY_QUOTA`.

### Inbox forwarding

Mail to any `@skovern.com` address arrives at Resend (MX `@` →
`receive.forge.rmta.net`, priority 10, with receiving turned on for the domain).
Resend posts a signed webhook to the api, and the api forwards each email to
`FORWARD_TO` from `Skovern inbox <inbox@in.skovern.com>`, with `[skovern.com]`
before the subject. Forwards use their own sending subdomain, so forwarded junk
can't hurt the reputation of `skovern.com`, which welcomes and sign-in links use. **Reply** goes to the message's own Reply-To when it's one plain
address outside `skovern.com`, and to the sender otherwise. The same webhook
carries bounce, complaint, and suppression events. They pause welcome emails when
more than 5% of the welcomes sent in the last 24 hours (with at least 20 sent)
bounced, were marked as spam, or were suppressed.

1. Create the webhook through the Resend API (or **Webhooks** → **Add webhook** in
   the dashboard):
   - Endpoint: `https://api.skovern.com/hooks/resend/inbound`
   - Events: `email.received`, `email.bounced`, `email.complained`, `email.suppressed`
2. Copy its signing secret (`whsec_...`, returned by the create call) straight into
   Railway without printing it:
   `railway variables --service api --set-from-stdin RESEND_WEBHOOK_SECRET`
3. Set `FORWARD_TO` on `api` to the one inbox that gets the mail. It can't be at
   `skovern.com`. Optionally set `FORWARD_MAX_PER_DAY` (default 15).
4. Add the sending domain `in.skovern.com` (or your `INBOX_FROM_DOMAIN`) in Resend and its
   DNS records. Until Resend shows it **Verified**, set `INBOX_FROM_FALLBACK=1`: forwards
   then go out from `inbox@skovern.com`, and the deploy log warns about it at every start.
   After it's verified, remove `INBOX_FROM_FALLBACK` and redeploy. Without the flag and
   without a verified subdomain, Resend refuses every forward.
5. Redeploy `api`. The deploy log says `inbox webhook ON at /hooks/resend/inbound`.
   Without `RESEND_WEBHOOK_SECRET` the route doesn't exist (404).

How it behaves:
- Each request must carry a valid Svix signature (`svix-id`, `svix-timestamp`,
  `svix-signature`) with a timestamp within 5 minutes. Anything else gets 401. There's
  no per-address limit: Resend delivers from addresses every Resend account shares.
- A repeated `svix-id` gets 200 and does nothing; IDs are kept for 7 days. The same
  email is never forwarded twice, even under a new delivery ID.
- The webhook only records the email as pending and answers 200. A background worker
  forwards it right after, and retries a failed attempt (a minute later per attempt,
  up to 30 minutes apart). An email still pending after 24 hours stays in Resend. The
  log names what failed: `fetching received email <id> failed (status ...)` or
  `sending the forward of email <id> failed (status ...)`.
- Sends carry an `Idempotency-Key` (`forward/<id>`, `forward/<id>/names`,
  `summary/<UTC day>`), so a retry after a lost answer doesn't deliver twice.
- The forward is built from the Receiving API (`GET /emails/receiving/{id}`), never
  from the webhook body. Attachments go along by their signed download links; over
  25 MB together, or if Resend refuses them, the email goes again with the files
  listed by name.
- A sender is trusted only when SPF or DKIM passed and DMARC didn't fail. Softfail, no
  checks, and errors all count as possibly forged. Such mail is still forwarded, with
  `[spam?]` before the subject (a small shop with weak SPF shouldn't lose its mail), but
  on its own cap, `FLAGGED_MAX_PER_DAY` (default 5), not a main forward slot. Each one
  still costs 2 of the shared budget. Past that cap, the rest of the day's flagged mail
  stays in Resend as `held_spam`, and the log says `may be spoofed ... flagged cap is
  used`. Treat `[spam?]` as a spoof warning: check the sender before paying or clicking.
- Automatic mail (`Auto-Submitted: auto-...`, like out-of-office replies) is held as
  `held_auto`. Forwards carry `Auto-Submitted: auto-generated` so auto-responders
  don't answer them.
- Neither flagged nor automatic mail uses a main forward slot, but each still counts
  against the shared Resend budget, because Resend counts every received email.
- Mail from `@skovern.com` senders is never forwarded.
- After 15 forwarded emails (`FORWARD_MAX_PER_DAY`), forwarding stops for the rest of
  the UTC day; it also stops when the shared budget is spent. Mail after that stays in
  Resend's **Receiving** tab and isn't forwarded later. The log says `forward budget
  spent` once per held email, and the first held email of the day sends one alert:
  "Forwarding paused for today. New mail is waiting in Resend → Emails → Receiving."
- When Resend's whole daily quota is used, even the reserve, the alert is skipped too.
  The log then says `forwarding paused, but the alert was skipped` once a day, so check
  the logs or Resend if forwards stop arriving.
- Refused webhook signatures are logged as one line a minute with counts. A body over
  256 KB gets 413 and a `webhook body over limit` line with its `svix-id`.

### The Resend budget

Resend counts every email sent **and every email received** against one daily
quota per UTC day: 100 on the free plan. The api keeps one shared count of both in
Postgres:
- Each received email counts 1, whether it's forwarded, held, or skipped.
- Each send counts 1: a welcome, a forward, a names-only resend, the daily alert, and
  (once `ACCOUNT_ROUTES` is on) a sign-in link.

So a forwarded email costs 2. Before a welcome or a forward goes out, its own cap
must have room and the shared count must be under `RESEND_DAILY_QUOTA` minus
`RESEND_RESERVE` (100 − 15 = 85 by default). The reserve covers your own replies
from Gmail as `hi@skovern.com`, which the api can't see. Only the daily alert and
sign-in links may use the reserve: the alert matters most when the budget is gone,
and a sign-in link is what lets someone in. Past the whole quota, no sign-in link
goes out.

With the defaults, a day of 50 welcomes and 15 forwarded emails uses 50 + 30 = 80,
plus 1 for the alert. Every extra received email uses 1 more, even when it's held.

Received mail can't be capped. A burst of spam to `@skovern.com` uses up the quota
by itself: forwards and welcomes stop for the rest of the UTC day, and Resend may
refuse sends past 100, including Gmail replies. The fix is Resend's paid plan; then
raise `RESEND_DAILY_QUOTA` to match.

### Before a deploy

Run the loop 051 metric locally (it builds and smokes both images):

```bash
docker build -f apps/site/Dockerfile -t skovern-api-smoke . && node apps/site/scripts/smoke-image.ts
docker build -f apps/www/Dockerfile -t skovern-www-smoke .
```

### After a deploy

1. `curl https://api.skovern.com/healthz` and `curl https://skovern.com/healthz` both say ok.
2. `node apps/site/scripts/smoke-prod.ts https://api.skovern.com <address>` signs up a test
   address you can read (mail to `skovern.com` is forwarded only when inbox forwarding is on) and checks the number and CORS.
   Open that welcome email and run the script again with `--remove "<link>"` to check the
   remove page and delete the address. The test uses up one waitlist number for good, because
   numbers never repeat: the next real signup gets the one after it.
3. Open `https://api.skovern.com/admin/waitlist` and sign in with any user name and the
   `SKOVERN_ADMIN_TOKEN` value as the password. It's in the Railway dashboard under the `api`
   service's **Variables**.
4. If inbox forwarding is on, send an email from your phone to `hi@skovern.com`. It arrives at
   `FORWARD_TO` within a minute with `[skovern.com]` before the subject, and **Reply** goes back
   to the phone. The `api` log shows `[inbox] email <id>: forwarded`.

### Blog posts

A post is one Markdown file in `apps/www/src/content/blog/`. The file name is the URL slug
(lowercase letters, numbers, and dashes). Front matter needs `title`, `description`, `date`,
and `category` (`guides`, `privacy`, `stories`, or `news`); `author` defaults to `dawid`, and
`cover` picks the card art (`icon`, `icon-dark`, `chat`, `brain`, `receipts`, `update`). The
build fails on a post with missing or wrong front matter, so a broken post can't ship.
