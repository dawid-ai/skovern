# Skovern

> [!WARNING]
> **Not ready for public testing. Please ignore the download for now.**
> These builds exist so the founder can test Skovern on his own machine. They're unsigned, they
> need a server that isn't online yet (so you can't even sign in), things will break, and there's
> no support. If you found this: thank you for looking. Check back when there's a beta.

**An extra pair of hands for your business. On your computer. Yours.**

Skovern is a local-first AI assistant for small-business owners — the
florist, the plumber, the single-location gym. It does real work (watches
your competitors, fixes how AI search sees your business, drafts your
content, organizes your knowledge) through buttons, not terminals.

- **Free to run.** Uses a model on your own computer, the Claude/ChatGPT
  subscription you already pay for, or your own key. Paid options exist for
  convenience — never as a lock-in.
- **Private by default.** Nothing leaves your machine unless you say so —
  and the app shows you a receipt for everything that does.
- **Human.** Every word in the app is written for a person who doesn't know
  what GitHub is. There's an Explain mode that teaches you AI while it works.
- **Radically transparent.** Affiliate links are always labeled with a
  no-commission alternative next to them. We don't control external
  services, and we say so on every connector.

## Status

Pre-alpha. Being built in public. Every feature ships through a four-stage
loop — spec, build, then an independent AI agent verifies the work against
its contract, and a second agent security-reviews the diff before anything
merges. The builder never signs off on its own code.

## Install (founder testing only)

Read the warning at the top first. For the founder's own box:

1. Download the latest Windows installer:
   [Skovern-Setup.exe](https://github.com/dawid-ai/skovern/releases/latest/download/Skovern-Setup.exe)
   (all versions: [Releases](https://github.com/dawid-ai/skovern/releases)).
2. Windows shows "Windows protected your PC" because builds are unsigned until the beta:
   **More info** → **Run anyway**.
3. Start the local server from this repo (the app talks to it for sign-in, messages, and news):

   ```bash
   pnpm install
   pnpm --filter @skovern/site db:up
   pnpm --filter @skovern/site dev
   ```

   The installed app finds the server at `SKOVERN_API_URL`, or `http://127.0.0.1:8787` when that
   isn't set.
4. Open Skovern from the Start menu. After that it updates itself: when a new version is out, a
   small note asks if you want it. **Settings** → **Updates** shows your version.

Release notes: [`UPDATES.md`](UPDATES.md). How releases are cut: [`docs/RELEASING.md`](docs/RELEASING.md).

## Why

AI is going to shake the job market and the economy underneath every small
business. The people with the least protection will be the last to get the
leverage. This project exists to change the order: the same tools, in your
hands, free, private, understandable.

## License

Fair-code (final license text landing before first release): free for any
personal or internal business use, source open to read and contribute to —
but selling access to Skovern as a hosted service requires a commercial
license. The plugin SDK (`packages/plugin-sdk`) is MIT so community skills
are yours, no strings.
