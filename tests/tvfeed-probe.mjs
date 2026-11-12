// LIVE probe: does a TradingView symbol render in a third-party embed, and at what price?
//
// TradingView licenses its own index feeds (TVC:DXY, SP:SPX, ...) for tradingview.com only; an
// embed shows "This symbol is only available on TradingView" instead. A plausible ticker is not
// evidence -- mount it and look. Used to choose the DXY feed after the chart (CAPITALCOM:DXY, a CFD)
// read 102.664 beside the strip's ICE index at 102.98: "price is not matching".
//
// Run:  node tests/tvfeed-probe.mjs --symbols=ICEUS:DXY,INDEX:DXY --shots=<dir>
// Not part of CI: it reaches TradingView.
import { chromium } from 'playwright'

const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || d
const SYMBOLS = arg('symbols', 'CAPITALCOM:DXY').split(',').filter(Boolean)
const SHOTS = arg('shots', '')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 700, height: 520 } })
for (const sym of SYMBOLS) {
  // The same widget the app mounts (embed-widget-advanced-chart.js), from a real https origin.
  await page.goto('https://insolvent.trade/', { waitUntil: 'domcontentloaded' })
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#111">
    <div class="tradingview-widget-container" style="height:500px;width:680px">
      <div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div>
      <script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js" async>
      ${JSON.stringify({ symbol: sym, interval: '15', theme: 'dark', autosize: true, hide_side_toolbar: true, allow_symbol_change: false })}
      </script>
    </div></body></html>`)
  await page.waitForTimeout(9000)
  const file = SHOTS ? `${SHOTS}/tv-${sym.replace(/[^A-Za-z0-9]/g, '_')}.png` : null
  if (file) await page.screenshot({ path: file })
  console.log(sym, file ?? '')
}
await browser.close()
