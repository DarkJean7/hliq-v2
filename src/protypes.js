/**
 * INSOLVENT TERMINAL — Pro order types
 *
 * Hyperliquid's order ticket has a "Pro" list behind the Market/Limit tabs: Chase, Scale,
 * Stop Limit, Stop Market, Take Limit, Take Market, Trailing Stop and TWAP. This module is
 * the catalogue of those types and every decision that can be made about one WITHOUT a
 * browser, a network or `state` — which prices a Scale ladder sits at, where a Chase order
 * belongs in the book, whether a TWAP is long enough to be accepted, what each type will
 * actually do when the button is pressed.
 *
 * It is pure on purpose. The ticket (src/proticket.js) collects the form, the learn-more
 * modal (src/prolearn.js) prints the copy, and both read their answers from here, so the
 * explanation on screen and the order that goes to the exchange cannot drift apart.
 *
 * ── where the words come from ──
 *
 * `blurb` is Hyperliquid's own one-line definition of each type, from their docs
 * (Trading → Order types). We repeat theirs rather than inventing ours because a trader who
 * learned the type on app.hyperliquid.xyz should not have to re-learn it here. `how` is the
 * part that is ours: what THIS terminal does to produce that behaviour, which is not always
 * a single order.
 *
 * ── what is native and what is not ──
 *
 * Only some of these are order types the exchange knows about:
 *
 *   Market, Limit             one order, `limit` with a time-in-force
 *   Stop/Take, Market/Limit   one order, `trigger` — tpsl 'sl' or 'tp', isMarket on or off
 *   TWAP                      the exchange's own twapOrder action; it runs the slices
 *   Scale                     N limit orders in ONE signed batch — the exchange sees N orders
 *   Chase                     an ALO order that something has to re-price; HL runs it in the
 *                             browser tab too, which is why they cap it at 5 at a time
 *   Trailing Stop             HL added this as a type; there is still no API for it, so ours
 *                             is the server-side watcher in strategies/trailstop.js
 *
 * `native: false` means something has to stay alive for the order to keep behaving. That is
 * worth saying out loud in the UI, and `liveness` is the sentence that says it.
 */

/** Time-in-force, as the exchange names them. */
export const TIFS = [
  { id: 'Gtc', label: 'GTC', name: 'Good Til Cancel',    desc: 'Rests on the order book until it is filled or cancelled.' },
  { id: 'Ioc', label: 'IOC', name: 'Immediate or Cancel', desc: 'Cancelled if it is not filled immediately. Nothing rests.' },
  { id: 'Alo', label: 'ALO', name: 'Post Only',           desc: 'Only ever adds to the book. Rejected outright if it would fill on arrival, so it always pays the maker fee.' },
]

/**
 * TWAP limits, from HL's docs — except the duration ceiling.
 *
 * The docs say 5 minutes to 7 days. The exchange schema the SDK validates against caps `m`
 * at 1440 minutes, so anything longer is rejected before it leaves the page — by valibot,
 * with a message about a number, which is not a thing a trader can act on. We cap at 1440
 * ourselves and say why. If HL widens the schema this is the one number to change.
 */
export const TWAP = {
  MIN_MINUTES:   5,
  MAX_MINUTES:   1440,
  MIN_NOTIONAL:  100,     // USD — HL rejects a smaller TWAP outright
  SUB_SECONDS:   30,      // one suborder every 30s
  MAX_SLIPPAGE:  0.03,    // each suborder is capped at 3%
  RANDOMIZE_PCT: 20,      // "randomize" jitters each suborder's size by up to ±20%
}

/** Scale ladders. More than this and the batch starts to look like spam to the rate limiter. */
export const SCALE = { MIN_ORDERS: 2, MAX_ORDERS: 20, MIN_SKEW: 0.05, MAX_SKEW: 20 }

/** HL caps concurrent chases per browser tab. Ours runs in the tab too, so the cap is real. */
export const CHASE = { MAX_ACTIVE: 5, MIN_REPRICE_MS: 1000 }

/**
 * The catalogue.
 *
 * `fields` is what the ticket must show. `submit` is the shape of the thing that gets sent,
 * which the executor switches on. Order matters: it is the order the dropdown prints, and it
 * matches Hyperliquid's own.
 */
export const ORDER_TYPES = [
  {
    id: 'market', label: 'Market', group: 'basic', native: true,
    tags: ['Immediate', 'Market'],
    blurb: side => `Place a ${side} order at market price. Trade price may vary based on slippage tolerance.`,
    doc: 'An order that executes immediately at the current market price.',
    how: 'Sent as an aggressive IOC limit order with 3% slippage headroom, which is how every venue actually builds a market order. Any part that cannot fill inside that headroom is cancelled rather than left resting.',
    note: 'Seeks immediate execution. You pay the taker fee.',
    fields: ['size'], submit: 'limit',
  },
  {
    id: 'limit', label: 'Limit', group: 'basic', native: true,
    tags: ['Resting', 'Maker'],
    blurb: side => `Place a ${side} order at a price you choose. It fills at that price or better, or waits.`,
    doc: 'An order that executes at the selected limit price or better.',
    how: 'One limit order at your price, with the time-in-force you pick. GTC rests until filled or cancelled, IOC takes what is there and cancels the rest, ALO is rejected rather than allowed to fill on arrival.',
    note: 'A resting limit order that fills earns the maker fee instead of paying the taker fee.',
    fields: ['size', 'limitPx', 'tif'], submit: 'limit',
  },
  {
    id: 'chase', label: 'Chase', group: 'algo', native: false,
    tags: ['Post Only', 'Follows the book'],
    blurb: side => `A post-only ${side} order that re-prices itself to stay at the front of the ${side === 'long' ? 'bid' : 'ask'} until it fills.`,
    doc: 'A Post Only (ALO) limit order that automatically re-prices to track the best bid or ask until it is filled or terminated.',
    how: 'An ALO order placed one tick inside the best bid (buying) or best ask (selling). When the book moves away from it, the order is cancelled and replaced at the new front. It never crosses the spread, so it never pays the taker fee — and it never chases a price that has run away from you further than the distance you set.',
    note: `Runs in this tab. Close the tab and the last order simply stops being re-priced — it stays resting where it was. Up to ${CHASE.MAX_ACTIVE} at once.`,
    liveness: 'This tab re-prices the order. If you close it, the order stops following the book.',
    fields: ['size', 'chaseMaxTicks'], submit: 'chase',
  },
  {
    id: 'scale', label: 'Scale', group: 'algo', native: true,
    tags: ['Ladder', 'Multiple orders'],
    blurb: side => `Spread the ${side} across a price range instead of one price — several limit orders at once.`,
    doc: 'Multiple limit orders in a set price range.',
    how: 'One signed batch containing every rung, so they all arrive together or none do. Prices are spaced evenly from the first price to the last; size skew tilts how much sits at each end — above 1 loads the far end, below 1 loads the near end, 1 is flat.',
    note: 'Averages your entry across the range. The rungs the market never reaches simply stay resting.',
    fields: ['size', 'scaleStartPx', 'scaleEndPx', 'scaleCount', 'scaleSkew'], submit: 'scale',
  },
  {
    id: 'stopLimit', label: 'Stop Limit', group: 'trigger', native: true,
    tags: ['Trigger', 'Limit'],
    blurb: side => `A ${side} limit order that only exists once the market trades through your trigger price.`,
    doc: 'A limit order that is activated when the price reaches the selected trigger price.',
    how: 'A trigger order held by the exchange. Nothing rests on the book and nothing is visible until the mark price reaches the trigger; then a limit order goes in at the price you set.',
    note: 'The limit price protects you from a bad fill and can also miss entirely — if price gaps straight through it, nothing fills.',
    fields: ['size', 'triggerPx', 'limitPx', 'reduceOnly'], submit: 'trigger',
    trigger: { tpsl: 'sl', isMarket: false },
  },
  {
    id: 'stopMarket', label: 'Stop Market', group: 'trigger', native: true,
    tags: ['Trigger', 'Market'],
    blurb: side => `A ${side} market order that fires once the market trades through your trigger price.`,
    doc: 'A market order that is activated when the price reaches the selected trigger price. For long orders the trigger price needs to be higher than the mid price; for short orders, lower.',
    how: 'A trigger order held by the exchange. When the mark price reaches the trigger it becomes a market order, so it takes whatever the book offers.',
    note: 'Fills are near-certain, the price is not. This is the one to use when being out matters more than the last few ticks.',
    fields: ['size', 'triggerPx', 'reduceOnly'], submit: 'trigger',
    trigger: { tpsl: 'sl', isMarket: true },
  },
  {
    id: 'takeLimit', label: 'Take Limit', group: 'trigger', native: true,
    tags: ['Trigger', 'Limit'],
    blurb: side => `A ${side} limit order that waits for the market to come back to your trigger price first.`,
    doc: 'A limit order that is activated when the price reaches the selected trigger price.',
    how: 'The same exchange-held trigger as a stop, pointed the other way: it arms on a move in your favour rather than against you. A limit order goes in when the trigger is reached.',
    note: 'A stop triggers on the price you did not want. A take triggers on the price you did.',
    fields: ['size', 'triggerPx', 'limitPx', 'reduceOnly'], submit: 'trigger',
    trigger: { tpsl: 'tp', isMarket: false },
  },
  {
    id: 'takeMarket', label: 'Take Market', group: 'trigger', native: true,
    tags: ['Trigger', 'Market'],
    blurb: side => `A ${side} market order that fires when the market reaches your trigger price in your favour.`,
    doc: 'A market order that is activated when the price reaches the selected trigger price. For long orders the trigger price needs to be lower than the mid price; for short orders, higher.',
    how: 'An exchange-held trigger that becomes a market order the moment the mark price reaches it.',
    note: 'Takes the price that is there when it fires, not the one on the ticket.',
    fields: ['size', 'triggerPx', 'reduceOnly'], submit: 'trigger',
    trigger: { tpsl: 'tp', isMarket: true },
  },
  {
    id: 'trailingStop', label: 'Trailing Stop', group: 'algo', native: false, perpOnly: true, needsPosition: true,
    tags: ['Trails the high', 'Perps only'],
    blurb: () => 'A stop that follows the best price reached and fires when the market gives back more than the distance you set.',
    doc: 'A market order that is activated when the mark price retraces from its best level by the selected distance or percentage. Available for perpetual markets only.',
    how: 'There is no trailing-stop order in the exchange API, so this arms a watcher on our server that remembers the high-water mark and keeps a reduce-only stop resting behind it, moving that order up as the high rises and never down.',
    note: 'It runs on the server, not in this tab — a stop that stops working when you close a browser is not a stop.',
    liveness: 'Runs on our server. It keeps working with this tab closed.',
    fields: ['position'], submit: 'trailing',
  },
  {
    id: 'twap', label: 'TWAP', group: 'algo', native: true,
    tags: ['Time-weighted', 'Sliced'],
    blurb: side => `Break the ${side} into small pieces and work it into the market over a period you choose.`,
    doc: 'Large orders divided into suborders executed at regular intervals, to fill near the average price over the window rather than in one hit.',
    how: `Handed to the exchange's own TWAP engine, which sends a suborder every ${TWAP.SUB_SECONDS} seconds for the duration you set, each capped at ${TWAP.MAX_SLIPPAGE * 100}% slippage. Randomize jitters each suborder's size by up to ±${TWAP.RANDOMIZE_PCT}% so the schedule is not obvious in the book.`,
    note: `Runs on the exchange, so it survives closing this tab. Minimum $${TWAP.MIN_NOTIONAL} and ${TWAP.MIN_MINUTES} minutes.`,
    liveness: 'Runs on the exchange. It keeps working with this tab closed.',
    fields: ['size', 'twapMinutes', 'twapRandomize', 'reduceOnly'], submit: 'twap',
  },
]

/** Everything that is not a plain Market or Limit — i.e. what lives behind the Pro button. */
export const PRO_IDS = ORDER_TYPES.filter(t => t.group !== 'basic').map(t => t.id)

export const byId = (id) => ORDER_TYPES.find(t => t.id === id) ?? null
export const isProType = (id) => PRO_IDS.includes(id)
export const needsField = (id, field) => !!byId(id)?.fields?.includes(field)

// ─── PRICE TICKS ──────────────────────────────────────────────────────────────

/**
 * The smallest price step this market allows.
 *
 * Same rule the order path rounds to (trading.js roundPx): at most 5 significant figures AND
 * at most 6 − szDecimals decimal places, whichever bites first. Chase needs the number
 * itself, not just the rounding — "one tick inside the best bid" is meaningless without it.
 */
export function tickSize(px, szDecimals = 6) {
  const p = Math.abs(parseFloat(px))
  const maxDec = Math.max(0, 6 - (parseInt(szDecimals) || 0))
  if (!(p > 0)) return Math.pow(10, -maxDec)
  // 5 significant figures: a price of 218.61 has 2 decimals left, 0.0034441 has 7.
  const sigDec = 4 - Math.floor(Math.log10(p))
  return Math.pow(10, -Math.max(0, Math.min(maxDec, sigDec)))
}

// ─── CHASE ────────────────────────────────────────────────────────────────────

/**
 * Where a chase order belongs right now.
 *
 * One tick inside the best bid (buying) or best ask (selling), which is the front of the
 * queue without crossing. When the spread is a single tick there is no room to improve, so
 * it joins the touch instead — an ALO that would cross is REJECTED by the exchange, not
 * downgraded, and a chase that keeps getting rejected is a chase that never fills.
 *
 * Returns null when the book is not usable, so no caller can accidentally place at 0.
 */
export function chaseTargetPx({ isBuy, bestBid, bestAsk, tick }) {
  const bid = parseFloat(bestBid), ask = parseFloat(bestAsk), t = parseFloat(tick)
  if (!(bid > 0) || !(ask > 0) || !(t > 0) || ask < bid) return null
  // A buy may not sit at or above the best ask, a sell not at or below the best bid — that
  // is what "post only" means, and the exchange REJECTS such an order rather than repricing
  // it. On a one-tick spread both clauses collapse onto the touch, which is correct: there
  // is no room inside, so join it.
  const px = isBuy ? Math.min(bid + t, ask - t) : Math.max(ask - t, bid + t)
  return px > 0 ? Math.round(px / t) * t : null
}

/**
 * Is the resting order in the wrong place?
 *
 * Only a full tick counts. Without this, float noise on a re-derived target re-places the
 * order on every book update — which is a cancel plus an order, every tick, against an IP
 * budget shared with everything else the page does.
 */
export function shouldRechase(restingPx, targetPx, tick) {
  const r = parseFloat(restingPx), g = parseFloat(targetPx), t = parseFloat(tick)
  if (!(t > 0) || !Number.isFinite(g)) return false
  if (!Number.isFinite(r)) return true
  return Math.abs(r - g) >= t - 1e-12
}

/**
 * Has the market run away from where the chase started?
 *
 * A chase with no leash follows price forever, which is how "get a maker fill near here"
 * turns into a fill somewhere you would never have chosen. `maxTicks` of 0 means no leash,
 * which is HL's own default.
 */
export function chaseExceeded({ isBuy, startPx, targetPx, tick, maxTicks }) {
  const n = parseInt(maxTicks)
  if (!(n > 0)) return false
  const s = parseFloat(startPx), g = parseFloat(targetPx), t = parseFloat(tick)
  if (!(s > 0) || !(g > 0) || !(t > 0)) return false
  // Only movement AGAINST the order counts: a buy chasing upward is paying more than it
  // meant to; a buy whose target fell is getting a better price and should keep going.
  const drift = isBuy ? (g - s) : (s - g)
  return drift / t > n
}

// ─── SCALE ────────────────────────────────────────────────────────────────────

/**
 * The rungs of a scale ladder.
 *
 * Prices are spaced evenly from `startPx` to `endPx` inclusive. Sizes run linearly from
 * weight 1 at the first rung to weight `skew` at the last, then are normalised so the whole
 * ladder adds up to `totalSz` — a skew of 2 puts twice as much on the last rung as the
 * first, a skew of 0.5 half as much, and 1 is flat.
 *
 * Normalising rather than scaling matters: the size on the ticket is the size that gets
 * placed, whatever the skew. A ladder that quietly placed 1.7× what you typed because you
 * moved a skew slider is the kind of surprise that costs money.
 *
 * Returns `{ orders, error }`. `orders` is null when the inputs cannot make a ladder —
 * never a partial one, because a partially-built ladder is an unbalanced position.
 */
export function scaleLadder({ startPx, endPx, count, totalSz, skew = 1 }) {
  const a = parseFloat(startPx), b = parseFloat(endPx)
  const n = parseInt(count), sz = parseFloat(totalSz), k = parseFloat(skew)
  if (!(a > 0) || !(b > 0))            return { orders: null, error: 'Enter both ends of the price range.' }
  if (!Number.isFinite(n) || n < SCALE.MIN_ORDERS || n > SCALE.MAX_ORDERS)
    return { orders: null, error: `Between ${SCALE.MIN_ORDERS} and ${SCALE.MAX_ORDERS} orders.` }
  if (!(sz > 0))                       return { orders: null, error: 'Enter a size.' }
  if (!(k >= SCALE.MIN_SKEW) || !(k <= SCALE.MAX_SKEW))
    return { orders: null, error: `Size skew must be between ${SCALE.MIN_SKEW} and ${SCALE.MAX_SKEW}.` }

  const weights = []
  for (let i = 0; i < n; i++) weights.push(1 + (k - 1) * (i / (n - 1)))
  const sum = weights.reduce((x, y) => x + y, 0)
  if (!(sum > 0)) return { orders: null, error: 'Size skew leaves nothing to place.' }

  const orders = []
  for (let i = 0; i < n; i++) {
    orders.push({ px: a + (b - a) * (i / (n - 1)), sz: sz * weights[i] / sum })
  }
  return { orders, error: null }
}

/** What the ladder averages out to, if every rung fills. The number people actually want. */
export function ladderAvgPx(orders) {
  if (!orders?.length) return null
  const sz = orders.reduce((s, o) => s + o.sz, 0)
  if (!(sz > 0)) return null
  return orders.reduce((s, o) => s + o.px * o.sz, 0) / sz
}

// ─── TRIGGER DIRECTION ────────────────────────────────────────────────────────

/**
 * Which side of the mark a trigger price has to be on.
 *
 * The exchange infers the direction from tpsl and the order's side, so a trigger on the
 * wrong side of the mark either fires instantly or never. HL's docs state the four cases;
 * this is them:
 *
 *   sl + buy   → fires at or above the trigger   (breakout entry, or a short's stop)
 *   sl + sell  → fires at or below               (a long's stop)
 *   tp + buy   → fires at or below               (buy the retrace)
 *   tp + sell  → fires at or above               (a long's take-profit)
 *
 * Returns 'above' or 'below': where the trigger must sit relative to the mark for the order
 * to mean anything.
 */
export function triggerSide({ tpsl, isBuy }) {
  if (tpsl === 'sl') return isBuy ? 'above' : 'below'
  return isBuy ? 'below' : 'above'
}

// ─── VALIDATION ───────────────────────────────────────────────────────────────

/**
 * Everything wrong with the form, first thing first.
 *
 * Ordered the way someone can actually clear them — a missing size before a trigger price on
 * the wrong side of the mark, because entering a size is the step in front of them. The
 * ticket shows `[0]`; nothing here throws.
 *
 * `markPx` is allowed to be missing. When it is, the checks that need it are SKIPPED rather
 * than failed: "we could not read the mark" is not the same as "your trigger is wrong", and
 * blocking an order on the first is how a rate-limit blip becomes an untradeable ticket.
 */
export function validate(typeId, f = {}) {
  const t = byId(typeId)
  const e = []
  if (!t) return ['Unknown order type.']

  const sz   = parseFloat(f.sz)
  const mark = parseFloat(f.markPx)
  const hasMark = Number.isFinite(mark) && mark > 0

  if (t.fields.includes('size') && !(sz > 0)) e.push('Enter a size.')

  if (t.fields.includes('limitPx')) {
    const px = parseFloat(f.limitPx)
    if (!(px > 0)) e.push('Enter a limit price.')
  }

  if (t.fields.includes('triggerPx')) {
    const px = parseFloat(f.triggerPx)
    if (!(px > 0)) e.push('Enter a trigger price.')
    else if (hasMark) {
      const want = triggerSide({ tpsl: t.trigger.tpsl, isBuy: !!f.isBuy })
      if (want === 'above' && px <= mark) e.push(`A ${t.label.toLowerCase()} ${f.isBuy ? 'buy' : 'sell'} triggers above the mark — set it above $${trim(mark)}.`)
      if (want === 'below' && px >= mark) e.push(`A ${t.label.toLowerCase()} ${f.isBuy ? 'buy' : 'sell'} triggers below the mark — set it below $${trim(mark)}.`)
    }
  }

  if (typeId === 'scale') {
    // Size is checked above by the shared rule; pass a placeholder so the ladder reports the
    // ladder's own problems and nobody sees "enter a size" twice.
    const { error } = scaleLadder({ startPx: f.scaleStartPx, endPx: f.scaleEndPx, count: f.scaleCount, totalSz: sz > 0 ? sz : 1, skew: f.scaleSkew ?? 1 })
    if (error) e.push(error)
    const a = parseFloat(f.scaleStartPx), b = parseFloat(f.scaleEndPx)
    if (a > 0 && b > 0 && a === b) e.push('The two ends of the range are the same price.')
  }

  if (typeId === 'twap') {
    const m = parseFloat(f.twapMinutes)
    if (!(m >= TWAP.MIN_MINUTES)) e.push(`A TWAP runs for at least ${TWAP.MIN_MINUTES} minutes.`)
    else if (m > TWAP.MAX_MINUTES) e.push(`The exchange accepts up to ${TWAP.MAX_MINUTES} minutes (24 hours).`)
    if (sz > 0 && hasMark && sz * mark < TWAP.MIN_NOTIONAL) e.push(`A TWAP has to be at least $${TWAP.MIN_NOTIONAL}.`)
  }

  if (typeId === 'chase') {
    const n = f.chaseMaxTicks
    if (n !== '' && n != null && !(parseInt(n) >= 0)) e.push('Max chase distance must be a number of ticks, or blank for no limit.')
    if (parseInt(f.activeChases) >= CHASE.MAX_ACTIVE) e.push(`${CHASE.MAX_ACTIVE} chase orders are already running. Stop one first.`)
  }

  if (t.needsPosition && !f.hasPosition) e.push(`${t.label} manages an open position — open one first.`)
  if (t.perpOnly && f.isSpot) e.push(`${t.label} is available on perpetual markets only.`)

  return e
}

const trim = (n) => {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  return v >= 1000 ? v.toFixed(2) : String(parseFloat(v.toPrecision(6)))
}

// ─── WHAT WILL HAPPEN ─────────────────────────────────────────────────────────

/**
 * One sentence describing the order that is about to be placed, in the numbers on the form.
 *
 * The ticket prints this under the button. It is the last chance to notice that the ladder
 * runs the wrong way or the trigger is on the wrong side, and it is deliberately specific:
 * "4 orders from $95.00 to $91.00" is checkable, "places a scale order" is not.
 */
export function describe(typeId, f = {}) {
  const t = byId(typeId)
  if (!t) return ''
  const side = f.isBuy ? 'Buy' : 'Sell'
  const coin = f.coin ?? ''
  const sz   = parseFloat(f.sz)
  const size = sz > 0 ? `${trim(sz)} ${coin}`.trim() : `your size`

  switch (typeId) {
    case 'market':
      return `${side} ${size} now, at whatever the book offers within 3%.`
    case 'limit': {
      const px  = parseFloat(f.limitPx)
      const tif = TIFS.find(x => x.id === (f.tif ?? 'Gtc'))
      if (!(px > 0)) return `${side} ${size} at a price you set.`
      return `${side} ${size} at $${trim(px)} — ${tif?.name ?? 'Good Til Cancel'}.`
    }
    case 'chase': {
      const n = parseInt(f.chaseMaxTicks)
      const leash = n > 0 ? ` Stops if the price runs more than ${n} tick${n === 1 ? '' : 's'} against you.` : ''
      return `${side} ${size} at the front of the ${f.isBuy ? 'bid' : 'ask'}, re-priced as the book moves, never crossing the spread.${leash}`
    }
    case 'scale': {
      const { orders, error } = scaleLadder({ startPx: f.scaleStartPx, endPx: f.scaleEndPx, count: f.scaleCount, totalSz: sz, skew: f.scaleSkew ?? 1 })
      if (error || !orders) return `${side} ${size} spread across a price range.`
      const avg = ladderAvgPx(orders)
      return `${side} ${size} as ${orders.length} limit orders from $${trim(orders[0].px)} to $${trim(orders[orders.length - 1].px)} — average $${trim(avg)} if they all fill.`
    }
    case 'stopLimit': case 'stopMarket': case 'takeLimit': case 'takeMarket': {
      const tp = parseFloat(f.triggerPx)
      const where = triggerSide({ tpsl: t.trigger.tpsl, isBuy: !!f.isBuy })
      if (!(tp > 0)) return `${side} ${size} once the mark price moves ${where} your trigger.`
      const tail = t.trigger.isMarket
        ? 'at market'
        : (parseFloat(f.limitPx) > 0 ? `with a limit at $${trim(f.limitPx)}` : 'with a limit price you set')
      const ro = f.reduceOnly ? ', reduce-only' : ''
      return `When the mark reaches $${trim(tp)} (${where} here), ${side.toLowerCase()} ${size} ${tail}${ro}.`
    }
    case 'trailingStop':
      return 'Follows the best price this position reaches and closes it when the market gives back your chosen distance.'
    case 'twap': {
      const m = parseFloat(f.twapMinutes)
      if (!(m >= TWAP.MIN_MINUTES)) return `${side} ${size} in slices over a window you set.`
      const slices = Math.max(1, Math.floor((m * 60) / TWAP.SUB_SECONDS))
      const rnd = f.twapRandomize ? `, sizes jittered ±${TWAP.RANDOMIZE_PCT}%` : ''
      return `${side} ${size} over ${trim(m)} minutes — about ${slices} suborders, one every ${TWAP.SUB_SECONDS}s${rnd}.`
    }
    default:
      return t.doc
  }
}
