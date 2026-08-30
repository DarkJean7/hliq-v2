// ─────────────────────────────────────────────────────────────────────────────
// INSOLVENT TERMINAL — self-test bot
//
// A bot whose job is to prove the plumbing works. It walks the whole surface in a
// fixed order and says what it found, then does one small round trip: open a
// position, hold it a few ticks, close it.
//
// Identical on a paper account and a real one. It reads ctx.paper only to print
// it — the behaviour does not branch, so whatever you see here is what you get
// there. Test it on paper first anyway.
//
// SUGGESTED SETTINGS when adding it
//   Market            BTC   (or anything liquid)
//   Max per order     25
//   Max orders / min  4
//   Run every (s)     10    ← the whole run takes about 2 minutes at 10s
//   Leverage          3
//
// WHAT YOU SHOULD SEE in the Log, oldest at the bottom:
//   tick 1  environment + a market count
//   tick 2  api.info and api.candles both answering
//   tick 3  "opening" and then a "Sent market buy"
//   tick 4+ the position, with its unrealised PnL moving
//   tick 7  "closing" and then a "Sent close"
//   tick 8  "position is flat again — self test complete"
//
// If a step is missing, the line before it tells you which part failed.
// ─────────────────────────────────────────────────────────────────────────────

// --- edit these two if you want ---------------------------------------------
const TEST_USD   = 15   // size of the one test order, in dollars
const HOLD_TICKS = 3    // how many ticks to hold before closing
// -----------------------------------------------------------------------------

let step = 0            // survives between ticks: the worker keeps this scope alive
let openedAt = null
let done = false

function onTick(ctx) {
  step++

  // ── 1. what did we actually receive? ──────────────────────────────────────
  if (step === 1) {
    log('--- self test starting ---')
    log('account:', ctx.paper ? 'PAPER (simulated)' : 'REAL', '| market:', ctx.coin)
    log('mark:', ctx.mark, '| equity: $' + Number(ctx.equity).toFixed(2))
    log('markets visible:', Object.keys(ctx.mids || {}).length,
        '| open positions:', (ctx.positions || []).length,
        '| resting orders:', (ctx.orders || []).length)
    // Expect 0 here on a fresh start: ctx.candles fills in a moment later, once the
    // app's own history load lands. api.candles() below always fetches on the spot,
    // which is what to use when you actually need bars.
    log('candles supplied:', (ctx.candles || []).length, '(0 is normal on the first tick)')
    if (ctx.position) {
      log('NOTE: already holding', ctx.position.szi, ctx.coin, '— will not open a second one')
    }
    return
  }

  // ── 2. does the bridge to the main thread work? ───────────────────────────
  // These are awaited, which is why onTick is async from here on. Returning the
  // promise is enough — the harness waits for it.
  if (step === 2) return probeApi(ctx)

  // ── 3. one small buy ──────────────────────────────────────────────────────
  if (step === 3) {
    if (ctx.position && Number(ctx.position.szi) !== 0) {
      log('skipping the open — a position already exists')
      openedAt = step
      return
    }
    log('opening: market buy $' + TEST_USD, 'of', ctx.coin)
    openedAt = step
    return { type: 'market', isBuy: true, usd: TEST_USD }
  }

  // ── 4. watch it, then close it ────────────────────────────────────────────
  if (done) return

  if (ctx.position && Number(ctx.position.szi) !== 0) {
    const p = ctx.position
    log('holding', Number(p.szi).toFixed(6), ctx.coin,
        '| entry', Number(p.entryPx).toFixed(2),
        '| mark', Number(ctx.mark).toFixed(2),
        '| pnl $' + Number(p.unrealizedPnl).toFixed(4))

    if (openedAt != null && step >= openedAt + HOLD_TICKS) {
      log('closing')
      done = true
      return { type: 'close' }
    }
    return
  }

  // No position. Either the open has not filled yet, or we have just closed.
  if (openedAt != null && step > openedAt + 1) {
    log('position is flat again — self test complete')
    log('--- nothing further will be traded ---')
    done = true
    return
  }
  log('waiting for the open to fill…')
}

// Kept separate so the tick above stays readable. Each call is wrapped, because a
// failing probe should say which one failed rather than aborting the whole tick.
async function probeApi(ctx) {
  try {
    const meta = await api.info({ type: 'meta' })
    log('api.info ok — universe has', (meta.universe || []).length, 'markets')
  } catch (e) {
    log('api.info FAILED:', e.message)
  }

  try {
    const cs = await api.candles(ctx.coin, '1h', Date.now() - 6 * 3600 * 1000)
    log('api.candles ok —', (cs || []).length, 'hourly candles for', ctx.coin)
  } catch (e) {
    log('api.candles FAILED:', e.message)
  }

  try {
    const book = await api.info({ type: 'l2Book', coin: ctx.coin })
    const bid = book?.levels?.[0]?.[0]?.px
    const ask = book?.levels?.[1]?.[0]?.px
    log('api.info l2Book ok — best bid', bid, '/ ask', ask)
  } catch (e) {
    log('api.info l2Book FAILED:', e.message)
  }

  // Deliberately asks for something bots are not allowed to do, to prove the
  // guard is real rather than assumed. Expect this to be REFUSED.
  try {
    await api.exchange('withdraw3', {})
    log('!!! a blocked action was allowed — tell the developer')
  } catch (e) {
    log('blocked action correctly refused:', e.message)
  }
}
