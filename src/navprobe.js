/**
 * INSOLVENT TERMINAL — where the mobile tab bar actually landed
 *
 * The bar being in the wrong place has now been diagnosed twice from a desktop browser and
 * "fixed" twice, and the phone still shows it wrong. Both fixes were verified in Chromium at
 * 430x930, where there is no safe area and fixed positioning behaves differently. That is not
 * evidence about an iPhone, and two rounds of it is enough.
 *
 * So this measures the real thing on the real device and posts it once per session.
 *
 * The reading that matters is CONTAINING BLOCK. `position: fixed; bottom: 0` means "the bottom
 * of the viewport" only while no ancestor establishes a containing block for fixed
 * descendants. A `filter`, `transform`, `perspective`, `backdrop-filter`, `will-change` on any
 * of those, or `contain: paint/layout/strict` on ANY ancestor silently changes what `bottom: 0`
 * refers to — and the app puts `filter: brightness()` on <html>. If that is what is happening,
 * every fixed element in the app is being laid out against a box that is not the screen, which
 * is exactly what the screenshot shows: the wallpaper and the bar both stop short of the
 * bottom edge together.
 *
 * Sends coarse geometry only — no addresses, no balances, nothing from the account.
 */

const KIND = 'navgeom'

/** Ancestors that would capture a position:fixed descendant, and the property that does it. */
function containingBlockChain(el) {
  const out = []
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const cs = getComputedStyle(n)
    const why = []
    if (cs.transform && cs.transform !== 'none') why.push('transform')
    if (cs.filter && cs.filter !== 'none') why.push('filter:' + cs.filter.slice(0, 28))
    if (cs.backdropFilter && cs.backdropFilter !== 'none') why.push('backdrop-filter')
    if (cs.perspective && cs.perspective !== 'none') why.push('perspective')
    if (/transform|filter|perspective/.test(cs.willChange || '')) why.push('will-change:' + cs.willChange)
    if (/paint|layout|strict|content/.test(cs.contain || '')) why.push('contain:' + cs.contain)
    if (why.length) {
      const tag = n.tagName.toLowerCase() +
        (n.id ? '#' + n.id : '') +
        (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/)[0] : '')
      const r = n.getBoundingClientRect()
      out.push(`${tag}[${why.join('+')}] box=${Math.round(r.top)}..${Math.round(r.bottom)}`)
    }
  }
  return out
}

/** What env(safe-area-inset-*) actually resolves to here, measured rather than assumed. */
function readInsets() {
  const d = document.createElement('div')
  d.style.cssText = 'position:fixed;left:-9999px;top:-9999px;' +
    'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);' +
    'padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)'
  document.body.appendChild(d)
  const cs = getComputedStyle(d)
  const v = {
    top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0, right: parseFloat(cs.paddingRight) || 0,
  }
  d.remove()
  return v
}

const rect = (el) => {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height) }
}

/**
 * Is the layout viewport actually the screen?
 *
 * This is the reading everything else has been standing in for. `screen.height` is the
 * device's own CSS height; `innerHeight` is what the page was given. If the page is SHORTER,
 * then `position: fixed; bottom: 0` cannot reach the bottom of the screen and no amount of
 * CSS will make it — the fix would be in the viewport meta or the installed web-app metadata,
 * not in a stylesheet. Three attempts have now assumed these are the same number.
 */
function screenFacts() {
  const s = window.screen || {}
  return `screen=${s.width}x${s.height} avail=${s.availWidth}x${s.availHeight}` +
    ` inner=${window.innerWidth}x${window.innerHeight}` +
    ` shortBy=${Math.round((s.height || 0) - window.innerHeight)}` +
    ` orient=${(s.orientation && s.orientation.type) || '?'}`
}

/**
 * The bar again, once the shell has settled and once more after the first scroll. Sent as its
 * own record so the two can be read against the opening one.
 */
function scheduleLateSample(nav) {
  let done = false
  const send = (why) => {
    if (done) return
    done = true
    try {
      const r = rect(nav)
      const gap = Math.round(window.innerHeight - (r?.b ?? 0))
      fetch('/api/error', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
        body: JSON.stringify({
          kind: KIND,
          message: `LATE (${why}) nav ${r?.t}..${r?.b} h=${r?.h}, ${gap}px above viewport bottom`,
          stack: `${screenFacts()} | navRect=${JSON.stringify(r)} | ` +
                 `parent=${nav.parentElement?.tagName}#${nav.parentElement?.id || ''} | ` +
                 `pos=${getComputedStyle(nav).position} | scrollY=${window.scrollY} | ` +
                 `mobViewScrollTop=${document.querySelector('.mob-view')?.scrollTop ?? '-'} | ` +
                 `contentScrollTop=${document.getElementById('mobVContent')?.scrollTop ?? '-'}`,
          url: location.pathname,
        }),
      }).catch(() => {})
    } catch {}
  }
  // Whichever comes first: a real scroll settling, or five seconds of sitting still.
  const onScroll = () => { clearTimeout(t2); t2 = setTimeout(() => send('after scroll'), 700) }
  let t2 = setTimeout(() => send('settled'), 5000)
  window.addEventListener('scroll', onScroll, { passive: true, capture: true })
  setTimeout(() => window.removeEventListener('scroll', onScroll, { capture: true }), 30000)
}

/**
 * Measure and send, once. Called after the mobile shell has painted; a second call is a no-op
 * so a re-render cannot spam the log.
 */
let sent = false
export function probeNavGeometry() {
  if (sent) return null
  try {
    const nav = document.querySelector('.mob-v-bottom')
    if (!nav || !nav.offsetParent && getComputedStyle(nav).display === 'none') return null
    sent = true
    // A second reading once things have settled, and a third after the first real scroll.
    // The 400ms sample has said "flush with the bottom" twice while the phone showed a gap,
    // so either the layout moves afterwards or the viewport is not the screen. Both readings
    // go in one record rather than three, so they can be compared.
    scheduleLateSample(nav)

    const ins = readInsets()
    const navR = rect(nav)
    const navCs = getComputedStyle(nav)
    const vv = window.visualViewport
    const de = document.documentElement

    // The single most useful number: how far the bar's bottom edge is from the bottom of the
    // screen. `position: fixed; bottom: 0` should make this zero, whatever the inset.
    const gap = Math.round((vv?.height ?? window.innerHeight) - (navR?.b ?? 0))

    const chain = containingBlockChain(nav)
    const msg = `nav bottom is ${gap}px above the viewport bottom` +
      ` (nav ${navR?.t}..${navR?.b} h=${navR?.h}, vh=${Math.round(vv?.height ?? window.innerHeight)})`

    const stack = [
      screenFacts(),
      `insets t=${ins.top} b=${ins.bottom} l=${ins.left} r=${ins.right}`,
      `innerH=${window.innerHeight} vvH=${Math.round(vv?.height ?? 0)} vvTop=${Math.round(vv?.offsetTop ?? 0)} vvScale=${(vv?.scale ?? 1).toFixed(2)}`,
      `docEl client=${de.clientHeight} scroll=${de.scrollHeight} rect=${Math.round(de.getBoundingClientRect().height)}`,
      `body rect=${Math.round(document.body.getBoundingClientRect().height)} scroll=${document.body.scrollHeight}`,
      `navCss h=${navCs.height} padB=${navCs.paddingBottom} pos=${navCs.position} bottom=${navCs.bottom}`,
      `mobView=${JSON.stringify(rect(document.querySelector('.mob-view')))}`,
      `content=${JSON.stringify(rect(document.getElementById('mobVContent')))}`,
      // The answer, if there is one.
      `fixedContainedBy=${chain.length ? chain.join(' <- ') : 'NOTHING (viewport, as intended)'}`,
      `standalone=${!!(window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches)}`,
      `dpr=${window.devicePixelRatio}`,
    ].join(' | ')

    fetch('/api/error', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ kind: KIND, message: msg, stack, url: location.pathname, ua: navigator.userAgent }),
    }).catch(() => {})
    return { msg, stack }
  } catch { return null }
}
