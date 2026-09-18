/**
 * Where an account's agent key lives on this device — and nothing else.
 *
 * This file exists because of how the keys broke. Every fault had the same shape: some code
 * in main.js reached for `state.addr` to decide whose key to read or write. In the combined
 * view that is the string "__all_accounts__", so reads came back empty (the panel looked
 * cleared) and writes went to `hliq_agent_key___all_accounts__`, an entry nothing ever reads
 * again. The mistake was easy to make because `state` was always in scope and an address was
 * always optional.
 *
 * So the storage moved here, where `state` does not exist and cannot be imported without it
 * being obvious. Every function takes the account explicitly, and an account that is not a
 * real 0x address is refused rather than used to build a key — quietly writing to the wrong
 * place is the failure mode this whole file is here to remove.
 *
 * Keyed by MASTER address, always lowercased. The value is the agent wallet's private key;
 * one agent wallet may legitimately be approved by several masters, so the same value
 * appearing under two addresses is normal and must never be "cleaned up".
 *
 * Keys are per device by design: they are never sent anywhere, so there is nothing to sync
 * and a key on your phone is not a key on your laptop.
 */

export const PREFIX     = 'hliq_agent_key_'
/** Pre-multi-account builds stored one key under this bare name, with no address at all. */
export const LEGACY_KEY = 'hliq_agent_key'

const ADDR = /^0x[0-9a-fA-F]{40}$/
export const isRealAddr = (a) => ADDR.test(String(a ?? ''))

/**
 * Called when something asks for the key of a thing that is not an account — the sentinel,
 * the paper address, null. It is always a bug in the caller, and it used to be silent: the
 * read returned nothing and the UI simply showed no key. main.js wires this to the telemetry
 * endpoint so it turns up in /api/errors instead.
 */
let _onMisuse = null
export function onAgentKeyMisuse(fn) { _onMisuse = typeof fn === 'function' ? fn : null }
function misuse(op, addr) {
  try { _onMisuse?.(op, String(addr ?? '')) } catch {}
  return null
}

/** The localStorage key for an account, or null if that is not an account. */
export function storageKeyFor(addr) {
  if (!isRealAddr(addr)) return misuse('addr', addr)
  return PREFIX + String(addr).toLowerCase()
}

/** This account's own key. Never another account's, and never the legacy bare key. */
export function readKey(storage, addr) {
  const k = storageKeyFor(addr)
  if (!k) return null
  try { return storage.getItem(k) || null } catch { return null }
}

/** Returns whether it was stored. A refusal means the caller named something that is not an account. */
export function writeKey(storage, addr, key) {
  const k = storageKeyFor(addr)
  if (!k || !key) { if (!k) misuse('write', addr); return false }
  try { storage.setItem(k, key); return true } catch { return false }
}

export function removeKey(storage, addr) {
  const k = storageKeyFor(addr)
  if (!k) return false
  try { storage.removeItem(k); return true } catch { return false }
}

/** Every account with a key saved here, lowercased. */
export function keyedAddresses(storage) {
  const out = new Set()
  const n = Number(storage?.length) || 0
  for (let i = 0; i < n; i++) {
    const k = storage.key(i)
    if (typeof k !== 'string' || !k.startsWith(PREFIX)) continue
    const a = k.slice(PREFIX.length)
    if (isRealAddr(a) && storage.getItem(k)) out.add(a.toLowerCase())
  }
  return [...out]
}

/**
 * Entries under the prefix whose suffix is not an address: `__all_accounts__` and anything
 * like it. Their existence is proof that something wrote a key against a non-account, so
 * main.js reports them rather than only ignoring them. They are never read as keys.
 */
export function strayEntries(storage) {
  const out = []
  const n = Number(storage?.length) || 0
  for (let i = 0; i < n; i++) {
    const k = storage.key(i)
    if (typeof k === 'string' && k.startsWith(PREFIX) && !isRealAddr(k.slice(PREFIX.length))) out.push(k)
  }
  return out
}

/**
 * The one-time move from the bare legacy key onto the account that was open when it was
 * saved. Returns the address it landed on, or null. It never overwrites a key the account
 * already has, and it only ever runs for a real address.
 */
export function migrateLegacy(storage, addr) {
  if (!isRealAddr(addr)) return null
  let legacy = null
  try { legacy = storage.getItem(LEGACY_KEY) } catch {}
  if (!legacy) return null
  if (readKey(storage, addr)) return null
  return writeKey(storage, addr, legacy) ? String(addr).toLowerCase() : null
}
