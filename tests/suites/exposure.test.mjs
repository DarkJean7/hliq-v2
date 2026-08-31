import fs from 'fs'
import { computeExposure, exposureFindings, exposureHtml } from 'file:///c:/Users/jeank/OneDrive/Desktop/hliq-v2/src/exposure.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))
const near = (a, b) => Math.abs(a - b) < 1e-6
const fmtUSD = (v, d = 2) => Number(v).toFixed(d)

const pos = (coin, szi, ntl, uPnl = 0) => ({ position: { coin, szi: String(szi), positionValue: String(ntl), unrealizedPnl: String(uPnl) } })
const acct = (label, equity, positions) => ({ label, addr: '0x' + label, accountValue: equity, positions })

// ── the headline case: same coin long on one wallet, short on another ────────
{
  const d = computeExposure([
    acct('A', 1000, [pos('HYPE', 10, 8000)]),
    acct('B', 1000, [pos('HYPE', -6, 5000)]),
  ])
  const h = d.coins.find(c => c.coin === 'HYPE')
  t('net = long − short', near(h.net, 3000), `${h.net}`)
  t('gross = long + short', near(h.gross, 13000))
  t('self-hedged = the offsetting part', near(h.hedged, 5000), `${h.hedged}`)
  t('hedge spans 2 wallets', h.wallets === 2)
  t('total equity summed', near(d.totalEquity, 2000))
  t('net leverage off NET not gross', near(d.netLeverage, 1.5), `${d.netLeverage}`)
  t('gross leverage', near(d.grossLeverage, 6.5))
  const f = exposureFindings(d, fmtUSD)
  t('flags the self-hedge', f.some(x => x.kind === 'warn' && /hedged against itself/.test(x.text)))
  t('flags gross >> net', f.some(x => /not directional exposure/.test(x.text)))
}

// ── no hedge: one wallet, one position ───────────────────────────────────────
{
  const d = computeExposure([acct('A', 1000, [pos('BTC', 1, 5000)])])
  t('single position: hedged is 0', near(d.hedgedNotional, 0))
  t('single position: net == gross', near(Math.abs(d.netDirectional), d.grossNotional))
  const f = exposureFindings(d, fmtUSD)
  t('no self-hedge warning when flat-hedged', !f.some(x => /hedged against itself/.test(x.text)))
  t('states net long', /Net LONG/.test(f[0].text), f[0]?.text)
}

// ── net short reads as SHORT ─────────────────────────────────────────────────
{
  const d = computeExposure([acct('A', 1000, [pos('PUMP', -100, 4000)])])
  t('negative net', d.netDirectional < 0)
  t('states net short', /Net SHORT/.test(exposureFindings(d, fmtUSD)[0].text))
}

// ── perfectly hedged: net zero, gross large — the case worth catching ────────
{
  const d = computeExposure([
    acct('A', 500, [pos('NEAR', 100, 3000)]),
    acct('B', 500, [pos('NEAR', -100, 3000)]),
  ])
  t('net is zero', near(d.netDirectional, 0))
  t('gross is not zero', near(d.grossNotional, 6000))
  t('all of it is self-hedged', near(d.hedgedNotional, 3000))
  t('net leverage 0 despite 6× gross', near(d.netLeverage, 0) && near(d.grossLeverage, 6))
  t('still warns about the hedge', exposureFindings(d, fmtUSD).some(x => /both sides/.test(x.text)))
}

// ── concentration warning ────────────────────────────────────────────────────
{
  const d = computeExposure([acct('A', 1000, [pos('PUMP', -1, 9000), pos('BTC', 1, 500)])])
  t('top coin sorted first by |net|', d.coins[0].coin === 'PUMP')
  t('flags single-coin concentration', exposureFindings(d, fmtUSD).some(x => /% of your net exposure/.test(x.text)))
}

// ── robustness ───────────────────────────────────────────────────────────────
{
  t('no rows → empty', computeExposure([]).coins.length === 0)
  t('undefined → empty', computeExposure(undefined).coins.length === 0)
  const d = computeExposure([
    { error: 'rate limited', addr: '0xX', accountValue: 999, positions: [pos('BTC', 1, 1000)] },
    acct('A', 100, [pos('BTC', 1, 1000)]),
  ])
  t('errored wallet excluded from equity', near(d.totalEquity, 100), `${d.totalEquity}`)
  t('errored wallet excluded from positions', near(d.grossNotional, 1000), `${d.grossNotional}`)

  const z = computeExposure([acct('A', 100, [
    pos('X', 0, 5000),        // closed position (szi 0)
    pos('Y', 1, 0),           // no notional
    { position: {} },         // junk
    null,
  ])])
  t('szi=0 / zero-notional / junk all skipped', z.coins.length === 0)

  const noEq = computeExposure([acct('A', 0, [pos('BTC', 1, 1000)])])
  t('zero equity does not divide by zero', noEq.netLeverage === 0 && Number.isFinite(noEq.grossLeverage))
}

// ── bare-position shape (no .position wrapper) also accepted ─────────────────
{
  const d = computeExposure([{ label: 'A', addr: '0xA', accountValue: 100,
    positions: [{ coin: 'HYPE', szi: '2', positionValue: '500', unrealizedPnl: '3' }] }])
  t('accepts unwrapped position objects', near(d.grossNotional, 500))
}

// ── render: no crash, escapes, and reports the numbers ───────────────────────
{
  const d = computeExposure([
    acct('<img src=x>', 1000, [pos('HYPE', 10, 8000)]),
    acct('B', 1000, [pos('HYPE', -6, 5000)]),
  ])
  const html = exposureHtml(d, fmtUSD)
  t('renders without throwing', typeof html === 'string' && html.length > 200)
  t('escapes wallet labels', !html.includes('<img src=x>') && html.includes('&lt;img'))
  t('shows the SELF-HEDGED badge', html.includes('SELF-HEDGED'))
  t('empty state when nothing open', /No open positions/.test(exposureHtml(computeExposure([]), fmtUSD)))
}

// ── it lives in the Allocation segmented control, not its own overlay ────────
{
  const srcExp  = fs.readFileSync('src/exposure.js', 'utf8')
  const srcMain = fs.readFileSync('src/main.js', 'utf8')
  const html    = fs.readFileSync('index.html', 'utf8')

  // The standalone overlay is gone — that is what shipped broken on mobile, because it
  // re-implemented layering and drawer-dismiss that the Allocation screen already does.
  t('exposure.js owns no overlay', !srcExp.includes('OVERLAY_ID') && !srcExp.includes('document.body.appendChild'))
  t('exposure.js sets no z-index of its own', !/z-index:\s*1000/.test(srcExp))
  t('no leftover openExposure/closeExposure exports',
    !/export function (openExposure|closeExposure)/.test(srcExp))
  const imp = /import \{([^}]*)\} from '\.\/exposure\.js'/.exec(srcMain)?.[1] ?? ''
  t('main.js imports from exposure.js', !!imp)
  t('imports only pure compute/render, no overlay control',
    imp.trim().split(/\s*,\s*/).every(n => /^(computeExposure|exposureHtml|exposureFindings|computeStress|computeUnprotected|stressHtml)$/.test(n)), imp)
  t('no dangling closeExposure reference', !srcMain.includes('__closeExposure'))

  // The tab, and its position between Allocation and What moved.
  const header = /function _allocViewHeader\(\)[\s\S]{0,1400}?\n}/.exec(srcMain)?.[0] ?? ''
  const iAlloc = header.indexOf("tab('allocation'")
  const iExp   = header.indexOf("tab('exposure'")
  const iMov   = header.indexOf("tab('movers'")
  t('header renders an exposure tab', iExp > -1)
  t('exposure sits BETWEEN allocation and what-moved', iAlloc > -1 && iExp > iAlloc && iMov > iExp,
    `alloc=${iAlloc} exp=${iExp} movers=${iMov}`)
  t('the view is routed', srcMain.includes("if (_allocView === 'exposure') { _mobVRenderExposure(el); return }"))
  t('the renderer reuses the shared header', /_mobVRenderExposure[\s\S]{0,300}_allocViewHeader\(\)/.test(srcMain))

  // The More-drawer entry is gone; the shortcut still lands on the right view.
  t('More drawer no longer has its own Exposure button', !html.includes('__openExposure()'))
  t('__openExposure now selects the exposure view', /__openExposure[\s\S]{0,200}_allocView = 'exposure'/.test(srcMain))
  t('__openExposure opens the allocation screen', /__openExposure[\s\S]{0,240}__mobMoreTab\('allocation'\)/.test(srcMain))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
