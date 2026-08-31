# Insolvent Terminal — working rules

A Hyperliquid trading terminal. Live at **https://insolvent.trade**, real money, real
users. Read this before changing anything.

This file exists because it travels with the repo. Notes kept on one machine do not, and a
session working from a phone previously had to guess at the rules below and overwrote
eighteen commits of `src/main.js` doing it.

---

## First, in every session

```bash
git fetch origin main
git status                     # behind? pull before touching anything
git config core.hooksPath .githooks    # once per clone — see "The guard" below
```

**More than one device edits this repo.** A phone session and a desktop session both work
on `src/main.js`, which is ~30,000 lines. If you start from a stale copy you will not get a
clean conflict — you will get a silent revert of someone's work.

---

## Deploying

**`git push` to `main` IS the deploy.** GitHub Actions builds and ships it. That is the
whole procedure.

- **Never `scp` or `rsync` to the server.** This is what caused the eighteen-commit loss.
  Another session may have pushed since you last pulled; a direct copy overwrites prod with
  whatever your disk happens to hold. `deploy.ps1` is legacy break-glass only.
- **Never run `npm run build` on the server.** vite needs >1 GB and that box also runs the
  trading bots. A server-side build has already been OOM-killed once (exit 137), and the
  kernel could as easily have picked a live bot. CI builds on the runner.
- **You do not need to build before pushing.** `dist/` is gitignored and CI builds it.
  Build locally only to test locally.
- `server.js` and `notify-server.js` restart only when their checksum changes, so a UI-only
  push never interrupts a running bot. Changes under `strategies/` need `deploy.ps1 -Bots`.

Deploys take ~2 minutes. Confirm by fetching the live bundle and grepping for a string your
change introduced — the asset hash differs from a local build, so comparing hashes proves
nothing:

```bash
h=$(curl -s https://insolvent.trade/ | grep -o "assets/index-[A-Za-z0-9_-]*\.js" | head -1)
curl -s "https://insolvent.trade/$h" | grep -c "some string you added"
```

Grep for a **string literal**, not a function name — the minifier renames functions.

---

## Before you push

```bash
npm test        # 63 suites, no browser or network needed, a few seconds
```

Expect `60 passing · 3 known-failing · 0 broken`. The three are listed with reasons in
`tests/run.mjs`; they fail for causes outside this repo. **`broken` must be 0.**

Suites read the source and assert against it, so they catch a surprising amount: a handler
that still points at the mobile container, a limit that stopped being enforced, a comment
promising something the code no longer does.

If you change behaviour a suite asserts, update the suite in the same commit and say in the
message why the old assertion no longer describes the truth.

---

## The guard

`.githooks/pre-push` refuses a push to `main` when `origin/main` has commits you do not.
It is in the repo, but git does not enable repo hooks automatically:

```bash
git config core.hooksPath .githooks
```

Run that once per clone. Without it you are relying on remembering to pull, which is the
thing that already failed.

---

## Things that will bite you

- **`src/main.js` is huge** — ~30,000 lines, about 75% of all the source in `src/`. Prefer
  `Edit` with a unique anchor over rewriting regions.
- **New features go in their own module by default.** This file got to 30,000 lines one
  reasonable decision at a time: an anchored edit into `main.js` is the cheapest possible
  change, so it kept winning, and nobody ever added up the total. `celebrate.js`,
  `devicebot.js`, `paper.js`, `charts.js` are what it looks like when that choice goes the
  other way.
  The test is dependencies, not size: code that needs `state` and a dozen internal helpers
  belongs where they are — threading nine arguments through a new interface is worse than
  the thing it replaced. But if the answer keeps coming out "main.js", say so out loud
  before writing, rather than noticing five features later.
  Heredocs mangle `\n`, backticks and `$` — if you script an edit, write the script to a
  file rather than piping it through a shell.
- **A build passing does not mean an identifier exists.** vite will happily bundle a call
  to something never imported; it fails at runtime. After adding a call to another module,
  check the import.
- **Check the telemetry before theorising.** `client-errors.json` on the server, or
  `GET /api/errors?pin=<LB_PIN>&kind=<kind>`. A Net PnL bug took three wrong guesses from
  screenshots and one read of the log to solve. Kinds: `ratelimit`, `pnlstep`, `rejection`,
  `error`.
- **Empty is not the same as unknown.** This has caused the same user-visible bug three
  separate times: an empty array meaning "we did not look" was treated as "there is none",
  and HIP-3 positions vanished from Net PnL. If you cannot tell the difference, pass `null`
  and say so.
- **Hyperliquid rate-limits by IP**, 1200 weight/min shared across `/info` and `/exchange`.
  Fanning a request across nine wallets is how the limiter gets tripped. Batch or cache.
- **Agent keys can trade but cannot move funds.** Anything that moves money needs the main
  wallet.
- **A horizontally scrolling element needs `data-dragscroll`**, or a global CSS rule strips
  its scrolling and the content is simply unreachable. This has bitten three times.

---

## Verifying UI work

Playwright is installed. Drive the real app rather than assuming:

```bash
npx playwright ... # see tests/ for the pattern, or write a throwaway script
```

Mobile is the primary surface — check at 430×930 with `isMobile: true`. The app is a
different shell on desktop (`switchTab`) and mobile (`_mobVActiveTab`); a change to a
shared view usually needs both.

Note when driving the app in a test: seeding `localStorage` from Playwright's
`addInitScript` is unreliable for anything a TradingView embed touches — the embed opens an
`about:blank` iframe that inherits the origin, init scripts re-run there, and your seed
overwrites the real value on every remount. Seed after load instead.
