// The iPhone launch screens for the home-screen app (public/splash/*.png).
//
// Reported: "when i cold start the mobile web app it shows the typical black screen, then a
// blank white, then the app". iOS shows a launch image for a home-screen web app only if the page
// names one per screen size (apple-touch-startup-image); with none it shows black. These are the
// loading page itself — the app's background, the icon, and the three orange dots — so the
// launch, the page's own loader and the app read as one screen.
//
//   node tests/make-splash.mjs        (re-run after changing the icon or the background)
//
// The <link> tags in index.html are generated from the same list: SPLASH below.
import sharp from 'sharp'
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

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('make-splash.mjs')) {
  mkdirSync('public/splash', { recursive: true })
  for (const [w, h] of SPLASH) {
    const icon = Math.round(w * 0.26)
    const logo = await sharp('public/pwa-512x512.png').resize(icon, icon).png().toBuffer()
    const dot = Math.round(w * 0.024), gap = Math.round(dot * 1.0)
    const dotsW = dot * 3 + gap * 2
    const dots = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${dotsW}" height="${dot}">${[0, 1, 2].map(i =>
      `<circle cx="${dot / 2 + i * (dot + gap)}" cy="${dot / 2}" r="${dot / 2}" fill="#ff8a2a" opacity="${[0.35, 0.6, 1][i]}"/>`).join('')}</svg>`)
    const top = Math.round(h / 2 - icon / 2 - dot * 2)
    await sharp({ create: { width: w, height: h, channels: 3, background: BG } })
      .composite([
        { input: logo, left: Math.round((w - icon) / 2), top },
        { input: dots, left: Math.round((w - dotsW) / 2), top: top + icon + dot * 3 },
      ])
      .png({ compressionLevel: 9 })
      .toFile(`public/splash/${w}x${h}.png`)
  }
  // The tags for index.html, printed so they can be pasted (and checked by the suite).
  writeFileSync('splash-links.txt', SPLASH.map(([w, h, dw, dh, r]) =>
    `<link rel="apple-touch-startup-image" media="(device-width: ${dw}px) and (device-height: ${dh}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait)" href="/splash/${w}x${h}.png"/>`).join('\n') + '\n')
  console.log(`wrote ${SPLASH.length} launch screens to public/splash/`)
}
