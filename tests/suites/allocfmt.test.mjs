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

console.log(nl + '-- fmtUSD has no dollar sign of its own --')
// The premise of the whole suite. If this ever changes, every '$' + fmtUSD below becomes
// a double sign and this test should be the thing that says so.
const fmt = fs.readFileSync('src/format.js', 'utf8')
t('fmtUSD returns digits only', !/return[^\n]*'\$'/.test(fmt.slice(fmt.indexOf('export function fmtUSD'), fmt.indexOf('export function fmtPrice'))))

console.log(nl + '-- every dollar figure in the donut carries a $ --')
// Each of these is a number the reader has to be able to tell from a percentage.
for (const [what, needle] of [
  ['the total in the centre',        "_prv('$' + fmtUSD(total, 2))"],
  ['the deployed half of the split', "_prv('$' + fmtUSD(used))"],
  ['the free half',                  "_prv('$' + fmtUSD(free))"],
  ['the total position value',       "_prv('$' + fmtUSD(totalNotional))"],
  ['a hovered slice\'s margin',      "_prv('$' + fmtUSD(s.margin, 2))"],
  ['a hovered slice\'s value',       "_prv('$' + fmtUSD(s.notional, 2))"],
  ['a row\'s margin',                "_prv('$' + fmtUSD(s.margin, 2))"],
  ['a row\'s value',                 "Value ${_prv('$' + fmtUSD(s.notional, 2))}"],
]) t(what + ' has one', cli.includes(needle))
t('and so does a row\'s PnL', /\$\{pnl >= 0 \? '\+' : '-'\}\$\$\{fmtUSD/.test(cli))
t('and a hovered slice\'s PnL', hover.includes("'+' : '-'}$${fmtUSD(Math.abs(s.uPnl))}"))

// The bug was bare fmtUSD calls, so assert none are left in the rendered strings.
const bare = [...render.matchAll(/\$\{_prv\(fmtUSD\(/g)].length +
             [...hover.matchAll(/\$\{_prv\(fmtUSD\(/g)].length
t('no dollar figure is left bare', bare === 0, String(bare))

console.log(nl + '-- and every position says how much coin it is --')
t('the slice carries a token size', slices.includes('cur.size     += Math.abs(sz)'))
t('the size is initialised with the rest', /coin: key, margin: 0, notional: 0, size: 0/.test(slices))
t('free margin has one too, so the shape does not vary',
  /coin: 'USDC', isFree: true[\s\S]{0,120}size: 0/.test(slices))
t('there is one place that formats it', cli.includes('function _allocSizeTxt(s)'))
t('it uses the app\'s own size formatter, not a new one',
  /function _allocSizeTxt[\s\S]{0,240}fmtSize\(s\.size\)/.test(cli))
t('and the market\'s display name', /function _allocSizeTxt[\s\S]{0,240}_ocCoinLabel\(s\.coin\)/.test(cli))
t('the hovered slice shows it', hover.includes('_allocSizeTxt(s)'))
t('so does every row', render.includes('const sizeTxt = _allocSizeTxt(s)') &&
  render.includes('${_prv(sizeTxt)}'))
t('a row with no size renders no empty line',
  render.includes("${sizeTxt ? `<div"))

console.log(nl + '-- the two judgement calls are written down --')
t('why the size is gross and not net', slices.includes('GROSS, like notional above'))
t('and that the row already shows the direction', slices.includes('"1L / 5S"'))
t('why free margin has no token line', cli.includes('the same number twice'))
t('the size is hidden under privacy mode like every other figure',
  render.includes('${_prv(sizeTxt)}') && hover.includes('_prv(_allocSizeTxt(s))'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
