// The landing page at /. Deliberately tiny and self-contained: it imports nothing from the
// app, so the front door is a few KB and never pays for main.js. See landing.html for the
// redirect that sends returning users straight to /app before this even runs.
import './landing.css'

document.documentElement.classList.add('ln-js')

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

// Reveal on scroll
const io = 'IntersectionObserver' in window
  ? new IntersectionObserver(es => {
      for (const e of es) if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target) }
    }, { rootMargin: '0px 0px -8% 0px' })
  : null
for (const el of document.querySelectorAll('.ln-reveal')) io ? io.observe(el) : el.classList.add('is-in')

// The candlestick skyline behind the hero. Seeded, so it is the same chart on every visit
// and every resize, a backdrop rather than something that looks like live data.
const cv = document.getElementById('lnCandles')
function drawCandles() {
  if (!cv) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = cv.clientWidth, h = cv.clientHeight
  if (!w || !h) return
  cv.width = w * dpr; cv.height = h * dpr
  const g = cv.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)
  let s = 7
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  const step = w < 600 ? 14 : 18, bw = Math.max(4, step * 0.55)
  const n = Math.ceil(w / step) + 1
  let p = 0.45
  const pts = []
  for (let i = 0; i < n; i++) {
    const o = p
    p = Math.min(0.92, Math.max(0.12, p + (rnd() - 0.47) * 0.09))
    pts.push({ o, c: p, hi: Math.max(o, p) + rnd() * 0.05, lo: Math.min(o, p) - rnd() * 0.05 })
  }
  const y = v => h - v * h
  pts.forEach((k, i) => {
    const x = i * step + step / 2
    const up = k.c >= k.o
    const fade = 0.25 + 0.75 * Math.sin(Math.PI * (i / n))   // dimmer at the edges
    g.globalAlpha = fade
    g.strokeStyle = g.fillStyle = up ? 'rgba(120,200,140,.28)' : 'rgba(255,138,42,.22)'
    g.beginPath(); g.moveTo(x + .5, y(k.hi)); g.lineTo(x + .5, y(k.lo)); g.stroke()
    const top = y(Math.max(k.o, k.c)), bot = y(Math.min(k.o, k.c))
    g.fillRect(x - bw / 2, top, bw, Math.max(1, bot - top))
  })
  g.globalAlpha = 1
}
drawCandles()
let rz
window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(drawCandles, 120) })
