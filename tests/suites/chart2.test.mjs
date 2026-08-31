// The spot-card crash, the spot pairing bug it exposed, and the interactive charts.
import fs from 'fs'
import { computeSpot } from '../../src/ecosystem.js'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  let p = s.indexOf('(', i), pd = 0, k = p
  for (; k < s.length; k++) { if (s[k] === '(') pd++; else if (s[k] === ')') { pd--; if (!pd) break } }
  let j = s.indexOf('{', k), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

console.log('\n── spotMetaAndAssetCtxs is NOT index-parallel ──')
// This is what broke the card: the ctxs array is keyed by c.coin, and zipping it to
// universe by index attributed one market's price and supply to another.
const meta = { universe: [
  { name: 'PURR/USDC', index: 0, tokens: [1, 0] },
  { name: '@107',      index: 107, tokens: [150, 0] },
  { name: '@142',      index: 142, tokens: [200, 0] },
] }
// Deliberately out of order, and carrying a market not in the universe.
const ctxs = [
  { coin: '@142', dayNtlVlm: '46500000', markPx: '78987', prevDayPx: '77000', circulatingSupply: '21000000' },
  { coin: 'PURR/USDC', dayNtlVlm: '19100000', markPx: '0.1475', prevDayPx: '0.15', circulatingSupply: '600000000' },
  { coin: '@107', dayNtlVlm: '120500000', markPx: '80.8', prevDayPx: '80', circulatingSupply: '298000000' },
  { coin: '@999', dayNtlVlm: '5', markPx: '1', prevDayPx: '1', circulatingSupply: '1' },
]
const sp = computeSpot([meta, ctxs])
const by = (c) => sp.top.find(r => r.coin === c)
t('each market keeps its OWN price', by('@107').mark === 80.8 && by('@142').mark === 78987)
t('and its own supply-derived cap', Math.round(by('@107').marketCap / 1e6) === Math.round(298000000 * 80.8 / 1e6))
t('the biggest by volume ranks first, with ITS volume', sp.top[0].coin === '@107' && sp.top[0].vol === 120500000)
t('order in the response does not shuffle the pairing', by('PURR/USDC').mark === 0.1475)
t('a ctx for a market not in the universe is skipped, not mispaired', !sp.top.some(r => r.coin === '@999'))
t('but its volume still counts toward the exchange total', sp.vol === 46500000 + 19100000 + 120500000 + 5)
t('24h change comes from that market\'s own prevDayPx',
  Math.abs(by('@107').chg - ((80.8 / 80 - 1) * 100)) < 1e-9)
t('a market with no previous price reports no change rather than -100%',
  computeSpot([meta, [{ coin: '@107', dayNtlVlm: '1', markPx: '5', prevDayPx: '0' }]]).top[0].chg === null)
t('rows are flagged as spot', sp.top.every(r => r.spot === true))

console.log('\n── a spot row has no perp fields, and must not invent them ──')
t('no open interest', by('@107').oi === undefined)
t('no funding', by('@107').apr === undefined)
t('no premium', by('@107').premium === undefined)
const card = grab(cli, 'function _pulseCardHtml(r, id)')
t('the card prints a dash for what does not exist', card.includes("const dash = '—'"))
t('rather than a zero, which would claim the market is flat', card.includes("oi == null ? dash"))
t('funding too', card.includes('apr == null ? dash'))
t('and premium', card.includes('prem == null ? dash'))
t('every numeric field is guarded before .toFixed', card.includes('const num = (v) => Number.isFinite(v) ? v : null'))
t('OI/volume needs both to exist', card.includes('oi != null && num(r.vol) > 0'))
t('a spot row still shows the cap it genuinely has', card.includes('num(r.marketCap) ?? _mktCapByName[r.coin]'))

console.log('\n── a broken card must never freeze the tab ──')
// The failure the user hit: the template threw, innerHTML was never assigned, the row
// stayed marked expanded, and every later render threw too — so taps did nothing.
const rend = grab(cli, 'function _pulseRender(el)')
t('rendering is wrapped', rend.includes('try { _pulseRenderInner(el) } catch'))
t('and a failure collapses the cards rather than leaving one wedged open',
  rend.includes('_mobVExpandedIds.clear()'))
t('then repaints, so the tab stays usable', rend.includes('try { _pulseRenderInner(el) } catch { el.innerHTML'))
t('the reason is recorded, not swallowed silently', rend.includes("console.warn('[pulse render]'"))

console.log('\n── the timeframe row, reflowed ──')
t('three per row, so 3M sits with 1y and All',
  card.includes('rows.slice(0, 3).map(tfCell)') && card.includes('rows.slice(3).map(tfCell)'))
t('the percentages ARE the chart control — no second widget to fall out of sync',
  card.includes('window.__pulseSetTf('))
t('the selected window is highlighted', card.includes('_pulseTfFor[id] ?? PULSE_TF_DEFAULT'))
// '30D' never matched the label '30d', so the default was highlighted nowhere and only
// worked through the find() fallback.
t('and the default matches a real label exactly', cli.includes("const PULSE_TF_DEFAULT = '30d'"))
t('two open cards keep separate windows', cli.includes('const _pulseTfFor = {}') && card.includes('_pulseTfFor[id]'))

console.log('\n── the interactive chart ──')
const ic = grab(cli, 'function _pulseInteractiveChart(pts, ')
t('it is one component, used by all three charts',
  (cli.match(/_pulseInteractiveChart\(/g) ?? []).length >= 4)
t('under two points there is nothing to draw', ic.includes('if (clean.length < 2)'))
t('non-numeric points are dropped before scaling', ic.includes('Number.isFinite(+p[0]) && Number.isFinite(+p[1])'))
t('it renders a date at each end of the window', ic.includes('_pulseDateLabel(x0, span)') && ic.includes('_pulseDateLabel(x1, span)'))
t('vertical scrolling still works over the chart', ic.includes('touch-action:pan-y'))
t('the fee chart keeps its band — a single line would invent the maker/taker mix',
  ic.includes('polygon points='))

const scrub = grab(cli, 'window.__pulseScrub = function(ev, key)')
t('dragging reports the value under the finger', scrub.includes("document.getElementById('rdv-' + key)"))
t('and the date it belongs to', scrub.includes("document.getElementById('rdt-' + key)"))
t('it picks the NEAREST point, so the label does not lag the finger',
  scrub.includes('let best = d.pts[0], bestD = Infinity'))
t('a hover with no button held is ignored', scrub.includes("if (ev.type === 'pointermove' && !ev.buttons) return"))
t('the position is clamped to the chart', scrub.includes('Math.min(1, Math.max(0,'))
t('a zero-width box cannot divide by zero', scrub.includes('if (!box.width) return'))
const end = grab(cli, 'window.__pulseScrubEnd = function(key)')
t('letting go hides the crosshair', end.includes("setAttribute('opacity', '0')"))
t('and restores the latest value', end.includes('d.pts[d.pts.length - 1]'))

console.log('\n── date labels ──')
const dl = new Function('span', `
  const d0 = ${Date.UTC(2026, 7, 24)}
  ${grab(cli, 'function _pulseDateLabel(ts, span)')}
  return (ts) => _pulseDateLabel(ts, span)`)
const D = 86400e3
t('inside a day it shows the time, not the date', /\d/.test(dl(D)(Date.now())) && !/2026/.test(dl(D)(Date.now())))
t('inside a year it shows day and month', /\w{3}/.test(dl(30 * D)(Date.UTC(2026, 7, 24))))
t('past a year it shows the YEAR — the request', dl(400 * D)(Date.UTC(2025, 0, 15)).includes('2025'))
t('a missing timestamp yields nothing rather than "Invalid Date"', dl(D)(0) === '' && dl(D)(NaN) === '')

console.log('\n── the market-cap alias ──')
// BTC's spot market is the Unit-wrapped UBTC; without the alias a BTC perp card found
// no cap and printed a dash where $1.66T belongs.
t('the cap map applies the same alias the rest of the app uses',
  grab(cli, 'async function _pulseEnsureCaps()').includes('_spotDisplayAlias(tok.name)'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
