/**
 * Which bot placed an order — carried on the order itself.
 *
 * Bot Performance used to attribute a trade by the coin it was in: every fill in a market
 * a bot ran on was counted as that bot's, including the account owner's own manual trades
 * there. The numbers were therefore a mix, and nothing on a Hyperliquid fill distinguishes
 * them — bot and manual orders are signed with the same agent key, so the exchange cannot
 * tell you either.
 *
 * Hyperliquid does accept a client order id (`c` on an order request, 32 hex characters),
 * and returns it on the resulting fills. So the bot says who it is at the moment it
 * places, and the fill carries that forever. Exact, and no log parsing.
 *
 * Two properties this has to keep:
 *
 *   - A cloid must be UNIQUE per order, so the identifying part is a fixed prefix and the
 *     rest is random.
 *   - A fill with NO cloid is unknown, not manual. Everything placed before this shipped
 *     has none, and so does anything placed from Hyperliquid's own UI or another client.
 *     `cloidBot` returns null for those, and callers must not read null as "manual" —
 *     that is the empty-is-not-unknown mistake this codebase keeps paying for.
 *
 * Imported by the client (bundled) and by every strategy (`../src/cloid.js` on the
 * server, where src/ and strategies/ sit side by side). Pure: no browser or node APIs.
 */

// Marker chosen to be recognisable in a hex dump and to not collide with anything HL
// itself generates. Three hex characters, reads as "bot".
const MARK = 'b07'

/** Bot type → two hex characters. Append only: changing one orphans past fills. */
export const BOT_CODES = {
  insolvent:   '01',
  dca:         '02',
  grid:        '03',
  ocgrid:      '04',
  twap:        '05',
  trend:       '06',
  accumulator: '07',
  volbreak:    '08',
  copytrade:   '09',
  liqguard:    '0a',
  levbrake:    '0b',
  longer:      '0c',
  shorter:     '0d',
}

/**
 * A fresh client order id for `type`. An unknown or missing type still gets the marker and
 * code '00' — the order is then known to be bot-placed even if we cannot say which bot,
 * which is strictly better than it passing for manual.
 */
export function botCloid(type) {
  const code = BOT_CODES[String(type ?? '').toLowerCase()] ?? '00'
  let rnd = ''
  while (rnd.length < 27) rnd += Math.floor(Math.random() * 16).toString(16)
  return '0x' + MARK + code + rnd.slice(0, 27)
}

/**
 * The bot behind a cloid, or null when it was not one of ours.
 *
 * null covers three different situations that all mean the same thing here: no cloid at
 * all, a cloid from something else, and a malformed one. None of them is a claim that a
 * human placed the order.
 */
export function cloidBot(cloid) {
  if (typeof cloid !== 'string') return null
  const s = cloid.toLowerCase()
  if (!/^0x[0-9a-f]{32}$/.test(s)) return null
  if (s.slice(2, 2 + MARK.length) !== MARK) return null
  const code = s.slice(2 + MARK.length, 2 + MARK.length + 2)
  return Object.keys(BOT_CODES).find(k => BOT_CODES[k] === code) ?? 'other'
}

/** True when this fill was placed by one of our bots. Absence of a cloid is not a no. */
export function isBotFill(fill) { return cloidBot(fill?.cloid) !== null }
