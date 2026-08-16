// ─── GAME MODE ─────────────────────────────────────────────────────────────────
// The tamagotchi world: pets, den scenes, behavior brain, gestures, asset/skin
// pipeline. Extracted from main.js — talks back through the window.__app bridge
// (late-bound getters set at the end of main.js) plus window.* globals.
import { fmtUSD, fmtPrice, fmtSize, esc } from './format.js'
import { coinLabel } from './api.js'
import { placeMarketOrder, isConnected } from './trading.js'
import { computeAcctStats } from './render.js'

const A = () => window.__app          // main.js bridge (state, helpers)
const S = () => window.__app.state()  // live app state

// Local copies of two tiny main.js helpers (cheaper than bridging)
const jsStr = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;')
function fmtOcK(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return n.toFixed(0)
}

// ── Solvi: the account-health pet ────────────────────────────────────────────
// A Tamagotchi-style creature whose mood = your account health (liq-distance).
// It turns a cold margin ratio into a visceral "feed me" instinct that nudges
// de-risking. v1 = one pet for the whole account; positions become a "zoo" later.
const _PET_STATES = {
  thriving: { color: '#00e5a0', label: 'Thriving', sub: 'Well fed and healthy. Nice work.' },
  uneasy:   { color: '#f5a623', label: 'Uneasy',   sub: 'Risk is creeping up — ease leverage or add margin.' },
  critical: { color: '#ff4d6d', label: 'Critical', sub: 'Close to liquidation! Feed me — cut risk now.' },
  idle:     { color: '#63b3ed', label: 'Chilling', sub: 'No open positions. Nothing at risk.' },
}
function _mobPetState(healthPct, hasPos) {
  if (!hasPos) return 'idle'
  if (healthPct > 60) return 'thriving'
  if (healthPct > 30) return 'uneasy'
  return 'critical'
}
// ── 3 selectable creatures — trading spirits (species persisted) ─────────────
// Bullo the bull (longs), Bera the bear (shorts), Botto the bot (automation).
// Bodies keep their species identity; the MOOD shows in the face + glow aura.
const _GM_SPECIES = ['bullo', 'bera', 'botto']
const _GM_NAMES   = { bullo: 'Bullo', bera: 'Bera', botto: 'Botto' }
// Species is PER ACCOUNT (each wallet can keep a different companion); falls
// back to the legacy global key, then Bullo.
function _gmGetSpecies() {
  const a = (window.__app?.state()?.addr || '').toLowerCase()
  const s = (a && localStorage.getItem('hliq_pet_species_' + a)) || localStorage.getItem('hliq_pet_species')
  return _GM_SPECIES.includes(s) ? s : 'bullo'
}
function _gmSetSpecies(s) {
  const a = (window.__app?.state()?.addr || '').toLowerCase()
  localStorage.setItem(a ? 'hliq_pet_species_' + a : 'hliq_pet_species', s)
}

// Shared face parts — same mood language across all three species.
function _gmFace(key, cx, cy, s = 1) {
  const crit  = key === 'critical'
  const happy = key === 'thriving' || key === 'idle'
  const ew    = (crit ? 8 : 6.5) * s
  const eyes  = key === 'idle'
    // sleepy: content closed-arc eyes
    ? `<path d="M${cx-16*s} ${cy} q ${4*s} ${5*s} ${8*s} 0" stroke="#0a0e14" stroke-width="${3*s}" fill="none" stroke-linecap="round"/>
       <path d="M${cx+8*s} ${cy} q ${4*s} ${5*s} ${8*s} 0" stroke="#0a0e14" stroke-width="${3*s}" fill="none" stroke-linecap="round"/>`
    // open eyes blink on a randomized timer (transform-box keeps the squish local)
    : `<g class="gm-blink" style="animation-delay:-${(Math.random() * 4).toFixed(2)}s">
       <ellipse cx="${cx-12*s}" cy="${cy}" rx="${ew}" ry="${ew+2*s}" fill="#0a0e14"/>
       <ellipse cx="${cx+12*s}" cy="${cy}" rx="${ew}" ry="${ew+2*s}" fill="#0a0e14"/>
       <circle cx="${cx-10*s}" cy="${cy-3*s}" r="${2.6*s}" fill="#fff"/><circle cx="${cx+14*s}" cy="${cy-3*s}" r="${2.6*s}" fill="#fff"/>
       <circle cx="${cx-14*s}" cy="${cy+2*s}" r="${1.2*s}" fill="#fff" opacity="0.8"/><circle cx="${cx+10*s}" cy="${cy+2*s}" r="${1.2*s}" fill="#fff" opacity="0.8"/></g>`
  const mouth = happy
    ? `<path d="M${cx-13*s} ${cy+16*s} Q${cx} ${cy+28*s} ${cx+13*s} ${cy+16*s}" fill="none" stroke="#0a0e14" stroke-width="${3*s}" stroke-linecap="round"/>`
    : crit
      ? `<path d="M${cx-9*s} ${cy+18*s} Q${cx} ${cy+11*s} ${cx+9*s} ${cy+18*s} Q${cx} ${cy+30*s} ${cx-9*s} ${cy+18*s} Z" fill="#0a0e14"/>`
      : `<path d="M${cx-10*s} ${cy+19*s} Q${cx} ${cy+14*s} ${cx+10*s} ${cy+19*s}" fill="none" stroke="#0a0e14" stroke-width="${3*s}" stroke-linecap="round"/>`
  const blush = happy
    ? `<ellipse cx="${cx-21*s}" cy="${cy+11*s}" rx="${6*s}" ry="${3.4*s}" fill="#ff9db0" opacity="0.55"/><ellipse cx="${cx+21*s}" cy="${cy+11*s}" rx="${6*s}" ry="${3.4*s}" fill="#ff9db0" opacity="0.55"/>` : ''
  const sweat = crit
    ? `<path d="M${cx+30*s} ${cy-14*s} q ${4.5*s} ${8*s} 0 ${13*s} q ${-4.5*s} ${-5*s} 0 ${-13*s}Z" fill="#7cc4ff"><animate attributeName="opacity" values="0.25;1;0.25" dur="0.9s" repeatCount="indefinite"/></path>` : ''
  const zzz = key === 'idle'
    ? `<text x="${cx+30*s}" y="${cy-22*s}" font-size="${13*s}" font-weight="900" fill="#3d5a80" opacity="0.9">z<animate attributeName="opacity" values="0.2;1;0.2" dur="2.4s" repeatCount="indefinite"/></text>` : ''
  return eyes + mouth + blush + sweat + zzz
}

function _gmPetSvg(species, key) {
  const mood = _PET_STATES[key].color
  const dark = 'rgba(0,0,0,0.22)'
  // Mood aura = soft radial GLOW that fades to nothing (a hard ellipse behind the
  // body read as "a second pet underneath" on the dark den background).
  const aura = `<radialGradient id="au-${species}-${key}" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${mood}" stop-opacity="0.5"/><stop offset="60%" stop-color="${mood}" stop-opacity="0.22"/><stop offset="100%" stop-color="${mood}" stop-opacity="0"/>
    </radialGradient>
    <ellipse cx="60" cy="72" rx="58" ry="54" fill="url(#au-${species}-${key})">
      <animate attributeName="opacity" values="0.55;1;0.55" dur="2.8s" repeatCount="indefinite"/></ellipse>`
  const bodyGrad = (id, base, light) => `<radialGradient id="${id}" cx="38%" cy="28%" r="80%">
    <stop offset="0%" stop-color="${light}"/><stop offset="55%" stop-color="${base}"/><stop offset="100%" stop-color="${base}"/>
  </radialGradient>`
  const shadow = `<ellipse cx="60" cy="119" rx="33" ry="6" fill="rgba(0,0,0,0.35)"/>`

  if (species === 'bera') {
    // Bera — the bear. Round brown bear cub, big ears, light muzzle, tummy patch.
    const B = '#c9855a', L = '#e8b38b', M = '#f2dcc3'
    return `<svg viewBox="0 0 120 124" width="108" height="112" aria-hidden="true">
      <defs>${bodyGrad('bg-bera', B, L)}</defs>
      ${aura}${shadow}
      <circle cx="30" cy="30" r="14" fill="url(#bg-bera)" stroke="${dark}" stroke-width="1.5"/>
      <circle cx="90" cy="30" r="14" fill="url(#bg-bera)" stroke="${dark}" stroke-width="1.5"/>
      <circle cx="30" cy="30" r="7" fill="${M}"/><circle cx="90" cy="30" r="7" fill="${M}"/>
      <path d="M60 20 C 90 20 105 44 103 74 C 101 102 87 114 60 114 C 33 114 19 102 17 74 C 15 44 30 20 60 20 Z" fill="url(#bg-bera)" stroke="${dark}" stroke-width="1.5"/>
      <ellipse cx="60" cy="96" rx="22" ry="15" fill="${M}" opacity="0.9"/>
      <ellipse cx="60" cy="74" rx="16" ry="12" fill="${M}"/>
      <ellipse cx="40" cy="113" rx="11" ry="6.5" fill="${B}" stroke="${dark}" stroke-width="1.5"/>
      <ellipse cx="80" cy="113" rx="11" ry="6.5" fill="${B}" stroke="${dark}" stroke-width="1.5"/>
      <path d="M14 74 q -7 4 -3 12 q 7 1 11 -5" fill="${B}" stroke="${dark}" stroke-width="1.5"/>
      <path d="M106 74 q 7 4 3 12 q -7 1 -11 -5" fill="${B}" stroke="${dark}" stroke-width="1.5"/>
      ${_gmFace(key, 60, 56, 0.94)}
    </svg>`
  }
  if (species === 'botto') {
    // Botto — the trading bot. Steel shell, candlestick antenna, mood-lit visor.
    const S = '#9aa6ba', L = '#cdd6e4'
    return `<svg viewBox="0 0 120 124" width="108" height="112" aria-hidden="true">
      <defs>${bodyGrad('bg-botto', S, L)}</defs>
      ${aura}${shadow}
      <g stroke="${dark}" stroke-width="1.4">
        <line x1="60" y1="22" x2="60" y2="4" stroke-width="3.4" stroke-linecap="round"/>
        <rect x="55.5" y="4" width="9" height="12" rx="2" fill="#35c97e"/>
        <line x1="60" y1="1" x2="60" y2="19" stroke="#35c97e" stroke-width="2"/>
      </g>
      <rect x="20" y="22" width="80" height="78" rx="24" fill="url(#bg-botto)" stroke="${dark}" stroke-width="1.5"/>
      <rect x="9"  y="50" width="13" height="30" rx="6.5" fill="${S}" stroke="${dark}" stroke-width="1.5"/>
      <rect x="98" y="50" width="13" height="30" rx="6.5" fill="${S}" stroke="${dark}" stroke-width="1.5"/>
      <circle cx="15.5" cy="46" r="5" fill="#ffd93b" stroke="${dark}" stroke-width="1.2"/>
      <circle cx="104.5" cy="46" r="5" fill="#ffd93b" stroke="${dark}" stroke-width="1.2"/>
      <rect x="30" y="34" width="60" height="50" rx="13" fill="#0d1420" stroke="rgba(255,255,255,0.3)" stroke-width="2"/>
      <g style="filter:drop-shadow(0 0 5px ${mood})">${_gmFace(key, 60, 53, 0.8).replaceAll('#0a0e14', mood).replaceAll('#ff9db0', mood)}</g>
      <rect x="32" y="88" width="56" height="7" rx="3.5" fill="rgba(0,0,0,0.25)"/>
      <rect x="34" y="89.5" width="${key === 'critical' ? 12 : key === 'uneasy' ? 28 : 52}" height="4" rx="2" fill="${mood}"/>
      <rect x="32" y="100" width="24" height="16" rx="6" fill="${S}" stroke="${dark}" stroke-width="1.5"/>
      <rect x="64" y="100" width="24" height="16" rx="6" fill="${S}" stroke="${dark}" stroke-width="1.5"/>
      <line x1="38" y1="104" x2="38" y2="112" stroke="${dark}" stroke-width="2"/><line x1="46" y1="104" x2="46" y2="112" stroke="${dark}" stroke-width="2"/>
      <line x1="70" y1="104" x2="70" y2="112" stroke="${dark}" stroke-width="2"/><line x1="78" y1="104" x2="78" y2="112" stroke="${dark}" stroke-width="2"/>
    </svg>`
  }
  // Bullo — the bull. Clean mint round-body, crescent horns curving UP, small ears.
  const G = '#3fbf7f', GL = '#7fdcae', H = '#f7f3e8'
  return `<svg viewBox="0 0 120 124" width="108" height="112" aria-hidden="true">
    <defs>${bodyGrad('bg-bullo', G, GL)}</defs>
    ${aura}${shadow}
    <path d="M34 30 C 26 26 20 18 21 8 C 30 10 37 18 38 28 Z" fill="${H}" stroke="${dark}" stroke-width="1.5"/>
    <path d="M86 30 C 94 26 100 18 99 8 C 90 10 83 18 82 28 Z" fill="${H}" stroke="${dark}" stroke-width="1.5"/>
    <ellipse cx="24" cy="42" rx="8" ry="5.5" fill="${G}" stroke="${dark}" stroke-width="1.5" transform="rotate(-30 24 42)"/>
    <ellipse cx="96" cy="42" rx="8" ry="5.5" fill="${G}" stroke="${dark}" stroke-width="1.5" transform="rotate(30 96 42)"/>
    <path d="M60 22 C 92 22 106 46 104 76 C 102 103 88 114 60 114 C 32 114 18 103 16 76 C 14 46 28 22 60 22 Z" fill="url(#bg-bullo)" stroke="${dark}" stroke-width="1.5"/>
    <ellipse cx="60" cy="94" rx="17" ry="10" fill="#8fe6bb" opacity="0.85"/>
    <circle cx="54" cy="94" r="2.2" fill="#1d6b43"/><circle cx="66" cy="94" r="2.2" fill="#1d6b43"/>
    <ellipse cx="42" cy="113" rx="11" ry="6.5" fill="${G}" stroke="${dark}" stroke-width="1.5"/>
    <ellipse cx="78" cy="113" rx="11" ry="6.5" fill="${G}" stroke="${dark}" stroke-width="1.5"/>
    ${_gmFace(key, 60, 56, 0.94)}
  </svg>`
}

// Back-compat shim — Solvi card + game world both render the selected species.
function _petSvg(key, _color) { return _gmPetSvg(_gmGetSpecies(), key) }
// ── GAME MODE ─────────────────────────────────────────────────────────────────
// A full Moy/Pou-style illustrated pet world, drawn 100% in inline SVG (zero
// image assets) and skinned over the REAL account: coins = account value,
// hearts = liq-distance health, the wooden sign = live uPnL, and every action
// button is a real trading action wearing a cute verb. Toggleable — Pro UI stays.
let _gameMode = localStorage.getItem('hliq_game_mode') === '1'
let _gmLastMood = null

const _GM_QUIPS = {
  thriving: ['Green candles for dinner! 🌿', 'The desk is printing~', 'Health bar full, LFG!', 'Funding just hit the bowl 😋', 'We are so back.'],
  uneasy:   ['Margin\'s getting thin, boss…', 'Maybe ease the leverage?', 'The monitors look scary today…', 'I\'d hedge. Just saying.'],
  critical: ['FEED ME MARGIN!! 😰', 'LIQ PRICE ON SCREEN 2!!', 'It\'s not a loss until we sell— wait', 'MAYDAY MAYDAY 🚨'],
  idle:     ['Flat book~ nap time 💤', 'Wanna flip a card in the shop?', 'Charts are for watching, not touching.', 'The neon sign flickers sometimes.'],
}

window.__toggleGameMode = function() {
  _gameMode = !_gameMode
  localStorage.setItem('hliq_game_mode', _gameMode ? '1' : '0')
  const ov = document.getElementById('gameModeOverlay')
  if (!_gameMode && ov) { ov.style.display = 'none'; ov.innerHTML = ''; delete ov.dataset.screen; _gmLastMood = null; _gmCardsBuilt = false }
  else { _gmScreen = 'home'; _updateGameMode() }
}

// Home scene: the trading den, but the ROOM IS THE MENU — every piece of
// furniture is a real action. viewBox is phone-shaped (400×820) so nothing gets
// cropped off the sides on tall screens (the old 400×560 lost ~100px each side).
//   · food table  → Feed (deposit)         · terminal  → Trade (card shop)
//   · clipboard   → List (positions+orders) · robot     → Bots (soon)
//   · door        → Outside (zoo, soon)     · monitor   → REAL account value + equity chart
// Every interactive furniture piece goes through this wrapper: a stable
// data-obj id, shared hover/press glow, floating name label — and if a painted
// `obj-<id>.png` is in the manifest, it replaces the SVG art in `box` while any
// `live` layers (screen text, charts) stay composited on top.
function _gmObj(id, action, box, svgArt, live, labelX, labelY, labelText) {
  const img = _gmV('obj-' + id, id)
  const art = img && box
    ? `<image href="${img}" x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}" preserveAspectRatio="xMidYMid meet"/>`
    : svgArt
  // Floating name labels removed — objects speak for themselves (label params
  // kept so call sites/skins stay stable).
  return `<g class="gm-obj" data-obj="${id}" onclick="${action}">${art}${live || ''}</g>`
}

function _gmWorldSvg() {
  const bg = _gmV('bg-den', 'bg-den')
  return `<svg class="gm-world" viewBox="0 0 400 820" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    <defs>
      <linearGradient id="gmDenWall" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#151a2c"/><stop offset="100%" stop-color="#242c4a"/></linearGradient>
      <linearGradient id="gmDenFloor" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#38291c"/><stop offset="100%" stop-color="#221812"/></linearGradient>
      <linearGradient id="gmCity" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0a1026"/><stop offset="100%" stop-color="#1e2d56"/></linearGradient>
      <linearGradient id="gmWoodTop" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#4a3826"/><stop offset="100%" stop-color="#33261a"/></linearGradient>
    </defs>
    ${bg ? `<image href="${bg}" x="0" y="0" width="400" height="820" preserveAspectRatio="xMidYMax slice"/>` : `
    <rect width="400" height="600" fill="url(#gmDenWall)"/>
    <rect y="600" width="400" height="220" fill="url(#gmDenFloor)"/>
    ${[0,1,2,3].map(i => `<line x1="0" y1="${640 + i * 46}" x2="400" y2="${640 + i * 46}" stroke="rgba(0,0,0,0.25)" stroke-width="2"/>`).join('')}`}

    <g class="gm-neon">
      <text x="242" y="242" text-anchor="middle" font-size="19" font-weight="900" letter-spacing="2.5" fill="none" stroke="#ff8a2a" stroke-width="1.4" style="filter:drop-shadow(0 0 8px #ff8a2a) drop-shadow(0 0 16px #ff8a2a88)">INSOLVENT</text>
      <text x="242" y="262" text-anchor="middle" font-size="9" font-weight="700" letter-spacing="4.5" fill="#ffb84d" opacity="0.8" style="filter:drop-shadow(0 0 6px #ff8a2a)">· TERMINAL ·</text>
    </g>

    <!-- Big window onto the city; the far building carries a LIVE billboard that
         cycles through the watchlist (coin · price · 24h%) like Times Square. -->
    <g stroke="#0d1120" stroke-width="5">
      <rect x="20" y="204" width="150" height="136" rx="7" fill="url(#gmCity)"/>
      <line x1="95" y1="206" x2="95" y2="338"/>
    </g>
    <g fill="#101a38">
      <rect x="28" y="268" width="18" height="72"/><rect x="52" y="248" width="15" height="92"/><rect x="126" y="256" width="17" height="84"/><rect x="150" y="276" width="14" height="64"/>
    </g>
    <g fill="#ffd93b">${[[32,276],[38,292],[56,256],[62,272],[130,264],[136,282],[153,284],[32,308],[62,300],[130,300],[153,306]].map(([x,y]) => `<rect x="${x}" y="${y}" width="3" height="3" opacity="0.85"/>`).join('')}</g>
    <circle cx="152" cy="222" r="7" fill="#e8ecf4" opacity="0.9"/>
    <g>
      <rect x="72" y="252" width="50" height="34" rx="4" fill="#06101f" stroke="#ff8a2a" stroke-width="2" style="filter:drop-shadow(0 0 6px #ff8a2a66)"/>
      <line x1="82" y1="286" x2="82" y2="300" stroke="#0d1120" stroke-width="3"/><line x1="112" y1="286" x2="112" y2="300" stroke="#0d1120" stroke-width="3"/>
      <text id="gmBillCoin" x="97" y="265" text-anchor="middle" font-size="9.5" font-weight="900" fill="#ffb84d">—</text>
      <text id="gmBillPx"   x="97" y="276" text-anchor="middle" font-size="8.5" font-weight="700" font-family="monospace" fill="#f4f6ff">—</text>
      <text id="gmBillChg"  x="97" y="284" text-anchor="middle" font-size="7.5" font-weight="900" font-family="monospace" fill="#8a93a8">—</text>
    </g>

    ${_gmObj('list', "window.__gmScreen('list')", [318, 216, 66, 112], `
      <rect x="322" y="228" width="58" height="76" rx="6" fill="#c9a755" stroke="#10141f" stroke-width="3"/>
      <rect x="330" y="240" width="42" height="58" rx="3" fill="#fdf7e4"/>
      <rect x="342" y="222" width="18" height="12" rx="4" fill="#8a93a8" stroke="#10141f" stroke-width="2"/>
      <text x="351" y="252" text-anchor="middle" font-size="7" font-weight="900" fill="#5d8f6f" letter-spacing="0.2">Hyperliquid</text>
      ${[262,272,282,290].map(y => `<line x1="335" y1="${y}" x2="367" y2="${y}" stroke="#b8a67c" stroke-width="2.5"/>`).join('')}`,
      '', 351, 322, 'List')}

    ${_gmObj('monitor', 'window.__gmPokeMonitor()', [96, 300, 208, 188], `
      <rect x="100" y="306" width="200" height="158" rx="12" fill="#0b1220" stroke="#2b2b2b" stroke-width="4"/>
      <rect x="107" y="313" width="186" height="144" rx="7" fill="#081018"/>
      <rect x="186" y="464" width="28" height="12" fill="#1c1c1e"/>
      <rect x="172" y="474" width="56" height="6" rx="3" fill="#1c1c1e"/>`, `
      <text x="114" y="326" font-size="7.5" font-weight="700" font-family="monospace" fill="#35c97e">┌ INSOLVENT:acct ── LIVE</text>
      <text x="114" y="326" font-size="7.5" font-family="monospace" fill="#35c97e"><tspan x="248">▮</tspan><animate attributeName="opacity" values="1;0;1" dur="1.2s" repeatCount="indefinite"/></text>
      <g id="gmMonPriv" onclick="event.stopPropagation();window.__gmMonPriv()" style="cursor:pointer">
        <rect x="264" y="316" width="24" height="14" rx="4" fill="#0f1d2e" stroke="#2f3a55" stroke-width="1.2"/>
        <text id="gmMonPrivIc" x="276" y="327" text-anchor="middle" font-size="8.5">👁</text>
      </g>
      <text id="gmMonVal" x="192" y="349" text-anchor="middle" font-size="19" font-weight="800" font-family="monospace" fill="#f4f6ff">—</text>
      <text id="gmMonDelta" x="192" y="362" text-anchor="middle" font-size="8.5" font-weight="700" font-family="monospace" fill="#8a93a8">—</text>
      <text id="gmMonPnl" x="192" y="374" text-anchor="middle" font-size="8.5" font-weight="700" font-family="monospace" fill="#8a93a8">—</text>
      <polyline id="gmMonSpark" points="" fill="none" stroke="#35c97e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gm-mon"/>
      ${['value', 'accum', 'realized'].map((t, i) => `
      <g onclick="event.stopPropagation();window.__gmMonType('${t}')" style="cursor:pointer">
        <rect id="gmMonBtn-${t}" x="${112 + i * 47}" y="422" width="43" height="13" rx="4" fill="#0f1d2e" stroke="#2f3a55" stroke-width="1.2"/>
        <text id="gmMonBtnT-${t}" x="${133.5 + i * 47}" y="431.5" text-anchor="middle" font-size="7.5" font-weight="800" font-family="monospace" fill="#8a93a8">${t === 'value' ? 'VALUE' : t === 'accum' ? 'ACCUM' : 'REALZD'}</text>
      </g>`).join('')}
      <g onclick="event.stopPropagation();window.__toggleGameMode()" style="cursor:pointer">
        <rect x="255" y="422" width="35" height="13" rx="4" fill="#2b1a08" stroke="#ff8a2a" stroke-width="1.2"/>
        <text x="272.5" y="431.5" text-anchor="middle" font-size="7.5" font-weight="900" font-family="monospace" fill="#ffb84d">PRO</text>
      </g>
      ${[['day', '1D'], ['week', '1W'], ['month', '1M'], ['allTime', 'ALL']].map(([tf, lb], i) => `
      <g onclick="event.stopPropagation();window.__gmMonTf('${tf}')" style="cursor:pointer">
        <rect id="gmMonTf-${tf}" x="${112 + i * 39}" y="439" width="35" height="13" rx="4" fill="#0f1d2e" stroke="#2f3a55" stroke-width="1.2"/>
        <text id="gmMonTfT-${tf}" x="${129.5 + i * 39}" y="448.5" text-anchor="middle" font-size="7.5" font-weight="800" font-family="monospace" fill="#8a93a8">${lb}</text>
      </g>`).join('')}`,
      0, 0, '')}

    ${_gmObj('terminal', "window.__gmScreen('trade')", [24, 382, 74, 104], `
      <rect x="28" y="386" width="66" height="76" rx="7" fill="#1a212f" stroke="#10141f" stroke-width="4"/>
      <rect x="34" y="392" width="54" height="56" rx="4" fill="#04140a"/>
      <rect x="40" y="452" width="42" height="5" rx="2.5" fill="#2b3350"/>`, `
      <text x="38" y="406" font-size="9" font-family="monospace" fill="#35c97e">&gt; long?</text>
      <text x="38" y="419" font-size="9" font-family="monospace" fill="#35c97e">&gt; short?</text>
      <text x="38" y="432" font-size="9" font-family="monospace" fill="#ffb84d">&gt; deal_</text>`,
      61, 480, 'Trade')}

    ${bg ? '' : `
    <g stroke="#181008" stroke-width="2.5">
      <rect x="312" y="424" width="18" height="22" rx="4" fill="#f4f0e4"/>
      <path d="M330 430 q 8 2 0 11" fill="none"/>
      <path d="M316 419 q 3 -6 0 -9 M323 419 q 3 -6 0 -9" fill="none" stroke="#8a93a8" opacity="0.8"/>
    </g>
    <rect x="12" y="464" width="288" height="18" rx="7" fill="url(#gmWoodTop)" stroke="#181008" stroke-width="3"/>
    <rect x="16" y="482" width="280" height="5" rx="2.5" fill="#ff8a2a" opacity="0.85" style="filter:drop-shadow(0 3px 8px #ff8a2a)"/>
    <rect x="36" y="482" width="13" height="118" fill="#241a12" stroke="#181008" stroke-width="3"/>
    <rect x="262" y="482" width="13" height="118" fill="#241a12" stroke="#181008" stroke-width="3"/>`}

    ${_gmObj('door', "window.__gmSoon('🚪 The pen outside is under construction!')", [310, 340, 84, 282], `
      <rect x="314" y="368" width="74" height="232" rx="8" fill="#5a3d20" stroke="#10141f" stroke-width="4"/>
      <rect x="322" y="378" width="58" height="102" rx="5" fill="none" stroke="#3d2913" stroke-width="3"/>
      <rect x="322" y="490" width="58" height="98" rx="5" fill="none" stroke="#3d2913" stroke-width="3"/>
      <circle cx="326" cy="486" r="5" fill="#ffd93b" stroke="#10141f" stroke-width="2"/>
      <rect x="328" y="346" width="46" height="18" rx="4" fill="#1a212f" stroke="#10141f" stroke-width="2.5"/>
      <text x="351" y="359" text-anchor="middle" font-size="9" font-weight="900" fill="#7cc4ff">EXIT</text>`,
      '', 351, 616, 'Outside')}

    ${_gmObj('feed', "window.__gmScreen('feed')", [18, 634, 120, 118], `
      <ellipse cx="78" cy="668" rx="55" ry="17" fill="#7a4e1e" stroke="#181008" stroke-width="3"/>
      <ellipse cx="78" cy="663" rx="55" ry="17" fill="#a06a2c" stroke="#181008" stroke-width="2.5"/>
      <path d="M23 663 q 55 26 110 0 l 0 8 q -55 26 -110 0 Z" fill="#e8e2d4" opacity="0.14"/>
      <rect x="70" y="676" width="16" height="40" fill="#5f3d17" stroke="#181008" stroke-width="2.5"/>
      <ellipse cx="78" cy="718" rx="27" ry="7" fill="#5f3d17" stroke="#181008" stroke-width="2.5"/>
      <ellipse cx="78" cy="658" rx="31" ry="9.5" fill="#f7f3e8" stroke="#c9c2b0" stroke-width="2"/>
      <ellipse cx="78" cy="656" rx="24" ry="6.5" fill="none" stroke="#d9d2c0" stroke-width="1.5"/>
      <text x="59" y="656" font-size="17">🍕</text><text x="83" y="653" font-size="15">🍎</text>
      <text x="97" y="660" font-size="13">🧀</text>`,
      '', 78, 746, 'Feed')}

    ${_gmObj('bots', "window.__gmSoon('🤖 Bot garage opening soon — my cousins are coming!')", [252, 612, 60, 110], `
      <g class="pet-bob" style="transform-origin:282px 700px">
        <rect x="258" y="640" width="48" height="44" rx="12" fill="#9aa6ba" stroke="#10141f" stroke-width="3"/>
        <rect x="266" y="648" width="32" height="20" rx="6" fill="#0d1420"/>
        <circle cx="275" cy="658" r="3.4" fill="#7cc4ff"/><circle cx="289" cy="658" r="3.4" fill="#7cc4ff"/>
        <line x1="282" y1="640" x2="282" y2="628" stroke="#10141f" stroke-width="3"/>
        <circle cx="282" cy="625" r="4" fill="#ffd93b" stroke="#10141f" stroke-width="1.5"/>
        <rect x="262" y="684" width="16" height="10" rx="4" fill="#7e8aa0" stroke="#10141f" stroke-width="2.5"/>
        <rect x="286" y="684" width="16" height="10" rx="4" fill="#7e8aa0" stroke="#10141f" stroke-width="2.5"/>
      </g>`,
      '', 282, 714, 'Bots')}

    ${bg ? '' : `
    <ellipse cx="180" cy="766" rx="130" ry="36" fill="#54412e" stroke="#241a12" stroke-width="4"/>
    <ellipse cx="180" cy="766" rx="98" ry="26" fill="none" stroke="#241a12" stroke-width="2.5" opacity="0.6"/>
    <ellipse cx="180" cy="766" rx="66" ry="16" fill="none" stroke="#241a12" stroke-width="2.5" opacity="0.5"/>`}
  </svg>`
}

window.__gmMonType = function(t) {
  _gmMonType = t
  _updateGameMode()
}
window.__gmMonTf = function(tf) {
  _gmMonTf = tf
  _updateGameMode()
}
window.__gmMonPriv = function() {
  window.__togglePrivacy?.()   // shared app-wide privacy mode (Pro UI follows too)
  _updateGameMode()
}

// Tap the big monitor → the pet comments on the stack (it's display-only).
window.__gmPokeMonitor = function() {
  const bub = document.getElementById('gmBubble')
  if (!bub) return
  bub.textContent = 'That\'s our whole stack up there 📈'
  bub.classList.add('show'); clearTimeout(bub._t)
  bub._t = setTimeout(() => bub.classList.remove('show'), 2200)
}

function _gmLevel(v)  { return Math.max(1, Math.floor(Math.log10(Math.max(v, 1)))) }
function _gmHearts(pct, hasPos) {
  const filled = hasPos ? Math.max(1, Math.round((pct || 0) / 20)) : 5
  return Array.from({ length: 5 }, (_, i) =>
    `<span class="gm-heart${i < filled ? '' : ' off'}">❤</span>`).join('')
}

// ── Screens: home | feed (food shop) | list (order board) | trade (card shop) ─
let _gmScreen     = 'home'
let _gmLastVal    = null       // account value at last tick — a jump = deposit landed → eat!
let _gmValAddr    = null
let _gmOrdersHash = null
let _gmCardCoin   = null       // expanded market card
let _gmBillIdx    = 0          // billboard rotation through the watchlist
let _gmBillTs     = 0
let _gmMonType    = 'value'    // desk monitor chart: value | accum | realized
let _gmMonTf      = 'allTime'  // desk monitor timeframe: day | week | month | allTime
const _gmSparkCache = {}

// ── Painted-asset pipeline ────────────────────────────────────────────────────
// Drop PNGs in public/game/ and list their names in public/game/manifest.json —
// every listed asset replaces its SVG placeholder (see GAME-ASSETS.md for the
// full spec + prompts). Missing assets keep the hand-drawn fallback, so art can
// ship one file at a time.
let _gmAssets = new Set()
const _GM_ASSET_VERSION = '20260708-2'
fetch(`/game/manifest.json?v=${_GM_ASSET_VERSION}`, { cache: 'no-store' })
  .then(r => (r.ok ? r.json() : []))
  .then(list => {
    _gmAssets = new Set(Array.isArray(list) ? list : [])
    if (_gmAssets.size && _gameMode) {
      const ov = document.getElementById('gameModeOverlay')
      if (ov) { ov.innerHTML = ''; delete ov.dataset.screen; _gmLastMood = null; _gmCardsBuilt = false }
      _updateGameMode()
    }
  })
  .catch(() => {})
const _gmA = n => (_gmAssets.has(n) ? `/game/${n}.png?v=${_GM_ASSET_VERSION}` : null)

// ── Skins ─────────────────────────────────────────────────────────────────────
// Every slot (object id, background name, or 'pet') can wear a named look.
// Variant files use a dot suffix: obj-door.neon.png, bg-den.winter.png,
// pet-bullo-thriving.royal.png. Resolution: selected variant → base painted
// asset → built-in SVG. The current SVG art IS the "default" skin, so future
// looks are purely additive — the shop just calls __gmSetSkin.
// Skins are PER ACCOUNT (each wallet can decorate its own room). Cached per addr.
let _gmSkinsAddr = undefined, _gmSkins = {}
function _gmSkinsLoad() {
  const a = (window.__app?.state()?.addr || '').toLowerCase()
  if (a === _gmSkinsAddr) return _gmSkins
  _gmSkinsAddr = a
  try {
    _gmSkins = JSON.parse(localStorage.getItem('hliq_game_skins_' + a) || localStorage.getItem('hliq_game_skins') || '{}')
  } catch { _gmSkins = {} }
  return _gmSkins
}
window.__gmSetSkin = function(slot, skin) {
  const skins = _gmSkinsLoad()
  if (!skin || skin === 'default') delete skins[slot]
  else skins[slot] = skin
  localStorage.setItem('hliq_game_skins_' + (window.__app?.state()?.addr || '').toLowerCase(), JSON.stringify(skins))
  const ov = document.getElementById('gameModeOverlay')
  if (ov) { ov.innerHTML = ''; delete ov.dataset.screen; _gmLastMood = null; _gmCardsBuilt = false }
  _updateGameMode()
}
// Variant-aware lookup: base asset name + the skin slot that owns it.
const _gmV = (base, slot) => {
  const sk = _gmSkinsLoad()[slot]
  return (sk ? _gmA(`${base}.${sk}`) : null) || _gmA(base)
}

window.__gmScreen = function(s) {
  _gmScreen = s
  const ov = document.getElementById('gameModeOverlay')
  if (ov) { ov.innerHTML = ''; delete ov.dataset.screen }
  _gmLastMood = null; _gmOrdersHash = null; _gmCardCoin = null; _gmCardsBuilt = false
  _updateGameMode()
}

// Shared top chrome. Home gets the player HUD (avatar · name · HP bar · coins),
// like a proper game; sub-screens get just the wooden back arrow. Exit to Pro
// lives on the monitor's PRO key.
function _gmChrome(title, sub) {
  return `
    ${title ? `<div class="gm-title gm-outline">${title}</div>` : ''}
    ${sub
      ? `<button class="gm-back" onclick="window.__gmScreen('home')">◀</button>`
      : `<div class="gm-hud">
           <div class="gm-hud-ava" id="gmHudAva" onclick="window.__gmSwapPet(1)" title="Switch companion"></div>
           <div class="gm-hud-info">
             <div class="gm-hud-name gm-outline" id="gmHudName">—</div>
             <div class="gm-hud-hp"><div class="gm-hud-hp-fill" id="gmHudHp"></div></div>
             <div class="gm-hud-coins">🪙 <span id="gmCoins" class="gm-outline">—</span></div>
           </div>
         </div>`}`
}

// ── Scene backgrounds (all inline SVG) ────────────────────────────────────────
// Food shop: warm bistro — pendant lamps with light cones, wood-panel wainscot,
// stocked shelves with proper jars, a glass display counter, checkerboard floor.
function _gmShopSvg() {
  const bg = _gmV('bg-shop', 'bg-shop')
  if (bg) return `<svg class="gm-world" viewBox="0 0 400 820" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><image href="${bg}" width="400" height="820" preserveAspectRatio="xMidYMax slice"/></svg>`
  const jar = (x, y, w, h, c) => `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${c}" stroke="#5f3d17" stroke-width="2"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="url(#gmGlass)"/>
    <rect x="${x + w * 0.2}" y="${y - 5}" width="${w * 0.6}" height="6" rx="2" fill="#8a5a22" stroke="#5f3d17" stroke-width="1.5"/>`
  const lamp = (x) => `
    <line x1="${x}" y1="0" x2="${x}" y2="64" stroke="#3d2913" stroke-width="3"/>
    <path d="M${x - 22} 88 Q${x} 58 ${x + 22} 88 Z" fill="#d9542e" stroke="#8f2f14" stroke-width="2.5"/>
    <circle cx="${x}" cy="88" r="6" fill="#ffe9a3" style="filter:drop-shadow(0 0 10px #ffd93b)"/>
    <path d="M${x - 30} 92 L${x + 30} 92 L${x + 58} 240 L${x - 58} 240 Z" fill="#ffd93b" opacity="0.07"/>`
  return `<svg class="gm-world" viewBox="0 0 400 820" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    <defs>
      <linearGradient id="gmShopWall" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3a2a22"/><stop offset="100%" stop-color="#5a4232"/></linearGradient>
      <linearGradient id="gmGlass" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/><stop offset="40%" stop-color="#ffffff" stop-opacity="0.05"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0.15"/></linearGradient>
      <linearGradient id="gmCounter" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#6e4a2a"/><stop offset="100%" stop-color="#4a2f18"/></linearGradient>
      <pattern id="gmChecker" width="64" height="34" patternUnits="userSpaceOnUse">
        <rect width="64" height="34" fill="#2a201a"/>
        <path d="M0 0 L32 0 L48 17 L16 17 Z" fill="#3d2f24"/>
        <path d="M16 17 L48 17 L64 34 L32 34 Z" fill="#3d2f24"/>
      </pattern>
    </defs>
    <rect width="400" height="620" fill="url(#gmShopWall)"/>
    ${[0,1,2,3].map(i => `<rect x="${i * 104 + 8}" y="330" width="88" height="180" rx="6" fill="rgba(0,0,0,0.16)" stroke="#2a1c12" stroke-width="2"/>`).join('')}
    <rect y="620" width="400" height="200" fill="url(#gmChecker)"/>
    <rect y="614" width="400" height="10" fill="#1d140e"/>

    ${lamp(100)}${lamp(300)}

    <g>
      <rect x="36" y="196" width="328" height="12" rx="4" fill="#7a4e1e" stroke="#3d2913" stroke-width="2.5"/>
      <rect x="42" y="208" width="316" height="6" fill="rgba(0,0,0,0.3)"/>
      ${jar(60, 160, 30, 36, '#9edb7a')}${jar(112, 166, 24, 30, '#f2b04a')}${jar(238, 162, 28, 34, '#7cc4ff')}${jar(296, 168, 30, 28, '#ff9db0')}
      <circle cx="180" cy="180" r="16" fill="#ffd93b" stroke="#5f3d17" stroke-width="2"/>
      <circle cx="196" cy="186" r="11" fill="#e2643d" stroke="#5f3d17" stroke-width="2"/>
    </g>

    <!-- Glass display counter: the food row (HTML) sits right on top of it -->
    <g>
      <rect x="14" y="300" width="372" height="96" rx="10" fill="#101a26" stroke="#2b2b2b" stroke-width="3"/>
      <rect x="14" y="300" width="372" height="96" rx="10" fill="url(#gmGlass)"/>
      <line x1="14" y1="348" x2="386" y2="348" stroke="rgba(255,255,255,0.18)" stroke-width="2"/>
      <rect x="6" y="392" width="388" height="26" rx="8" fill="url(#gmCounter)" stroke="#241505" stroke-width="3"/>
      <rect x="10" y="418" width="380" height="120" fill="#3a2716" stroke="#241505" stroke-width="3"/>
      <rect x="26" y="436" width="160" height="84" rx="6" fill="rgba(0,0,0,0.22)" stroke="#241505" stroke-width="2"/>
      <rect x="214" y="436" width="160" height="84" rx="6" fill="rgba(0,0,0,0.22)" stroke="#241505" stroke-width="2"/>
      <text x="200" y="410" text-anchor="middle" font-size="12" font-weight="900" letter-spacing="2" fill="#ffd93b" style="filter:drop-shadow(0 0 6px #ff8a2a)">FRESH MARGIN DAILY</text>
    </g>
  </svg>`
}
// Cozy study for the order board: wall, window, desk lamp glow.
function _gmRoomSvg() {
  const bg = _gmV('bg-study', 'bg-study')
  if (bg) return `<svg class="gm-world" viewBox="0 0 400 820" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><image href="${bg}" width="400" height="820" preserveAspectRatio="xMidYMax slice"/></svg>`
  return `<svg class="gm-world" viewBox="0 0 400 560" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    <defs><linearGradient id="gmRoomWall" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#5d6a8c"/><stop offset="100%" stop-color="#48536e"/></linearGradient></defs>
    <rect width="400" height="450" fill="url(#gmRoomWall)"/>
    <rect y="450" width="400" height="110" fill="#6e4a24"/>
    <rect y="444" width="400" height="12" fill="#8a5a22"/>
    <g stroke="#2b3247" stroke-width="4">
      <rect x="290" y="46" width="86" height="70" rx="8" fill="#0e1524"/>
      <line x1="333" y1="50" x2="333" y2="112"/><line x1="294" y1="81" x2="372" y2="81"/>
    </g>
    <circle cx="320" cy="60" r="7" fill="#f4f6ff" opacity="0.9"/>
    <circle cx="352" cy="70" r="3" fill="#f4f6ff" opacity="0.7"/><circle cx="306" cy="98" r="2.5" fill="#f4f6ff" opacity="0.6"/>
    <ellipse cx="70" cy="120" rx="46" ry="40" fill="#ffd93b" opacity="0.12"/>
    <path d="M46 96 q 24 -26 48 0 l -6 34 q -18 8 -36 0 Z" fill="#f2b04a" stroke="#8a5a22" stroke-width="3"/>
    <rect x="66" y="130" width="8" height="26" fill="#8a5a22"/>
  </svg>`
}
// Market stall for the card shop: tent top + counter.
function _gmMarketSvg() {
  const bg = _gmV('bg-market', 'bg-market')
  if (bg) return `<svg class="gm-world" viewBox="0 0 400 820" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><image href="${bg}" width="400" height="820" preserveAspectRatio="xMidYMax slice"/></svg>`
  return `<svg class="gm-world" viewBox="0 0 400 560" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    <defs><linearGradient id="gmMktSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#79c7f2"/><stop offset="100%" stop-color="#b8e6fa"/></linearGradient></defs>
    <rect width="400" height="470" fill="url(#gmMktSky)"/>
    <rect y="470" width="400" height="90" fill="#4ea82e"/>
    <g class="gm-cloud gm-cloud-a" fill="#fff" opacity="0.9"><ellipse cx="120" cy="70" rx="30" ry="14"/><ellipse cx="146" cy="63" rx="22" ry="12"/></g>
    <g>${[0,1,2,3,4,5,6,7].map(i => `<path d="M${i*50} 8 L${i*50+50} 8 L${i*50+42} 78 Q${i*50+25} 94 ${i*50+8} 78 Z" fill="${i%2 ? '#6d28d9' : '#f6f2ea'}" stroke="#4c1d95" stroke-width="2.5"/>`).join('')}</g>
    <rect x="14" y="8" width="10" height="440" fill="#8a5a22" stroke="#5f3d17" stroke-width="2"/>
    <rect x="376" y="8" width="10" height="440" fill="#8a5a22" stroke="#5f3d17" stroke-width="2"/>
    <rect x="0" y="440" width="400" height="34" rx="8" fill="#a96e2c" stroke="#5f3d17" stroke-width="3"/>
  </svg>`
}

// ── The dispatcher: builds the active screen once, then patches live numbers ──
function _updateGameMode() {
  if (!window.__app) return   // bridge not ready yet (main.js still evaluating)
  const ov = document.getElementById('gameModeOverlay')
  if (!ov) return
  if (!_gameMode || !A().isMobView()) { if (ov.style.display !== 'none') { ov.style.display = 'none'; ov.innerHTML = ''; delete ov.dataset.screen; _gmLastMood = null; _gmCardsBuilt = false } return }

  const stats  = computeAcctStats(S().perpState, S().spotState, S().fills, S().portfolio)
  const hasPos = (S().perpState?.assetPositions ?? []).some(p => parseFloat(p.position?.szi ?? 0) !== 0)
  let mood     = _mobPetState(stats.healthPct, hasPos)
  // Test override from the long-press menu (🎭) — expires after 45s
  if (_gmMoodForce) {
    if (Date.now() < _gmMoodForce.until) mood = _gmMoodForce.mood
    else _gmMoodForce = null
  }
  ov.style.display = 'block'

  // Deposit detector: the account value jumping between ticks (same account, no
  // position-PnL of that size in 5s) = food arrived → chomp chomp.
  if (_gmValAddr === S().addr && _gmLastVal != null) {
    const jump = stats.accountValue - _gmLastVal
    if (jump > 1 && stats.accountValue > 0) _gmEatAnim(jump)
  }
  _gmValAddr = S().addr
  if (stats.accountValue > 0) _gmLastVal = stats.accountValue

  if (_gmScreen === 'feed')       { _gmFeedScreen(ov, stats, mood) }
  else if (_gmScreen === 'list')  { _gmListScreen(ov, mood) }
  else if (_gmScreen === 'trade') { _gmTradeScreen(ov, mood) }
  else                            { _gmHomeScreen(ov, stats, hasPos, mood) }
}

function _gmSetPet(mood, size = 190, cls = '') {
  const pet = document.getElementById('gmPet')
  if (!pet) return
  if (mood !== _gmLastMood || !pet.innerHTML) {
    const prevMood = _gmLastMood
    _gmLastMood = mood
    pet.className = 'gm-pet ' + cls
    // Painted pet if the asset shipped (pet-<species>-<mood>.png), else SVG.
    const img = _gmV(`pet-${_gmGetSpecies()}-${mood}`, 'pet')
    const art = img
      ? `<img src="${img}" width="${size}" alt="" draggable="false" style="display:block;filter:drop-shadow(0 0 22px ${_PET_STATES[mood].color}55) drop-shadow(0 8px 10px rgba(0,0,0,0.45))">`
      : _gmPetSvg(_gmGetSpecies(), mood).replace('width="108" height="112"', `width="${size}" height="${Math.round(size * 112 / 108)}"`)
    // Inner wrapper: on home the BRAIN drives all motion procedurally; on other
    // screens fall back to the CSS bob/shake loops.
    const anim = _gmScreen === 'home' ? '' : (mood === 'critical' ? 'pet-shake' : 'pet-bob')
    pet.innerHTML = `<div class="gm-pet-inner ${anim}">${art}</div>`
    if (_gmScreen === 'home') {
      pet.style.transition = 'none'
      pet.style.transform = `translate(${_gmPetOff.x}px, ${_gmPetOff.y}px)`
      // Mood flipped mid-life → visible stumble, like it felt the market move
      if (prevMood && prevMood !== mood) {
        const inner = pet.firstElementChild
        inner.classList.add('gm-stumble')
        setTimeout(() => inner.classList.remove('gm-stumble'), 700)
      }
    }
  }
}

// ── THE PET BRAIN ─────────────────────────────────────────────────────────────
// Autonomous behavior loop that makes the pet feel ALIVE on the home screen:
//   wander → pause → nap → wander…, with squash-and-stretch hops while walking,
//   direction flips, breathing at rest, 💤 while napping, frantic pacing +
//   trembling when the account is critical. Runs on rAF; interruptions (grab,
//   tap, food landing) beat the loop. Works for painted PNG pets and SVG alike
//   (whole-body motion); SVG pets additionally blink via their eye rig.
const _gmBrain = { mode: 'pause', until: 0, tx: 0, dir: 1, phase: 0, raf: null, held: false, last: 0 }

function _gmBrainStart() {
  if (_gmBrain.raf) return
  _gmBrain.last = performance.now()
  _gmBrain.until = 0
  _gmBrain.raf = requestAnimationFrame(_gmBrainTick)
}

function _gmBrainPick(now) {
  const mood = _gmLastMood || 'idle'
  const r = Math.random()
  // Mood biases the repertoire: critical paces frantically, flat account naps.
  let mode
  if (mood === 'critical')    mode = r < 0.78 ? 'walk' : 'pause'
  else if (mood === 'idle')   mode = r < 0.28 ? 'walk' : r < 0.55 ? 'pause' : 'nap'
  else if (mood === 'uneasy') mode = r < 0.45 ? 'walk' : r < 0.9 ? 'pause' : 'nap'
  else                        mode = r < 0.5  ? 'walk' : r < 0.88 ? 'pause' : 'nap'
  if (mode === 'walk') {
    const ov = document.getElementById('gameModeOverlay')
    const maxX = Math.max(60, (ov?.clientWidth ?? 380) / 2 - 85)
    _gmBrain.tx = (Math.random() * 2 - 1) * maxX
    _gmBrain.until = now + 20000
  } else if (mode === 'pause') _gmBrain.until = now + 1200 + Math.random() * 3000
  else _gmBrain.until = now + 4500 + Math.random() * 7000
  _gmBrain.mode = mode
}

function _gmZzz(pet, show) {
  let z = pet.querySelector('.gm-zzz')
  if (show && !z) { z = document.createElement('div'); z.className = 'gm-zzz'; z.textContent = '💤'; pet.appendChild(z) }
  else if (!show && z) z.remove()
}

function _gmBrainTick(now) {
  _gmBrain.raf = null
  const pet   = document.getElementById('gmPet')
  const inner = pet?.firstElementChild
  // Self-terminate off the home screen; _gmHomeScreen restarts us.
  if (!pet || !inner || _gmScreen !== 'home' || !_gameMode) return
  const dt = Math.min(50, now - (_gmBrain.last || now))
  _gmBrain.last = now

  if (!_gmBrain.held) {
    if (now > _gmBrain.until && _gmBrain.mode !== 'walk') _gmBrainPick(now)

    const mood    = _gmLastMood || 'idle'
    const walking = _gmBrain.mode === 'walk'
    if (walking) {
      const speed = (mood === 'critical' ? 125 : 52) / 1000        // px/ms
      const dx    = _gmBrain.tx - _gmPetOff.x
      _gmBrain.dir = dx >= 0 ? 1 : -1
      _gmPetOff.x += _gmBrain.dir * Math.min(Math.abs(dx), speed * dt)
      _gmBrain.phase += dt * (mood === 'critical' ? 0.022 : 0.013)  // hop cadence
      if (Math.abs(dx) < 2 || now > _gmBrain.until) {
        _gmBrain.mode = 'pause'
        _gmBrain.until = now + 900 + Math.random() * 2400
        _gmBrain.phase = 0
      }
    } else {
      _gmBrain.phase += dt * (_gmBrain.mode === 'nap' ? 0.0016 : 0.0035)  // breathing
    }
    _gmZzz(pet, _gmBrain.mode === 'nap')

    // Squash-and-stretch: compress on footfall, stretch mid-hop; breathe at rest.
    // Rest breathing is deliberately exaggerated (±3.5% + a small body lift) so
    // it reads at a glance, not just under measurement.
    const s    = Math.abs(Math.sin(_gmBrain.phase))
    const br   = Math.sin(_gmBrain.phase)
    const hop  = walking ? -s * 11 : -Math.max(0, br) * 3
    const sy   = walking ? 0.92 + 0.10 * s : 1 + 0.035 * br
    const sx   = walking ? 1.08 - 0.09 * s : 1 - 0.026 * br
    // Critical: a nervous tremble even while standing
    const jit  = mood === 'critical' && !walking ? Math.sin(now * 0.045) * 1.6 : 0
    pet.style.transition = 'none'
    pet.style.transform  = `translate(${_gmPetOff.x + jit}px, ${hop}px)`
    inner.style.transform = `scaleX(${(_gmBrain.dir * sx).toFixed(3)}) scaleY(${sy.toFixed(3)})`
  }
  _gmBrain.raf = requestAnimationFrame(_gmBrainTick)
}

// Food landed → interrupt everything and rush to it (it falls onto the pet).
function _gmBrainRushToFood() {
  _gmBrain.mode = 'pause'
  _gmBrain.until = performance.now() + 1800
  _gmBrain.phase = 0
}

// ── Pet action menu (long-press the pet) ─────────────────────────────────────
// Direct triggers for every behavior — play with the pet, and test new features
// without waiting for the random loop or a real market event to fire them.
// 🎭 forces a mood for 45s (art + behavior), overriding the real account health.
let _gmMoodForce = null   // { mood, until }
const _GM_MOODCYCLE = ['thriving', 'uneasy', 'critical', 'idle']

function _gmHidePetMenu() { document.getElementById('gmPetMenu')?.remove() }

function _gmShowPetMenu() {
  _gmHidePetMenu()
  const ov = document.getElementById('gameModeOverlay')
  if (!ov) return
  try { navigator.vibrate?.(28) } catch {}
  const m = document.createElement('div')
  m.id = 'gmPetMenu'
  m.className = 'gm-pet-menu'
  m.style.left = `calc(50% + ${_gmPetOff.x}px)`
  m.innerHTML = `
    <button onclick="window.__gmMenu('walk')">🚶<span>Walk</span></button>
    <button onclick="window.__gmMenu('nap')">😴<span>Nap</span></button>
    <button onclick="window.__gmMenu('eat')">🍕<span>Eat</span></button>
    <button onclick="window.__gmMenu('talk')">💬<span>Talk</span></button>
    <button onclick="window.__gmMenu('stumble')">🤸<span>Trip</span></button>
    <button onclick="window.__gmMenu('mood')">🎭<span id="gmMenuMood">${_gmMoodForce ? _gmMoodForce.mood : 'Mood'}</span></button>`
  ov.appendChild(m)
  clearTimeout(m._t)
  m._t = setTimeout(_gmHidePetMenu, 10000)   // auto-dismiss
}

window.__gmMenu = function(action) {
  const now = performance.now()
  const pet = document.getElementById('gmPet')
  const inner = pet?.firstElementChild
  if (action === 'walk') {
    const ov = document.getElementById('gameModeOverlay')
    const maxX = Math.max(60, (ov?.clientWidth ?? 380) / 2 - 85)
    _gmBrain.mode = 'walk'
    _gmBrain.tx = (Math.random() * 2 - 1) * maxX
    _gmBrain.until = now + 20000
  } else if (action === 'nap') {
    _gmBrain.mode = 'nap'
    _gmBrain.until = now + 9000 + Math.random() * 5000
    _gmBrain.phase = 0
  } else if (action === 'eat') {
    _gmEatAnim(Math.floor(5 + Math.random() * 95))   // demo meal (no real deposit)
  } else if (action === 'talk') {
    window.__gmPokePet()
  } else if (action === 'stumble') {
    if (inner) { inner.classList.remove('gm-stumble'); void inner.offsetWidth; inner.classList.add('gm-stumble') }
  } else if (action === 'mood') {
    const cur = _gmMoodForce ? _GM_MOODCYCLE.indexOf(_gmMoodForce.mood) : -1
    const next = _GM_MOODCYCLE[(cur + 1) % _GM_MOODCYCLE.length]
    _gmMoodForce = { mood: next, until: Date.now() + 45000 }
    const lbl = document.getElementById('gmMenuMood')
    if (lbl) lbl.textContent = next
    _updateGameMode()
  }
}

// ── Grab & drag the pet (Beat-the-Boss style) + swipe-to-switch-account ──────
const _gmPetOff = { x: 0, y: 0 }   // where the pet was dropped (home screen)
function _gmWireGestures() {
  const ov = document.getElementById('gameModeOverlay')
  if (!ov || ov._wired) return
  ov._wired = true
  let sx = 0, sy = 0, t0 = 0, grabbed = null, baseX = 0, baseY = 0, moved = false, lastTap = 0
  let lpTimer = null, lpFired = false
  ov.addEventListener('pointerdown', e => {
    sx = e.clientX; sy = e.clientY; t0 = Date.now(); moved = false; lpFired = false
    // Tap anywhere outside the pet menu dismisses it
    if (!e.target.closest('#gmPetMenu')) _gmHidePetMenu()
    const pet = _gmScreen === 'home' ? e.target.closest('#gmPet') : null
    if (pet) {
      grabbed = pet; baseX = _gmPetOff.x; baseY = _gmPetOff.y
      _gmBrain.held = true                                // brain lets go while held
      const inner = pet.firstElementChild
      if (inner) inner.style.transform = ''               // let the grabbed pose show
      pet.classList.add('gm-grabbed')
      try { ov.setPointerCapture(e.pointerId) } catch {}
      e.preventDefault()
      // Long-press (hold still ~half a second) → the pet action menu
      clearTimeout(lpTimer)
      lpTimer = setTimeout(() => {
        if (grabbed && !moved) {
          lpFired = true
          grabbed.classList.remove('gm-grabbed')
          grabbed = null
          _gmBrain.held = false
          _gmBrain.mode = 'pause'; _gmBrain.until = performance.now() + 3000
          _gmShowPetMenu()
        }
      }, 480)
    } else grabbed = null
  })
  ov.addEventListener('pointermove', e => {
    if (!grabbed) return
    const dx = e.clientX - sx, dy = e.clientY - sy
    if (Math.abs(dx) + Math.abs(dy) > 6) { moved = true; clearTimeout(lpTimer) }
    _gmPetOff.x = baseX + dx; _gmPetOff.y = baseY + dy
    grabbed.style.transition = 'none'
    grabbed.style.transform = `translate(${_gmPetOff.x}px, ${_gmPetOff.y}px)`
  })
  ov.addEventListener('pointerup', e => {
    clearTimeout(lpTimer)
    if (lpFired) { lpFired = false; return }   // menu already opened — swallow the tap
    if (grabbed) {
      grabbed.classList.remove('gm-grabbed')
      if (!moved && Date.now() - t0 < 350) {
        // tap = poke · double-tap = swap companion — the pet stops to react
        const now = Date.now()
        if (now - lastTap < 320) { lastTap = 0; window.__gmSwapPet(1) }
        else { lastTap = now; window.__gmPokePet() }
        _gmBrain.mode = 'pause'; _gmBrain.until = performance.now() + 2200
        _gmBrain.held = false
      } else {
        // Drop: clamp inside the room, fall back to the rug with a bounce,
        // then the brain resumes wandering from wherever it landed.
        const maxX = Math.max(60, ov.clientWidth / 2 - 70)
        _gmPetOff.x = Math.max(-maxX, Math.min(maxX, _gmPetOff.x))
        _gmPetOff.y = 0
        grabbed.style.transition = 'transform 0.55s cubic-bezier(0.34, 1.6, 0.5, 1)'
        grabbed.style.transform = `translate(${_gmPetOff.x}px, 0px)`
        _gmBrain.mode = 'pause'; _gmBrain.phase = 0
        _gmBrain.until = performance.now() + 900
        setTimeout(() => { _gmBrain.held = false }, 620)   // after the bounce settles
      }
      grabbed = null
      return
    }
    // Elsewhere on the home screen: a horizontal swipe flips to the next account.
    if (_gmScreen !== 'home') return
    const dx = e.clientX - sx, dy = e.clientY - sy
    if (Math.abs(dx) > 70 && Math.abs(dx) > 2.2 * Math.abs(dy)) _gmSwitchAccount(dx < 0 ? 1 : -1)
  })
  ov.addEventListener('pointercancel', () => {
    // iOS stole the gesture mid-drag — release the pet so the brain resumes
    clearTimeout(lpTimer)
    if (grabbed) { grabbed.classList.remove('gm-grabbed'); _gmPetOff.y = 0; grabbed = null }
    _gmBrain.held = false
  })
}

// Swipe → cycle through the saved recent accounts. Each account brings its own
// pet, skins and (of course) data — the room literally changes owners.
function _gmSwitchAccount(dir) {
  let list = []
  try { list = JSON.parse(localStorage.getItem('hliq_recent_addrs') || '[]') } catch {}
  list = list.filter(a => typeof a === 'string' && a.startsWith('0x'))
  if (list.length < 2) { window.__gmSoon('👤 Save another account to swipe between rooms!'); return }
  const cur = (S().addr || '').toLowerCase()
  let i = list.findIndex(a => a.toLowerCase() === cur)
  if (i < 0) i = 0
  const next = list[(i + dir + list.length) % list.length]
  if (next.toLowerCase() === cur) return
  window.__gmSoon(`🚪 Heading to ${next.slice(0, 6)}…${next.slice(-4)}'s room`)
  _gmPetOff.x = 0; _gmPetOff.y = 0
  setTimeout(() => window.__quickLoad?.(next), 250)
}

// ── HOME ──────────────────────────────────────────────────────────────────────
function _gmHomeScreen(ov, stats, hasPos, mood) {
  if (ov.dataset.screen !== 'home') {
    ov.dataset.screen = 'home'
    ov.innerHTML = `
      ${_gmWorldSvg()}
      ${_gmChrome('', false)}
      <div class="gm-bubble" id="gmBubble"></div>
      <div class="gm-pet" id="gmPet"></div>`
    _gmLastMood = null
    if (!A().mktCtxReady()) A().ensureMarketData().catch(() => {})   // billboard 24h% data
    _gmWireGestures()   // drag the pet, swipe to switch accounts
    _gmBrainStart()     // wake the behavior loop — wander/nap/pace
    // One-time hint: the species switch is otherwise invisible
    if (!localStorage.getItem('hliq_gm_hint_pet')) {
      localStorage.setItem('hliq_gm_hint_pet', '1')
      setTimeout(() => {
        const bub = document.getElementById('gmBubble')
        if (bub) {
          bub.textContent = 'Tap my portrait (top-left) to switch companions! 🐾'
          bub.classList.add('show'); clearTimeout(bub._t)
          bub._t = setTimeout(() => bub.classList.remove('show'), 4200)
        }
      }, 1200)
    }
  }
  // ── Player HUD: mini pet avatar, account name, HP bar, coins ──
  const ava = document.getElementById('gmHudAva')
  if (ava) ava.innerHTML = _gmPetSvg(_gmGetSpecies(), mood).replace('width="108" height="112"', 'width="40" height="41"')
  const nameEl = document.getElementById('gmHudName')
  if (nameEl) {
    const a = S().addr || ''
    nameEl.textContent = (A().getLabel(a)) || (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—')
  }
  const hp = document.getElementById('gmHudHp')
  if (hp) {
    const pct = hasPos ? Math.max(4, Math.min(100, stats.healthPct || 0)) : 100
    hp.style.width = pct + '%'
    hp.style.background = pct > 60 ? 'linear-gradient(90deg,#35c97e,#7fdcae)' : pct > 30 ? 'linear-gradient(90deg,#f5a623,#ffd93b)' : 'linear-gradient(90deg,#f0597a,#ff8aa0)'
  }
  const coins = document.getElementById('gmCoins')
  if (coins) coins.textContent = A().privacy() ? '•••••' : fmtUSD(stats.accountValue, 0)

  // The desk monitor is a live terminal: chart TYPE (VALUE / ACCUM / REALZD) ×
  // TIMEFRAME (1D / 1W / 1M / ALL), a Δ line for the period, uPnL, and privacy.
  const port = (S().portfolio ?? []).find(p => p[0] === _gmMonTf)?.[1]
             ?? (S().portfolio ?? []).find(p => p[0] === 'allTime')?.[1]
  const _tfMs = { day: 864e5, week: 7 * 864e5, month: 30 * 864e5 }[_gmMonTf] ?? Infinity
  let series = [], big = '', bigColor = '#f4f6ff'
  if (_gmMonType === 'accum') {
    series = (port?.pnlHistory ?? []).map(h => parseFloat(h[1]))
    const last = series.length ? series[series.length - 1] : 0
    big = (last >= 0 ? '+' : '−') + '$' + (A().privacy() ? '•••' : fmtUSD(Math.abs(last), 0))
    bigColor = last >= 0 ? '#35c97e' : '#f0597a'
  } else if (_gmMonType === 'realized') {
    const cutoff = Date.now() - _tfMs
    let acc = 0
    series = (S().fills ?? []).filter(f => f.time >= cutoff).sort((a, b) => a.time - b.time).map(f => (acc += (f.closedPnl || 0)))
    big = (acc >= 0 ? '+' : '−') + '$' + (A().privacy() ? '•••' : fmtUSD(Math.abs(acc), 0))
    bigColor = acc >= 0 ? '#35c97e' : '#f0597a'
  } else {
    series = (port?.accountValueHistory ?? []).map(h => parseFloat(h[1]))
    big = A().privacy() ? '•••••' : '$' + fmtUSD(stats.accountValue, 0)
  }
  // Downsample long series to ~48 points so the polyline stays light
  if (series.length > 48) {
    const step = series.length / 48
    series = Array.from({ length: 48 }, (_, i) => series[Math.floor(i * step)])
  }
  const mv = document.getElementById('gmMonVal')
  if (mv) { mv.textContent = big; mv.setAttribute('fill', bigColor) }
  // Δ over the selected period ($ and %)
  const md = document.getElementById('gmMonDelta')
  if (md) {
    if (series.length >= 2 && series[0] !== 0) {
      const d = series[series.length - 1] - series[0]
      const pct = Math.abs(series[0]) > 0 ? d / Math.abs(series[0]) * 100 : 0
      const tfLbl = { day: '24h', week: '7d', month: '30d', allTime: 'all' }[_gmMonTf]
      md.textContent = `Δ ${tfLbl}: ${d >= 0 ? '+' : '−'}$${A().privacy() ? '•••' : fmtUSD(Math.abs(d))} (${d >= 0 ? '+' : ''}${pct.toFixed(1)}%)`
      md.setAttribute('fill', d >= 0 ? '#35c97e' : '#f0597a')
    } else { md.textContent = 'Δ —'; md.setAttribute('fill', '#8a93a8') }
  }
  const mp = document.getElementById('gmMonPnl')
  if (mp) {
    const uPnl = stats.unrealizedPnl || 0
    mp.textContent = hasPos ? `uPnL ${uPnl >= 0 ? '+' : '−'}$${A().privacy() ? '•••' : fmtUSD(Math.abs(uPnl))} · lev ${stats.accountLeverage > 0 ? stats.accountLeverage.toFixed(1) + 'x' : '—'}` : 'no open risk'
    mp.setAttribute('fill', !hasPos ? '#8a93a8' : uPnl >= 0 ? '#35c97e' : '#f0597a')
  }
  const spark = document.getElementById('gmMonSpark')
  if (spark && series.length >= 2) {
    const min = Math.min(...series), max = Math.max(...series), rng = (max - min) || 1
    // chart area: x 114..286, y 382..414 (button rows live below)
    const pts = series.map((v, i) => `${(114 + i / (series.length - 1) * 172).toFixed(1)},${(414 - (v - min) / rng * 32).toFixed(1)}`).join(' ')
    spark.setAttribute('points', pts)
    spark.setAttribute('stroke', series[series.length - 1] >= series[0] ? '#35c97e' : '#f0597a')
  } else if (spark) spark.setAttribute('points', '')
  // Active buttons (type row + timeframe row) + privacy eye
  for (const t of ['value', 'accum', 'realized']) {
    const b = document.getElementById('gmMonBtn-' + t), tx = document.getElementById('gmMonBtnT-' + t)
    if (b)  { b.setAttribute('fill', t === _gmMonType ? '#1e3050' : '#0f1d2e'); b.setAttribute('stroke', t === _gmMonType ? '#7cc4ff' : '#2f3a55') }
    if (tx) tx.setAttribute('fill', t === _gmMonType ? '#cfe4ff' : '#8a93a8')
  }
  for (const tf of ['day', 'week', 'month', 'allTime']) {
    const b = document.getElementById('gmMonTf-' + tf), tx = document.getElementById('gmMonTfT-' + tf)
    if (b)  { b.setAttribute('fill', tf === _gmMonTf ? '#1e3050' : '#0f1d2e'); b.setAttribute('stroke', tf === _gmMonTf ? '#7cc4ff' : '#2f3a55') }
    if (tx) tx.setAttribute('fill', tf === _gmMonTf ? '#cfe4ff' : '#8a93a8')
  }
  const pv = document.getElementById('gmMonPrivIc')
  if (pv) pv.textContent = A().privacy() ? '🙈' : '👁'

  // City billboard: rotates through the watchlist (name · price · 24h%), one
  // asset every ~4s — falls back to the majors if the watchlist is empty.
  const nowTs = Date.now()
  if (nowTs - _gmBillTs > 4000) { _gmBillTs = nowTs; _gmBillIdx++ }
  const wl    = (A().loadWatchlist() || []).map(w => typeof w === 'string' ? w : w?.coin).filter(Boolean)
  const bills = wl.length ? wl : ['BTC', 'ETH', 'SOL', 'HYPE']
  const bCoin = bills[_gmBillIdx % bills.length]
  const bEl   = document.getElementById('gmBillCoin')
  if (bEl && bCoin) {
    const px  = parseFloat(S().allMids?.[bCoin] ?? 0)
    const chg = A().mktCtxMap()?.[bCoin]?.change24
    bEl.textContent = coinLabel(bCoin)
    const pxEl = document.getElementById('gmBillPx')
    if (pxEl) pxEl.textContent = px > 0 ? '$' + fmtPrice(px) : '…'
    const chEl = document.getElementById('gmBillChg')
    if (chEl) {
      if (Number.isFinite(chg)) {
        chEl.textContent = `${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(2)}%`
        chEl.setAttribute('fill', chg >= 0 ? '#35c97e' : '#f0597a')
      } else { chEl.textContent = '· · ·'; chEl.setAttribute('fill', '#8a93a8') }
    }
  }
  _gmSetPet(mood, 190)
}

// Cycle this account's companion — triggered by DOUBLE-TAPPING the pet.
window.__gmSwapPet = function(dir) {
  const next = _GM_SPECIES[(_GM_SPECIES.indexOf(_gmGetSpecies()) + dir + _GM_SPECIES.length) % _GM_SPECIES.length]
  _gmSetSpecies(next)
  _gmLastMood = null                       // force pet redraw
  _updateGameMode()
  const bub = document.getElementById('gmBubble')
  if (bub) {
    bub.textContent = `${_GM_NAMES[next]} reporting for duty!`
    bub.classList.add('show'); clearTimeout(bub._t)
    bub._t = setTimeout(() => bub.classList.remove('show'), 2000)
  }
}

window.__gmSoon = function(msg) {
  const bub = document.getElementById('gmBubble')
  if (bub) {
    bub.textContent = msg || '🚧 Under construction!'
    bub.classList.add('show'); clearTimeout(bub._t)
    bub._t = setTimeout(() => bub.classList.remove('show'), 2200)
  }
}

// ── FEED: the food shop. Each dish = a real USDC deposit amount ───────────────
const _GM_FOODS = [
  { ic: '🍎', usd: 10,  plate: '#7cc4ff', as: 'food-apple'  },
  { ic: '🍕', usd: 20,  plate: '#9edb7a', as: 'food-pizza'  },
  { ic: '🍔', usd: 50,  plate: '#b98aff', as: 'food-burger' },
  { ic: '🎂', usd: 100, plate: '#ffd93b', as: 'food-cake'   },
]
function _gmFeedScreen(ov, stats, mood) {
  if (ov.dataset.screen !== 'feed') {
    ov.dataset.screen = 'feed'
    ov.innerHTML = `
      ${_gmShopSvg()}
      ${_gmChrome('Food Shop', true)}
      <div class="gm-feed-hint gm-outline">Pick a snack — it's a real USDC deposit!</div>
      <div class="gm-food-row">
        ${[..._GM_FOODS, { ic: '🍱', usd: 0, plate: '#ff9db0', as: 'food-bento' }].map(f => {
          const im = _gmV(f.as, 'food')
          return `<button class="gm-food" onclick="window.__gmFeedPick(${f.usd})">
            ${im ? `<img class="gm-food-img" src="${im}" alt="" draggable="false">`
                 : `<span class="gm-food-ic">${f.ic}</span><span class="gm-plate" style="background:${f.plate}"></span>`}
            <span class="gm-food-tag gm-outline">${f.usd ? '$' + f.usd : '$…'}</span>
          </button>`
        }).join('')}
      </div>
      <div class="gm-bubble" id="gmBubble"></div>
      <div class="gm-pet gm-pet-feed" id="gmPet" onclick="window.__gmPokePet()"></div>
      <div class="gm-feed-bal"><span class="gm-outline" id="gmFeedBal">—</span></div>`
    _gmLastMood = null
  }
  const bal = document.getElementById('gmFeedBal')
  if (bal) bal.textContent = 'Balance: ' + (A().privacy() ? '•••••' : '$' + fmtUSD(stats.accountValue, 0))
  _gmSetPet(mood, 150)
}

window.__gmFeedPick = function(usd) {
  if (!usd) {
    const v = parseFloat(prompt('How much USDC should we feed?') || 0)
    if (!(v > 0)) return
    usd = v
  }
  // Open the REAL deposit sheet (z 9000 — sits above the game) with the amount
  // prefilled. When the deposit lands on-chain the value-jump detector plays the
  // eating animation, so the chomp only happens on real food.
  window.mobVDeposit?.()
  setTimeout(() => {
    const inp = document.getElementById('depositAmount')
    if (inp) { inp.value = usd; window.__updateDepositPreview?.() }
  }, 60)
  const bub = document.getElementById('gmBubble')
  if (bub) {
    bub.textContent = 'Ooh!! Is that for me?? 🤤'
    bub.classList.add('show'); clearTimeout(bub._t)
    bub._t = setTimeout(() => bub.classList.remove('show'), 2400)
  }
}

// Deposit landed → food falls to the pet, big chomp, happy bubble.
function _gmEatAnim(amount) {
  const ov = document.getElementById('gameModeOverlay')
  const pet = document.getElementById('gmPet')
  if (!ov || !pet || ov.style.display === 'none') return
  const food = document.createElement('div')
  food.className = 'gm-fall-food'
  food.textContent = _GM_FOODS[Math.floor(Math.random() * _GM_FOODS.length)].ic
  // Fall onto the pet wherever it wandered to, and make it stop for the meal
  if (_gmScreen === 'home') { food.style.left = `calc(50% + ${_gmPetOff.x}px)`; _gmBrainRushToFood() }
  ov.appendChild(food)
  setTimeout(() => {
    food.remove()
    const _pi = pet.firstElementChild || pet; _pi.classList.remove('gm-boing'); void _pi.offsetWidth
    _pi.classList.add('gm-boing')
    const bub = document.getElementById('gmBubble')
    if (bub) {
      bub.textContent = `YUM!! +$${fmtUSD(amount)} 😋`
      bub.classList.add('show'); clearTimeout(bub._t)
      bub._t = setTimeout(() => bub.classList.remove('show'), 3000)
    }
  }, 950)
}

// ── LIST: the pet studies your open orders on a corkboard; edits = rewriting ──
function _gmListScreen(ov, mood) {
  if (ov.dataset.screen !== 'list') {
    ov.dataset.screen = 'list'
    ov.innerHTML = `
      ${_gmRoomSvg()}
      ${_gmChrome('The List', true)}
      <div class="gm-board">
        <div class="gm-board-pin"></div><div class="gm-board-pin gm-board-pin-r"></div>
        <div class="gm-board-title">THE BOOK <span id="gmListPencil">✏️</span></div>
        <div class="gm-board-body" id="gmListBody"></div>
      </div>
      <div class="gm-bubble" id="gmBubble"></div>
      <div class="gm-pet gm-pet-list" id="gmPet" onclick="window.__gmPokePet()"></div>`
    _gmLastMood = null
  }
  _gmSetPet(mood, 120)

  const positions = (S().perpState?.assetPositions ?? []).filter(ap => parseFloat(ap.position?.szi ?? 0) !== 0)
  const orders    = S().openOrders ?? []

  // Live uPnL refresh on the existing rows (no rebuild — that would restart
  // animations and eat taps); the structural hash below decides full rewrites.
  positions.forEach((ap, i) => {
    const el = document.getElementById('gmpos-u-' + i)
    if (!el) return
    const u = parseFloat(ap.position?.unrealizedPnl ?? 0)
    el.textContent = `${u >= 0 ? '+' : '−'}$${fmtUSD(Math.abs(u))}`
    el.style.color = u >= 0 ? '#1d9e5f' : '#d33a56'
  })

  const hash = positions.map(ap => `${ap.position.coin}:${ap.position.szi}`).join('|') + '§' +
               orders.map(o => `${o.oid}:${o.sz}:${o.limitPx}`).join('|')
  if (hash === _gmOrdersHash) return
  const changed = _gmOrdersHash !== null
  _gmOrdersHash = hash

  const body = document.getElementById('gmListBody')
  if (body) {
    // ALL positions — each with mark, live uPnL and a real market-close button
    const posHtml = positions.length ? `<div class="gm-board-sec">— positions (${positions.length}) —</div>` + positions.map((ap, i) => {
      const p = ap.position, szi = parseFloat(p.szi ?? 0)
      const long = szi > 0
      const u    = parseFloat(p.unrealizedPnl ?? 0)
      const mark = parseFloat(S().allMids?.[p.coin] ?? 0)
      const lev  = p.leverage?.value ? ` ${p.leverage.value}x` : ''
      return `<div class="gm-order">
        <span class="gm-order-side" style="color:${long ? '#1d9e5f' : '#d33a56'}">${long ? 'LONG' : 'SHORT'}${lev}</span>
        <span class="gm-order-coin">${esc(window._ocCoinLabel(p.coin))}</span>
        <span class="gm-order-px">${fmtSize(Math.abs(szi))} @ $${fmtPrice(parseFloat(p.entryPx ?? 0))}</span>
        <span class="gm-order-upnl" id="gmpos-u-${i}" style="color:${u >= 0 ? '#1d9e5f' : '#d33a56'}">${u >= 0 ? '+' : '−'}$${fmtUSD(Math.abs(u))}</span>
        <button class="gm-order-x" title="Market close" onclick="window._mobVClosePos(this,'${jsStr(p.coin)}','${long ? 'LONG' : 'SHORT'}','${p.szi}','${mark}')">✕</button>
      </div>`
    }).join('') : ''
    // ALL orders — the board itself scrolls, so nothing gets cut off anymore
    const ordHtml = orders.length ? `<div class="gm-board-sec">— orders (${orders.length}) —</div>` + orders.map(o => {
      const isBuy = o.side === 'B'
      const px = parseFloat(o.triggerPx ?? 0) > 0 ? o.triggerPx : o.limitPx
      const kind = o.orderType?.startsWith('Take Profit') ? 'TP' : o.orderType?.startsWith('Stop') ? 'SL' : (o.isTrigger ? 'TRG' : '')
      return `<div class="gm-order">
        <span class="gm-order-side" style="color:${isBuy ? '#1d9e5f' : '#d33a56'}">${isBuy ? 'BUY' : 'SELL'}${kind ? ' ' + kind : ''}</span>
        <span class="gm-order-coin">${esc(window._ocCoinLabel(o.coin))}</span>
        <span class="gm-order-px">${fmtSize(parseFloat(o.sz ?? 0))} @ $${fmtPrice(parseFloat(px ?? 0))}</span>
        <button class="gm-order-x" onclick="window.__gmCancel('${jsStr(o.coin)}',${o.oid},this)">✕</button>
      </div>`
    }).join('') + (orders.length > 1 ? `<button class="gm-board-clear" onclick="window.__gmCancelAll(this)">🧹 Cancel all orders</button>` : '') : ''
    body.innerHTML = (posHtml + ordHtml) || '<div class="gm-order-empty">Flat book, empty list.<br>Nothing to rewrite~ 📝</div>'
  }
  if (changed) {
    // scribble: pencil wiggles + pet reacts, like it's rewriting the board
    const pencil = document.getElementById('gmListPencil')
    if (pencil) { pencil.classList.remove('gm-scribble'); void pencil.offsetWidth; pencil.classList.add('gm-scribble') }
    const bub = document.getElementById('gmBubble')
    if (bub) {
      bub.textContent = 'Rewriting the list… ✏️'
      bub.classList.add('show'); clearTimeout(bub._t)
      bub._t = setTimeout(() => bub.classList.remove('show'), 2000)
    }
  }
}

window.__gmCancel = async function(coin, oid, btn) {
  btn.disabled = true; btn.textContent = '…'
  try { await window.__cancelOrder(coin, oid, false, null) } catch {}
  _gmOrdersHash = null   // force list re-render next tick
  _updateGameMode()
}

window.__gmCancelAll = async function(btn) {
  const orders = (S().openOrders ?? []).slice()
  if (!orders.length) return
  if (!confirm(`Cancel all ${orders.length} open orders?`)) return
  btn.disabled = true; btn.textContent = 'Sweeping…'
  for (const o of orders) { try { await window.__cancelOrder(o.coin, o.oid, false, null) } catch {} }
  _gmOrdersHash = null
  _updateGameMode()
}

// ── TRADE: scrollable card shop — each card is a real market ──────────────────
function _gmTopMarkets() {
  return Object.entries(A().mktCtxMap())
    .filter(([coin, c]) => c.volume > 0 && !coin.includes(':') && !coin.startsWith('@'))
    .sort((a, b) => b[1].volume - a[1].volume)
    .slice(0, 30)
}
function _gmTradeScreen(ov, mood) {
  if (ov.dataset.screen !== 'trade') {
    ov.dataset.screen = 'trade'
    ov.innerHTML = `
      ${_gmMarketSvg()}
      ${_gmChrome('Card Shop', true)}
      <input class="gm-card-search" id="gmCardSearch" placeholder="🔎 Search markets…" oninput="window.__gmCardFilter(this.value)">
      <div class="gm-cards" id="gmCards"><div class="gm-cards-loading gm-outline">Opening the shop…</div></div>
      <div class="gm-bubble" id="gmBubble"></div>
      <div class="gm-pet gm-pet-trade" id="gmPet" onclick="window.__gmPokePet()"></div>`
    _gmLastMood = null
    if (!A().mktCtxReady()) A().ensureMarketData().then(() => { if (_gmScreen === 'trade') { _gmCardsBuilt = false; _updateGameMode() } })
  }
  _gmSetPet(mood, 110)
  _gmBuildCards()
  _gmPatchCards()
}

let _gmCardsBuilt = false
function _gmBuildCards() {
  const host = document.getElementById('gmCards')
  if (!host || !A().mktCtxReady() || _gmCardsBuilt) return
  const mkts = _gmTopMarkets()
  if (!mkts.length) return
  _gmCardsBuilt = true
  host.innerHTML = mkts.map(([coin, c]) => {
    const cid = coin.replace(/[^a-zA-Z0-9]/g, '_')
    return `<div class="gm-card" id="gmcard-${cid}" data-q="${esc(coinLabel(coin).toLowerCase())}" onclick="window.__gmCardTap('${jsStr(coin)}')">
      <div class="gm-card-head">${A().coinIcon(coin)}<span class="gm-card-name">${esc(coinLabel(coin))}</span></div>
      <div class="gm-card-px" id="gmpx-${cid}">$${fmtPrice(c.markPx)}</div>
      <div class="gm-card-chg ${c.change24 >= 0 ? 'up' : 'dn'}" id="gmchg-${cid}">${c.change24 >= 0 ? '▲' : '▼'} ${Math.abs(c.change24).toFixed(2)}%</div>
      <svg class="gm-card-spark" id="gmspark-${cid}" viewBox="0 0 100 34" preserveAspectRatio="none"></svg>
      <div class="gm-card-buy" id="gmbuy-${cid}" onclick="event.stopPropagation()">
        <div class="gm-card-meta">vol $${fmtOcK(c.volume)} · fund ${(c.funding ?? 0).toFixed(4)}%</div>
        <div class="gm-card-amts">${[10, 25, 50, 100].map(u => `<button class="gm-card-amt" onclick="window.__gmCardAmt('${cid}',${u},this)">$${u}</button>`).join('')}
          <input class="gm-card-cust" id="gmcust-${cid}" type="number" min="0" placeholder="$…" inputmode="decimal" onclick="event.stopPropagation()">
        </div>
        <div class="gm-card-levs">${[1, 3, 5, 10, 20].map(l => `<button class="gm-card-lev${l === 1 ? ' on' : ''}" onclick="window.__gmCardLev('${cid}',${l},this)">${l}x</button>`).join('')}</div>
        <div class="gm-card-btns">
          <button class="gm-card-long"  onclick="window.__gmCardBuy('${jsStr(coin)}','${cid}',true ,this)">LONG</button>
          <button class="gm-card-short" onclick="window.__gmCardBuy('${jsStr(coin)}','${cid}',false,this)">SHORT</button>
        </div>
        <div class="gm-card-st" id="gmst-${cid}"></div>
      </div>
    </div>`
  }).join('')
  // Sparklines: 24h of 1h candles per card — fetched in small chunks so 30
  // cards don't burst-fire the rate limit at once.
  ;(async () => {
    for (let i = 0; i < mkts.length; i += 6) {
      await Promise.all(mkts.slice(i, i + 6).map(([coin]) => _gmDrawSpark(coin)))
      if (_gmScreen !== 'trade') return
    }
  })()
}

window.__gmCardFilter = function(q) {
  q = (q || '').toLowerCase().trim()
  document.querySelectorAll('#gmCards .gm-card').forEach(c => {
    c.style.display = !q || (c.dataset.q || '').includes(q) ? '' : 'none'
  })
}
window.__gmCardLev = function(cid, lev, btn) {
  const wrap = document.getElementById('gmbuy-' + cid)
  if (!wrap) return
  wrap.dataset.lev = lev
  wrap.querySelectorAll('.gm-card-lev').forEach(b => b.classList.remove('on'))
  btn.classList.add('on')
}
async function _gmDrawSpark(coin) {
  if (A().hlLimited()) return   // global 429 breaker
  const cid = coin.replace(/[^a-zA-Z0-9]/g, '_')
  try {
    if (!_gmSparkCache[coin]) {
      _gmSparkCache[coin] = fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime: Date.now() - 24 * 3600 * 1000, endTime: null } }),
      }).then(r => r.json())
    }
    const cs = await _gmSparkCache[coin]
    const el = document.getElementById('gmspark-' + cid)
    if (!el || !Array.isArray(cs) || cs.length < 2) return
    const vals = cs.map(k => parseFloat(k.c))
    const min = Math.min(...vals), max = Math.max(...vals), rng = (max - min) || 1
    const pts = vals.map((v, i) => `${(i / (vals.length - 1) * 100).toFixed(1)},${(30 - (v - min) / rng * 26 + 2).toFixed(1)}`).join(' ')
    const up  = vals[vals.length - 1] >= vals[0]
    el.innerHTML = `<polyline points="${pts}" fill="none" stroke="${up ? '#1d9e5f' : '#d33a56'}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`
  } catch {}
}
function _gmPatchCards() {
  if (!_gmCardsBuilt) return
  for (const [coin, c] of _gmTopMarkets()) {
    const cid = coin.replace(/[^a-zA-Z0-9]/g, '_')
    const px  = parseFloat(S().allMids?.[coin] ?? c.markPx)
    const pxEl = document.getElementById('gmpx-' + cid)
    if (pxEl) pxEl.textContent = '$' + fmtPrice(px)
  }
}
window.__gmCardTap = function(coin) {
  const cid = coin.replace(/[^a-zA-Z0-9]/g, '_')
  const open = _gmCardCoin === coin
  document.querySelectorAll('.gm-card.open').forEach(c => c.classList.remove('open'))
  _gmCardCoin = open ? null : coin
  if (!open) document.getElementById('gmcard-' + cid)?.classList.add('open')
  document.getElementById('gmCards')?.classList.toggle('has-open', !open)
}
window.__gmCardAmt = function(cid, usd, btn) {
  const wrap = document.getElementById('gmbuy-' + cid)
  if (!wrap) return
  wrap.dataset.usd = usd
  wrap.querySelectorAll('.gm-card-amt').forEach(b => b.classList.remove('on'))
  btn.classList.add('on')
}
window.__gmCardBuy = async function(coin, cid, isBuy, btn) {
  const st   = document.getElementById('gmst-' + cid)
  if (!isConnected()) { window.__quickConnectAgent?.(); if (st) st.textContent = 'Connect agent key first!'; return }
  const wrap = document.getElementById('gmbuy-' + cid)
  const cust = parseFloat(document.getElementById('gmcust-' + cid)?.value)
  const usd  = cust > 0 ? cust : parseFloat(wrap?.dataset.usd || 25)
  const px   = parseFloat(S().allMids?.[coin] ?? A().mktCtxMap()[coin]?.markPx ?? 0)
  if (!(px > 0)) { if (st) st.textContent = 'No price — try again.'; return }
  const lev = parseFloat(wrap?.dataset.lev) || 1
  const sz  = (usd * lev) / px
  if (st) { st.textContent = 'Placing…'; st.style.color = '#5d6a8c' }
  btn.disabled = true
  try {
    const result   = await placeMarketOrder({ coin, isBuy, sz, markPrice: px, leverage: lev, isIsolated: S().isIsolated || false })
    const statuses = result?.response?.data?.statuses ?? []
    const filled   = statuses.find(x => x?.filled)?.filled
    if (filled) {
      if (st) { st.textContent = `✓ Got it! ${filled.totalSz} @ $${fmtPrice(parseFloat(filled.avgPx))}`; st.style.color = '#1d9e5f' }
      const bub = document.getElementById('gmBubble')
      if (bub) { bub.textContent = 'New card for the collection! 🃏'; bub.classList.add('show'); clearTimeout(bub._t); bub._t = setTimeout(() => bub.classList.remove('show'), 2600) }
    } else {
      const err = statuses.find(x => x?.error)?.error ?? 'rejected'
      if (st) { st.textContent = '✗ ' + err; st.style.color = '#d33a56' }
    }
  } catch (e) {
    if (st) { st.textContent = '✗ ' + e.message; st.style.color = '#d33a56' }
  } finally { btn.disabled = false }
}

window.__gmPokePet = function() {
  const pet = document.getElementById('gmPet')
  const bub = document.getElementById('gmBubble')
  if (pet) {
    const _pi2 = pet.firstElementChild || pet; _pi2.classList.remove('gm-boing'); void _pi2.offsetWidth   // restart animation
    _pi2.classList.add('gm-boing')
  }
  if (bub) {
    const qs = _GM_QUIPS[_gmLastMood || 'idle'] || _GM_QUIPS.idle
    bub.textContent = qs[Math.floor(Math.random() * qs.length)]
    bub.classList.add('show')
    clearTimeout(bub._t)
    bub._t = setTimeout(() => bub.classList.remove('show'), 2600)
  }
}


// ── Exports back to main.js ───────────────────────────────────────────────────
export { _updateGameMode as updateGameMode }
export function gmOrdersInvalidate() { _gmOrdersHash = null; _updateGameMode() }
