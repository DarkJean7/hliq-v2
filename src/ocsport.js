// Sports in the Outcomes list: which sport a market is, and the art its section is drawn with.
//
// Asked for: "make popular sports like nba, mlb, futboll, etc more eye captive. if we can have
// some type of official or generic image it would be better" — and, in the same breath, "i
// selected nba finals and it kind of be lost with all types of cards. at the right you can see
// unrelated sports, and more to the right more nba stuff."
//
// So Sports is grouped BY SPORT, each under a banner of its own, futures first and then the games
// by when they close. The art is generic and drawn here (a court, a diamond, a pitch): league
// marks are trademarks, and using them would claim an affiliation the app does not have.
//
// Pure: strings in, strings out. main.js decides where the result goes.

export const SPORTS = {
  basketball: { label: 'Basketball',        glyph: '🏀', a: '#f2732b', b: '#3b1606' },
  football:   { label: 'American Football', glyph: '🏈', a: '#c9822b', b: '#14290f' },
  baseball:   { label: 'Baseball',          glyph: '⚾', a: '#e2453c', b: '#13254d' },
  soccer:     { label: 'Football / Soccer', glyph: '⚽', a: '#22b35e', b: '#06281a' },
  hockey:     { label: 'Hockey',            glyph: '🏒', a: '#4cb8ef', b: '#0b2236' },
  tennis:     { label: 'Tennis',            glyph: '🎾', a: '#b6dc3a', b: '#1d3010' },
  motorsport: { label: 'Motorsport',        glyph: '🏎️', a: '#e8423b', b: '#1f1012' },
  combat:     { label: 'Fighting',          glyph: '🥊', a: '#e0344f', b: '#2a0d14' },
  golf:       { label: 'Golf',              glyph: '⛳', a: '#5fc25a', b: '#0f2a12' },
  cricket:    { label: 'Cricket',           glyph: '🏏', a: '#d6b24a', b: '#1f2a12' },
  esports:    { label: 'Esports',           glyph: '🎮', a: '#8f6cf0', b: '#170f33' },
  other:      { label: 'More sports',       glyph: '🏆', a: '#d9a93b', b: '#241a08' },
}
// Biggest audiences first when two have the same number of markets.
export const SPORT_ORDER = ['basketball', 'football', 'soccer', 'baseball', 'hockey', 'tennis', 'motorsport', 'combat', 'golf', 'cricket', 'esports', 'other']

const KIND = [
  ['basketball', /\bnba\b|\bwnba\b|basketball|euroleague|ncaab\b|march madness/i],
  ['football',   /\bnfl\b|american football|super ?bowl|ncaaf\b|college football/i],
  ['baseball',   /\bmlb\b|baseball|world series/i],
  ['hockey',     /\bnhl\b|hockey|stanley cup/i],
  ['soccer',     /soccer|premier league|champions league|europa league|la ?liga|serie a|bundesliga|ligue 1|\bmls\b|\buefa\b|\bfifa\b|world cup|copa|eredivisie|\bepl\b/i],
  ['tennis',     /tennis|wimbledon|roland garros|us open|australian open|\batp\b|\bwta\b/i],
  ['motorsport', /\bf1\b|formula ?1|grand prix|nascar|motogp|indycar/i],
  ['combat',     /\bufc\b|\bmma\b|boxing/i],
  ['golf',       /golf|\bpga\b|the masters|ryder cup/i],
  ['cricket',    /cricket|\bipl\b/i],
  ['esports',    /esports|league of legends|counter-strike|\bcs2\b|dota|valorant/i],
]

// `sport` is Hyperliquid's own field; everything else is any text known about the market.
export function sportOf(sport, ...text) {
  const sp = String(sport ?? '').trim()
  // Plain "football" is the NFL in Hyperliquid's data; soccer is "Soccer" or "football/soccer".
  if (/^football$/i.test(sp)) return 'football'
  if (/soccer/i.test(sp)) return 'soccer'
  const all = [sp, ...text].filter(Boolean).join(' ')
  for (const [k, re] of KIND) if (re.test(all)) return k
  return 'other'
}

const LEAGUES = [
  [/\bwnba\b/i, 'WNBA'], [/\bnba\b/i, 'NBA'], [/euroleague/i, 'EuroLeague'], [/\bnfl\b|super ?bowl/i, 'NFL'],
  [/\bmlb\b|world series/i, 'MLB'], [/\bnhl\b|stanley cup/i, 'NHL'], [/premier league|\bepl\b/i, 'Premier League'],
  [/champions league/i, 'Champions League'], [/europa league/i, 'Europa League'], [/la ?liga/i, 'LaLiga'],
  [/serie a/i, 'Serie A'], [/bundesliga/i, 'Bundesliga'], [/ligue 1/i, 'Ligue 1'], [/\bmls\b/i, 'MLS'],
  [/world cup/i, 'World Cup'], [/nations league/i, 'Nations League'], [/\bncaa\b/i, 'NCAA'], [/\bufc\b/i, 'UFC'], [/\bf1\b|formula ?1/i, 'F1'],
]
// The league named in the text, or null — the banner lists the ones present ("NBA · EuroLeague").
export function leagueOf(...text) {
  const s = text.filter(Boolean).join(' ')
  for (const [re, name] of LEAGUES) if (re.test(s)) return name
  return null
}

// Generic field art, white lines on the sport's colours. viewBox 0 0 200 100, drawn on the right
// of the banner and faded so the title stays the thing you read.
const ART = {
  basketball: '<rect x="4" y="4" width="192" height="92" rx="3"/><line x1="100" y1="4" x2="100" y2="96"/><circle cx="100" cy="50" r="15"/><path d="M4 30h34v40H4M196 30h-34v40h34"/><path d="M38 38a12 12 0 0 1 0 24M162 38a12 12 0 0 0 0 24"/><path d="M4 12q70 38 0 76M196 12q-70 38 0 76"/>',
  football:   '<rect x="4" y="4" width="192" height="92" rx="3"/><path d="M22 4v92M178 4v92"/>' + [40, 58, 76, 94, 112, 130, 148, 166].map(x => `<line x1="${x}" y1="4" x2="${x}" y2="96"/>`).join('') + '<path d="M8 44v12M192 44v12"/>',
  baseball:   '<path d="M100 92 L40 40 Q100 -14 160 40 Z"/><path d="M100 80 L80 60 L100 40 L120 60 Z"/><circle cx="100" cy="61" r="4"/><path d="M100 92L4 4M100 92L196 4"/>',
  soccer:     '<rect x="4" y="4" width="192" height="92" rx="3"/><line x1="100" y1="4" x2="100" y2="96"/><circle cx="100" cy="50" r="16"/><circle cx="100" cy="50" r="1.5"/><path d="M4 26h28v48H4M196 26h-28v48h28M4 38h10v24H4M196 38h-10v24h10"/><path d="M32 40a10 10 0 0 1 0 20M168 40a10 10 0 0 0 0 20"/>',
  hockey:     '<rect x="4" y="4" width="192" height="92" rx="28"/><line x1="100" y1="4" x2="100" y2="96"/><line x1="72" y1="4" x2="72" y2="96"/><line x1="128" y1="4" x2="128" y2="96"/><circle cx="100" cy="50" r="13"/><circle cx="40" cy="30" r="9"/><circle cx="40" cy="70" r="9"/><circle cx="160" cy="30" r="9"/><circle cx="160" cy="70" r="9"/>',
  tennis:     '<rect x="4" y="10" width="192" height="80"/><path d="M4 20h192M4 80h192"/><line x1="100" y1="10" x2="100" y2="90"/><path d="M52 20v60M148 20v60M52 50h96"/>',
  golf:       '<path d="M10 80q50-40 100-20t80-30"/><circle cx="160" cy="40" r="10"/><path d="M160 40V8l18 7-18 7"/>',
  motorsport: '<path d="M10 70q20-60 60-40t50 30 60-40"/><path d="M10 82q20-60 60-40t50 30 60-40"/>',
}
export function sportArt(kind) {
  const g = ART[kind]
  return g ? `<svg class="oc-sport-art" viewBox="0 0 200 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6">${g}</svg>` : ''
}

// The banner over one sport's markets. `leagues` = the league names among them.
export function sportHeadHtml(kind, count, leagues = [], esc = (s) => s) {
  const s = SPORTS[kind] ?? SPORTS.other
  const sub = [...new Set(leagues.filter(Boolean))].slice(0, 4).join(' · ')
  return `<div class="oc-sport-head oc-sub-head" data-sport="${kind}" data-sub="${kind}" style="--sp-a:${s.a};--sp-b:${s.b}">` +
    sportArt(kind) +
    `<span class="oc-sport-glyph">${s.glyph}</span>` +
    `<span class="oc-sport-txt"><span class="oc-sport-name">${esc(s.label)}</span>${sub ? `<span class="oc-sport-leagues">${esc(sub)}</span>` : ''}</span>` +
    `<span class="oc-sport-n">${count} market${count === 1 ? '' : 's'}</span><span class="oc-sec-chev" aria-hidden="true"></span></div>`
}

// Futures first (who wins the league), biggest first; then the games, soonest first.
export function sportOrder(cards) {
  const isEvt = (c) => (c.isEvent ? 1 : 0)
  return [...cards].sort((a, b) => (isEvt(b) - isEvt(a)) ||
    (isEvt(a) ? (b.oi ?? 0) - (a.oi ?? 0) : (a.close ?? Infinity) - (b.close ?? Infinity)))
}

// A match's name from its legs: "Denmark vs Norway", not "Sports Contest Result".
export function matchTitle(legs) {
  const t = (legs ?? []).map(s => String(s ?? '').trim()).filter(s => s && !/^(draw|tie)$/i.test(s))
  return t.length >= 2 && t.length <= 3 ? t.join(' vs ') : null
}
