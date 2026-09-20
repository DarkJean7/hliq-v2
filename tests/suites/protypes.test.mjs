// Pro order types: the catalogue, and every decision that can be made about one without a
// market in front of you.
//
// These are the types that place more than one order, or an order that something has to keep
// moving, so the failure modes are not "it did not work" — they are "it worked, and placed
// something other than what the screen said". A ladder that does not add up to the size on
// the ticket, a chase that sits where post-only orders get rejected, a trigger on the side of
// the mark where it can never fire. All of that is arithmetic, so all of it is testable here.
import fs from 'fs'
import {
  ORDER_TYPES, PRO_IDS, TIFS, TWAP, SCALE, CHASE,
  byId, isProType, tickSize, chaseTargetPx, shouldRechase, chaseExceeded,
  scaleLadder, ladderAvgPx, triggerSide, validate, describe,
} from '../../src/protypes.js'

const nl = String.fromCharCode(10)
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e

console.log(nl + '-- the catalogue --')
{
  // Every type HL's own Pro list shows. Missing one is a feature that silently is not there.
  const want = ['market', 'limit', 'chase', 'scale', 'stopLimit', 'stopMarket',
                'takeLimit', 'takeMarket', 'trailingStop', 'twap']
  t('every Hyperliquid order type is listed', want.every(id => !!byId(id)), want.filter(id => !byId(id)))
  t('and in their order', ORDER_TYPES.map(x => x.id).join() === want.join(), ORDER_TYPES.map(x => x.id))
  t('Market and Limit are not behind the Pro button', !isProType('market') && !isProType('limit'))
  t('everything else is', PRO_IDS.length === want.length - 2, PRO_IDS)

  // The copy is what the learn-more modal prints and what the ticket explains itself with.
  // A type with no description is a type nobody can learn from the app.
  for (const x of ORDER_TYPES) {
    t(`${x.id} says what it is`, !!x.doc && !!x.how && !!x.note && typeof x.blurb === 'function')
    t(`${x.id} declares its fields`, Array.isArray(x.fields) && x.fields.length > 0)
  }
  // The four trigger types are the ones that get mixed up. Each must carry the two flags that
  // decide what actually goes to the exchange.
  for (const id of ['stopLimit', 'stopMarket', 'takeLimit', 'takeMarket']) {
    const x = byId(id)
    t(`${id} carries tpsl + isMarket`, (x.trigger?.tpsl === 'sl' || x.trigger?.tpsl === 'tp') && typeof x.trigger?.isMarket === 'boolean')
  }
  t('stops are sl, takes are tp',
    byId('stopLimit').trigger.tpsl === 'sl' && byId('stopMarket').trigger.tpsl === 'sl' &&
    byId('takeLimit').trigger.tpsl === 'tp' && byId('takeMarket').trigger.tpsl === 'tp')
  t('the Market variants are market and the Limit variants are not',
    byId('stopMarket').trigger.isMarket && byId('takeMarket').trigger.isMarket &&
    !byId('stopLimit').trigger.isMarket && !byId('takeLimit').trigger.isMarket)

  t('all three times-in-force are offered', TIFS.map(x => x.id).join() === 'Gtc,Ioc,Alo')
  // Anything that needs something alive to keep behaving has to SAY so — that sentence is
  // the only warning a user gets that closing the tab changes the order's behaviour.
  t('chase admits it runs in the tab', byId('chase').native === false && !!byId('chase').liveness)
  t('trailing stop says where it runs', !!byId('trailingStop').liveness)
  t('twap says it survives the tab', /exchange/i.test(byId('twap').liveness))
}

console.log(nl + '-- price ticks --')
{
  // Same rule trading.js rounds prices to: 5 significant figures, and at most 6 - szDecimals
  // decimals. Chase needs the size of the step, not just the rounding.
  t('a three-figure price ticks in cents', near(tickSize(218.61, 2), 0.01))
  t('a five-figure price ticks in whole dollars', near(tickSize(94213, 5), 1))
  t('a sub-cent price ticks finer', near(tickSize(0.0034441, 0), 1e-6))
  // The decimal cap bites before the significant-figure rule on high-szDecimals markets.
  t('the decimal cap wins when it is tighter', near(tickSize(1.2345, 6), 1))
  t('a missing price still gives a usable tick', tickSize(0, 2) > 0)
}

console.log(nl + '-- where a chase sits --')
{
  // One tick inside the touch: the front of the queue, without crossing it.
  t('a buy improves the bid', near(chaseTargetPx({ isBuy: true, bestBid: 100.00, bestAsk: 100.10, tick: 0.01 }), 100.01))
  t('a sell improves the ask', near(chaseTargetPx({ isBuy: false, bestBid: 100.00, bestAsk: 100.10, tick: 0.01 }), 100.09))

  // The case that breaks naive implementations. With a one-tick spread there is no room
  // inside, and bid + tick IS the ask — a post-only order there is REJECTED, not repriced,
  // so a chase that does this never rests and never fills.
  const b = chaseTargetPx({ isBuy: true,  bestBid: 100.00, bestAsk: 100.01, tick: 0.01 })
  const s = chaseTargetPx({ isBuy: false, bestBid: 100.00, bestAsk: 100.01, tick: 0.01 })
  t('a one-tick spread joins the bid instead of crossing', near(b, 100.00), b)
  t('and joins the ask on the sell side', near(s, 100.01), s)
  t('a buy never reaches the ask', chaseTargetPx({ isBuy: true, bestBid: 9.99, bestAsk: 10.00, tick: 0.01 }) < 10.00)

  // No book, no order. Null rather than zero, so nothing downstream places at the bottom.
  t('an unreadable book gives null', chaseTargetPx({ isBuy: true, bestBid: null, bestAsk: 100, tick: 0.01 }) === null)
  t('and so does a zero tick', chaseTargetPx({ isBuy: true, bestBid: 100, bestAsk: 101, tick: 0 }) === null)
}

console.log(nl + '-- when to re-price --')
{
  t('a full tick away is worth moving', shouldRechase(100.00, 100.01, 0.01))
  // Float noise on a re-derived target must NOT count: a cancel plus an order on every poll
  // is real weight against a budget shared with order placement, for no price improvement.
  t('a rounding wobble is not', !shouldRechase(100.01, 100.01 + 1e-12, 0.01))
  t('being in the right place is not', !shouldRechase(100.01, 100.01, 0.01))
  t('having no order at all is', shouldRechase(null, 100.01, 0.01))

  // The leash. Only movement AGAINST the order counts.
  const tick = 0.01
  t('a buy that has chased 12 ticks up with a 10 limit stops',
    chaseExceeded({ isBuy: true, startPx: 100.00, targetPx: 100.12, tick, maxTicks: 10 }))
  t('a buy whose price came DOWN keeps going',
    !chaseExceeded({ isBuy: true, startPx: 100.00, targetPx: 99.80, tick, maxTicks: 10 }))
  t('a sell that has chased 12 ticks down stops',
    chaseExceeded({ isBuy: false, startPx: 100.00, targetPx: 99.88, tick, maxTicks: 10 }))
  t('no limit means no leash',
    !chaseExceeded({ isBuy: true, startPx: 100, targetPx: 200, tick, maxTicks: 0 }))
}

console.log(nl + '-- the scale ladder --')
{
  const { orders } = scaleLadder({ startPx: 100, endPx: 96, count: 5, totalSz: 10, skew: 1 })
  t('places the number of orders asked for', orders.length === 5)
  t('the first rung is the first price', near(orders[0].px, 100))
  t('the last rung is the last price', near(orders[4].px, 96))
  t('the rungs are evenly spaced', near(orders[1].px, 99) && near(orders[2].px, 98) && near(orders[3].px, 97))

  // THE property. Whatever the skew, the ladder places the size on the ticket — not more.
  // A ladder that quietly placed 1.7x what was typed because a slider moved is the kind of
  // surprise that costs real money.
  for (const skew of [0.2, 0.5, 1, 2, 5, 20]) {
    const r = scaleLadder({ startPx: 100, endPx: 96, count: 7, totalSz: 3.5, skew })
    const sum = r.orders.reduce((a, o) => a + o.sz, 0)
    t(`skew ${skew} still adds up to the size on the ticket`, near(sum, 3.5, 1e-9), sum)
  }

  const flat = scaleLadder({ startPx: 100, endPx: 96, count: 4, totalSz: 8, skew: 1 }).orders
  t('skew 1 is even', flat.every(o => near(o.sz, 2)))
  const far = scaleLadder({ startPx: 100, endPx: 96, count: 2, totalSz: 9, skew: 2 }).orders
  t('skew 2 puts twice as much on the far rung', near(far[1].sz, 2 * far[0].sz), far.map(o => o.sz))
  const near0 = scaleLadder({ startPx: 100, endPx: 96, count: 2, totalSz: 9, skew: 0.5 }).orders
  t('skew below 1 loads the near rung', near0[0].sz > near0[1].sz)

  // Upward ladders are the short side's ladder, and must work identically.
  const up = scaleLadder({ startPx: 96, endPx: 100, count: 3, totalSz: 3, skew: 1 }).orders
  t('a ladder can run upward', near(up[0].px, 96) && near(up[2].px, 100))

  t('the average is size-weighted', near(ladderAvgPx(far), (far[0].px * far[0].sz + far[1].px * far[1].sz) / 9))

  // Never a partial ladder: a half-built ladder is an unbalanced position nobody asked for.
  t('a bad count builds nothing', scaleLadder({ startPx: 100, endPx: 96, count: 1, totalSz: 5 }).orders === null)
  t('too many rungs builds nothing', scaleLadder({ startPx: 100, endPx: 96, count: SCALE.MAX_ORDERS + 1, totalSz: 5 }).orders === null)
  t('a missing price builds nothing', scaleLadder({ startPx: 0, endPx: 96, count: 4, totalSz: 5 }).orders === null)
  t('and each refusal says why', !!scaleLadder({ startPx: 0, endPx: 96, count: 4, totalSz: 5 }).error)
}

console.log(nl + '-- which side of the mark a trigger belongs on --')
{
  // HL infers the direction from tpsl and the side. Get these backwards and the order either
  // fires the instant it is placed or can never fire at all.
  t('a stop BUY fires above',  triggerSide({ tpsl: 'sl', isBuy: true })  === 'above')
  t('a stop SELL fires below', triggerSide({ tpsl: 'sl', isBuy: false }) === 'below')
  t('a take BUY fires below',  triggerSide({ tpsl: 'tp', isBuy: true })  === 'below')
  t('a take SELL fires above', triggerSide({ tpsl: 'tp', isBuy: false }) === 'above')
}

console.log(nl + '-- what the ticket refuses to send --')
{
  const base = { sz: 1, markPx: 100, isBuy: true }
  t('no size, no order', validate('scale', { ...base, sz: 0, scaleStartPx: 99, scaleEndPx: 97, scaleCount: 4 })[0] === 'Enter a size.')

  // A stop buy below the mark has already "triggered" — HL would fill it instantly at market,
  // which is the opposite of what someone setting a breakout entry wants.
  t('a stop buy below the mark is refused', validate('stopMarket', { ...base, triggerPx: 95 }).length > 0)
  t('a stop buy above the mark is fine', validate('stopMarket', { ...base, triggerPx: 105 }).length === 0)
  t('a take buy above the mark is refused', validate('takeMarket', { ...base, triggerPx: 105 }).length > 0)
  t('a take buy below the mark is fine', validate('takeMarket', { ...base, triggerPx: 95 }).length === 0)
  t('a short stop is the mirror', validate('stopMarket', { ...base, isBuy: false, triggerPx: 95 }).length === 0)

  // Empty is not the same as unknown. With no mark we cannot tell which side is right, and
  // refusing the order on that basis would make a rate-limit blip look like a bad ticket.
  t('with no mark the side check is skipped, not failed',
    validate('stopMarket', { sz: 1, isBuy: true, triggerPx: 95, markPx: null }).length === 0)

  t('a stop LIMIT also needs a limit price', validate('stopLimit', { ...base, triggerPx: 105 }).length > 0)
  t('and passes with one', validate('stopLimit', { ...base, triggerPx: 105, limitPx: 105.5 }).length === 0)

  // TWAP's bounds are the exchange's, not ours — sending something outside them is a
  // rejection the user reads as the app being broken.
  t('a TWAP under the minimum is refused', validate('twap', { ...base, sz: 5, twapMinutes: 2 }).length > 0)
  t('a TWAP over the ceiling is refused', validate('twap', { ...base, sz: 5, twapMinutes: TWAP.MAX_MINUTES + 1 }).length > 0)
  t('a TWAP under $100 is refused', validate('twap', { sz: 0.5, markPx: 100, isBuy: true, twapMinutes: 30 }).length > 0)
  t('a normal TWAP passes', validate('twap', { sz: 5, markPx: 100, isBuy: true, twapMinutes: 30 }).length === 0)

  t('the sixth chase is refused', validate('chase', { ...base, activeChases: CHASE.MAX_ACTIVE }).length > 0)
  t('the fifth is not', validate('chase', { ...base, activeChases: CHASE.MAX_ACTIVE - 1 }).length === 0)

  t('a trailing stop with no position is refused', validate('trailingStop', { hasPosition: false }).length > 0)
  t('and allowed with one', validate('trailingStop', { hasPosition: true }).length === 0)
  t('a trailing stop on spot is refused', validate('trailingStop', { hasPosition: true, isSpot: true }).length > 0)
}

console.log(nl + '-- what the ticket says it will do --')
{
  // The sentence under the button is the last chance to notice the ladder runs the wrong way.
  // It has to be specific enough to check, which means it has to contain the numbers.
  const d = describe('scale', { sz: 10, coin: 'SOL', isBuy: true, scaleStartPx: 100, scaleEndPx: 96, scaleCount: 5, scaleSkew: 1 })
  t('a scale names its ends and its count', /5 limit orders/.test(d) && /\$100/.test(d) && /\$96/.test(d), d)
  t('and its average', /average/i.test(d), d)

  const tw = describe('twap', { sz: 5, coin: 'BTC', isBuy: true, twapMinutes: 30 })
  t('a TWAP names its window and slice count', /30 minutes/.test(tw) && /60 suborders/.test(tw), tw)

  const sm = describe('stopMarket', { sz: 1, coin: 'ETH', isBuy: true, triggerPx: 4200 })
  t('a stop names the trigger and the direction', /\$4200/.test(sm) && /above/.test(sm), sm)

  const ch = describe('chase', { sz: 1, coin: 'HYPE', isBuy: true, chaseMaxTicks: 8 })
  t('a chase names its leash', /8 ticks/.test(ch), ch)
  t('a chase with no leash does not invent one', !/tick/.test(describe('chase', { sz: 1, isBuy: true, chaseMaxTicks: '' })))

  for (const x of ORDER_TYPES) {
    t(`${x.id} describes itself even with an empty form`, typeof describe(x.id, {}) === 'string' && describe(x.id, {}).length > 0)
  }
}

console.log(nl + '-- the wiring, as the source has it --')
{
  const tr = fs.readFileSync('src/trading.js', 'utf8')
  const pt = fs.readFileSync('src/proticket.js', 'utf8')
  const mn = fs.readFileSync('src/main.js', 'utf8')
  const ix = fs.readFileSync('index.html', 'utf8')

  // A scale is one signed batch, not a loop. A loop can place four rungs of six and then hit
  // a rejection, which leaves a lopsided position nobody asked for.
  t('the ladder goes out as one batch', /placeScaleOrders[\s\S]{0,600}orders:\s*rungs\.map/.test(tr))
  t('and placeOrdersRaw can carry more than one order', /orders:\s*orders\.map\(o =>/.test(tr))

  // A trigger MARKET order still needs a limit price through the trigger, or it rests
  // instead of filling.
  t('a trigger market carries slippage headroom', /isMarket[\s\S]{0,200}trig \* 1\.03/.test(tr))

  // The TWAP action nests under `twap`; twapCancel does not. Getting this wrong is a
  // signature over the wrong payload.
  t('twapOrder nests its params', /twapOrder\(\{\s*[\s\S]{0,40}twap: \{/.test(tr))
  t('paper mode refuses a TWAP rather than faking one', /isPaper\(\)\) throw new Error\('TWAP/.test(tr))

  // The chase poll must go through the METERED transport, or it spends the shared IP budget
  // invisibly — and the budget is shared with order placement.
  t('the chase reads the book through api.js', /from '\.\/api\.js'/.test(pt) && /bestBidAsk/.test(pt))
  t('bestBidAsk lives where the transport is metered', /export async function bestBidAsk/.test(fs.readFileSync('src/api.js', 'utf8')))
  t('an unreadable book stops the chase repricing', /if \(!bestBid \|\| !bestAsk\) return/.test(pt))

  // Both shells, one renderer and one submit path — the "second copy" trap in CLAUDE.md.
  t('both tickets mount the same field renderer',
    /mountProFields\(document\.getElementById\('proFieldsDesk'\)\)/.test(mn) &&
    /mountProFields\(document\.getElementById\('proFieldsMob'\)\)/.test(mn))
  t('both containers exist', /id="proFieldsDesk"/.test(ix) && /id="proFieldsMob"/.test(mn))
  // One definition, and one call from each ticket — not a branch copied into both.
  t('there is exactly one Pro submit', (mn.match(/window\.__proSubmit = /g) ?? []).length === 1)
  t('and both tickets call it', (mn.match(/window\.__proSubmit\(statusEl/g) ?? []).length === 2)
  t('the desktop ticket has a Pro tab', /id="otype-pro"/.test(ix))
  t('the mobile ticket has one too', /id="mobTradeOrderTypePro"/.test(mn))

  // Picking a plain tab has to leave Pro mode, or the submit button means one thing and the
  // highlighted tab says another.
  t('the plain tabs clear Pro mode', (mn.match(/\n\s*clearPro\(\)/g) ?? []).length >= 2)

  // Flipping the paper flag under a running chase would have it cancel a real order and
  // replace it with a simulated one.
  t('paper mode stops running chases', (mn.match(/stopAllChases\(\)/g) ?? []).length >= 2)

  // The module must not be able to reach state — that is what makes the __all_accounts__
  // mistake impossible inside it.
  t('proticket.js cannot see state', !/\bstate\./.test(pt.replace(/^.*\*.*$/gm, '')))
  t('protypes.js touches no DOM', !/document\.|window\./.test(fs.readFileSync('src/protypes.js', 'utf8')))

  // A horizontally scrolling element without this loses its scrolling to a global rule.
  t('the learn-more type list is drag-scrollable', /data-dragscroll/.test(fs.readFileSync('src/prolearn.js', 'utf8')))
}

console.log(nl + `${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
