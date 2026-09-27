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
 * simply pass through; the rest are the handful below, where one shell splits a screen the
 * other keeps whole:
 *
 *   overview    → positions   Desktop opens on an Overview the phone does not have. Its
 *                             phone equivalent is the home screen, which is the positions
 *                             list. (Not the reverse: a phone showing positions means
 *                             positions, and desktop has that tab.)
 *   orders      → positions   The phone gives resting orders their own screen; on desktop
 *                             they are a table under Positions.
 *   heatmap     → allocation  Two segments of one screen on desktop.
 *   attribution → portfolio   "What moved your account" is a phone screen of its own and a
 *                             panel of the desktop Portfolio tab.
 *
 * Anything with no equivalent falls back to that shell's own landing page rather than to a
 * tab that does not exist — a blank panel is worse than the Home this was meant to stop.
 */

export const DESK_DEFAULT = 'overview'
export const MOB_DEFAULT  = 'positions'

/** Phone screen → desktop tab, for the names that differ. */
export const TO_DESKTOP = {
  orders:      'positions',
  heatmap:     'allocation',
  attribution: 'portfolio',
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
 * `isValid` answers whether a desktop tab exists — the caller checks the DOM for its panel,
 * so a tab that is renamed or removed degrades to the landing page instead of switching to
 * nothing. Same for `toMobile` below.
 */
export function toDesktop(mobTab, isValid = () => true) {
  const name = String(mobTab ?? '')
  if (name && isValid(name)) return name
  const mapped = TO_DESKTOP[name]
  if (mapped && isValid(mapped)) return mapped
  return DESK_DEFAULT
}

/** The phone screen that shows what the desktop was showing. */
export function toMobile(deskTab, isValid = () => true) {
  const name = String(deskTab ?? '')
  const mapped = TO_MOBILE[name]
  if (mapped && isValid(mapped)) return mapped
  if (name && isValid(name)) return name
  return MOB_DEFAULT
}
