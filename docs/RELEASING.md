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
   - Optional: `WELCOME_MAX_PER_HOUR` (default 20) and `WELCOME_MAX_PER_DAY` (default 70) cap
     welcome emails across all signups, to stay inside Resend's free tier. Over the cap, signups
     are still saved and the welcome goes out later, newest first.
   - Inbox forwarding (optional, see [Inbox forwarding](#inbox-forwarding)):
     `RESEND_WEBHOOK_SECRET` (secret), `FORWARD_TO`, and `FORWARD_MAX_PER_DAY` (default 25).
   - Leave `ACCOUNT_ROUTES` unset until the beta. In production it defaults to off, so the api
     serves only `/healthz`, the waitlist, the remove page, and the waitlist admin view.
4. Variables on `www`: `PORT=8080`. The api origin is baked in at build time
   (`PUBLIC_API_URL`, default `https://api.skovern.com`).

The api refuses to boot in production without `RESEND_API_KEY`, `APP_URL`, or
`DATABASE_URL`, with an admin token under 32 characters, or with a non-https
`RESEND_API_URL`, and says which setting is wrong in the deploy log. With
`RESEND_WEBHOOK_SECRET` set, it also refuses a secret that isn't `whsec_...`, a
missing `FORWARD_TO`, a `FORWARD_TO` that isn't one plain address, or one at
`skovern.com`.

### Inbox forwarding

Mail to any `@skovern.com` address arrives at Resend (MX `@` →
`receive.forge.rmta.net`, priority 10, with receiving turned on for the domain).
Resend posts a signed webhook to the api, and the api forwards each email to
`FORWARD_TO` from `Skovern inbox <inbox@skovern.com>`, with **Reply-To** set to
the sender and `[skovern.com]` before the subject. The same webhook carries
bounce and complaint events, which pause welcome emails when more than 5% of
the last 24 hours' welcomes (with at least 20 sent) bounce or are marked as spam.

1. Create the webhook through the Resend API (or **Webhooks** → **Add webhook** in
   the dashboard):
   - Endpoint: `https://api.skovern.com/hooks/resend/inbound`
   - Events: `email.received`, `email.bounced`, `email.complained`
2. Copy its signing secret (`whsec_...`, returned by the create call) straight into
   Railway without printing it:
   `railway variables --service api --set-from-stdin RESEND_WEBHOOK_SECRET`
3. Set `FORWARD_TO` on `api` to the one inbox that gets the mail. It can't be at
   `skovern.com`. Optionally set `FORWARD_MAX_PER_DAY` (default 25).
4. Redeploy `api`. The deploy log says `inbox webhook ON at /hooks/resend/inbound`.
   Without `RESEND_WEBHOOK_SECRET` the route doesn't exist (404).

How it behaves:
- Each request must carry a valid Svix signature (`svix-id`, `svix-timestamp`,
  `svix-signature`) with a timestamp within 5 minutes. Anything else gets 401, and
  20 bad requests from one address in 10 minutes get 429.
- A repeated `svix-id` gets 200 and does nothing; IDs are kept for 7 days. The same
  email is never forwarded twice, even under a new delivery ID.
- The forward is built from the Receiving API (`GET /emails/receiving/{id}`), never
  from the webhook body. Attachments go along by their signed download links; over
  25 MB together, or if Resend refuses them, they're listed by name instead.
- `[spam?]` goes before the subject when Resend's SPF, DKIM, or DMARC check failed.
- Mail from `@skovern.com` senders is never forwarded.
- Over `FORWARD_MAX_PER_DAY` forwards in 24 hours, mail stays in Resend's
  **Receiving** tab. The log says `forward budget spent` once per held email, and the
  first held email of the (UTC) day sends one summary: "N emails waiting in Resend".
- If Resend is unreachable, the webhook answers 500 and Resend retries it later.

Resend's free plan sends 100 emails a day in total: 70 welcomes, 25 forwards, and
1 summary fit under it. Replies sent from Gmail as `hi@skovern.com` count too.

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
