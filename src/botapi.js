/**
 * The bot server, signed in the way the app does it: a login message signed by the account's
 * agent key (which the server checks against Hyperliquid's approvals), exchanged for a token,
 * cached per account. Shared by the panels that drive server bots from their own module —
 * /portfolios' Trade live (src/pftrade.js) and the Grid Ladder (src/gridladder-ui.js).
 */
import { readKey } from './agentkeys.js'

const ls = { get: (k) => { try { return localStorage.getItem(k) } catch { return null } } }
const tokens = {}

export async function botToken(addr) {
  const c = tokens[addr.toLowerCase()]
  if (c && c.exp - 60_000 > Date.now()) return c.token
  const key = readKey(localStorage, addr)
  if (!key) throw new Error('no agent key for this account')
  const { Wallet } = await import('ethers')
  const { nonce } = await (await fetch('/api/auth/nonce')).json()
  if (!nonce) throw new Error('the bot server did not answer')
  const msg = `Insolvent Trade — bot control login\nAccount: ${addr.toLowerCase()}\nNonce: ${nonce}`
  const signature = await new Wallet(key).signMessage(msg)
  const j = await (await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: addr, nonce, signature }) })).json()
  if (!j.token) throw new Error(j.error || 'sign-in to the bot server failed')
  tokens[addr.toLowerCase()] = { token: j.token, exp: j.exp ?? Date.now() + 11 * 3600_000 }
  return j.token
}

/** GET (no body) or POST (body) to the bot server as `addr`. Always resolves: {status, ...json}. */
export async function botApi(path, addr, body) {
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await botToken(addr) }
  // Dev mode is earned by the PIN; the server checks the same PIN on /api/start only.
  if (path === '/api/start' && ls.get('hliq_dev') === '1' && ls.get('hliq_lb_pin')) headers['x-lb-pin'] = ls.get('hliq_lb_pin')
  const r = await fetch(path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers })
  const j = (r.headers.get('content-type') ?? '').includes('json') ? await r.json() : { ok: false, error: (await r.text()).slice(0, 200) || 'the bot server did not answer' }
  return { status: r.status, ...j }
}

/** The name the user gave the account in the app's wallet list (savedWallets), or its short address. */
export function acctName(a) {
  try {
    const k = String(a).toLowerCase()
    const w = (JSON.parse(localStorage.getItem('savedWallets') || '[]') || []).find(x => String(x?.addr).toLowerCase() === k)
    if (w?.label && String(w.label).trim()) return String(w.label).trim()
  } catch {}
  return `${String(a).slice(0, 6)}…${String(a).slice(-4)}`
}
