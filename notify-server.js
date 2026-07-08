import express   from 'express'
import webpush   from 'web-push'
import fs        from 'fs'
import path      from 'path'
import https     from 'https'
import { fileURLToPath } from 'url'

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const SUBS_FILE  = path.join(__dirname, 'data', 'subscriptions.json')

const VAPID_PUBLIC  = 'BLspXxgXQYJsr0J672DRQr2tgKt0rVXdVft0MEeuLwb5rfEB7IsAfUjqxvF2pMwii9tvkuIFRa_Ku5dG9z1NZoQ'
const VAPID_PRIVATE = 'N-mh41CQYddkMFm-V9CxCvqnw3EpCfusiXI0Ui9kQrY'

webpush.setVapidDetails('mailto:admin@insolvent.trade', VAPID_PUBLIC, VAPID_PRIVATE)

// ─── SUBSCRIPTION STORE ───────────────────────────────────────────────────────

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/

function loadSubs() {
  try {
    const subs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'))
    // Drop malformed wallets defensively — a bad addr persisted to disk must not
    // be able to take down the poll loop on every restart.
    return subs.filter(s => s?.subscription?.endpoint).map(s => ({
      ...s,
      wallets: (s.wallets ?? []).filter(w => typeof w?.addr === 'string' && ADDR_RE.test(w.addr)),
    }))
  } catch { return [] }
}

function saveSubs(subs) {
  fs.mkdirSync(path.dirname(SUBS_FILE), { recursive: true })
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2))
}

// ─── LEADERBOARD STORE ────────────────────────────────────────────────────────

const LB_FILE  = path.join(__dirname, 'data', 'leaderboard.json')
const PIN_FILE = path.join(__dirname, 'data', 'lb-pin.txt')

function loadLB()    { try { return JSON.parse(fs.readFileSync(LB_FILE, 'utf8')) } catch { return [] } }
function saveLB(d)   { fs.mkdirSync(path.dirname(LB_FILE), { recursive: true }); fs.writeFileSync(LB_FILE, JSON.stringify(d, null, 2)) }
function getPin()    { try { return fs.readFileSync(PIN_FILE, 'utf8').trim() } catch { return null } }
function checkPin(p) { const s = getPin(); if (!s) { fs.mkdirSync(path.dirname(PIN_FILE), { recursive: true }); fs.writeFileSync(PIN_FILE, p); return true } return s === p }

// ─── HYPERLIQUID HEALTH FETCH ─────────────────────────────────────────────────

function hlPost(type, addr) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ type, user: addr })
    const req  = https.request({
      hostname: 'api.hyperliquid.xyz',
      path:     '/info',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = ''
      res.on('data', d => data += d)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { reject(new Error('parse')) }
      })
    })
    req.on('error', reject)
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(body)
    req.end()
  })
}

async function fetchClearinghouse(addr) {
  const parsed = await hlPost('clearinghouseState', addr)
  if (parsed?.error || (!parsed?.crossMarginSummary && !parsed?.marginSummary)) throw new Error('bad response')
  return parsed
}

async function fetchSpotUSDC(addr) {
  try {
    const parsed = await hlPost('spotClearinghouseState', addr)
    const usdc   = (parsed?.balances ?? []).find(b => b.coin === 'USDC')
    return Math.max(0, parseFloat(usdc?.total ?? 0))
  } catch { return 0 }
}

function healthPct(cs, usdcTotal = 0) {
  // Health = 100 − HL's Unified Account Ratio (maint margin / unified USDC
  // balance — which already contains perp equity on unified accounts).
  // Falls back to perp equity for non-unified accounts.
  const perpAcct = parseFloat(cs?.marginSummary?.accountValue)
  const maint    = parseFloat(cs?.crossMaintenanceMarginUsed ?? 0)
  const base     = usdcTotal > 0 ? usdcTotal : perpAcct
  // Return null on bad data — caller skips notification rather than false-triggering
  if (!isFinite(base) || base <= 0) return null
  if (!isFinite(maint)) return null
  return Math.max(0, (1 - maint / base) * 100)
}

// HL maintenance margin per position ≈ notional / (2 × maxLeverage).
function estMaint(p, markPx) {
  const pv  = Math.abs(parseFloat(p.positionValue ?? (Math.abs(parseFloat(p.szi ?? 0)) * markPx)))
  const mlv = parseFloat(p.maxLeverage ?? p.leverage?.value ?? 1) || 1
  return pv / (2 * mlv)
}

// Per-position health — MUST match the app's position health bar so the alert
// threshold lines up with what the user sees. CROSS positions share the whole
// account's margin, so each gets its SHARE of the account maintenance against the
// unified balance — a single cross position's health therefore equals the account
// Health (HL Unified Account Ratio). ISOLATED positions have their own margin, so
// they use the liq-distance metric (100% at entry, 0% at liquidation). Falls back
// to ROE-based health when there's no liquidation price.
function positionHealth(p, markPx, ctx) {
  const isCross = (p.leverage?.type ?? 'cross') !== 'isolated'
  if (isCross && ctx && ctx.marginBase > 0 && ctx.sumEstMaint > 0) {
    const share   = estMaint(p, markPx) / ctx.sumEstMaint
    const mmShare  = ctx.crossMaint * share
    return Math.max(0, Math.min(100, (1 - mmShare / ctx.marginBase) * 100))
  }
  const liqPx   = parseFloat(p.liquidationPx ?? 0)
  const entryPx = parseFloat(p.entryPx ?? 0)
  const isLong  = parseFloat(p.szi) > 0
  const roe     = parseFloat(p.returnOnEquity) * 100
  if (liqPx > 0 && entryPx > 0 && markPx > 0) {
    if (isLong && entryPx > liqPx)  return Math.max(0, Math.min(100, (markPx - liqPx) / (entryPx - liqPx) * 100))
    if (!isLong && liqPx > entryPx) return Math.max(0, Math.min(100, (liqPx - markPx) / (liqPx - entryPx) * 100))
    return 100
  }
  return Math.max(0, Math.min(100, (isFinite(roe) ? roe : 0) + 100))
}

// Lowest-health (closest to liquidation) open position. Returns null when there
// are no open positions. Needs the unified USDC balance to compute cross health.
function worstPositionHealth(cs, usdcTotal = 0) {
  const positions = (cs?.assetPositions ?? [])
    .map(ap => ap?.position)
    .filter(p => p && isFinite(parseFloat(p.szi)) && parseFloat(p.szi) !== 0
                   && isFinite(parseFloat(p.positionValue)) && Math.abs(parseFloat(p.positionValue)) > 0)
  if (!positions.length) return null
  const markOf      = p => Math.abs(parseFloat(p.positionValue)) / Math.abs(parseFloat(p.szi))
  const crossMaint  = parseFloat(cs?.crossMaintenanceMarginUsed ?? 0)
  const perpAcct    = parseFloat(cs?.marginSummary?.accountValue ?? 0)
  const marginBase  = usdcTotal > 0 ? usdcTotal : perpAcct
  const sumEstMaint = positions.reduce((s, p) => s + estMaint(p, markOf(p)), 0)
  const ctx         = { crossMaint, marginBase, sumEstMaint }
  let worst = null
  for (const p of positions) {
    const markPx = markOf(p)
    const health = positionHealth(p, markPx, ctx)
    if (worst == null || health < worst.health) {
      worst = { coin: p.coin, health, liqPx: parseFloat(p.liquidationPx ?? 0), markPx, side: parseFloat(p.szi) > 0 ? 'long' : 'short' }
    }
  }
  return worst
}

// ─── POLL LOOP ────────────────────────────────────────────────────────────────

const lastFired     = new Map() // `${endpoint}:${addr}` → timestamp
const lowStreak     = new Map() // `${addr}` → consecutive below-threshold count
const lowStreakLiq  = new Map() // `${addr}` → consecutive near-liquidation count
const CONFIRM_COUNT = 3         // must be low for this many polls in a row before alerting
const CONFIRM_LIQ   = 2         // liquidation is urgent — confirm faster
// Per-subscription cooldown (user-selected "alert frequency"); default 60 min
const subCooldownMs = sub => Math.max(5, parseInt(sub.cooldownMin) || 60) * 60 * 1000

async function checkAndNotify() {
  const subs = loadSubs()
  if (!subs.length) return

  const allAddrs = [...new Set(subs.flatMap(s => (s.wallets ?? []).map(w => w.addr)))]
  const healthMap = {}
  const liqMap    = {}

  // Prune state for endpoints/addresses no longer subscribed so the Maps don't
  // grow for the lifetime of the process.
  const liveEndpoints = new Set(subs.map(s => s.subscription.endpoint))
  const liveAddrs     = new Set(allAddrs)
  for (const key of lastFired.keys()) {
    const ep = key.startsWith('liq:') ? key.slice(4, key.lastIndexOf(':')) : key.slice(0, key.lastIndexOf(':'))
    if (!liveEndpoints.has(ep)) lastFired.delete(key)
  }
  for (const addr of lowStreak.keys())    if (!liveAddrs.has(addr)) lowStreak.delete(addr)
  for (const addr of lowStreakLiq.keys()) if (!liveAddrs.has(addr)) lowStreakLiq.delete(addr)

  await Promise.all(allAddrs.map(async addr => {
    try {
      const [cs, usdcTotal] = await Promise.all([fetchClearinghouse(addr), fetchSpotUSDC(addr)])
      const health   = healthPct(cs, usdcTotal)
      const perpAcct = parseFloat(cs?.marginSummary?.accountValue)
      const maint    = parseFloat(cs?.crossMaintenanceMarginUsed ?? 0)
      const liq      = worstPositionHealth(cs, usdcTotal)
      console.log(`[health] ${addr.slice(0,8)}… perp=$${perpAcct?.toFixed(2)} usdc=$${usdcTotal.toFixed(2)} maint=$${maint?.toFixed(2)} health=${health != null ? health.toFixed(2) + '%' : 'NULL'} posHealth=${liq ? liq.coin + ' ' + liq.health.toFixed(1) + '%' : 'none'}`)
      healthMap[addr] = health
      liqMap[addr]    = liq ?? null // null = fetched but no position; undefined = fetch failed
    } catch (e) {
      console.log(`[health] ${addr.slice(0,8)}… FETCH ERROR: ${e.message}`)
    }
  }))

  // Update health streaks — only for addresses we got valid data for
  for (const addr of allAddrs) {
    const health = healthMap[addr]
    if (health == null) continue // bad data — don't reset streak, don't increment
    // streak increments if health is below ANY subscription's threshold for this addr
    const thresholds = subs.flatMap(s => (s.wallets ?? []).filter(w => w.addr === addr).map(() => s.threshold ?? 50))
    const maxThreshold = Math.max(...thresholds)
    if (health <= maxThreshold) {
      lowStreak.set(addr, (lowStreak.get(addr) || 0) + 1)
    } else {
      lowStreak.set(addr, 0)
    }
  }

  // Update position-health streaks — health below ANY enabled sub's threshold
  for (const addr of allAddrs) {
    if (!(addr in liqMap)) continue       // fetch failed — leave streak untouched
    const liq = liqMap[addr]
    const liqThresholds = subs
      .filter(s => s.liqEnabled)
      .flatMap(s => (s.wallets ?? []).filter(w => w.addr === addr).map(() => s.liqThreshold ?? 20))
    if (!liqThresholds.length || liq == null) { lowStreakLiq.set(addr, 0); continue }
    const maxLiqT = Math.max(...liqThresholds)
    if (liq.health <= maxLiqT) {
      lowStreakLiq.set(addr, (lowStreakLiq.get(addr) || 0) + 1)
    } else {
      lowStreakLiq.set(addr, 0)
    }
  }

  const now     = Date.now()
  const expired = []

  for (const sub of subs) {
    if (sub.healthEnabled === false) continue    // account-health alerts disabled for this sub
    if ((sub.mutedUntil ?? 0) > now) continue   // user hit "Mute" on a notification
    const threshold = sub.threshold ?? 50
    for (const w of (sub.wallets ?? [])) {
      const health = healthMap[w.addr]
      if (health == null || health > threshold) continue

      // Require at least CONFIRM_COUNT consecutive low readings before alerting
      if ((lowStreak.get(w.addr) || 0) < CONFIRM_COUNT) continue

      const key = `${sub.subscription.endpoint}:${w.addr}`
      if (now - (lastFired.get(key) || 0) < subCooldownMs(sub)) continue
      lastFired.set(key, now)

      const label   = w.label || (w.addr.slice(0, 6) + '…' + w.addr.slice(-4))
      const payload = JSON.stringify({
        title: `⚠ Health Alert — ${label}`,
        body:  `Account health at ${health.toFixed(1)}% (threshold ${threshold}%)`,
        tag:   'hliq-health-' + w.addr,
      })

      try {
        await webpush.sendNotification(sub.subscription, payload)
        console.log(`[notify] pushed health=${health.toFixed(1)}% to ${label}`)
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          expired.push(sub.subscription.endpoint)
        } else {
          console.warn('[notify] send error:', err.message)
        }
      }
    }
  }

  // Per-position health alerts
  for (const sub of subs) {
    if (!sub.liqEnabled) continue
    if ((sub.mutedUntil ?? 0) > now) continue   // user hit "Mute" on a notification
    const liqT = sub.liqThreshold ?? 20
    for (const w of (sub.wallets ?? [])) {
      const liq = liqMap[w.addr]
      if (!liq || liq.health > liqT) continue

      if ((lowStreakLiq.get(w.addr) || 0) < CONFIRM_LIQ) continue

      const key = `liq:${sub.subscription.endpoint}:${w.addr}`
      if (now - (lastFired.get(key) || 0) < subCooldownMs(sub)) continue
      lastFired.set(key, now)

      const label   = w.label || (w.addr.slice(0, 6) + '…' + w.addr.slice(-4))
      const payload = JSON.stringify({
        title: `🚨 Position Health — ${label}`,
        body:  `${liq.coin} ${liq.side} health at ${liq.health.toFixed(1)}% (liq $${liq.liqPx})`,
        tag:   'hliq-liq-' + w.addr,
      })

      try {
        await webpush.sendNotification(sub.subscription, payload)
        console.log(`[notify] pushed posHealth=${liq.coin} ${liq.health.toFixed(1)}% to ${label}`)
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          expired.push(sub.subscription.endpoint)
        } else {
          console.warn('[notify] send error:', err.message)
        }
      }
    }
  }

  if (expired.length) {
    saveSubs(loadSubs().filter(s => !expired.includes(s.subscription.endpoint)))
  }
}

// ─── EXPRESS API ──────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())

app.get('/notify/vapid-public', (_req, res) => res.json({ key: VAPID_PUBLIC }))

// Stub for legacy /api/status poll — server-side strategies no longer run
app.get('/api/status', (_req, res) => res.json({ insolvent: false, dca: false, grid: false, trend: false, longer: false, shorter: false }))

app.get('/api/leaderboard', (_req, res) => res.json(loadLB()))

app.post('/api/leaderboard', (req, res) => {
  const pin = req.headers['x-lb-pin'] || ''
  if (!pin || !checkPin(pin)) return res.status(403).json({ error: 'wrong pin' })
  const { addrs } = req.body
  if (!Array.isArray(addrs)) return res.status(400).json({ error: 'addrs must be array' })
  saveLB(addrs)
  res.json({ ok: true })
})

app.post('/notify/subscribe', (req, res) => {
  const { subscription, wallets, healthEnabled, threshold, liqEnabled, liqThreshold, cooldownMin } = req.body
  if (!subscription?.endpoint || !Array.isArray(wallets) || !wallets.length) {
    return res.status(400).json({ error: 'Missing fields' })
  }
  if (!wallets.every(w => typeof w?.addr === 'string' && ADDR_RE.test(w.addr))) {
    return res.status(400).json({ error: 'Invalid wallet address' })
  }
  const subs = loadSubs().filter(s => s.subscription.endpoint !== subscription.endpoint)
  subs.push({
    subscription,
    wallets,
    // Default true so older clients that don't send the flag keep getting health alerts.
    healthEnabled: healthEnabled !== false,
    threshold:    parseInt(threshold) || 50,
    liqEnabled:   !!liqEnabled,
    liqThreshold: parseInt(liqThreshold) || 20,
    cooldownMin:  parseInt(cooldownMin) || 60,
    updatedAt:    new Date().toISOString(),
  })
  saveSubs(subs)
  console.log(`[notify] subscribed ${wallets.length} wallet(s), health=${healthEnabled !== false ? '≤' + threshold + '%' : 'off'} liq=${liqEnabled ? '≤' + liqThreshold + '%' : 'off'} every≥${parseInt(cooldownMin) || 60}min`)
  res.json({ ok: true })
})

// Mute all alerts for this device for N minutes (from the notification's
// "Mute" action button or the in-app button)
app.post('/notify/mute', (req, res) => {
  const { endpoint, minutes } = req.body
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' })
  const mins = Math.min(7 * 24 * 60, Math.max(5, parseInt(minutes) || 1440))
  const subs = loadSubs()
  const sub  = subs.find(s => s.subscription.endpoint === endpoint)
  if (!sub) return res.status(404).json({ error: 'No subscription' })
  sub.mutedUntil = Date.now() + mins * 60 * 1000
  saveSubs(subs)
  console.log(`[notify] muted for ${mins} min`)
  res.json({ ok: true, mutedUntil: sub.mutedUntil })
})

app.post('/notify/unsubscribe', (req, res) => {
  const { endpoint } = req.body
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' })
  saveSubs(loadSubs().filter(s => s.subscription.endpoint !== endpoint))
  console.log('[notify] unsubscribed')
  res.json({ ok: true })
})

const PORT = 3001
app.listen(PORT, () => console.log(`[notify] server on :${PORT}`))

// Kick off immediately, then every 60s. A rejected poll must never become an
// unhandled rejection — that would exit the process and kill all alerts.
const safeCheck = () => checkAndNotify().catch(e => console.error('[notify] poll failed:', e))
safeCheck()
setInterval(safeCheck, 60_000)
