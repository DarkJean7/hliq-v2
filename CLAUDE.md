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
- `server.js`, `notify-server.js` and `strategies/` all ship on a push and restart only when
  their checksum changes, so a UI-only push never interrupts a running bot. A bot script under
  `strategies/` is read when `hliq-strat` spawns a child, so it needs that restart to take —
  which the checksum gate does for you. `deploy.ps1 -Bots` is no longer needed for it.

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
npm test        # 128 suites, no browser or network needed, a few seconds
```

Expect `123 passing · 3 known-failing · 0 broken`. The three are listed with reasons in
`tests/run.mjs`; they fail for causes outside this repo. **`broken` must be 0.**

Suites read the source and assert against it, so they catch a surprising amount: a handler
that still points at the mobile container, a limit that stopped being enforced, a comment
promising something the code no longer does.

If you change behaviour a suite asserts, update the suite in the same commit and say in the
message why the old assertion no longer describes the truth.

There is also a browser test. **CI runs both, and a failure blocks the deploy** — it is a
step in `deploy.yml` before the SSH key is even loaded, so a red test cannot ship. Run it
yourself when you touch agent keys, the account switcher or the combined view:

```bash
npm run dev &                 # or leave one running
npm run test:browser          # tests/browser.mjs runs them all, --port=NNNN if not 5175
```

They drive both shells and assert things no single function's source shows: that the key on
screen is the key that signs for the account on screen, and that a bulk action sends exactly
the orders it named.

Match the exchange by HOST, not with a `**hyperliquid**` glob — that also matches the SDK's own
module files, which a dev server serves per-file out of node_modules, and the page then gets
JSON where it expected JavaScript and never boots. It is hermetic: its own server and the
exchange are both stubbed, so it takes about fifteen seconds and cannot fail because
Hyperliquid is having a bad morning. Keep it that way — fixtures live at the top of the file,
and an unstubbed request type gets `{}`, which the app treats like a call that failed.

**`ctx.route` does not cover WebSockets**, and the combined view opens one to Hyperliquid for
live state. Left alone it delivers real prices straight past every fixture: a stubbed coin at
$0.26438 rendered as $0.2872 and drifted between runs, so the assertion was really testing the
market. Every browser test calls `blockHlSockets(ctx)` (`ctx.routeWebSocket(/hyperliquid/i,
ws => ws.close())`) so the app falls back to the REST path the fixtures govern. A new browser
test needs that line too.

CI serves `dist/`, so the browser test gates the artifact that is about to ship, not a dev
build of it.

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
- **`state.addr` is not an account in the combined view.** It is the string
  `__all_accounts__`, and the paper account is a sentinel too. Anything per-account — a key,
  a balance, a setting — must take the address explicitly and reject a non-address rather
  than build a storage key out of one. This wiped agent keys for a day: reads came back empty
  so the panel looked cleared, and writes went to `hliq_agent_key___all_accounts__`, which
  nothing ever reads. `src/agentkeys.js` is the shape that prevents it — it cannot see
  `state`, so the mistake cannot be made inside it. Use `_agentUiAddr()` for "which account is
  the UI about".
- **Empty is not the same as unknown.** The most expensive rule in this file — it has now
  caused five separate user-visible bugs. An empty array meaning "we did not look" read as
  "there is none" and HIP-3 positions vanished from Net PnL; a partial wallet sum published
  as a total made the combined equity jump by hundreds between renders. If you cannot tell
  the difference, pass `null` and say so.
- **A renderer usually has a second copy for the combined view.** `renderSpotRow` has
  `renderSpotGroup`, the single-account cancel has the All-Accounts one, and so on. Fixing one
  and shipping it is how the same crash gets reported twice in a row. After any fix here,
  grep for the pattern before you claim it is done.
- **A perp-equity delta is not an account-value delta.** Every equity figure in the app is
  `snapshot + (live perp equity − perp equity when the snapshot was taken)`. On a unified
  account Hyperliquid moves USDC between the spot and perp sides on its own — funding a new
  position's margin, reserving it for a resting order, a bot's `usdClassTransfer`. Perp equity
  jumps, the account is worth what it was, and the bridge publishes the transfer as profit
  until the next snapshot lands: "equity spikes with a fake value and then fixes itself". What
  separates a transfer from a trade is whether a position changed SIZE — not whether fills
  were fetched, which is what the old check used and why it lagged by up to thirty seconds.
  `src/perpcash.js`, and `kind=eqstep` in the telemetry is what settled it.
- **Margin has more than two places to be.** Positions post it, resting ORDERS reserve it,
  spot tokens hold it, and only what is left is withdrawable. `marginSummary.totalMarginUsed`
  is positions ONLY and `withdrawable` already has the order reserve taken out, so anything
  that adds those two and calls it the account is short by whatever is resting — $710 of a
  $1,664 wallet, and the allocation wheel shipped that way for months. The reserve is
  `accountValue − totalMarginUsed − withdrawable`, which agrees to the cent with
  `Σ size × price ÷ leverage` over the non-reduce-only orders. `src/alloc.js`.
- **Health is not `1 - maint / accountValue`.** It is 100 minus Hyperliquid's Unified Account
  Ratio, and their docs give the algorithm (Trading → Account abstraction modes). Per COLLATERAL
  TOKEN: cross maintenance margin summed across EVERY dex, divided by that token'''s SPOT balance
  less isolated margin, then the WORST token wins — you are liquidated on the book that runs out
  first. We divided main-dex maintenance by portfolio value, which is wrong twice and optimistic
  twice: 89.1% against HL'''s 83.9% on the account it was reported on. Portfolio value includes
  spot tokens that do not collateralise a USDC position. `src/health.js`.
- **Hyperliquid rate-limits by IP**, 1200 weight/min shared across `/info` and `/exchange`.
  Fanning a request across nine wallets is how the limiter gets tripped. Batch or cache.
- **The average is not the thing that 429s you — the peak is.** The limiter is a bucket
  refilling at ~20 weight/second. 1200 spread over a minute never empties it; the same 1200 in
  the first eight seconds does. A cold All Accounts load with eight wallets measured 992/min
  (83%, "fine") while putting every one of its 98 requests inside 8.0 seconds, peaking at 1240
  against a 200-per-10s refill. `npm run hl-weight -- --settle=0` reports both; only read the
  peak. Every request is now metered and paced at `transport.request` (`src/hlbudget.js`), and
  the RESERVE is the part that matters: the dashboard is not allowed to spend the last of the
  budget, because `/exchange` is in it and being throttled as you try to close a position is
  the failure that costs money. Order placement is counted but never delayed.
- **Check-then-act on a shared budget is a race.** One wallet's fan fires six requests through
  `Promise.all`; if you ask "is there room" and only spend after awaiting, all six read the
  same level and all six go at once. Claim the weight before the wait.
- **Agent keys can trade but cannot move funds.** Anything that moves money needs the main
  wallet.
- **A horizontally scrolling element needs `data-dragscroll`**, or a global CSS rule strips
  its scrolling and the content is simply unreachable. This has bitten three times.

---

## Verifying UI work

Playwright is installed. Drive the real app rather than assuming:

```bash
npx playwright ... # see tests/agentkeys-browser.mjs for the pattern
```

**Put the harness in `tests/`, not a scratch directory.** Two harnesses that found real bugs
were written in a temp folder and deleted with the session, so the next person re-derived
them from nothing. If it was worth writing to prove a fix, it is worth keeping to prove the
fix is still there.

Wait on conditions, never on a fixed sleep. Entering the combined view takes as long as nine
wallets take to answer; `waitForTimeout(13000)` passes on your machine and fails on a slower
one, and a flaky test gets deleted rather than trusted.

Mobile is the primary surface — check at 430×930 with `isMobile: true`. The app is a
different shell on desktop (`switchTab`) and mobile (`_mobVActiveTab`); a change to a
shared view usually needs both.

Note when driving the app in a test: seeding `localStorage` from Playwright's
`addInitScript` is unreliable for anything a TradingView embed touches — the embed opens an
`about:blank` iframe that inherits the origin, init scripts re-run there, and your seed
overwrites the real value on every remount. Seed after load instead.
