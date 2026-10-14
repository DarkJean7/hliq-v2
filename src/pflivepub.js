// Running portfolios, as anyone may see them (server.js GET /api/portfolios/live).
//
// Asked for: "make the running portfolio visible to every user not just to the deployer …
// showing performance, graph, etc. pause, stop … only available for the deployer".
//
// The history comes from the bot's own log: strategies/portfolio.js writes its equity every
// five minutes ("[HOLD] … equity $1003.02", "[EQUITY] $999.72 of $1000"), so every run already
// running has a curve without a restart or a new file.
//
// What is public, and what never is:
//   - a run is public only if its owner made it so; a PAPER run is public by default (no real
//     money), a real-money run private by default (visibilityDefault);
//   - nothing here carries an address, a key or a paper secret — a run is named by an opaque id;
//   - a real-money run is shown in PERCENT only: its return, drawdown and costs relative to its
//     budget, its holdings as shares of the book. Dollar figures and fill sizes are paper-only.
// Pure: text and objects in, objects out — tests/suites/pflivepub.test.mjs.

const LINE = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\] \[([A-Z]+)\s*\] (.*)$/
const tsOf = (d, t) => Date.parse(`${d}T${t}Z`)

/** [[t, equity]] from a portfolio bot's log, from `sinceMs` on (the current run's start). */
export function parseEquity(text, sinceMs = 0) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = LINE.exec(line)
    if (!m) continue
    const t = tsOf(m[1], m[2])
    if (!(t >= sinceMs)) continue
    let eq = null
    if (m[3] === 'EQUITY') { const x = /^\$(-?[\d.]+) of \$/.exec(m[4]); if (x) eq = Number(x[1]) }
    else { const x = /equity \$(-?[\d.]+)/.exec(m[4]); if (x) eq = Number(x[1]) }
    if (Number.isFinite(eq) && eq > 0) out.push([t, eq])
  }
  return out.sort((a, b) => a[0] - b[0])
}

/**
 * What the bot did, newest first: its decisions (REBAL, START, STOP, SKIP, RECONCILE) always,
 * and its fills only when `sizes` (paper, or the owner) — a real account's fill sizes are its
 * position sizes, which are nobody else's business.
 */
export function parseEvents(text, sinceMs = 0, { sizes = false, max = 40 } = {}) {
  const keep = new Set(['REBAL', 'START', 'STOP', 'SKIP', 'RECONCILE', 'WARN', ...(sizes ? ['FILL'] : [])])
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = LINE.exec(line)
    if (!m || !keep.has(m[3])) continue
    const t = tsOf(m[1], m[2])
    if (!(t >= sinceMs)) continue
    // A warning can quote an error from the exchange; that is diagnostics, not a story. Only the
    // ones that explain a skipped trade are kept.
    if (m[3] === 'WARN' && !/did not fill|leverage not set|under \$/.test(m[4])) continue
    // A restart (a deploy, a reboot) logs START again; only the run's own beginning is news.
    if (m[3] === 'START' && t - sinceMs > 120_000) continue
    out.push({ t, kind: m[3], text: m[4].slice(0, 200) })
  }
  return out.sort((a, b) => b.t - a.t).slice(0, max)
}

/**
 * Each market's average entry, from the bot's own fills since the run began ("BUY 0.39 HYPE @
 * $86.36", "SELL 4.3 UNI @ $7.70"). A reduce keeps the entry; past zero it flips to the fill's
 * price. → { coin: { units, entry } }. Only what the log shows: a market with no fill here has
 * no entry, never a guessed one.
 */
export function entriesFrom(text, sinceMs = 0) {
  const pos = {}
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = LINE.exec(line)
    if (!m || m[3] !== 'FILL') continue
    if (!(tsOf(m[1], m[2]) >= sinceMs)) continue
    const f = /^(BUY|SELL)\s+([\d.]+)\s+(\S+)\s+@\s+\$([\d.]+)/.exec(m[4])
    if (!f) continue
    const d = (f[1] === 'BUY' ? 1 : -1) * Number(f[2]), px = Number(f[4]), c = f[3]
    if (!(px > 0) || !d) continue
    const p = pos[c] ?? { units: 0, entry: 0 }
    if (p.units === 0 || Math.sign(p.units) === Math.sign(d)) {
      p.entry = (Math.abs(p.units) * p.entry + Math.abs(d) * px) / (Math.abs(p.units) + Math.abs(d))
      p.units += d
    } else if (Math.abs(d) <= Math.abs(p.units) + 1e-12) {
      p.units += d
      if (Math.abs(p.units) < 1e-12) { p.units = 0; p.entry = 0 }
    } else { p.units += d; p.entry = px }
    pos[c] = p
  }
  return pos
}

/** At most `n` points, keeping the first and last and spreading the rest evenly. */
export function downsample(pts, n) {
  if (!Array.isArray(pts) || pts.length <= n) return pts ?? []
  const out = []
  const step = (pts.length - 1) / (n - 1)
  for (let i = 0; i < n; i++) out.push(pts[Math.round(i * step)])
  return out
}

/** The biggest fall from a high, as a fraction (≤ 0). 0 with fewer than two points. */
export function maxDrawdown(pts) {
  let peak = -Infinity, dd = 0
  for (const [, v] of pts ?? []) { if (v > peak) peak = v; else if (peak > 0) dd = Math.min(dd, v / peak - 1) }
  return dd
}

/** Public unless the owner said otherwise: paper by default, real money never by default. */
export function visibilityDefault(args) { return Array.isArray(args) && args.includes('--paper') }

const argOf = (args, k) => { const i = (args ?? []).indexOf(k); return i >= 0 ? args[i + 1] : null }

/**
 * One run, as the public sees it. `full` adds the detail view's long history and events.
 *   key: 'addr:ID' (never sent), pid: its opaque id, state: the ledger the bot saves,
 *   args: its launch arguments, paused, text: its log since the run began, px: { coin: mid },
 *   owner: true when the asker owns it (dollars and fills shown).
 */
export function publicRun({ pid, state = {}, args = [], paused = false, text = '', px = {}, full = false, owner = false }) {
  const paper = (args ?? []).includes('--paper')
  const money = paper || owner
  const since = Number(state.startedAt) || 0
  const budget = Number(state.budget) || 0
  const eqPts = parseEquity(text, since)
  if (state.equity > 0 && state.at) eqPts.push([Number(state.at), Number(state.equity)])
  eqPts.sort((a, b) => a[0] - b[0])
  const ret = budget > 0 && state.equity > 0 ? state.equity / budget - 1 : null
  // Holdings as position cards: share of what is held (by value where a price is known), the
  // average entry from its fills, the price now, and the move between them. Sizes and dollars
  // only where money is shown (paper, or the owner).
  const units = state.units ?? {}
  const ent = entriesFrom(text, since)
  const vals = Object.entries(units).filter(([, u]) => u).map(([c, u]) => [c, u, Math.abs(u) * (Number(px[c]) || 0)])
  const tot = vals.reduce((s, [, , v]) => s + v, 0)
  const holdings = vals.map(([coin, u, v]) => {
    const mark = Number(px[coin]) > 0 ? Number(px[coin]) : null
    const entry = ent[coin]?.entry > 0 ? ent[coin].entry : null
    const pnlPct = mark && entry ? (mark / entry - 1) * Math.sign(u) : null
    return {
      coin, short: u < 0, share: tot > 0 && v > 0 ? v / tot : null, entry, mark, pnlPct,
      ...(money ? { size: Math.abs(u), value: mark ? v : null, pnl: mark && entry ? u * (mark - entry) : null } : {}),
    }
  }).sort((a, b) => (b.share ?? 0) - (a.share ?? 0))
  const curve = downsample(eqPts.map(([t, v]) => [t, budget > 0 ? v / budget - 1 : 0]), full ? 600 : 60)
  const out = {
    pid, name: String(state.name ?? 'Portfolio').slice(0, 40), strategy: state.strategy ?? argOf(args, '--strategy'),
    lev: argOf(args, '--leverage'), margin: argOf(args, '--margin') ?? 'cross', paper, paused: !!paused,
    startedAt: since || null, updatedAt: Number(state.at) || null,
    ret, maxDd: eqPts.length > 1 ? maxDrawdown(eqPts) : null,
    costPct: budget > 0 && state.fees != null ? Number(state.fees) / budget : null,
    trades: Number(state.trades) || 0, positions: holdings.length, holdings,
    reason: String(state.reason ?? '').slice(0, 160), curve,
    ...(money ? { budget, equity: state.equity ?? null, fees: state.fees ?? null } : {}),
  }
  if (full) out.events = parseEvents(text, since, { sizes: money })
  return out
}
