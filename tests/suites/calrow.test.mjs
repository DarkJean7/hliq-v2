// The calendar's day detail: when each thing happened, and what it was traded in.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const rnd = fs.readFileSync('src/render.js', 'utf8').replace(/\r\n/g, '\n')
const css = fs.readFileSync('src/style.css', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

console.log(String.fromCharCode(10) + '-- every row says when --')
t('trades carry the time', rnd.includes('<span class="cal-detail-time">${_calTime(t.time)}</span>'))
t('so do deposits and withdrawals', rnd.includes('<span class="cal-detail-time">${_calTime(e.time)}</span>'))
// The day is already known from the cell that was clicked, so the date would be noise.
t('time only, not the date again', rnd.includes("{ hour: '2-digit', minute: '2-digit' })") &&
  !/_calTime[\s\S]{0,220}month:/.test(rnd))
t('a missing timestamp renders nothing, not "Invalid Date"', rnd.includes("!ms ? '' :"))
// Six things do not fit across a phone's ~380px of panel, and what got clipped was the
// PnL -- the one number a reader came for. The size/price moved to a line a tap reveals.
t('size and price hide behind a tap on a phone', /\.cal-detail-meta  \{[^}]*display: none/.test(css))
t('and come back when expanded', css.includes('.cal-detail-trade.cal-expanded .cal-detail-meta  { display: block; }'))
t('the class is the state, so a re-render starts collapsed', rnd.includes(`onclick="this.classList.toggle('cal-expanded')"`))
t('indented with padding, not margin -- 100% plus a margin overruns the row',
  /\.cal-detail-meta  \{[^}]*padding-left: 54px[^}]*\}/.test(css) && !/\.cal-detail-meta  \{[^}]*margin-left: 54px/.test(css))
t('the caret is pinned, so the PnL auto-margin cannot squeeze it out',
  /\.cal-detail-caret \{[^}]*position: absolute/.test(css))
t('desktop keeps one line and hides the caret', css.includes('@media (min-width: 621px) { .cal-detail-caret { display: none; } }'))
t('the column is fixed width so the list scans straight',
  /\.cal-detail-time \{[^}]*min-width: 46px/.test(css) && /\.cal-detail-time \{[^}]*tabular-nums/.test(css))

console.log(String.fromCharCode(10) + '-- a spot buy names its market --')
// Reported: spot buys showed as "@107". That is HL's market index; only main.js holds the
// map that turns it into a ticker (@107 is HYPE).
t('render.js asks main.js rather than keeping a second table', rnd.includes("const spot = window._spotLabel?.(coin)"))
t('only for @-prefixed coins, so nothing else changes behaviour', rnd.includes("coin.charCodeAt(0) === 64"))
t('and falls through when it cannot answer', /if \(spot\) return spot\n  \}\n  return \(typeof window/.test(rnd))
t('main.js exposes the map', cli.includes('window._spotLabel = (coin) => _spotNameMap[coin] ?? null'))

console.log(String.fromCharCode(10) + '-- and loads the names if nothing else has --')
// _ensureMarketData only ran when a coin picker opened, so a session that went straight to
// the Calendar had nothing to resolve an index with and showed "@107" forever.
t('main.js lets a view ask for them', cli.includes('window._ensureSpotNames = () => _ensureMarketData()'))
t('the calendar asks when an index is unresolved', rnd.includes('window._ensureSpotNames?.()?.then('))
t('it repaints only if the same day is still open', rnd.includes("if (detail.dataset.activeKey !== key) return"))
t('and clears the double-tap guard, which would swallow the repaint',
  rnd.includes('_calClickGuard = { key: null, ts: 0 }'))
t('a throw in any of it cannot break the day', /try \{\n      window\._ensureSpotNames/.test(rnd))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
