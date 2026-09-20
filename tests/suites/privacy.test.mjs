// Privacy mode — does the eye actually cover everything?
//
// "Hide balances" makes one promise: someone glancing at your screen learns nothing about
// how much you have. A single figure left uncovered breaks the whole promise, and it breaks
// it silently — the eye is closed, the icon says private, and the number is right there.
//
// The Spot tab shipped that way: every holding's token amount, USD value and PnL rendered
// in full while privacy was on. The Outcomes tab did too.
//
// Two surfaces mask differently and both are checked here:
//   desktop  CSS — `body.priv` sets -webkit-text-security on the money-bearing selectors,
//                  so a live tick cannot un-mask anything and no re-render is needed
//   mobile   _prv() at render time, because the mobile rows are built as HTML strings
//
// What is masked is the MONEY and the QUANTITY. Market prices are not — a mark price is
// public, and covering it would hide the market rather than the balance.
import fs from 'fs'

const nl = String.fromCharCode(10)
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const main = fs.readFileSync('src/main.js', 'utf8')
const css  = fs.readFileSync('src/style.css', 'utf8')

// Slice out each renderer so an assertion cannot accidentally be satisfied by a masked
// figure somewhere else in a 38,000-line file.
const between = (from, to) => {
  const a = main.indexOf(from)
  const b = main.indexOf(to, a + 1)
  if (a < 0 || b < 0) return ''
  return main.slice(a, b)
}
const spotRow   = between('const renderSpotRow = (b, id) =>', 'const renderOcRow = (b, id) =>')
const ocRow     = between('const renderOcRow = (b, id) =>', 'const renderSpotGroup = (coin, items, id) =>')
const spotGroup = between('const renderSpotGroup = (coin, items, id) =>', "if (_mobVActiveTab === 'spot') {")

console.log(nl + '-- the renderers are where this suite thinks they are --')
{
  t('the Spot row', spotRow.length > 1000, String(spotRow.length))
  t('the Outcome row', ocRow.length > 2000, String(ocRow.length))
  // CLAUDE.md: a renderer usually has a second copy for the combined view. Fixing one and
  // shipping it is how the same report comes in twice.
  t('and the combined view\'s copy of the Spot row', spotGroup.length > 1000, String(spotGroup.length))
}

console.log(nl + '-- the Spot row covers what you hold --')
{
  for (const [what, needle] of [
    ['the token amount',   '${_prv(fmtSize(total))} ${esc(_ocCoinLabel(b.coin))}'],
    ['the USD value',      "${_prv(usd > 0 ? '$' + fmtUSD(usd) : '—')}"],
    ['the PnL and ROI',    '${_prv(`${'],
    ['the cost basis',     "['Cost', _prv('$' + fmtUSD(cost))]"],
    ['the profit',         "['Profit', _prv("],
    ['the ROI row',        "['ROI', _prv("],
    ['what is available',  "['Available', _prv(fmtSize(avail))"],
    ['what is in orders',  "['In Orders', hold > 0 ? _prv(fmtSize(hold))"],
    ['the value row',      "['Value', _prv(usd > 0 ?"],
  ]) t(what + ' is masked', spotRow.includes(needle), needle)

  // ...and does NOT cover the market. A price is public; hiding it hides the market rather
  // than the balance, and the desktop reference row (__ovBuildSpotBody) leaves it alone too.
  t('the live price stays visible', spotRow.includes("px > 0 ? '$' + fmtPrice(px)") && !spotRow.includes('_prv(fmtPrice'))
  t('and so does the average buy price', spotRow.includes("['Avg buy', total > 0 ? '$' + fmtPrice(cost / total)"))
}

console.log(nl + '-- the combined view\'s Spot row covers the same things --')
{
  for (const [what, needle] of [
    ['the summed amount',        '${_prv(fmtSize(total))} · ×${items.length} accounts'],
    ['the single-account amount', '${_prv(fmtSize(total))} ${esc(_ocCoinLabel(coin))}'],
    ['the group value',          "${_prv(usd > 0 ? '$' + fmtUSD(usd) : '—')}"],
    ['each account\'s amount',   '${_prv(fmtSize(t))} ${esc(_ocCoinLabel(coin))}'],
    ['each account\'s free',     '${_prv(fmtSize(av))} free'],
    ['each account\'s value',    "${_prv(u > 0 ? '$' + fmtUSD(u) : '—')}"],
    ['each account\'s held',     '${_prv(fmtSize(hd))} held'],
    ['the cost',                 "['Cost', _prv('$' + fmtUSD(cost))]"],
    ['the value',                "['Value', _prv(usd > 0 ?"],
    ['the profit',               "['Profit', _prv("],
    ['the ROI',                  "['ROI', _prv("],
  ]) t(what + ' is masked', spotGroup.includes(needle), needle)
}

console.log(nl + '-- the Outcomes card covers what you hold --')
{
  for (const [what, needle] of [
    ['the share count',      '${_prv(fmtSize(total))} shares'],
    ['what a win pays',      '${_prv(`+$${fmtUSD(winProfit)} (+${winPct.toFixed(0)}%)`)}'],
    ['the PnL',              'id="ocpnl-${id}"'],
    ['the size row',         "['Size', _prv(fmtSize(total))"],
    ['the position value',   "['Position Value', _prv("],
    ['the cost',             "['Cost', _prv("],
    ['the PnL row',          "['PnL (ROE)', _prv("],
    ['the payout row',       "['If it wins', _prv("],
    ['what is in orders',    "['In Orders', _prv(fmtSize(hold))"],
  ]) t(what + ' is masked', ocRow.includes(needle), needle)

  t('the card PnL and ROE are both masked',
    /id="ocpnl-\$\{id\}"[^>]*>\$\{_prv\(/.test(ocRow) && /id="ocroe-\$\{id\}"[^>]*>\$\{_prv\(/.test(ocRow), 'header figures')
  // Entry and mark are prices, not amounts.
  t('the mark price stays visible', ocRow.includes("['Mark Price', mark > 0 ? (mark * 100).toFixed(2)"))
  t('and the entry price', ocRow.includes("['Entry Price', (entry * 100).toFixed(2)"))

  // The close panel is a FORM, not a readout: its share count is an editable input and the
  // slider mirrors it, so masking the estimate underneath would hide nothing and cost the
  // one figure that says what the slider did. Asserted so nobody "fixes" it by accident.
  t('the close panel is left alone, on purpose', /close panel is deliberately NOT masked/.test(main))
  // ...and is MARKED as such, so the exemption is something a test can find rather than a
  // paragraph of comment the next reader has to take on trust.
  t('and is marked as a form', ocRow.includes('<div data-ocform style='))
}

console.log(nl + '-- a live tick must not un-mask what the render hid --')
{
  // The Outcomes marks are re-polled and written straight into the elements the render
  // masked. Without _prv here the numbers come back a second or two after the eye was shut.
  const tick = between("const mk = document.getElementById('ocmark-' + key)", 'function ')
  t('the ticked PnL is masked', /ocpnl[\s\S]{0,120}_prv\(/.test(tick), tick.slice(0, 200))
  t('the ticked ROE is masked', /ocroe[\s\S]{0,120}_prv\(/.test(tick), tick.slice(0, 200))
  t('but not the ticked mark price', /ocmark[\s\S]{0,90}textContent = \(mark/.test(tick))
}

console.log(nl + '-- the desktop surfaces --')
{
  // The desktop Spot TAB is a plain table and was never in the privacy selector list, so
  // Total / On Hold / Available all rendered in the clear with the eye shut.
  t('the Spot table is masked', /body\.priv #spotTbody td:not\(:first-child\)/.test(css))
  t('but its Token column is not', !/#spotTbody td \{/.test(css))

  // The overview's outcome row puts the share count in .ov-pos-info, which the
  // `.ov-ord-row .mono` rule that covers the rest of that row never reaches.
  t('the overview outcome share count is masked', main.includes('<i>${_prv(fmtSize(total))} shares</i>'))
  // The overview spot row was already the reference implementation — keep it that way.
  t('the overview spot balance is still masked', main.includes('${_prv(fmtSize(h.total))}'))
  t('and its value', main.includes("${h.usd > 0 ? _prv('$' + fmtUSD(h.usd)) : '—'}"))
}

console.log(nl + '-- and the switch itself --')
{
  t('privacy survives a reload', main.includes("localStorage.getItem('hliq_privacy') === '1'"))
  t('both shells share one flag', main.includes('window._mobVTogglePrivacy = window.__togglePrivacy'))
  // Mobile masks at render time, so flipping the switch has to re-render or nothing changes.
  t('flipping it re-renders the mobile shell', /__togglePrivacy[\s\S]{0,320}_mobVRenderContent\(\)/.test(main))
}

console.log(nl + `${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
