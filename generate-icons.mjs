// App icons from the wordmark: "in" with the orange strike through it — "insolvent" with
// the "in" crossed out, the landing headline's mark.
//
// Rendered with Playwright from HTML so the icon uses the site's own self-hosted Inter Tight
// rather than whatever font an SVG rasteriser happens to find. (This used to read an
// icon-source.svg that was no longer in the repo, so it could not regenerate anything.)
//
//   node generate-icons.mjs            → public/pwa-512x512.png, pwa-192x192.png,
//                                        apple-touch-icon.png, favicon.png
// After changing them, bump ?v= on every icon URL (index.html, landing.html, manifest.json,
// src/main.js) or phones keep the cached one.
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const font = readFileSync('public/fonts/inter-tight-700-normal-latin.woff2').toString('base64')

// Everything sits inside the central 80%, so the 512 also works as the maskable icon.
const html = (size) => `<!doctype html><html><head><style>
@font-face { font-family: 'IT'; font-weight: 700; src: url(data:font/woff2;base64,${font}) format('woff2'); }
html, body { margin: 0; background: transparent; }
.ic {
  width: ${size}px; height: ${size}px; border-radius: ${size * 0.22}px; position: relative; overflow: hidden;
  background: radial-gradient(70% 60% at 30% 18%, #3a2310 0%, #120c08 55%, #07070a 100%);
  box-shadow: inset 0 0 0 ${Math.max(1, size / 256)}px rgba(255,138,42,.35);
  display: flex; align-items: center; justify-content: center;
}
.in {
  position: relative; font-family: 'IT'; font-weight: 700; color: #7d8597;
  font-size: ${size * 0.56}px; letter-spacing: -0.05em; line-height: 1; transform: translateY(-${size * 0.03}px);
}
.in::after {
  content: ''; position: absolute; left: -10%; right: -12%; top: 54%; height: .13em; border-radius: .07em;
  background: #ff8a2a; transform: rotate(-12deg);
  box-shadow: 0 0 ${size * 0.06}px rgba(255,138,42,.55);
}
</style></head><body><div class="ic"><span class="in">in</span></div></body></html>`

const OUT = [
  ['public/pwa-512x512.png', 512],
  ['public/pwa-192x192.png', 192],
  ['public/apple-touch-icon.png', 180],
  ['public/favicon.png', 256],
]

const browser = await chromium.launch()
const page = await browser.newPage({ deviceScaleFactor: 1 })
for (const [file, size] of OUT) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(html(size))
  await page.evaluate(() => document.fonts.ready)
  await page.locator('.ic').screenshot({ path: file, omitBackground: true })
  console.log(`Written ${file} (${size}×${size})`)
}
await browser.close()
