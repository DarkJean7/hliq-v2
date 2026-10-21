/**
 * Position, zoom and preview a picture before it is used — profile photo or wallpaper.
 *
 * Asked: "when uploading a photo (user image or background image), it should let the user resize,
 * etc, and preview before putting it". Both used to be applied the instant a file was picked:
 * the profile photo centre-cropped to a square, the wallpaper scaled to 1600px wide, with no way
 * to choose which part showed.
 *
 * editImage() opens a sheet over the app: drag to move, zoom by slider, wheel or pinch, rotate in
 * quarter turns, reset. A profile photo is framed as the circle it is shown in, with the sizes it
 * appears at beside it; a wallpaper is framed in this screen's own shape, under the same dim the
 * app puts over it, with a sample card on top, so what you see is what the app will look like.
 * Apply draws exactly that crop at the output size. Cancel (or Escape) changes nothing.
 *
 * Resolves { dataUrl, w, h, bytes } on Apply, CANCELLED on cancel, null if the file cannot be read.
 */

export const CANCELLED = Symbol('cancelled')

// ── geometry (pure, tested in tests/suites/imgedit.test.mjs) ─────────────────────────────

/** Scale at which the image just covers the frame: zoom 1 never shows an empty edge. */
export function coverScale(imgW, imgH, frameW, frameH) {
  return Math.max(frameW / imgW, frameH / imgH)
}

/** Keep the view centre where the frame stays covered by the image. */
export function clampCenter(cx, cy, imgW, imgH, sw, sh) {
  return {
    cx: sw >= imgW ? imgW / 2 : Math.min(imgW - sw / 2, Math.max(sw / 2, cx)),
    cy: sh >= imgH ? imgH / 2 : Math.min(imgH - sh / 2, Math.max(sh / 2, cy)),
  }
}

/** The part of the image the frame shows: { sx, sy, sw, sh } in image pixels. */
export function cropRect({ imgW, imgH, frameW, frameH, zoom = 1, cx = imgW / 2, cy = imgH / 2 }) {
  const scale = coverScale(imgW, imgH, frameW, frameH) * Math.max(1, zoom)
  const sw = frameW / scale, sh = frameH / scale
  const c = clampCenter(cx, cy, imgW, imgH, sw, sh)
  return { sx: c.cx - sw / 2, sy: c.cy - sh / 2, sw, sh, scale, cx: c.cx, cy: c.cy }
}

// ── the sheet ──────────────────────────────────────────────────────────────────────────────

const loadImage = (file) => new Promise((resolve) => {
  if (!file || !/^image\//.test(file.type || 'image/')) return resolve(null)
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.onload = () => resolve(img)
  img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
  img.src = url
})

/** A copy of the source turned a quarter turn clockwise, as a canvas. */
function rotated(src) {
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height
  const c = document.createElement('canvas')
  c.width = h; c.height = w
  const g = c.getContext('2d')
  g.translate(h, 0); g.rotate(Math.PI / 2); g.drawImage(src, 0, 0)
  return c
}

/**
 * @param {File} file
 * @param {object} o
 *   kind     'avatar' | 'wallpaper'
 *   outW/outH  output size in pixels
 *   quality  JPEG quality
 *   dim      wallpaper: the scrim the app lays over it (0–1), so the preview matches
 *   title    sheet heading
 *   T        (en, es) => string, for the two languages
 */
export async function editImage(file, { kind = 'avatar', outW = 256, outH = 256, quality = 0.88, dim = 0.62, title, T = (en) => en } = {}) {
  const img0 = await loadImage(file)
  if (!img0) return null
  const doc = document
  let src = img0
  const W = () => src.naturalWidth || src.width, H = () => src.naturalHeight || src.height
  const avatar = kind === 'avatar'

  // The frame on screen has the OUTPUT's shape, sized to fit the sheet.
  const maxW = Math.min(avatar ? 300 : 560, window.innerWidth - 48)
  const maxH = Math.min(avatar ? 300 : 360, window.innerHeight - 300)
  const k = Math.min(maxW / outW, maxH / outH)
  const fw = Math.round(outW * k), fh = Math.round(outH * k)
  const dpr = Math.min(2, window.devicePixelRatio || 1)

  let zoom = 1, cx = W() / 2, cy = H() / 2

  const ov = doc.createElement('div')
  ov.className = 'imged-ov'
  ov.setAttribute('role', 'dialog')
  ov.innerHTML = `
    <div class="imged">
      <div class="imged-head"><b>${title ?? (avatar ? T('Profile photo', 'Foto de perfil') : T('Background image', 'Imagen de fondo'))}</b>
        <span>${T('Drag to move · scroll or pinch to zoom', 'Arrastra para mover · rueda o pellizca para zoom')}</span></div>
      <div class="imged-body">
        <div class="imged-stage${avatar ? ' imged-round' : ''}" style="width:${fw}px;height:${fh}px">
          <canvas class="imged-cv" width="${fw * dpr}" height="${fh * dpr}" style="width:${fw}px;height:${fh}px"></canvas>
          ${avatar ? '' : `<div class="imged-dim" style="opacity:${dim}"></div>
            <div class="imged-sample"><i>${T('Account value', 'Valor de la cuenta')}</i><b>$3,946.73</b><em>▲ +$34.61 · +0.88%</em></div>`}
        </div>
        ${avatar ? `<div class="imged-previews">
          <canvas class="imged-pv" data-s="64"></canvas><canvas class="imged-pv" data-s="40"></canvas><canvas class="imged-pv" data-s="24"></canvas>
        </div>` : ''}
      </div>
      <div class="imged-tools">
        <span>−</span><input class="imged-zoom" type="range" min="1" max="5" step="0.01" value="1" aria-label="${T('Zoom', 'Zoom')}"><span>+</span>
        <button type="button" class="imged-btn" data-act="rot" title="${T('Rotate', 'Rotar')}">⟳</button>
        <button type="button" class="imged-btn" data-act="reset">${T('Reset', 'Restablecer')}</button>
      </div>
      <div class="imged-actions">
        <button type="button" class="imged-btn" data-act="cancel">${T('Cancel', 'Cancelar')}</button>
        <button type="button" class="imged-btn imged-primary" data-act="apply">${T('Apply', 'Aplicar')}</button>
      </div>
    </div>`
  doc.body.appendChild(ov)

  const cv = ov.querySelector('.imged-cv'), g = cv.getContext('2d')
  const zoomEl = ov.querySelector('.imged-zoom')
  const pvs = [...ov.querySelectorAll('.imged-pv')]
  for (const p of pvs) { const s = +p.dataset.s; p.width = p.height = s * dpr; p.style.width = p.style.height = s + 'px' }

  const view = () => { const r = cropRect({ imgW: W(), imgH: H(), frameW: fw, frameH: fh, zoom, cx, cy }); cx = r.cx; cy = r.cy; return r }
  const draw = () => {
    const r = view()
    g.clearRect(0, 0, cv.width, cv.height)
    g.drawImage(src, r.sx, r.sy, r.sw, r.sh, 0, 0, cv.width, cv.height)
    for (const p of pvs) { const pg = p.getContext('2d'); pg.clearRect(0, 0, p.width, p.height); pg.drawImage(cv, 0, 0, p.width, p.height) }
  }
  draw()

  const setZoom = (z, ax = fw / 2, ay = fh / 2) => {
    // Zoom about the point under the cursor (or the centre), so it stays put under the finger.
    const before = view()
    const ix = before.sx + ax / before.scale, iy = before.sy + ay / before.scale
    zoom = Math.min(5, Math.max(1, z))
    const s = coverScale(W(), H(), fw, fh) * zoom
    cx = ix - ax / s + (fw / s) / 2; cy = iy - ay / s + (fh / s) / 2
    zoomEl.value = String(zoom)
    draw()
  }

  // Drag (one pointer) and pinch (two).
  const stage = ov.querySelector('.imged-stage')
  const pts = new Map()
  let pinch0 = null
  stage.addEventListener('pointerdown', (e) => { stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }) })
  stage.addEventListener('pointermove', (e) => {
    const prev = pts.get(e.pointerId)
    if (!prev) return
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pts.size === 2) {
      const [a, b] = [...pts.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (pinch0) setZoom(pinch0.zoom * d / pinch0.d)
      else pinch0 = { d, zoom }
      return
    }
    const s = view().scale
    cx -= (e.clientX - prev.x) / s; cy -= (e.clientY - prev.y) / s
    draw()
  })
  const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch0 = null }
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up)
  stage.addEventListener('wheel', (e) => {
    e.preventDefault()
    const r = stage.getBoundingClientRect()
    setZoom(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top)
  }, { passive: false })
  zoomEl.addEventListener('input', () => setZoom(+zoomEl.value))

  return new Promise((resolve) => {
    const close = (v) => { doc.removeEventListener('keydown', onKey); ov.remove(); try { URL.revokeObjectURL(img0.src) } catch {}; resolve(v) }
    const onKey = (e) => { if (e.key === 'Escape') close(CANCELLED); if (e.key === 'Enter') apply() }
    const apply = () => {
      const r = view()
      const out = doc.createElement('canvas')
      out.width = outW; out.height = outH
      out.getContext('2d').drawImage(src, r.sx, r.sy, r.sw, r.sh, 0, 0, outW, outH)
      const dataUrl = out.toDataURL('image/jpeg', quality)
      close({ dataUrl, w: outW, h: outH, bytes: Math.round(dataUrl.length * 0.75) })
    }
    doc.addEventListener('keydown', onKey)
    ov.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act
      if (e.target === ov || act === 'cancel') return close(CANCELLED)
      if (act === 'apply') return apply()
      if (act === 'reset') { zoom = 1; cx = W() / 2; cy = H() / 2; zoomEl.value = '1'; draw() }
      if (act === 'rot') { src = rotated(src); zoom = 1; cx = W() / 2; cy = H() / 2; zoomEl.value = '1'; draw() }
    })
  })
}
