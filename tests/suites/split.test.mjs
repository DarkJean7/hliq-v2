// Per-wallet chart lines in All Accounts, driven against REAL Hyperliquid portfolio history.
import fs from 'fs'
import { computeCompare, assignCompareColors, compareChartSvg, compareLegendHtml }
  from 'file:///C:/Users/jeank/OneDrive/Desktop/hliq-v2/src/compare.js'

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

// ── the extractor, run against real rows ─────────────────────────────────────
const ADDRS = [
  '0x974E086b541AFc90ACaF9AC5D3326D666A601e6B',
  '0xAB333c752402fF3F753AB9Eab657e86547a69B79',
  '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159',
]
const post = (b) => fetch('https://api.hyperliquid.xyz/info', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}).then(r => r.json())

const rows = []
for (const addr of ADDRS) {
  const portfolio = await post({ type: 'portfolio', user: addr }).catch(() => null)
  rows.push({ addr, error: null, label: '', portfolio })
}
t('real portfolio history fetched for every wallet', rows.every(r => Array.isArray(r.portfolio)))

const mkExtract = (period, type) => new Function('_allAcctLastResults', `
  const _mobVPortPeriod = '${period}'
  const _mobVPortChartType = '${type}'
  const _maHiddenLoad = () => new Set()
  ${grab(cli, 'function _splitSeriesByWallet(period = _mobVPortPeriod)')}
  return _splitSeriesByWallet('${period}')
`)(rows)

let { byWallet, labels } = mkExtract('allTime', 'value')
t('one series per wallet', labels.length === 3, JSON.stringify(labels))
t('each is candle-shaped for computeCompare',
  labels.every(l => byWallet[l].length > 1 && 't' in byWallet[l][0] && 'c' in byWallet[l][0]))
t('labels fall back to a short address when unlabelled', labels.every(l => /…/.test(l)))

const d = computeCompare(byWallet, labels)
t('every wallet becomes a plotted series', d.series.length === 3, String(d.series.length))
t('normalised to percent, so a small wallet is not a flat line at the bottom',
  d.series.every(s => Math.abs(s.pts[0].v) < 1e-9))
t('they share one axis — that shared scale IS the comparison',
  d.series.every(s => s.pts.every(p => p.v >= d.min - 1e-6 && p.v <= d.max + 1e-6)))
t('best performer is first', d.series[0].change >= d.series[d.series.length - 1].change)

const colors = assignCompareColors(d.series.map(s => s.coin))
t('every wallet gets a distinct colour',
  new Set(Object.values(colors)).size === d.series.length, JSON.stringify(colors))

const svg = compareChartSvg(d, { width: 320, height: 150, colors })
t('an SVG is produced', svg.includes('<svg') && svg.includes('cmp-svg'))
t('with one path per wallet', (svg.match(/<path/g) ?? []).length >= 3)
t('the legend names them', d.series.every(s => compareLegendHtml(d, { colors }).includes(s.coin)))

// ── the awkward inputs ───────────────────────────────────────────────────────
const one = (over) => new Function('_allAcctLastResults', `
  const _mobVPortPeriod = 'allTime'
  const _mobVPortChartType = 'value'
  const _maHiddenLoad = () => new Set(${JSON.stringify([...(over.hidden ?? [])])})
  ${grab(cli, 'function _splitSeriesByWallet(period = _mobVPortPeriod)')}
  return _splitSeriesByWallet('allTime')
`)(over.rows)

t('an errored wallet is skipped, not plotted as a flat zero',
  one({ rows: [{ addr: '0x' + '1'.repeat(40), error: 'boom', portfolio: rows[0].portfolio }] }).labels.length === 0)
t('a hidden wallet is skipped', one({ rows, hidden: rows.map(r => r.addr) }).labels.length === 0)
t('a wallet with under two points is skipped',
  one({ rows: [{ addr: '0x' + '2'.repeat(40), error: null, portfolio: [['allTime', { accountValueHistory: [[1, '5']] }]] }] }).labels.length === 0)

// Two wallets sharing a label would collide in a map keyed by it.
const dupRows = [
  { addr: '0xaaaa000000000000000000000000000000000001', error: null, label: 'Main', portfolio: rows[0].portfolio },
  { addr: '0xbbbb000000000000000000000000000000000002', error: null, label: 'Main', portfolio: rows[1].portfolio },
]
const dup = one({ rows: dupRows })
t('two wallets with the same label stay separate series', dup.labels.length === 2, JSON.stringify(dup.labels))

// Percent needs a non-zero base; a wallet funded mid-period starts at 0.
const zero = computeCompare({ z: [{ t: 1, c: 0 }, { t: 2, c: 50 }] }, ['z'])
t('a series starting at zero is dropped rather than plotted as infinity', zero.series.length === 0)

// ── wiring ───────────────────────────────────────────────────────────────────
t('the toggle exists', cli.includes('window.mobVTogglePortSplit'))
t('it only appears in All Accounts', cli.includes('${state.isAllAccounts ? `<div style="padding:8px 16px 0">'))
t('split takes over before the canvas is touched',
  grab(cli, 'function _mobVDrawPortChart()').includes('if (_mobVPortSplit && state.isAllAccounts) { _mobVDrawPortSplit(); return }'))
t('the canvas is hidden while split is on', cli.includes("display:${_mobVPortSplit && state.isAllAccounts ? 'none' : 'block'}"))
t('scrubbing is detached before a redraw, so handlers do not stack',
  grab(cli, 'function _mobVDrawPortSplit()').includes('_mobVSplitDetach?.()'))
// These moved into the shared renderer when Advanced started using it too.
t('an empty period says so rather than drawing nothing',
  grab(cli, 'function _renderSplitInto(host, { period, width, height, heroEl })').includes('No per-wallet history'))
t('it reuses the Watch comparison module rather than a second chart path',
  !cli.includes('function _splitChartSvg')
    && grab(cli, 'function _renderSplitInto(host, { period, width, height, heroEl })').includes('compareChartSvg('))

const shared = grab(cli, 'function _renderSplitInto(host, { period, width, height, heroEl })')
t('the summary colours by sign, not by rank — last of three winners is still a gain',
  shared.includes("const tone = (x) => x.change >= 0 ? 'var(--green)' : 'var(--red)'"))
t('and says "lowest" rather than "worst" for it', shared.includes("_T('lowest'"))

// ── dollars beside the percentage ────────────────────────────────────────────
const mkSub = (type) => new Function('fmtUSD', '_mobVPortChartType', `
  ${grab(cli, 'function _splitUsdSub(s)')}
  return _splitUsdSub
`)((n) => Number(n).toFixed(2), type)
const usdSub = mkSub('value')

// The reported confusion: "+$13.28" beside a wallet the cards list at $105.16 was read as
// the wallet being worth $13. The value has to lead, with the change marked as a change.
t('the VALUE leads, so it reconciles with the account cards',
  usdSub({ base: 91.88, last: 105.16 }).startsWith('$105.16'), usdSub({ base: 91.88, last: 105.16 }))
t('and the change is bracketed, not bare',
  usdSub({ base: 91.88, last: 105.16 }) === '$105.16 (+$13.28)', usdSub({ base: 91.88, last: 105.16 }))
t('a loss is signed', usdSub({ base: 100, last: 60 }) === '$60.00 (−$40.00)')
t('on the PnL charts last is a cumulative PnL, not a value — only the change is shown',
  mkSub('pnl')({ base: 10, last: 60 }) === '+$50.00')
t('a series with no usable numbers is left blank rather than showing NaN', mkSub('value')({}) === '')
t('the legend is asked for it', shared.includes('sub: _splitUsdSub'))
t('but only here — the asset comparison keeps percent only, where a price move per unit is meaningless',
  fs.readFileSync('src/compare.js', 'utf8').includes('sub = null'))

// The dollar figure is what the percentage cannot tell you.
const big = { base: 10000, last: 12500, change: 25 }
const small = { base: 100, last: 1091, change: 991 }
const gain = (x) => parseFloat((mkSub('pnl')(x)).replace(/[^0-9.]/g, ''))
t('+991% on a small wallet is visibly less money than +25% on a large one',
  gain(small) < gain(big))

// ── Advanced mode ────────────────────────────────────────────────────────────
t('Advanced has the toggle too', cli.includes('window.advToggleSplit'))
t('it is the SAME setting, not a second one', grab(cli, 'window.advToggleSplit = function()').includes('_mobVPortSplit = !_mobVPortSplit'))
t('and it keeps the inline chart in step',
  grab(cli, 'window.advToggleSplit = function()').includes('_mobVRenderContent()'))
t('split renders before the _adv.data guard, or the overlay would stay blank',
  grab(cli, 'function _advDraw()').indexOf('_advDrawSplit(); return') < grab(cli, 'function _advDraw()').indexOf('if (!canvas || !d) return'))
t('the canvas is hidden behind it, not left dead underneath',
  grab(cli, 'function _advDrawSplit()').includes("wrapEl.style.display = 'none'"))
t('and restored when going back to combined',
  grab(cli, 'function _advDraw()').includes("wrapEl.style.display = ''"))
t('both views share one renderer', shared.length > 0 &&
  grab(cli, 'function _advDrawSplit()').includes('_renderSplitInto(') &&
  grab(cli, 'function _mobVDrawPortSplit()').includes('_renderSplitInto('))
t('Advanced scrubbing is detached before redraw', grab(cli, 'function _advDrawSplit()').includes('_advSplitDetach?.()'))
t('candles and markers are disabled while split — they mean nothing across normalised series',
  grab(cli, 'function _advSyncControls()').includes("for (const id of ['advStyleBtn', 'advMarkersBtn'])"))
t('the hint line says what the chart is now showing',
  grab(cli, 'function _advSyncControls()').includes('% from the start of the period'))
t("Advanced's 1H/8H map onto the finest bucket HL actually has",
  grab(cli, 'function _splitSeriesByWallet(period = _mobVPortPeriod)').includes("'1H': 'day', '8H': 'day'"))

// The 12s value tick patches the portfolio hero with the combined total. In split view the
// hero holds the per-wallet summary and the scrub readout, so that patch erased both.
const lp = grab(cli, 'function _allAcctLightPaint()')
t('the light paint leaves the split hero alone',
  lp.includes('!(_mobVPortSplit && state.isAllAccounts)'))
t('but still patches it in the combined view, which is what it is for',
  lp.includes("_mobVActiveTab === 'portfolio' && _mobVPortChartType === 'value'"))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
