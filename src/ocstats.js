/**
 * Outcome markets: volume, open interest, and a topic glyph — for sorting, Trending and icons.
 *
 * Asked: "add a filter by open interest, volume, etc. by default sort by open interest. in trending
 * should be the markets with more open interest ... similar as the outcome.xyz website ... the more
 * icons for like nba, football, etc".
 *
 * The numbers come from ONE request. Hyperliquid lists every outcome side in spotMetaAndAssetCtxs
 * as "#<outcome×10 + side>" with its 24h notional volume (dayNtlVlm) and shares outstanding
 * (circulatingSupply). (The app used to say outcomes were not there and fetched candles per card on
 * expand; 716 sides were there when this was written.)
 *
 * Open interest here is contracts outstanding (the larger side's circulatingSupply). It RANKS
 * markets exactly as Hyperliquid's own Open Interest column does (MLB > Premier League > Champions
 * League > NFL when checked), but its dollar figure is not one Hyperliquid publishes a way to
 * reproduce — theirs ran about half of this — so it is used to sort and pick Trending, and not
 * printed as a dollar amount that would disagree with theirs.
 */

/** Map outcomeId -> { vol, oi } from spotMetaAndAssetCtxs' contexts (the array, or the pair). */
export function outcomeStats(spotCtxs) {
  const ctxs = Array.isArray(spotCtxs?.[1]) && !spotCtxs[1].coin ? spotCtxs[1] : spotCtxs
  const out = new Map()
  for (const c of Array.isArray(ctxs) ? ctxs : []) {
    const m = /^#(\d+)$/.exec(String(c?.coin ?? ''))
    if (!m) continue
    const n = Number(m[1]), id = Math.floor(n / 10)
    const vol = parseFloat(c.dayNtlVlm) || 0
    const oi = parseFloat(c.circulatingSupply) || 0
    const e = out.get(id) ?? { vol: 0, oi: 0 }
    // Volume is the "Yes" side's, as Hyperliquid's own market list counts it — checked to the
    // dollar against it (Premier League 21,439; NFL 29,868; MLB 25). Adding the "No" side too
    // came out 2–14× larger.
    if (n % 10 === 0) e.vol += vol
    e.oi = Math.max(e.oi, oi)
    out.set(id, e)
  }
  return out
}

/** A grouped event's figures: its legs added up. Null when none of them is known. */
export function eventStats(ids, stats) {
  let vol = 0, oi = 0, any = false
  for (const id of ids ?? []) {
    const s = stats?.get(Number(id))
    if (!s) continue
    any = true; vol += s.vol; oi += s.oi
  }
  return any ? { vol, oi } : null
}

/** "$1.1M", "$783.1k", "$420". */
export function fmtUsdShort(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M'
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'k'
  return '$' + Math.round(v)
}

/**
 * A glyph for what a non-price market is about: the sport, the competition, the kind of question.
 * `parts` is any text known about it (question name, competition, sport, award, title). Null when
 * nothing matches, so the caller keeps its own fallback.
 */
const GLYPHS = [
  [/\bnba\b|basketball|euroleague|wnba/i,                         '🏀', 28],
  [/\bnfl\b|american football|super bowl|ncaa football/i,         '🏈', 20],
  [/\bmlb\b|baseball|world series/i,                              '⚾', 0],
  [/\bnhl\b|hockey|stanley cup/i,                                 '🏒', 200],
  [/ballon d'or|award|mvp|oscar|grammy|golden (?:boot|ball)/i,    '🏆', 45],
  [/soccer|football|premier league|champions league|europa|la liga|serie a|bundesliga|ligue 1|uefa|fifa|world cup|mls\b|copa/i, '⚽', 130],
  [/tennis|wimbledon|roland garros|us open|australian open|atp|wta/i, '🎾', 75],
  [/\bf1\b|formula|grand prix|nascar|motogp/i,                    '🏎️', 0],
  [/ufc|mma|boxing|fight/i,                                       '🥊', 350],
  [/golf|pga|masters\b|ryder/i,                                   '⛳', 110],
  [/cricket|ipl\b/i,                                              '🏏', 95],
  [/esports|league of legends|\blol\b|cs2|counter-strike|dota|valorant|worlds/i, '🎮', 265],
  [/election|president|senate|parliament|vote|prime minister/i,   '🗳️', 220],
  [/policyrate|federal reserve|fomc|rate decision|interest rate|central bank/i, '🏛️', 218],
  [/weather|temperature|rain|snow|hurricane/i,                    '⛅', 195],
]
export function topicGlyph(...parts) {
  // A `sport` of plain "football" is the NFL in Hyperliquid's data (its NFL games, totals and
  // spreads carry nothing else); soccer is "Soccer" or "football/soccer". Joined into one string
  // it would read as soccer, so it is checked on its own first.
  if (parts.some(p => /^\s*football\s*$/i.test(String(p ?? '')))) return { glyph: '🏈', hue: 20 }
  const s = parts.filter(Boolean).join(' ')
  for (const [re, glyph, hue] of GLYPHS) if (re.test(s)) return { glyph, hue }
  return null
}
