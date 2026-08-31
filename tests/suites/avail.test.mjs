// Drives the REAL _availEffective from main.js with the live-verified HL payload shape.
import fs from 'fs'

const src = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const grab = (sig) => {
  const start = src.indexOf(sig)
  if (start < 0) throw new Error(`not found: ${sig}`)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error('unbalanced')
}

let state = {}, _availCache = {}, canAct = true
const mk = () => new Function('getState', 'getCache', 'canActFn', `
  const _selectedAcctAvail = () => -1
  const _canAct = () => canActFn()
  Object.defineProperty(globalThis, '__st', { get: getState, configurable: true })
  ${grab('function _availEffective(')
      .replace(/\bstate\./g, '__st.')
      .replace(/_availCache/g, 'getCache()')}
  return _availEffective
`)(() => state, () => _availCache, () => canAct)
const _availEffective = mk()

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))

// Exactly what HL returned for the user's short PUMP position.
const LONG = 967.898889, SHORT = 431.866961
_availCache = { long: LONG, short: SHORT, coin: 'PUMP' }
state = { selectedCoin: 'PUMP', isAllAccounts: false, tradeSide: 'long' }

// ── the reported bug ─────────────────────────────────────────────────────────
t('LONG (reduces the short) gets the LARGER figure', _availEffective() === LONG, `got ${_availEffective()}`)
state.tradeSide = 'short'
t('SHORT (adds to the short) gets the SMALLER figure', _availEffective() === SHORT, `got ${_availEffective()}`)
t('long > short with a short open — not inverted', LONG > SHORT)

// ── flipping sides must actually change the number ───────────────────────────
state.tradeSide = 'long'
const a = _availEffective()
state.tradeSide = 'short'
const b = _availEffective()
t('toggling side changes the displayed value', a !== b)

// ── flat account: HL reports both sides equal, so neither is favoured ────────
_availCache = { long: 500, short: 500, coin: 'PUMP' }
state.tradeSide = 'long';  const fl = _availEffective()
state.tradeSide = 'short'; const fs_ = _availEffective()
t('flat account reads the same both ways', fl === 500 && fs_ === 500)

// ── a LONG position mirrors it: selling is now the reducing side ─────────────
_availCache = { long: 431.87, short: 967.90, coin: 'PUMP' }
state.tradeSide = 'short'
t('with a LONG open, SHORT gets the larger figure', _availEffective() === 967.90)
state.tradeSide = 'long'
t('with a LONG open, LONG gets the smaller figure', _availEffective() === 431.87)

// ── combined view falls back only while the cache is for another coin ────────
_availCache = { long: LONG, short: SHORT, coin: 'ETH' }
state = { selectedCoin: 'PUMP', isAllAccounts: true, tradeSide: 'long' }
t('combined view falls back on a coin mismatch', _availEffective() === -1)
_availCache = { long: LONG, short: SHORT, coin: 'PUMP' }
t('combined view uses the cache once the coin matches', _availEffective() === LONG)

// ── no side selected yet defaults to long, never undefined ───────────────────
state = { selectedCoin: 'PUMP', isAllAccounts: false, tradeSide: undefined }
t('missing tradeSide defaults to long (never undefined)', _availEffective() === LONG)

// ── structural: the inverting inference is gone ──────────────────────────────
const fn = grab('function _availEffective(')
t('opposing-side inference removed', !fn.includes('opposing'))
t('no leftover .min/.max readers', !/_availCache\.(min|max)/.test(src))
t('fetch labels the array by side', src.includes('[0] = buy/long, [1] = sell/short'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
