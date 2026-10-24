// The app's icons: the full >insolvent. wordmark across a dark square, the way a card network
// puts its whole name on the card. Asked: "lets change the app icon, like the mobile home icon from
// just "in" to the full word "insolvent". just as similar as the "discover" credit card icon where
// they just display the full name".
//
// Drawn by a browser in the app's own font (Inter Tight, served by the dev server), with the same
// styling as the loading page's wordmark (index.html #init-loader): grey "in" struck through in
// orange, "solvent" in white, an orange dot. So icon, launch screen and loader are one mark.
//
//   npm run dev        (another terminal)
//   node tests/make-icons.mjs [--port=5175]
//
// Writes public/: apple-touch-icon.png (180, full-bleed: iOS rounds it), pwa-192x192.png and
// pwa-512x512.png (rounded, for "any"), and pwa-maskable-512.png — full-bleed with the word kept
// inside the centre 80% circle, because Android crops a maskable icon to its own shape.
// favicon.png is NOT redrawn: a browser tab shows it at 16–32px, where nine letters cannot be
// read, so it keeps the "in".
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'

export const ICONS = [
  // [file, size px, rounded corners, wordmark width as a share of the icon]
  ['apple-touch-icon.png', 180, false, 0.84],
  ['pwa-192x192.png',      192, true,  0.84],
  ['pwa-512x512.png',      512, true,  0.84],
  ['pwa-maskable-512.png', 512, false, 0.66],
]

const page = (size, rounded, share) => `<!doctype html><html><head>
<link rel="stylesheet" href="/fonts/fonts.css">
<style>
  html,body{margin:0;background:transparent}
  .ic{width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;overflow:hidden;
    border-radius:${rounded ? Math.round(size * 0.22) : 0}px;
    background:radial-gradient(70% 60% at 22% 18%, rgba(255,138,42,.20), transparent 65%),
               radial-gradient(60% 55% at 85% 95%, rgba(255,138,42,.10), transparent 70%), #0a0c10;
    box-shadow:inset 0 0 0 ${Math.max(1, Math.round(size / 180))}px rgba(255,138,42,.16)}
  .w{font-family:"Inter Tight","Inter",system-ui,sans-serif;font-weight:700;letter-spacing:-0.05em;line-height:1;
    color:#e5e9f0;white-space:nowrap;font-size:100px}
  .in{position:relative;color:#6b7384}
  .in::after{content:'';position:absolute;left:-6%;right:-6%;top:52%;height:.15em;border-radius:.08em;background:#ff8a2a;transform:rotate(-10deg)}
  .dot{color:#ff8a2a}
</style></head><body>
<div class="ic"><div class="w" id="w"><span class="in">in</span>solvent<span class="dot">.</span></div></div>
<script>
  // Size the word to the share of the icon it should span, after the font has loaded.
  document.fonts.ready.then(() => {
    const w = document.getElementById('w'), want = ${size} * ${share}
    w.style.fontSize = (100 * want / w.getBoundingClientRect().width) + 'px'
    document.body.dataset.ready = '1'
  })
</script></body></html>`

if (process.argv[1]?.endsWith('make-icons.mjs')) {
  const browser = await chromium.launch()
  for (const [file, size, rounded, share] of ICONS) {
    const ctx = await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
    // Served from the dev server's own origin: fonts are not loaded across origins.
    const at = `http://localhost:${port}/__icon-${size}`
    await ctx.route(at, r => r.fulfill({ status: 200, contentType: 'text/html', body: page(size, rounded, share) }))
    const p = await ctx.newPage()
    await p.goto(at, { waitUntil: 'networkidle' })
    await p.waitForSelector('body[data-ready="1"]')
    const fam = await p.evaluate(() => document.fonts.check('700 40px "Inter Tight"'))
    if (!fam) throw new Error('Inter Tight did not load — is the dev server running on ' + port + '?')
    await p.locator('.ic').screenshot({ path: 'public/' + file, omitBackground: rounded })
    await ctx.close()
    console.log('wrote public/' + file)
  }
  await browser.close()
}
