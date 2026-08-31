/**
 * Celebrations — confetti and a banner, for the handful of moments worth one.
 *
 * Deliberately dependency-free: this is a canvas, a few hundred particles and some
 * arithmetic. Pulling a confetti library into a bundle this size to draw rectangles
 * would not be a trade worth making.
 *
 * Three things this module refuses to do, because it fires on a live trading screen:
 *
 *   - Block anything. The canvas is `pointer-events:none` and sits above the UI only
 *     visually. You can keep trading through a celebration.
 *   - Outstay it. Every canvas removes itself, and a second burst replaces the first
 *     rather than stacking, so a fast run of events cannot leave debris on screen.
 *   - Ignore a preference. `prefers-reduced-motion` drops the particles entirely and
 *     keeps the banner, which is the part that carries the information.
 */

const FX_KEY = 'hliq_fx'

/** Celebrations are opt-out, and the setting is read fresh every time. */
export function fxEnabled() {
  try { return localStorage.getItem(FX_KEY) !== '0' } catch { return true }
}
export function setFxEnabled(on) {
  try { localStorage.setItem(FX_KEY, on ? '1' : '0') } catch {}
}

function reducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

const STYLE_ID = 'fxStyles'
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return
  const s = document.createElement('style')
  s.id = STYLE_ID
  s.textContent = `
    #fxCanvas { position:fixed; inset:0; width:100%; height:100%; pointer-events:none; z-index:100000; }
    #fxBanner {
      position:fixed; left:50%; top:22%; transform:translate(-50%,-50%);
      z-index:100001; pointer-events:none; text-align:center;
      padding:14px 22px; border-radius:16px;
      background:var(--panel-2,#14161c); border:1px solid var(--border2,#2a2f3a);
      box-shadow:0 18px 50px rgba(0,0,0,.45);
      animation:fxPop .42s cubic-bezier(.16,1.02,.3,1.24) both;
      max-width:min(88vw,420px);
    }
    #fxBanner.fx-out { animation:fxFade .34s ease forwards; }
    .fx-title { font-size:11px; font-weight:800; letter-spacing:.09em; text-transform:uppercase;
                color:var(--fg-2,#98a2b3); margin-bottom:5px; }
    .fx-big   { font-size:26px; font-weight:800; line-height:1.1; }
    .fx-sub   { font-size:12px; color:var(--fg-2,#98a2b3); margin-top:5px; }
    @keyframes fxPop  { from { opacity:0; transform:translate(-50%,-50%) scale(.82) } to { opacity:1; transform:translate(-50%,-50%) scale(1) } }
    @keyframes fxFade { to { opacity:0; transform:translate(-50%,-56%) scale(.97) } }
    @media (prefers-reduced-motion: reduce) {
      #fxBanner, #fxBanner.fx-out { animation:none; }
    }`
  document.head.appendChild(s)
}

/** The banner. Carries the message, so it shows even when motion is reduced. */
function banner(title, big, sub, color, holdMs) {
  document.getElementById('fxBanner')?.remove()
  const el = document.createElement('div')
  el.id = 'fxBanner'
  el.innerHTML =
    `<div class="fx-title" style="color:${color}">${title}</div>` +
    `<div class="fx-big" style="color:${color}">${big}</div>` +
    (sub ? `<div class="fx-sub">${sub}</div>` : '')
  document.body.appendChild(el)
  setTimeout(() => {
    el.classList.add('fx-out')
    setTimeout(() => el.remove(), 400)
  }, holdMs)
}

/**
 * The particle burst. Two jets angled inward from the lower corners — the shape reads as
 * a celebration rather than as weather, which a straight top-down fall does not.
 *
 * Particle count scales with the viewport and hard-caps, so a phone does not try to
 * animate a desktop's worth of confetti on a battery.
 */
function confetti(colors, durationMs) {
  document.getElementById('fxCanvas')?.remove()
  const cv = document.createElement('canvas')
  cv.id = 'fxCanvas'
  document.body.appendChild(cv)

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const W = window.innerWidth, H = window.innerHeight
  cv.width = W * dpr; cv.height = H * dpr
  const ctx = cv.getContext('2d')
  ctx.scale(dpr, dpr)

  const n = Math.min(160, Math.round(W / 7))
  const parts = []
  for (let i = 0; i < n; i++) {
    const left  = i % 2 === 0
    const angle = (left ? -60 : -120) * Math.PI / 180 + (Math.random() - 0.5) * 0.85
    const speed = 11 + Math.random() * 13
    parts.push({
      x: left ? -10 : W + 10,
      y: H * (0.72 + Math.random() * 0.2),
      vx: Math.cos(angle) * speed * (left ? -1 : 1) * -1,
      vy: Math.sin(angle) * speed,
      w: 5 + Math.random() * 6,
      h: 8 + Math.random() * 7,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.36,
      color: colors[(Math.random() * colors.length) | 0],
      wob: Math.random() * Math.PI * 2,
    })
  }

  const start = performance.now()
  let raf = 0
  ;(function frame(now) {
    const t = now - start
    if (t > durationMs) { cancelAnimationFrame(raf); cv.remove(); return }
    // Fade the whole field out over the last 600ms rather than letting pieces vanish.
    ctx.clearRect(0, 0, W, H)
    ctx.globalAlpha = t > durationMs - 600 ? Math.max(0, (durationMs - t) / 600) : 1

    for (const p of parts) {
      p.vy += 0.34                 // gravity
      p.vx *= 0.992                // drag
      p.wob += 0.1
      p.x += p.vx + Math.sin(p.wob) * 0.7
      p.y += p.vy
      p.rot += p.vr
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(p.rot)
      ctx.fillStyle = p.color
      // Squash on rotation fakes a flat piece of paper turning over.
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot)))
      ctx.restore()
    }
    raf = requestAnimationFrame(frame)
  })(start)
}

const PRESETS = {
  ath: {
    colors: ['#22c55e', '#4ade80', '#a7f3d0', '#fbbf24', '#ffffff'],
    color:  'var(--green,#22c55e)',
    hold:   3400,
    burst:  3000,
  },
  win: {
    colors: ['#22c55e', '#86efac', '#ffffff'],
    color:  'var(--green,#22c55e)',
    hold:   2600,
    burst:  2200,
  },
  milestone: {
    colors: ['#8b5cf6', '#c4b5fd', '#fbbf24', '#ffffff'],
    color:  '#a78bfa',
    hold:   3000,
    burst:  2600,
  },
}

/**
 * Fire a celebration. `kind` picks the palette and timing; the three strings are the
 * banner's contents. Returns false when it did nothing, so a caller that wants to know
 * whether the moment was actually shown can tell.
 */
export function celebrate(kind, title, big, sub = '') {
  if (!fxEnabled()) return false
  const p = PRESETS[kind] ?? PRESETS.win
  ensureStyles()
  banner(title, big, sub, p.color, p.hold)
  if (!reducedMotion()) confetti(p.colors, p.burst)
  return true
}
