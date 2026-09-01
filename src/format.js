// ─── NUMBER & DATE FORMATTERS ─────────────────────────────────────────────────

/**
 * Format a dollar value with commas and 2 decimal places
 * 1234567.891 → "1,234,567.89"
 */
export function fmtUSD(n, decimals = 2) {
  const f = parseFloat(n) || 0
  return f.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/**
 * Format a price — auto precision based on magnitude
 * 65000.1234 → "65,000.12"
 * 0.00045    → "0.000450"
 */
export function fmtPrice(n) {
  const f = parseFloat(n) || 0
  if (f === 0) return '0.00'
  if (f >= 10000)  return f.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (f >= 1000)   return f.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 })
  if (f >= 1)      return f.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
  if (f >= 0.01)   return f.toFixed(5)
  return f.toFixed(8)
}

/**
 * Format a coin size
 * 0.12345678 → "0.12346"
 * 1234.5     → "1,234.5"
 */
export function fmtSize(n) {
  const f = parseFloat(n) || 0
  if (f === 0) return '0'
  if (Math.abs(f) >= 1000) return f.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
  if (Math.abs(f) >= 1)    return f.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 5 })
  return f.toFixed(6)
}

/**
 * Format a PnL value with sign and color class
 * Returns { text, cls }
 */
export function fmtPnL(n) {
  const f = parseFloat(n) || 0
  const abs = Math.abs(f)
  const sign = f >= 0 ? '+' : '-'
  const cls = f > 0 ? 'pos' : f < 0 ? 'neg' : 'muted'
  return { text: sign + '$' + fmtUSD(abs), cls }
}

/**
 * Format a percentage
 * 0.1234 → "+12.34%"
 */
export function fmtPct(n, alreadyPct = false) {
  const f = parseFloat(n) || 0
  const val = alreadyPct ? f : f * 100
  const sign = val >= 0 ? '+' : ''
  return sign + val.toFixed(2) + '%'
}

/**
 * Compact large numbers
 * 1_200_000 → "1.2M"
 * 45_000    → "45.0K"
 */
export function fmtCompact(n) {
  const f = parseFloat(n) || 0
  if (Math.abs(f) >= 1_000_000_000) return (f / 1_000_000_000).toFixed(2) + 'B'
  if (Math.abs(f) >= 1_000_000)     return (f / 1_000_000).toFixed(2) + 'M'
  if (Math.abs(f) >= 1_000)         return (f / 1_000).toFixed(1) + 'K'
  return fmtUSD(f)
}

/**
 * Format timestamp to readable date
 * 1704067200000 → "Jan 1, 14:32"
 */
export function fmtTime(ms) {
  return new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

/**
 * Short date for chart labels
 */
export function fmtTimeShort(ms) {
  return new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

/**
 * XSS-safe string escape for innerHTML
 */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  )
}

// ─── FILL / FUNDING PARSERS ───────────────────────────────────────────────────

/**
 * Derive clean fill records from raw userFills response.
 */
// Stable identity for a fill, for deduping. HL returns hash = 0x0…0 for a large share
// of fills, so hash can NOT be used as a key; tid is unique per fill, with an oid-based
// composite as the last resort. fetchAllFills dedups its pages with this same formula —
// keep the two in sync so a fill can't be counted once by one path and twice by the other.
export function fillKey(f) {
  return f.tid ?? `${f.time}_${f.oid}_${f.px}_${f.sz}_${f.dir}`
}

export function parseFills(rawFills) {
  return rawFills.map(f => ({
    time:      f.time,
    timeStr:   fmtTime(f.time),
    coin:      f.coin,
    side:      f.side === 'B' ? 'BUY' : 'SELL',
    rawSide:   f.side,
    sz:        parseFloat(f.sz),
    px:        parseFloat(f.px),
    notional:  parseFloat(f.sz) * parseFloat(f.px),
    closedPnl: parseFloat(f.closedPnl ?? 0),
    fee:       parseFloat(f.fee ?? 0),
    feeToken:  f.feeToken ?? 'USDC',
    dir:       f.dir ?? '',
    hash:      f.hash ?? '',
    oid:       f.oid ?? null,   // unique per order — used to collapse partial fills (hash is 0x0…0 for many HL fills)
    tid:       f.tid ?? null,
    // Which bot placed the order, when one did. Undefined for everything placed before
    // bots started stamping it, and for anything placed by hand or from another client --
    // absent means UNKNOWN here, never "a human did it".
    cloid:     f.cloid ?? null,   // unique per fill — last-resort key
  }))
}

/**
 * Derive clean funding records
 */
export function parseFunding(rawFunding) {
  return rawFunding.map(f => ({
    time:        f.time,
    timeStr:     fmtTime(f.time),
    coin:        f.delta?.coin ?? '—',
    usdc:        parseFloat(f.delta?.usdc ?? 0),
    szi:         parseFloat(f.delta?.szi ?? 0),
    fundingRate: f.delta?.fundingRate ?? '—',
  }))
}


/**
 * Is this fill a SPOT trade?
 *
 * Hyperliquid reports a spot fill under its MARKET id — '@107', or a pair name like
 * 'PURR/USDC' — while a perp arrives as the bare coin ('HYPE'). HYPE trades as both, so
 * the display name cannot decide it and the id is the only thing that separates them.
 *
 * Outcome markets ('#N' / '+N') and HIP-3 builder perps ('dex:COIN') are perps, not spot.
 *
 * @param spotNames optional coin→name map, when the caller has one loaded. It is keyed by
 *   '@N' and 'TOKEN/USDC' and never by a bare perp name, so it cannot mislabel a perp. The
 *   shape checks stand alone without it — every spot market in HL's universe is named in
 *   one of those two forms — so it is a belt-and-braces pass, not a requirement.
 */
export function isSpotCoin(coin, spotNames = null) {
  const c = String(coin ?? '')
  if (!c) return false
  if (c[0] === '#' || c[0] === '+') return false   // outcome market
  if (c.includes(':')) return false                // HIP-3 builder perp
  return c[0] === '@' || c.includes('/') || !!(spotNames && spotNames[c])
}
