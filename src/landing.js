// The landing page at /. Deliberately tiny and self-contained: it imports nothing from the
// app, so the front door is a few KB and never pays for main.js. See landing.html for the
// redirect that sends returning users straight to /app before this even runs.
import './landing.css'

document.documentElement.classList.add('ln-js')
const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// "Launch app" remembers the choice, so the bare domain opens the app from now on. The app
// sets the same flag on load; this covers the moment between the click and that load.
for (const a of document.querySelectorAll('[data-launch]')) {
  a.addEventListener('click', () => { try { localStorage.setItem('hliq_app_entered', '1') } catch {} })
}

// Mobile menu
const nav = document.getElementById('lnNav')
const burger = document.getElementById('lnBurger')
burger?.addEventListener('click', () => {
  const open = nav.classList.toggle('is-open')
  burger.setAttribute('aria-expanded', String(open))
})
document.getElementById('lnLinks')?.addEventListener('click', e => {
  if (e.target.closest('a')) { nav.classList.remove('is-open'); burger?.setAttribute('aria-expanded', 'false') }
})

// Reveal on scroll (also slides the final health knob to the safe end)
const io = 'IntersectionObserver' in window
  ? new IntersectionObserver(es => {
      for (const e of es) if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target) }
    }, { rootMargin: '0px 0px -8% 0px' })
  : null
for (const el of document.querySelectorAll('.ln-reveal, .ln-final__knob')) io ? io.observe(el) : el.classList.add('is-in')

// ── Live prices ──────────────────────────────────────────────────────────────
// One metaAndAssetCtxs call (weight 20 of the visitor's own 1,200/min) for the busiest
// markets, refreshed every 30s while the tab is visible. If Hyperliquid does not answer, the
// tape is hidden: no made-up prices on a page about a trading terminal.
const tape = document.getElementById('lnTape')
const track = document.getElementById('lnTapeTrack')
const fmtPx = p => p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 0 })
  : p >= 1 ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : p.toPrecision(4)
async function loadTape() {
  try {
    const r = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }), signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) throw new Error(r.status)
    const [meta, ctxs] = await r.json()
    const rows = (meta?.universe ?? []).map((u, i) => ({ name: u.name, delisted: u.isDelisted, c: ctxs?.[i] }))
      .filter(x => !x.delisted && x.c && parseFloat(x.c.markPx) > 0 && parseFloat(x.c.prevDayPx) > 0)
      .sort((a, b) => parseFloat(b.c.dayNtlVlm) - parseFloat(a.c.dayNtlVlm))
      .slice(0, 14)
    if (rows.length < 4) throw new Error('too few')
    const html = rows.map(({ name, c }) => {
      const px = parseFloat(c.markPx), chg = (px / parseFloat(c.prevDayPx) - 1) * 100
      return `<span class="ln-tick"><b>${name}</b><span>$${fmtPx(px)}</span><em class="${chg >= 0 ? 'up' : 'dn'}">${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(2)}%</em></span>`
    }).join('')
    track.innerHTML = html + html          // twice, so the marquee loops seamlessly
    tape.hidden = false
  } catch {
    if (!track.childElementCount) tape.hidden = true
  }
}
if (tape && track) {
  tape.hidden = true
  loadTape()
  setInterval(() => { if (!document.hidden) loadTape() }, 30_000)
}

// ── Bot log ──────────────────────────────────────────────────────────────────
// Illustrative output in the shape the strategy server prints, so the section shows what
// running a bot looks like rather than describing it.
const logEl = document.getElementById('lnLog')
const LOG = [
  ['grid', 'BTC buy filled · level 7/24'],
  ['grid', 'BTC sell filled · <span class="w">+$4.18</span>'],
  ['dca', 'HYPE bought $25 · next in 6h'],
  ['twap', 'ETH slice 12/40 filled'],
  ['trend', 'SOL flat · holding'],
  ['grid', 'ETH sell filled · <span class="w">+$2.61</span>'],
  ['shorter', 'margin within cap · 41% used'],
  ['grid', 'BTC buy filled · level 6/24'],
  ['twap', 'ETH slice 13/40 filled'],
  ['dca', 'HYPE schedule ok · 14 buys'],
]
if (logEl) {
  let i = 0, t = Date.now() - LOG.length * 37_000
  const stamp = () => new Date(t).toTimeString().slice(0, 8)
  const push = () => {
    const [k, msg] = LOG[i++ % LOG.length]
    t += 37_000
    const d = document.createElement('div')
    d.className = 'ln-log__line'
    d.innerHTML = `<span class="t">[${stamp()}]</span> <span class="k">${k.padEnd(7, ' ').replace(/ /g, '&nbsp;')}</span> ${msg}`
    logEl.appendChild(d)
    while (logEl.childElementCount > 14) logEl.firstChild.remove()
  }
  for (let n = 0; n < 9; n++) push()
  if (!reduced) setInterval(() => { if (!document.hidden) push() }, 1900)
}

// ── PnL calendar tile ────────────────────────────────────────────────────────
// Seeded, so it is the same month on every visit — decoration, not anyone's results.
const cal = document.getElementById('lnCal')
if (cal) {
  let s = 11
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  let html = ''
  for (let n = 0; n < 30; n++) {
    const v = rnd()
    const c = v > .62 ? `rgba(34,227,154,${(.25 + (v - .62) * 1.8).toFixed(2)})`
      : v < .3 ? `rgba(255,77,109,${(.2 + (.3 - v) * 1.8).toFixed(2)})` : '#191d26'
    html += `<i style="background:${c}"></i>`
  }
  cal.innerHTML = html
}

// ── The phone breathes ───────────────────────────────────────────────────────
// Small moves on the drawn app so it reads as live, never far from where it started.
const eqEl = document.getElementById('lnPhEq'), knob = document.getElementById('lnPhKnob'), hEl = document.getElementById('lnPhHealth')
if (eqEl && !reduced) {
  let eq = 12480.36, h = 82.4
  setInterval(() => {
    if (document.hidden) return
    eq = Math.max(12380, Math.min(12590, eq + (Math.random() - 0.5) * 18))
    h  = Math.max(79, Math.min(86, h + (Math.random() - 0.5) * 0.8))
    const [w, c] = eq.toFixed(2).split('.')
    eqEl.innerHTML = `$${Number(w).toLocaleString('en-US')}<span>.${c}</span>`
    if (knob) knob.style.left = h.toFixed(1) + '%'
    if (hEl) hEl.textContent = h.toFixed(1) + '%'
  }, 2200)
}
