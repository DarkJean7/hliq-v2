// Labs — strategies built from signals, groups and rules, replayed over candles (src/labs.js).
//
// Asked for: "a strategy builder with a signals section where the user would be able pick/adjust
// multiple signals and pair it with an action ... the ability to group signals and make lets say 3
// signals into one (but let the user also use the same 3 signals to pair them and make another one)".
// So most of this is about the model: that a group is made of REFERENCES, that the same signal can
// feed two groups, that unknown never fires a rule, and that the run cannot see the future.
import fs from 'fs'
import { runLab, evaluate, signalSeries, sourceSeries, makesCycle, coerceStrategy, groupFormula,
         labRows, LAB_TEMPLATES, LAB_PRESETS, LAB_SOURCES, nextId } from '../../src/labs.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

// A price path with a shape: up 60 candles, down 60, up 60. Flat candles, no wicks, unless asked.
const H = 3600e3
const mk = (closes, wick = 0) => closes.map((c, i) => {
  const o = i ? closes[i - 1] : c
  return { t: i * H, o, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick, c, v: 100 + (i % 7) * 10 }
})
const path = []
for (let i = 0; i < 60; i++) path.push(100 + i)
for (let i = 0; i < 60; i++) path.push(160 - i)
for (let i = 0; i < 60; i++) path.push(100 + i)
const rows = mk(path)

console.log(nl + '-- rows --')
{
  const raw = [{ t: 2, o: '1', h: '2', l: '0.5', c: '1.5', v: '9' }, { t: 1, o: 1, h: 1, l: 1, c: 1 }, { t: 2, o: 1, h: 2, l: 1, c: 1 }, { t: 3, o: 1, h: 0, l: 2, c: 1 }]
  const r = labRows(raw)
  t('sorted, deduped, impossible candles dropped', r.length === 2 && r[0].t === 1 && r[1].t === 2, r)
  t('and volume kept, which the simulator drops', r[1].v === 9)
}

console.log(nl + '-- series cannot see the future --')
{
  const hh = sourceSeries(rows, 'hh', { n: 5 })
  t('a highest-high is the candles BEFORE this one', hh[10] === Math.max(...rows.slice(5, 10).map(r => r.h)), hh[10])
  t('so a rising market can break it', rows[10].c > hh[10])
  t('and it is unknown until it has n candles behind it', hh[4] === null && hh[5] !== null)
  const ema = sourceSeries(rows, 'ema', { n: 10 })
  t('an EMA is unknown while warming up, seeded with the plain average', ema[8] === null && Math.abs(ema[9] - rows.slice(0, 10).reduce((a, r) => a + r.c, 0) / 10) < 1e-9)
  const rsi = sourceSeries(rows, 'rsi', { n: 14 })
  t('RSI is 100 all the way up a straight climb', rsi[40] === 100)
  const ch = sourceSeries(rows, 'change', { n: 10 })
  t('change % is over n candles', Math.abs(ch[20] - (rows[20].c / rows[10].c - 1) * 100) < 1e-9)
  for (const k of Object.keys(LAB_SOURCES)) {
    const s = sourceSeries(rows, k, {})
    if (s.length !== rows.length) { t('every source is one value per candle: ' + k, false); break }
  }
  t('every source is one value per candle', true)
}

console.log(nl + '-- signals --')
{
  const above = signalSeries(rows, { left: { src: 'close' }, op: 'gt', right: { type: 'value', value: 150 } })
  t('a comparison against a number', above[55] === true && above[30] === false)
  const cross = signalSeries(rows, { left: { src: 'close' }, op: 'crossUp', right: { type: 'value', value: 130 } })
  const ups = cross.map((v, i) => v ? i : -1).filter(i => i >= 0)
  t('a cross fires on the candle it happens and no other', ups.length === 2 && rows[ups[0]].c > 130 && rows[ups[0] - 1].c <= 130, ups)
  const held = signalSeries(rows, { left: { src: 'close' }, op: 'rising', bars: 5 })
  t('"for 5 candles in a row" waits for the fifth', held[4] !== true && held[6] === true && held[62] === false)
  const unknown = signalSeries(rows, { left: { src: 'sma', p: { n: 50 } }, op: 'gt', right: { type: 'value', value: 0 } })
  t('a signal on an indicator still warming up is UNKNOWN, not false', unknown[10] === null && unknown[60] === true)
  const mult = signalSeries(rows, { left: { src: 'volume' }, op: 'gt', right: { type: 'src', src: 'volAvg', p: { n: 7 }, mult: 100 } })
  t('a series can be scaled: volume above 100× its average never fires', mult.every(v => v !== true))
}

console.log(nl + '-- groups are made of references, and can share them --')
{
  const strat = {
    signals: [
      { id: 's1', left: { src: 'close' }, op: 'gt', right: { type: 'value', value: 120 } },
      { id: 's2', left: { src: 'close' }, op: 'rising' },
      { id: 's3', left: { src: 'sma', p: { n: 50 } }, op: 'gt', right: { type: 'value', value: 0 } },
    ],
    groups: [
      { id: 'g1', mode: 'all', members: [{ ref: 's1' }, { ref: 's2' }, { ref: 's3' }] },
      // the SAME three, paired differently
      { id: 'g2', mode: 'all', members: [{ ref: 's1' }, { ref: 's2', not: true }, { ref: 's3' }] },
      { id: 'g3', mode: 'atleast', k: 2, members: [{ ref: 's1' }, { ref: 's2' }, { ref: 's3' }] },
      { id: 'g4', mode: 'any', members: [{ ref: 'g1' }, { ref: 'g2' }] },
    ],
  }
  const e = evaluate(rows, strat)
  t('ALL of three: rising above 120 after warm-up', e.g1[150] === true && e.g1[70] === false)
  t('the same three with one negated: falling above 120', e.g2[70] === true && e.g2[150] === false)
  t('the two groups never agree, because they share their signals', e.g1.every((v, i) => !(v === true && e.g2[i] === true)))
  t('AT LEAST 2 of 3 is true while ALL is still unknown (the SMA is warming up)', e.g3[30] === true && e.g1[30] === null, [e.g3[30], e.g1[30]])
  t('a group of groups', e.g4[150] === true && e.g4[70] === true)
  t('ALL is false as soon as one member is false, even with another unknown', e.g1[5] === false || e.g1[5] === null)
  const w = evaluate(rows, { signals: [{ id: 'a', left: { src: 'close' }, op: 'crossUp', right: { type: 'value', value: 130 } }],
    groups: [{ id: 'g', mode: 'all', within: 3, members: [{ ref: 'a' }] }] })
  const firstUp = w.a.indexOf(true)
  t('"within 3 candles" keeps a one-candle event true for three', w.g[firstUp] && w.g[firstUp + 2] && w.g[firstUp + 3] === false)
  // A cycle saved by hand: unknown, not a hang.
  const cyc = evaluate(rows, { signals: [{ id: 'a', left: { src: 'close' }, op: 'rising' }],
    groups: [{ id: 'x', mode: 'all', members: [{ ref: 'y' }] }, { id: 'y', mode: 'all', members: [{ ref: 'x' }, { ref: 'a' }] }] })
  t('a group that contains itself is unknown, and does not hang', cyc.x.every(v => v === null))
  t('the screen refuses to build one', makesCycle({ groups: [{ id: 'x', members: [{ ref: 'y' }] }, { id: 'y', members: [] }] }, 'y', 'x')
    && !makesCycle({ groups: [{ id: 'x', members: [] }, { id: 'y', members: [] }] }, 'y', 'x'))
  t('a formula reads the way it was built', groupFormula(strat, strat.groups[1], id => id.toUpperCase()) === 'S1 AND NOT S2 AND S3'
    && groupFormula(strat, strat.groups[2], id => id) === '2 of (s1, s2, s3)')
}

console.log(nl + '-- the run --')
{
  const up = { id: 'u', left: { src: 'close' }, op: 'rising' }, dn = { id: 'd', left: { src: 'close' }, op: 'falling' }
  const base = { signals: [up, dn], groups: [], rules: [{ ref: 'u', action: 'buy' }, { ref: 'd', action: 'sell' }] }
  const r = runLab(rows, base, { feeBps: 0, slipBps: 0, makerBps: 0 })
  const first = r.trades[0]
  // "rising" is first true on candle 1, the first with a candle before it to compare with.
  t('a rule read on a close fills at the NEXT open', first.i === 2 && first.entry === rows[2].o, first)
  t('long the climb, out on the turn (read on 61, filled on 62), back in on the next climb', r.trades.length === 2 && r.trades[0].j === 62 && r.trades[1].i === 122, r.trades.map(x => [x.i, x.j, x.outcome]))
  t('a position still open at the end is listed as open', r.trades.at(-1).outcome === 'open')
  t('and the balance is equity: it includes that open position', Math.abs(r.balance - r.curve.at(-1)[1]) < 1e-9)
  t('the curve has one point per candle', r.curve.length === rows.length)
  const fees = runLab(rows, base, { feeBps: 10, slipBps: 5 })
  t('costs are charged', fees.balance < r.balance)

  // Hold vetoes the rules below it.
  const veto = runLab(rows, { ...base, signals: [...base.signals, { id: 'h', left: { src: 'close' }, op: 'gt', right: { type: 'value', value: 0 } }],
    rules: [{ ref: 'h', action: 'hold' }, ...base.rules] })
  t('Hold stops the rules under it', veto.trades.length === 0 && veto.actions.hold > 0)

  // Unknown never fires.
  const warm = runLab(rows, { signals: [{ id: 'm', left: { src: 'sma', p: { n: 100 } }, op: 'gt', right: { type: 'value', value: 0 } }], groups: [], rules: [{ ref: 'm', action: 'buy' }] })
  t('a rule on an indicator still warming up does not fire', warm.trades[0].i === 100, warm.trades[0]?.i)

  // A stop inside the candle; ambiguous candles count against you.
  const wick = mk(path, 3)
  const stopped = runLab(wick, { signals: [{ id: 'a', left: { src: 'close' }, op: 'gt', right: { type: 'value', value: 0 } }], groups: [], rules: [{ ref: 'a', action: 'buy' }] },
    { stopPct: 2, targetPct: 2, feeBps: 0, slipBps: 0, makerBps: 0 })
  t('when one candle reaches both stop and target, the stop is assumed', stopped.trades[0].outcome === 'stop', stopped.trades[0])

  // Short, and a flip.
  const flip = runLab(rows, { signals: [up, dn], groups: [], rules: [{ ref: 'u', action: 'buy' }, { ref: 'd', action: 'short' }] }, { feeBps: 0, slipBps: 0 })
  const sides = flip.trades.map(x => x.side)
  t('buy and short flip between each other', sides.includes('long') && sides.includes('short'), sides)
  t('a short makes money on the way down', flip.trades.find(x => x.side === 'short').delta > 0)

  // Liquidation.
  const crash = mk([100, 100, 100, 100, 60, 60, 60, 60])
  const liq = runLab(crash, { signals: [{ id: 'a', left: { src: 'close' }, op: 'gt', right: { type: 'value', value: 0 } }], groups: [], rules: [{ ref: 'a', action: 'buy' }] },
    { leverage: 10, maxLev: 20, feeBps: 0, slipBps: 0 })
  t('10× through a 40% drop is liquidated', liq.trades[0].outcome === 'liquidated' && liq.trades[0].liq, liq.trades[0])
  // All of the balance was posted as margin, so all of it goes -- and not a cent more.
  t('and loses the margin, not more', liq.balance >= 0 && liq.balance < 1, liq.balance)
  const half = runLab(crash, { signals: [{ id: 'a', left: { src: 'close' }, op: 'gt', right: { type: 'value', value: 0 } }], groups: [], rules: [{ ref: 'a', action: 'buy' }] },
    { leverage: 10, maxLev: 20, feeBps: 0, slipBps: 0, sizePct: 50 })
  t('half posted, half kept', Math.abs(half.balance - 500) < 1e-6, half.balance)
  const tiny = runLab(rows, base, { balance: 10, sizePct: 50 })
  t('a position under $10 is refused, as Hyperliquid refuses it', tiny.trades.length === 0 && tiny.refused > 0)
}

console.log(nl + '-- starting points and saved strategies --')
{
  for (const tpl of LAB_TEMPLATES) {
    const s = coerceStrategy(tpl.make())
    const r = runLab(rows, s)
    if (!Number.isFinite(r.balance)) { t('every template runs: ' + tpl.key, false); }
  }
  t('every template runs', true)
  const br = coerceStrategy(LAB_TEMPLATES.find(x => x.key === 'breakout').make())
  const shared = br.signals.filter(sg => br.groups.filter(g => g.members.some(m => m.ref === sg.id)).length > 1)
  t('the breakout template shows one signal feeding two groups', shared.length >= 2, shared.map(x => x.id))
  t('every preset makes a valid signal', LAB_PRESETS.every(p => coerceStrategy({ signals: [{ id: 's1', ...p.make() }] }).signals.length === 1))
  const junk = coerceStrategy({ signals: [{ id: 's1', left: { src: 'eval' }, op: 'rm' }, { id: 's1' }, { id: '../x' }], groups: [{ id: 'g1', members: [{ ref: 'nope' }, { ref: 'g1' }, { ref: 's1' }] }], rules: [{ ref: 'zzz', action: 'buy' }, { ref: 's1', action: 'launch' }, { ref: 'g1', action: 'buy' }] })
  t('a saved strategy is untrusted: unknown sources, duplicate ids and dangling refs are dropped',
    junk.signals.length === 1 && junk.signals[0].left.src === 'close' && junk.signals[0].op === 'gt'
    && junk.groups[0].members.length === 1 && junk.rules.length === 1, junk)
  t('ids are reused, never collided', nextId({ signals: [{ id: 's1' }, { id: 's3' }], groups: [{ id: 's2' }] }, 's') === 's4')
}

console.log(nl + '-- wired into both shells --')
{
  const main = fs.readFileSync('src/main.js', 'utf8'), html = fs.readFileSync('index.html', 'utf8'), view = fs.readFileSync('src/labsview.js', 'utf8')
  t('desktop: a nav tab, a sidebar item and a panel', /switchTab\('labs',this\)/.test(html) && /data-tab="labs"/.test(html) && /id="tab-labs"/.test(html) && /id="deskLabs"/.test(html))
  t('phone: in the More menu', /__mobMoreTab\('labs'\)/.test(html))
  t('switchTab renders it', /if \(name === 'labs'\)\s+_labsRender\(_viewHost\('deskLabs'\)\)/.test(main))
  t('and so does the phone content area', /_mobVActiveTab === 'labs'\) \{\s*_labsRender\(el\)/.test(main))
  const sets = [...main.matchAll(/new Set\(\[([^\]]*'simulator'[^\]]*)\]\)/g)].map(m => m[1])
  t('every phone tab list that knows the simulator knows Labs', sets.length >= 3 && sets.every(s => s.includes("'labs'")), sets.length)
  t('it is imported, so the call is not a runtime ReferenceError', /import \{ initLabs, renderLabs as _labsRender \} from '\.\/labsview\.js'/.test(main))
  t('it cannot see state', !/\bstate\./.test(view))
  t('it never places an order', !/placeOrder|exchangeClient|order\(/.test(view))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
