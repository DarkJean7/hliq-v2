// Trailing stop arithmetic.
//
// Hyperliquid has no trailing-stop order type, so this is something that WATCHES: remember
// the best price since the stop went live, and get out when price gives back more than you
// agreed to. All the ways that can be wrong are arithmetic, so all of them are testable here
// without a browser or an exchange.
//
// The one-way ratchet is the mechanism. A long's stop rises with the high-water mark and can
// never fall, so the worst case is fixed the moment it is set — and any bug that lets `best`
// move the wrong way turns a stop-loss into a slowly widening hole.
import fs from 'fs'
import {
  sideOf, retraceDistance, stopPrice, advance, isTriggered,
  shouldMoveStop, resolveSize, validate, describe, MIN_STOP_MOVE,
} from '../../src/trailstop.js'

const nl = String.fromCharCode(10)
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e

console.log(nl + '-- which way the position points --')
{
  t('positive size is long', sideOf('20.19') === 'long')
  t('negative is short', sideOf('-20.19') === 'short')
  // Flat is not a case that reaches here, but it must not throw or read as short by accident.
  t('flat does not read as short', sideOf('0') === 'long')
}

console.log(nl + '-- the retracement distance --')
{
  // Percent is of the BEST price, not of entry. "Retraces 5% from the high" is what it says;
  // taking it off entry would make the trailing distance drift as the trade moved.
  t('percent is of the best price', near(retraceDistance(100, 5, '%'), 5))
  t('and follows the best price up', near(retraceDistance(200, 5, '%'), 10))
  t('dollars are a flat distance', near(retraceDistance(200, 5, '$'), 5))
  t('nothing sensible gives null, not zero', retraceDistance(100, 0, '%') === null && retraceDistance(100, 'x', '%') === null)
}

console.log(nl + '-- where the stop sits --')
{
  t('a long trails below', near(stopPrice('long', 100, 5, '%'), 95))
  t('a short trails above', near(stopPrice('short', 100, 5, '%'), 105))
  t('in dollars too', near(stopPrice('long', 91.348, 1.5, '$'), 89.848))
  // A retracement wider than the price would put the stop at or below zero. Null, so nothing
  // downstream can place an order against it.
  t('a stop that cannot exist is null', stopPrice('long', 100, 150, '%') === null)
  t('and so is one with no price to work from', stopPrice('long', 0, 5, '%') === null)
}

console.log(nl + '-- the ratchet only turns one way --')
{
  let s = { active: true, best: 100 }
  s = advance(s, 110, { side: 'long' })
  t('a new high moves it', s.best === 110 && s.moved === true)
  s = advance(s, 105, { side: 'long' })
  t('a pullback does not', s.best === 110 && s.moved === false)
  s = advance(s, 111, { side: 'long' })
  t('a higher high does', s.best === 111 && s.moved === true)

  // The whole safety property: after any sequence, a long's stop is monotonically rising.
  let st = { active: true, best: 100 }
  let prevStop = stopPrice('long', st.best, 5, '%')
  for (const m of [101, 99, 104, 97, 108, 103, 120, 90]) {
    st = advance(st, m, { side: 'long' })
    const now = stopPrice('long', st.best, 5, '%')
    if (now < prevStop - 1e-9) { t('the stop never moves against a long', false, `${prevStop} -> ${now}`); break }
    prevStop = now
  }
  t('the stop never moves against a long', prevStop >= stopPrice('long', 100, 5, '%'))

  let sh = { active: true, best: 100 }
  sh = advance(sh, 90, { side: 'short' })
  t('a short ratchets downward', sh.best === 90 && sh.moved === true)
  sh = advance(sh, 95, { side: 'short' })
  t('and ignores a bounce', sh.best === 90 && sh.moved === false)

  // Junk ticks must not poison the high-water mark.
  const poisoned = advance({ active: true, best: 110 }, 'nonsense', { side: 'long' })
  t('an unreadable mark changes nothing', poisoned.best === 110 && poisoned.moved === false)
  t('nor does a zero', advance({ active: true, best: 110 }, 0, { side: 'long' }).best === 110)
}

console.log(nl + '-- activation holds it back until the level is reached --')
{
  // Recording highs before activation would arm the stop against a price the trade never
  // reached in profit — which is the opposite of what an activation price is for.
  let s = advance({}, 95, { side: 'long', activationPx: 100 })
  t('below the activation price nothing starts', s.active === false && s.best === undefined)
  s = advance(s, 99.9, { side: 'long', activationPx: 100 })
  t('still nothing, just short of it', s.active === false)
  s = advance(s, 100, { side: 'long', activationPx: 100 })
  t('reaching it activates', s.active === true)
  t('and that tick is the first high-water mark', s.best === 100)
  s = advance(s, 98, { side: 'long', activationPx: 100 })
  t('after which it behaves normally', s.active === true && s.best === 100)

  // A short activates from above.
  let sh = advance({}, 105, { side: 'short', activationPx: 100 })
  t('a short waits for the price to fall to it', sh.active === false)
  sh = advance(sh, 100, { side: 'short', activationPx: 100 })
  t('and activates there', sh.active === true && sh.best === 100)

  // No activation price means start now.
  t('without one it is live immediately', advance({}, 50, { side: 'long' }).active === true)
  t('and an unparseable one does not strand it', advance({}, 50, { side: 'long', activationPx: 'x' }).active === true)
}

console.log(nl + '-- and the trigger --')
{
  t('a long fires at or below the stop', isTriggered('long', 95, 95) && isTriggered('long', 94, 95))
  t('not above it', !isTriggered('long', 96, 95))
  t('a short fires at or above', isTriggered('short', 105, 105) && isTriggered('short', 106, 105))
  t('not below', !isTriggered('short', 104, 105))
  t('and never on a missing number', !isTriggered('long', NaN, 95) && !isTriggered('long', 95, undefined))
}

console.log(nl + '-- moving the resting order costs two requests, so it is batched --')
{
  t('with nothing resting, place one', shouldMoveStop('long', null, 95) === true)
  // Every move is a cancel and a place, out of the same rate budget order placement needs.
  t('a trivial improvement is not worth it', shouldMoveStop('long', 95, 95 * (1 + MIN_STOP_MOVE / 2)) === false)
  t('a real one is', shouldMoveStop('long', 95, 95 * (1 + MIN_STOP_MOVE * 2)) === true)
  // The important one: a stop that moved backwards is a trailing stop that gives back more
  // than it promised. Refused outright, not merely rate-limited.
  t('a long stop never moves down', shouldMoveStop('long', 95, 90) === false)
  t('a short stop never moves up', shouldMoveStop('short', 105, 110) === false)
  t('a short stop does move down', shouldMoveStop('short', 105, 105 * (1 - MIN_STOP_MOVE * 2)) === true)
}

console.log(nl + '-- how much it closes --')
{
  t('a percentage of the position', near(resolveSize(20.19, { pct: 50 }), 10.095))
  t('all of it', near(resolveSize(20.19, { pct: 100 }), 20.19))
  t('an absolute size wins over the percentage', near(resolveSize(20.19, { pct: 50, size: 5 }), 5))
  // A stop for more than is held would be rejected by the exchange — and one set when the
  // position was bigger must not keep trying to sell size closed by hand since.
  t('never more than is held', near(resolveSize(20.19, { size: 999 }), 20.19))
  t('a short is sized by magnitude', near(resolveSize(-20.19, { pct: 100 }), 20.19))
  t('nothing held closes nothing', resolveSize(0, { pct: 100 }) === 0)
  t('and neither does a nonsense size', resolveSize(20, { pct: 0 }) === 0)
}

console.log(nl + '-- the form explains itself before it is submitted --')
{
  const ok = { side: 'long', positionSz: 20.19, amount: 5, unit: '%', pct: 100, markPx: 90.839 }
  t('a complete form has nothing to say', validate(ok).length === 0, JSON.stringify(validate(ok)))
  t('no position', validate({ ...ok, positionSz: 0 }).some(e => /no open position/i.test(e)))
  t('no retracement', validate({ ...ok, amount: 0 }).some(e => /enter a retracement/i.test(e)))
  // 100% off the high is a stop at zero: it can never trigger, which is worse than useless
  // because it looks set.
  t('a 100% retracement is refused', validate({ ...ok, amount: 100 }).some(e => /never trigger/i.test(e)))
  t('a dollar retracement wider than the price is too',
    validate({ ...ok, amount: 500, unit: '$' }).some(e => /wider than the price/i.test(e)))
  t('no size', validate({ ...ok, pct: 0 }).some(e => /size to close/i.test(e)))
  // An activation price already behind the market starts instantly, which is not what
  // somebody setting one means.
  t('an activation price already passed is called out',
    validate({ ...ok, activationPx: 80 }).some(e => /already below/i.test(e)))
  t('and the short case too',
    validate({ ...ok, side: 'short', activationPx: 99 }).some(e => /already above/i.test(e)))
  t('a good activation price is fine', validate({ ...ok, activationPx: 95 }).length === 0)
}

console.log(nl + '-- and says what it will do --')
{
  const d = describe({ side: 'long', amount: 5, unit: '%', markPx: 100 })
  t('it names the amount', /5%/.test(d))
  t('and which extreme it trails from', /highest/.test(d))
  t('and roughly where that puts the stop', /95/.test(d))
  t('a short trails the lowest', /lowest/.test(describe({ side: 'short', amount: 5, unit: '%', markPx: 100 })))
  // Before a retracement is entered the sentence still has to read, with a blank where the
  // number will go — the modal shows it from the moment it opens.
  t('an empty form still reads', /retraces by -- from/.test(describe({ side: 'long', markPx: 100 })))
  t('an activation price is mentioned when set', /Once the mark reaches/.test(describe({ side: 'long', amount: 5, markPx: 100, activationPx: 110 })))
}

console.log(nl + '-- the watcher runs where a stop has to run --')
{
  // A stop that only works while a browser tab is open is not a stop.
  t('there is a server-side strategy', fs.existsSync('strategies/trailstop.js'))
  const bot = fs.readFileSync('strategies/trailstop.js', 'utf8')
  t('it reads the exchange as the source of truth', bot.includes('clearinghouseState'))
  t('and persists the high-water mark, so a restart does not forget it', bot.includes('STATE_FILE'))
  // Resting the order beats holding the intention: if the process dies, an order is still
  // there and a memory is not.
  t('it rests the stop on the exchange', bot.includes('placeTriggerOrder') || bot.includes("trigger:"))
  t('and only ratchets it in the favourable direction', bot.includes('shouldMoveStop'))
  t('it honours the shared pause switch, like every other bot', bot.includes('isPaused'))
  const srv = fs.readFileSync('server.js', 'utf8')
  t('the server knows how to launch it', srv.includes("trailstop: 'strategies/trailstop.js'"))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
