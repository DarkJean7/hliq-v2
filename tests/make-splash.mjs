// The iPhone launch screens for the home-screen app (public/splash/*.png).
//
// Reported: "when i cold start the mobile web app it shows the typical black screen, then a
// blank white, then the app". iOS shows a launch image for a home-screen web app only if the page
// names one per screen size (apple-touch-startup-image); with none it shows black.
//
// Each image is a SCREENSHOT of the page's own loading screen (#init-loader in index.html — the
// icon, the >insolvent. wordmark and the dots), taken at that iPhone's size and pixel density with
// the app's code held back so the loader stays up. So the launch screen and the loading page are
// the same picture, and changing the loader and re-running this keeps them so.
//
//   npm run dev        (in another terminal)
//   node tests/make-splash.mjs [--port=5175]
//
// The <link> tags in index.html come from the same list (SPLASH), written to splash-links.txt.
import { mkdirSync, writeFileSync } from 'node:fs'

export const BG = '#0a0c10'
// [width px, height px, device-width, device-height, pixel ratio] — portrait.
export const SPLASH = [
  [1320, 2868, 440, 956, 3],   // 16 Pro Max
  [1206, 2622, 402, 874, 3],   // 16 Pro
  [1290, 2796, 430, 932, 3],   // 14/15 Pro Max, 15/16 Plus
  [1179, 2556, 393, 852, 3],   // 14/15 Pro, 15, 16
  [1284, 2778, 428, 926, 3],   // 12/13 Pro Max, 14 Plus
  [1170, 2532, 390, 844, 3],   // 12/13/14, 12/13 Pro
  [1125, 2436, 375, 812, 3],   // X, XS, 11 Pro, 12/13 mini
  [1242, 2688, 414, 896, 3],   // XS Max, 11 Pro Max
  [828, 1792, 414, 896, 2],    // XR, 11
  [1242, 2208, 414, 736, 3],   // 6/7/8 Plus
  [750, 1334, 375, 667, 2],    // 6/7/8, SE 2/3
  [640, 1136, 320, 568, 2],    // SE 1
]

if (process.argv[1]?.endsWith('make-splash.mjs')) {
  const { chromium } = await import('playwright')
  const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
  mkdirSync('public/splash', { recursive: true })
  const browser = await chromium.launch()
  for (const [w, h, dw, dh, r] of SPLASH) {
    const ctx = await browser.newContext({ viewport: { width: dw, height: dh }, deviceScaleFactor: r, isMobile: true })
    // Hold the app back: with its code never arriving, the loading screen is all there is.
    await ctx.route(/\/src\/main\.js|\/assets\/index-[^/]*\.js/, () => {})
    const p = await ctx.newPage()
    await p.goto(`http://localhost:${port}/app`, { waitUntil: 'commit' })
    await p.waitForSelector('#init-loader .il-icon')
    await p.evaluate(async () => {
      await document.fonts.ready
      const img = document.querySelector('#init-loader .il-icon')
      if (!img.complete) await new Promise(res => { img.onload = img.onerror = res })
      // A still frame of the dots: no bounce, a gentle left-to-right build.
      const st = document.createElement('style')
      st.textContent = '#init-loader .il-dots span{animation:none!important}#init-loader .il-dots span:nth-child(1){opacity:.35}#init-loader .il-dots span:nth-child(2){opacity:.6}'
      document.head.appendChild(st)
    })
    await p.screenshot({ path: `public/splash/${w}x${h}.png` })
    await ctx.close()
  }
  await browser.close()
  writeFileSync('splash-links.txt', SPLASH.map(([w, h, dw, dh, r]) =>
    `<link rel="apple-touch-startup-image" media="(device-width: ${dw}px) and (device-height: ${dh}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait)" href="/splash/${w}x${h}.png"/>`).join('\n') + '\n')
  console.log(`wrote ${SPLASH.length} launch screens to public/splash/`)
}
