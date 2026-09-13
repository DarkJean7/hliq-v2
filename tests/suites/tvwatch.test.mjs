// Watched external markets (DXY, gold, yields) are CARDS, because the widget that draws them
// needs the room.
//
// Reported: "i want in watch tab, to also make cards for the tradingview assets like in the
// image which btc cards appears but not for dxy". A coin gets an icon, a sparkline and a
// price, all drawn from Hyperliquid candles. There is no HL feed for DXY, so its chart is a
// TradingView mini widget — and that widget hides content as its box shrinks, with no error
// and no fallback. In the 150x52 cell it used to sit in, it rendered a name and a spinner.
//
// Measured against CAPITALCOM:DXY by mounting it at four sizes and screenshotting:
//
//     150x52   symbol name only              (what was shipped)
//     240x80   + the price
//     370x110  + the change, chart clipped
//     370x160  + the sparkline and its axis  (the whole card)
//
// So this is a layout fact, not a styling preference: below ~160px of height the card is
// silently incomplete.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const CSS = fs.readFileSync('src/style.css', 'utf8').replace(/\r\n/g, '\n')

/** The declaration block for a selector, braces included. */
const block = (sel) => {
  const i = CSS.indexOf(sel + ' {')
  if (i < 0) return ''
  return CSS.slice(i, CSS.indexOf('}', i) + 1)
}

console.log(nl + '-- the market renders as a card --')
t('the watch tab builds .mob-tv-card', CLI.includes('<div class="mob-tv-card">'))
t('and it is no longer a row', !/mob-v-row mob-watch-row" onclick="window\.__tvOpenChart/.test(CLI))
t('the 150x52 cell is gone', !CLI.includes('width:150px;height:52px'))
t('the mini keeps its id, so the mount still finds it', CLI.includes('id="tvmini-${_tvId(sym)}"'))
t('the mount targets that id', CLI.includes("document.getElementById('tvmini-' + _tvId(sym))"))
// autosize + 100% means the CSS height below is what the widget actually gets.
t('the widget fills the card rather than a fixed pixel size',
  /_tvInject\(el, [^)]*mini-symbol-overview[^)]*\{[\s\S]{0,200}?width: '100%', height: '100%'/.test(CLI) &&
  /_tvMountMinis[\s\S]{0,600}autosize: true/.test(CLI))

console.log(nl + '-- and the card is tall enough for the widget to finish drawing --')
{
  const mini = block('.mob-tv-mini')
  t('there is a rule for the mini', mini.length > 0)
  t('it is at least the 160px the chart needs',
    parseInt((mini.match(/height:\s*(\d+)px/) || [])[1] ?? '0') >= 160, mini)
  // A tap inside the iframe leaves the app for tradingview.com.
  t('the iframe does not take taps', mini.includes('pointer-events: none'))
  t('why that height is written down, with the measurements',
    CSS.includes('160px is the first height that') && CLI.includes('80px adds the price'))
}

console.log(nl + '-- the two controls do not fight --')
{
  const open = block('.mob-tv-open')
  const x    = block('.mob-tv-x')
  t('a transparent button covers the card', open.includes('inset: 0'))
  t('tapping it opens OUR chart, not tradingview.com',
    CLI.includes('class="mob-tv-open" onclick="window.__tvOpenChart('))
  t('the remove button sits above it',
    parseInt((x.match(/z-index:\s*(\d+)/) || [])[1] ?? '0') >
    parseInt((open.match(/z-index:\s*(\d+)/) || [])[1] ?? '0'), { x, open })
  t('and the tap does not also open the chart', CLI.includes('event.stopPropagation();window.__tvRemove('))
  // The widget's own TradingView badge is its attribution and sits top-right; the × is inset
  // from the right to clear it rather than sitting on the end of the sparkline.
  t('the × clears the TradingView badge',
    parseInt((x.match(/right:\s*(\d+)px/) || [])[1] ?? '0') >= 40, x)
  // A contiguous fragment: the comment wraps, so the whole sentence never sits on one line.
  t('why it is not in the corner is written down', CSS.includes('Bottom-right was the other candidate'))
  t('both controls are labelled for screen readers',
    CLI.includes('aria-label="${esc(_tvLabel(sym))} — open chart"') &&
    CLI.includes('aria-label="Remove ${esc(_tvLabel(sym))}"'))
}

console.log(nl + '-- removing one still works --')
// The card is rebuilt from storage on the next tick, so a remove that only updates the DOM
// comes back by itself.
t('remove writes through to storage', CLI.includes('saveTvWatch(loadTvWatch().filter(s => s !== sym))'))
t('and repaints the tab', /__tvRemove[\s\S]{0,200}_mobVRenderContent\(\)/.test(CLI))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
