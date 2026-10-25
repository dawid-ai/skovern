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

Run these after a loop merges to `main`, from an up-to-date `main`.

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
"unknown publisher" once, at first install (**More info** → **Run anyway**). Updates are
trusted through:

- only admins can push `v*` tags (ruleset "Release tags");
- published releases can't change (immutable releases);
- electron-updater checks the download's sha512 against `latest.yml` from the same release;
- the installer has a build provenance attestation from this workflow.

The open risk is the GitHub account itself (ledger `update-feed-trust-0x`); signing closes it.

## Where the installed app keeps things

- Data: `%APPDATA%\Skovern` (the same folder the dev app uses).
- Update log: `%APPDATA%\Skovern\logs\updates.log`.
- The installed app talks to the server at `SKOVERN_API_URL`, or `http://127.0.0.1:8787` when
  it isn't set (ledger `api-url-override-packaged`).
