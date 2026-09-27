/**
 * INSOLVENT TERMINAL — keeping your place across the two shells
 *
 * The app is two shells over one state: desktop drives `switchTab`, mobile drives
 * `_mobVActiveTab`, and they have their own vocabularies for the same screens. Turning the
 * phone, or flipping the Mobile layout switch in Settings, swapped shells and landed you on
 * whatever each one happened to be showing — in practice Home, every time. Reported as:
 * "its annoying changing modes and encountering home."
 *
 * So a switch carries the view across. Most names are already the same on both sides and
 * simply pass through; the rest are below, where one shell splits a screen the other keeps
 * whole, or keeps a screen the other does not have at all.
 *
 * ── the trap this walked into first ──
 *
 * index.html has a `tab-positions` panel and a `tab-spot` panel, and NOTHING opens either:
 * no nav button, no switchTab call anywhere in the app. They are leftovers. Sending the
 * phone's home screen (which is its positions list) to the same-named desktop panel landed
 * the reader on an orphan — reported as: "instead of displaying overview it displays 'Open
 * orders'? which is not even a tab by its own".
 *
 * So a name only passes through when desktop has a NAV TAB for it. Everything else goes
 * through the map, whose destinations are all places the app itself can open:
 *
 *   positions   → overview    The phone's home screen. Desktop's home is the Overview.
 *   orders      → trade       Desktop keeps open orders in the Trade tab's manage tables.
 *   spot        → overview    The desktop spot panel is one of the orphans; the Overview is
 *                             where holdings are summarised.
 *   heatmap     → allocation  Two segments of one desktop screen.
 *   attribution → portfolio   "What moved your account" is a phone screen of its own and a
 *                             panel of the desktop Portfolio tab.
 *   accounts    → accounts    All Accounts has no nav button either — the account switcher
 *                             opens it — but switchTab knows it, so it is named here.
 *   overview    → positions   Coming back the other way: the phone has no Overview, and its
 *                             home screen is the nearest thing.
 *
 * Anything with no equivalent falls back to that shell's own landing page rather than to a
 * tab that does not exist — a blank panel is worse than the Home this was meant to stop.
 */

export const DESK_DEFAULT = 'overview'
export const MOB_DEFAULT  = 'positions'

/** Phone screen → desktop tab: the names that differ, and the ones with no nav tab. */
export const TO_DESKTOP = {
  positions:   'overview',
  orders:      'trade',
  spot:        'overview',
  heatmap:     'allocation',
  attribution: 'portfolio',
  accounts:    'accounts',
  home:        'overview',
}

/** Desktop tab → phone screen, for the names that differ. */
export const TO_MOBILE = {
  overview: 'positions',
}

/**
 * The screens the phone shell can render — the union of what its three routers accept
 * (`mobVTab` on the home strip, `mobVGoTab` on the bottom nav, `__mobMoreTab` in the menu)
 * plus the ones only reachable in passing. A name that is not here has no phone screen, and
 * asking for it would paint an empty content area.
 */
export const MOB_VIEWS = new Set([
  'positions', 'orders', 'spot', 'outcomes', 'accounts', 'attribution',
  'portfolio', 'watch', 'strategies', 'trades', 'leaderboard', 'calendar', 'tokens',
  'performance', 'transfers', 'settings', 'trade', 'pulse', 'analysis', 'allocation',
  'heatmap', 'replay', 'simulator',
])

/**
 * The desktop tab that shows what the phone was showing.
 *
 * `hasNav` answers whether desktop offers that tab in its nav — the test a pass-through has
 * to meet, because a panel with no way in is not a destination. `hasPanel` answers whether
 * the panel exists at all, which is what the map's own destinations are checked against
 * (All Accounts has no nav button and is still a real place). Both are asked of the DOM by
 * the caller, so a tab renamed out of index.html degrades to the landing page rather than
 * switching to nothing.
 */
export function toDesktop(mobTab, { hasNav = () => true, hasPanel = () => true } = {}) {
  const name = String(mobTab ?? '')
  const mapped = TO_DESKTOP[name]
  if (mapped) return hasPanel(mapped) ? mapped : DESK_DEFAULT
  return name && hasNav(name) ? name : DESK_DEFAULT
}

/** The phone screen that shows what the desktop was showing. */
export function toMobile(deskTab, isValid = () => true) {
  const name = String(deskTab ?? '')
  const mapped = TO_MOBILE[name]
  if (mapped && isValid(mapped)) return mapped
  if (name && isValid(name)) return name
  return MOB_DEFAULT
}
