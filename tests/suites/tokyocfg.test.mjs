// The shipped tokyo preset, driven through its Settings field.
//
// This one runs the file rather than reading it. A preset is the only bot whose source we
// ship, so its behaviour is ours to keep: someone taps Add, and whatever this file does is
// what the app did. Asserting on the source would have caught none of the bugs below.
//
// The cases that matter are the ones where being wrong is silent — a market that quietly
// keeps its old hours, a stop that reopens the trade it just closed, a fixed margin that
// gets divided by fifteen.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

const SRC = fs.readFileSync('src/bots/tokyo-partners.js', 'utf8')
const FIXED = Date.UTC(2026, 8, 3, 0, 41)           // 20:41 America/New_York
const ALL = ['ZEC', 'CASHCAT', 'xyz:SMSN', 'xyz:SKHX', 'LIT', 'XMR', 'xyz:SNDK', 'xyz:EWY',
             'xyz:MU', 'NEAR', 'xyz:DRAM', 'PUMP', 'xyz:INTC', 'xyz:SPCX', 'xyz:SOXL']

// A fresh scope per case. The file keeps state on purpose — the tp/sl re-entry lock and
// the say-it-once warnings — so one shared instance would leak it between cases.
function load() {
  const lines = []
  const log = (...a) => lines.push(a.join(' '))
  const api = { exchange: async () => ({}), info: async () => ({ universe: [] }) }
  const onTick = new Function('api', 'log',
    SRC + ';return typeof onTick === "function" ? onTick : null')(api, log)
  return { onTick, lines }
}
const ctxOf = (over = {}) => ({
  coin: 'ZEC', coins: ALL, tick: FIXED, equity: 5000, paper: true,
  marks: Object.fromEntries(ALL.map((c, i) => [c, 100 + i])),
  mids: {}, positions: [], orders: [], candles: [],
  config: { coin: 'ZEC', coins: ALL, maxUsd: 1e9, maxPerMin: 20, maxOpen: 20,
            everySec: 30, leverage: 3, dry: true, params: {} },
  ...over,
})
const run = (params, over = {}) => {
  const { onTick, lines } = load()
  const c = ctxOf(over); c.config.params = params
  const out = onTick(c)
  return { intents: Array.isArray(out) ? out : out ? [out] : [], lines, said: lines.join(' | ') }
}
const held = (coin, szi, entryPx) => [{
  coin, szi, entryPx, unrealizedPnl: 0, leverage: 3, liquidationPx: 0, marginUsed: 33,
}]

console.log(nl + '-- the file loads and still does what it always did --')
t('it defines onTick', !!load().onTick)
{
  const r = run({})
  t('with no settings it still moves all fifteen', r.intents.length === 15, String(r.intents.length))
  t('and still sizes from riesgo, not from a new default',
    r.intents[0].usd === 30, String(r.intents[0].usd))
}

console.log(nl + '-- activos and horarios pair up by index --')
{
  const r = run({
    activos:  'ZEC | XMR | xyz:SPCX',
    horarios: '20:00-21:00, 21:00-20:00 | 01:00-02:00, 02:00-01:00 | 20:30-23:00, 23:00-20:30',
  })
  const by = Object.fromEntries(r.intents.map(i => [i.coin, i.isBuy]))
  t('the list DEFINES the portfolio, it does not add to it',
    r.intents.length === 3, JSON.stringify(Object.keys(by)))
  t('market 1 gets hours 1 — long inside 20:00-21:00', by.ZEC === true)
  t('market 2 gets hours 2 — short, outside 01:00-02:00', by.XMR === false)
  t('market 3 gets hours 3 — long inside 20:30-23:00', by['xyz:SPCX'] === true)
  t('a dex-prefixed market is matched on its bare name', 'xyz:SPCX' in by)
}
{
  // The whole point of index pairing is that a shift is invisible, so it must not shift.
  const r = run({ activos: 'ZEC | XMR | NEAR', horarios: '20:00-21:00, 21:00-20:00' })
  t('lists of different lengths pair NOTHING', r.intents.length === 0, String(r.intents.length))
  t('and the counts are both named', /activos tiene 3 y horarios tiene 1/.test(r.said))
  t('and it says nothing will run until it is fixed', /NO se opera nada/.test(r.said))
  t('why partial pairing is refused is in the file',
    SRC.includes('el octavo mercado acaba') || SRC.includes('el mercado numero ocho'))
}
t('unreadable hours name the entry AND the market it belonged to',
  /horarios #1 .* para ZEC/.test(run({ activos: 'ZEC', horarios: 'nope' }).said))
t('one list without the other is refused by name',
  /falta horarios/.test(run({ activos: 'ZEC' }).said) &&
  /falta activos/.test(run({ horarios: '01:00-02:00, 02:00-01:00' }).said))
t('a per-market window still wins over the list, being more specific',
  run({ activos: 'ZEC', horarios: '01:00-02:00, 02:00-01:00',
        'ventana.ZEC': '20:00-21:00, 21:00-20:00' }).intents[0]?.isBuy === true)

console.log(nl + '-- margin, and leverage per market --')
t('a fixed margin is margin x leverage', run({ margen: 50 }).intents.every(i => i.usd === 150))
t('and is NOT divided between the markets',
  run({ margen: 50 }).intents.length === 15)
t('leverage multiplies it', run({ margen: 50, apalancamiento: 10 }).intents.every(i => i.usd === 500))
{
  const r = run({ margen: 50, apalancamiento: 3, 'apalancamiento.ZEC': 10 })
  t('one market can carry its own leverage',
    r.intents.find(i => i.coin === 'ZEC').usd === 500 &&
    r.intents.find(i => i.coin === 'XMR').usd === 150)
}
{
  const r = run({ margen: 20, 'margen.ZEC': 100, apalancamiento: 2 })
  t('and its own margin',
    r.intents.find(i => i.coin === 'ZEC').usd === 200 &&
    r.intents.find(i => i.coin === 'XMR').usd === 40)
}
t('riesgo still applies when no margin is set',
  run({ riesgo: 0.06 }).intents[0].usd === 60, String(run({ riesgo: 0.06 }).intents[0].usd))

console.log(nl + '-- tp and sl are price moves, measured on the right side --')
t('off by default: no position is closed for price',
  !run({}, { positions: held('ZEC', 1, 100), marks: { ZEC: 200 } })
    .intents.some(i => i.coin === 'ZEC' && i.type === 'close'))
t('a long below its tp is left alone',
  !run({ tp: 2 }, { positions: held('ZEC', 1, 100), marks: { ZEC: 101 } })
    .intents.some(i => i.coin === 'ZEC' && i.type === 'close'))
t('a long takes profit when price RISES',
  run({ tp: 2 }, { positions: held('ZEC', 1, 100), marks: { ZEC: 103 } })
    .intents.find(i => i.coin === 'ZEC')?.type === 'close')
// CASHCAT, not XMR: at 20:41 XMR is in its LONG window, so a short there is closed to
// turn it over and the assertion would pass without tp ever being consulted. CASHCAT is
// short 19:00-07:00, so the position and the window agree and only tp/sl can move it.
t('a short takes profit when price FALLS',
  run({ tp: 2 }, { positions: held('CASHCAT', -1, 100), marks: { CASHCAT: 97 } })
    .intents.find(i => i.coin === 'CASHCAT')?.type === 'close')
t('a short is NOT stopped out by the move that pays it',
  run({ sl: 2 }, { positions: held('CASHCAT', -1, 100), marks: { CASHCAT: 97 } })
    .intents.find(i => i.coin === 'CASHCAT') === undefined)
t('and IS stopped out by the move against it',
  run({ sl: 2 }, { positions: held('CASHCAT', -1, 100), marks: { CASHCAT: 103 } })
    .intents.find(i => i.coin === 'CASHCAT')?.type === 'close')
t('the log names TP or SL and the move',
  /ZEC TP 3\.00%/.test(run({ tp: 2 }, { positions: held('ZEC', 1, 100), marks: { ZEC: 103 } }).said))
t('a per-market tp overrides the general one',
  !run({ tp: 2, 'tp.ZEC': 10 }, { positions: held('ZEC', 1, 100), marks: { ZEC: 103 } })
    .intents.some(i => i.coin === 'ZEC' && i.type === 'close'))
t('a missing price is said, not treated as no move',
  /no puedo medir tp\/sl/.test(
    run({ tp: 2 }, { positions: held('ZEC', 1, 100), marks: {}, mids: {} }).said))

console.log(nl + '-- and a stop does not reopen what it just closed --')
{
  const { onTick } = load()
  const tick = (marks, positions, at) => {
    const c = ctxOf({ marks: { ...Object.fromEntries(ALL.map((x, i) => [x, 100 + i])), ...marks }, positions })
    if (at) c.tick = at
    c.config.params = { sl: 2 }
    return onTick(c) ?? []
  }
  t('it stops out', tick({ ZEC: 97 }, held('ZEC', 1, 100)).some(i => i.coin === 'ZEC' && i.type === 'close'))
  t('the next tick does NOT re-enter, though the window is still open',
    !tick({ ZEC: 97 }, []).some(i => i.coin === 'ZEC'))
  t('nor the one after that', !tick({ ZEC: 97 }, []).some(i => i.coin === 'ZEC'))
  // 22:00 NY: ZEC's long window (07:00-21:00) has closed, its short has opened.
  t('but it trades again once the window turns over',
    tick({ ZEC: 97 }, [], Date.UTC(2026, 8, 3, 2, 0))
      .some(i => i.coin === 'ZEC' && i.type === 'market' && i.isBuy === false))
  t('why the lock exists is written down, not just the rule',
    SRC.includes('manera cara de pagar comisiones'))
}

console.log(nl + '-- the file tells its reader all of this --')
for (const [what, needle] of [
  ['the paired lists', 'activos  = ZEC | XMR | xyz:SPCX'],
  ['that the lists define the portfolio', 'DEFINE la cartera'],
  ['tp and sl', 'tp = 2'],
  ['that they are price moves, not return on margin', 'MOVIMIENTO DEL PRECIO'],
  ['the no-reopen rule', 'NO se vuelve a entrar'],
  ['fixed margin', 'margen = 50'],
  ['per-market leverage', 'apalancamiento.ZEC = 5'],
]) t('the header documents ' + what, SRC.includes(needle))


console.log(nl + '-- and the card offers them without opening the file --')
// The Settings box existed and read as empty, which to the person looking at it is the
// same thing as missing. It now arrives pre-filled and entirely commented out, so every
// knob is on screen and using one means deleting a #.
const PRESET = fs.readFileSync('src/botpresets.js', 'utf8')
const seedM = PRESET.match(/params: \[([\s\S]*?)\]\.join/)
t('the preset seeds the Settings box', !!seedM)
const seed = seedM ? seedM[1] : ''
for (const knob of ['activos', 'horarios', 'tp =', 'sl =', 'margen =', 'riesgo =', 'apalancamiento.ZEC']) {
  t('the seed offers ' + knob.replace(' =', ''), seed.includes(knob), seed.slice(0, 90))
}
const seedLines = seed.split(nl).map(l => l.trim()).filter(l => l.startsWith("'"))
t('every seeded line is commented out', seedLines.length > 0 && seedLines.every(l => l.startsWith("'#")),
  seedLines.find(l => !l.startsWith("'#")) ?? '')
// Proof, not assertion: the real parser must read nothing out of it, or adding the bot
// would quietly configure it.
const { parseBotParams } = await import('../../src/devicebot.js')
const parsed = parseBotParams(seedLines.map(l => l.replace(/^'|',?$/g, '')).join(nl))
t('so the parser reads nothing out of it', Object.keys(parsed).length === 0, JSON.stringify(parsed))
t('and the box is tall enough to show it',
  /id="devBotParams" rows="([7-9]|[1-9][0-9])"/.test(fs.readFileSync('src/main.js', 'utf8')))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
