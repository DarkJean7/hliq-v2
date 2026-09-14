// What a leaderboard row shows about someone's open positions.
//
// Asked for: "add more data like besides size we can include the value in $. also liq price,
// margin, etc." The table had Coin / Side / Size / Entry / PnL, and size alone does not say how
// big a position is — 0.0073 ETH and 132.3 ARB are the same sentence in different units, and
// neither tells you what is at stake.
//
// The interesting part is not the extra columns, it is that every figure comes from the
// SERVER'S cached snapshot, which is a projection of Hyperliquid's position object. Anything
// the projection does not carry has to be handled rather than assumed — and margin is exactly
// that case: it is added to the projection by this change, so rows cached before it shipped
// have none, and a dash there would read as "no margin" on a live position.
import fs from 'fs'

const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const SRV = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')

const grab = (src, sig) => {
  const start = src.indexOf(sig)
  if (start < 0) throw new Error('not found: ' + sig)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error('unbalanced: ' + sig)
}

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

// The real renderer, with the app's formatters stubbed to something legible.
const render = new Function(`
  const esc = (s) => String(s)
  const coinLabel = (c) => String(c).replace(/.*:/, '')
  const fmtUSD = (v) => Number(v).toFixed(2)
  const fmtPrice = (v) => String(Number(v))
  const fmtSize = (v) => String(Number(v))
  ${grab(CLI, 'function _lbPosHtml(positions)')}
  return _lbPosHtml`)()

const pos = (o) => ({ position: {
  coin: o.coin, szi: o.szi, entryPx: o.entry ?? '100',
  positionValue: o.value, unrealizedPnl: o.pnl ?? '0',
  liquidationPx: o.liq, returnOnEquity: o.roe ?? '0',
  leverage: o.lev == null ? undefined : { value: o.lev, type: o.iso ? 'isolated' : 'cross' },
  ...(o.margin == null ? {} : { marginUsed: o.margin }) } })
/** The cells of row `i`, tags stripped. */
const cells = (html, i = 0) => {
  const rows = html.split('<tr>').slice(2)          // [0] is the head row
  const tr = rows[i] ?? ''
  return tr.split('</td>').slice(0, -1).map(td => td.replace(/<[^>]*>/g, '').trim())
}

console.log(nl + '-- the columns someone asked for are there --')
{
  const html = render([pos({ coin: 'ETH', szi: '-0.0073', value: '18.27', liq: '4210.5',
                             lev: 10, margin: '1.83', pnl: '-0.04', roe: '-0.021' })])
  const head = [...html.matchAll(/<th>([^<]*)<\/th>/g)].map(m => m[1].trim())
  t('value, liquidation, leverage and margin joined the row',
    ['Value', 'Liq.', 'Lev.', 'Margin'].every(h => head.includes(h)), head)
  t('and the original five are still there',
    ['Coin', 'Side', 'Size', 'Entry', 'PnL'].every(h => head.includes(h)), head)
  // The Accounts tab shows exactly this set for your own wallets. Two tables of the same thing
  // that disagree about which columns matter is a worse answer than either.
  t('it matches what the Accounts tab already showed', head.length === 10, head)

  const c = cells(html)
  t('the value is money, not a size', c[3] === '$18.27', c)
  t('the liquidation price is there', c[5] === '$4210.5', c)
  t('so is the leverage', c[6] === '10x', c)
  t('and the margin the account actually posted', c[7] === '$1.83', c)
  t('a short still reads as a short', c[1] === 'SHORT' && c[2] === '0.0073', c)
  t('and the ROE is a percentage', c[9] === '-2.10%', c)
}

console.log(nl + '-- margin, when the snapshot does not carry it --')
{
  // Rows cached before marginUsed was added to the projection. A dash would read as "no
  // margin" on a live position, so it is inferred from the leverage — and marked, because an
  // inference presented as the account's own number is a small lie that compounds.
  const legacy = render([pos({ coin: 'SKHX', szi: '-0.014', value: '18.09', liq: '2400', lev: 3 })])
  const c = cells(legacy)
  t('it is estimated from value over leverage', c[7] === '≈$6.03', c)
  t('and marked as an estimate, not passed off as fact', legacy.includes('Estimated from value'))

  // Nothing to infer from either: say nothing rather than invent a number.
  const bare = render([pos({ coin: 'ABC', szi: '1', value: '0', liq: '0' })])
  t('with no leverage and no value it is a dash', cells(bare)[7] === '—', cells(bare))
  t('a real zero margin is still printed as a number',
    cells(render([pos({ coin: 'ABC', szi: '1', value: '5', lev: 2, margin: '0' })]))[7] === '$0.00')
}

console.log(nl + '-- and the other figures are honest about being missing --')
{
  const none = render([pos({ coin: 'ABC', szi: '2', value: '0', liq: '0', lev: 0 })])
  const c = cells(none)
  // "$0.00" for an unknown value and "$0" for an unknown liquidation price are both claims.
  t('an absent value is a dash, not $0.00', c[3] === '—', c)
  t('an absent liquidation price is a dash', c[5] === '—', c)
  t('and absent leverage too', c[6] === '—', c)
}
{
  // Isolated changes what the liquidation price MEANS: only that margin stands behind it.
  const iso = render([pos({ coin: 'INJ', szi: '3.1', value: '18.32', liq: '3.11', lev: 5,
                            margin: '3.66', iso: true })])
  t('an isolated position says so', /5x\s*<span[^>]*>iso/.test(iso), iso.slice(0, 200))
  const cross = render([pos({ coin: 'INJ', szi: '3.1', value: '18.32', liq: '3.11', lev: 5, margin: '3.66' })])
  t('a cross one does not', !cross.includes('iso'))
}
{
  t('an empty list still says so', render([]).includes('No open positions'))
}

console.log(nl + '-- ten columns do not fit every window, so the TABLE scrolls --')
{
  const html = render([pos({ coin: 'ETH', szi: '1', value: '1', liq: '1', lev: 1, margin: '1' })])
  t('the table sits in its own scroller', html.includes('<div class="lb-pos-wrap"'))
  // A global rule strips scrolling from anything that does not declare it — this has made
  // content unreachable three times.
  t('which declares itself scrollable', html.includes('data-dragscroll'))
  const CSS = fs.readFileSync('src/style.css', 'utf8')
  t('the scroller really scrolls', /\.lb-pos-wrap \{[^}]*overflow-x: auto/.test(CSS))
  t('the table keeps a width worth scrolling to', /\.lb-pos-wrap \.lb-pos-table \{[^}]*min-width/.test(CSS))
  t('and cells do not wrap into unreadable stacks', /\.lb-pos-table td, \.lb-pos-table th \{[^}]*white-space: nowrap/.test(CSS))
}

console.log(nl + '-- the server sends what the table needs --')
{
  // The projection is deliberate: it is what a cached row carries, and the client can only
  // draw what is in it.
  const proj = SRV.slice(SRV.indexOf('const positions = rawPos.map(ap => ({'))
  t('margin is in the projection now', /marginUsed: ap\.position\.marginUsed/.test(proj.slice(0, 900)))
  t('alongside value, liquidation and leverage',
    ['positionValue', 'liquidationPx', 'leverage', 'returnOnEquity'].every(f => proj.slice(0, 900).includes(f)))
  t('why margin is not just value over leverage is written down',
    SRV.includes('an isolated position') && SRV.includes('carries whatever was added to it'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
