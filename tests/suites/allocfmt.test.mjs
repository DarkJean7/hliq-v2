// Money in the allocation donut looks like money, and a position says how much coin it is.
//
// fmtUSD returns "342.04" — the dollar sign is the caller's job, and in this panel several
// callers had forgotten it. A bare 342.04 next to a bare 8.5% gives the reader nothing to
// tell a dollar amount from a share, in the one view whose whole job is splitting an
// account into parts.
//
// The token amount is the other half: margin and position value are both dollars, so
// nothing on the row said how much of the coin was actually held.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

const region = (sig, end) => {
  const i = cli.indexOf(sig); if (i < 0) return ''
  const j = cli.indexOf(end, i)
  return j < 0 ? cli.slice(i) : cli.slice(i, j)
}
const slices = region('function _allocationSlices()', 'let _allocSlices =')
const hover  = region('window.__allocHover = function(i)', 'window.__allocLeave')
const render = region('function _mobVRenderAllocation(el)', 'function _allocViewHeader')

console.log(nl + '-- the panel is where we think it is --')
t('the slice builder is there', slices.length > 500, String(slices.length))
t('the hover readout is there', hover.length > 500, String(hover.length))
t('the renderer is there', render.length > 2000, String(render.length))
// The centre says what the ring adds up to and nothing it has no room for.
t('the centre carries the total and the asset count',
  render.includes("_prv('$' + fmtUSD(total, 2))") && render.includes('asset${assetCount === 1'))
t('and no longer tries to fit the four-way split into it', !render.includes("part(used, 'in positions'"))

console.log(nl + '-- fmtUSD has no dollar sign of its own --')
// The premise of the whole suite. If this ever changes, every '$' + fmtUSD below becomes
// a double sign and this test should be the thing that says so.
const fmt = fs.readFileSync('src/format.js', 'utf8')
t('fmtUSD returns digits only', !/return[^\n]*'\$'/.test(fmt.slice(fmt.indexOf('export function fmtUSD'), fmt.indexOf('export function fmtPrice'))))

console.log(nl + '-- every dollar figure in the donut carries a $ --')
// Each of these is a number the reader has to be able to tell from a percentage.
for (const [what, needle] of [
  ['the total in the centre',        "_prv('$' + fmtUSD(total, 2))"],
  // The four-way split used to be spelled out in the centre. At five lines it outgrew the
  // hole — "$2,776.04 in orders" wrapped and the last line ran under the ring — and the inner
  // asset ring made the hole smaller still. The figures live on the four cards below now,
  // each with its share, so the assertion follows them there rather than being deleted.
  ['the total position value',       "_prv('$' + fmtUSD(totalNotional))"],
  // The ring is four money buckets now, not one arc per coin, so a "slice" is a bucket and
  // the coins are the rows that open underneath it. Same rule, new names.
  ['a hovered bucket\'s total',      "_prv('$' + fmtUSD(g.value, 2))"],
  ['each asset named in the centre', "_prv('$' + fmtUSD(it.margin))"],
  ['the bucket card\'s total',       "_prv('$' + fmtUSD(g.value, 2))"],
  ['an asset row\'s figure',         "_prv('$' + fmtUSD(it.margin, 2))"],
  ['a position row\'s value',        "Value ${_prv('$' + fmtUSD(it.notional, 2))}"],
  ['an order row\'s notional',       "${_T('Notional', 'Nocional')} ${_prv('$' + fmtUSD(it.notional, 2))}"],
]) t(what + ' has one', cli.includes(needle))
t('and so does an asset row\'s PnL', /\$\{it\.uPnl >= 0 \? '\+' : '-'\}\$\$\{fmtUSD/.test(cli))

// The bug was bare fmtUSD calls, so assert none are left in the rendered strings.
const bare = [...render.matchAll(/\$\{_prv\(fmtUSD\(/g)].length +
             [...hover.matchAll(/\$\{_prv\(fmtUSD\(/g)].length
t('no dollar figure is left bare', bare === 0, String(bare))

console.log(nl + '-- and every position says how much coin it is --')
t('the slice carries a token size', slices.includes('cur.size     += Math.abs(sz)'))
t('the size is initialised with the rest', /coin: key, margin: 0, notional: 0, size: 0/.test(slices))
t('the unattributed order row has one too, so the shape does not vary',
  /coin: 'USDC', unattributed: true[\s\S]{0,160}size: 0/.test(slices))
t('there is one place that formats it', cli.includes('function _allocSizeTxt(s)'))
t('it uses the app\'s own size formatter, not a new one',
  /function _allocSizeTxt[\s\S]{0,240}fmtSize\(s\.size\)/.test(cli))
t('and the market\'s display name', /function _allocSizeTxt[\s\S]{0,240}_ocCoinLabel\(s\.coin\)/.test(cli))
// The centre now describes a BUCKET, which has no single coin to count — it names the
// biggest few assets in it by dollars instead. The token amount belongs on the asset row.
t('a position row carries its token amount', render.includes('const szTxt = _allocSizeTxt(it)'))
t('and so does a spot row', render.includes('${_prv(_allocSizeTxt(it))}'))
t('a row with no size renders no empty separator',
  render.includes("szTxt ? _prv(szTxt) : ''") && render.includes(".filter(Boolean).join(' · ')"))

console.log(nl + '-- the two judgement calls are written down --')
t('why the size is gross and not net', slices.includes('GROSS, like notional above'))
t('and that the row already shows the direction', slices.includes('"1L / 5S"'))
t('why cash has no token line', cli.includes('the same number twice'))
t('the size is hidden under privacy mode like every other figure',
  render.includes('_prv(szTxt)') && render.includes('_prv(_allocSizeTxt(it))'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
