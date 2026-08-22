#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — Strategy Server
 *
 * Manages strategy processes per address, streams live logs via SSE,
 * persists logs to disk, and records wins per strategy.
 *
 * Run:
 *   WALLET_KEY=0xYOUR_KEY node server.js
 *
 * Port: 3002
 */

import { createServer }                                       from 'node:http'
import { spawn }                                              from 'node:child_process'
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs'
import { join, dirname }                                      from 'node:path'
import { fileURLToPath }                                      from 'node:url'
import { homedir }                                            from 'node:os'
import { randomBytes, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto'
import { ethers }                                             from 'ethers'

const __dirname  = dirname(fileURLToPath(import.meta.url))
const PORT       = 3002
const LOGS_DIR        = join(__dirname, 'logs')
const LEADERBOARD_FILE = join(__dirname, 'leaderboard.json')
const LB_STATS_FILE    = join(__dirname, 'leaderboard-stats.json')

// Admin/dev PIN for leaderboard management (replace list, remove entries, dev mode).
// Read from ~/.hliq/lb_pin FIRST (durable across deploys/reboots, editable without
// touching the pm2 env), falling back to the LB_PIN env var. Fails closed: with no
// PIN configured, nobody can manage the board.
function _readLbPin() {
  try { return readFileSync(join(homedir(), '.hliq', 'lb_pin'), 'utf8').trim() } catch { return '' }
}
const LB_PIN     = _readLbPin() || process.env.LB_PIN || ''
const LB_MAX     = 500                 // hard cap on auto-joined accounts
// Minimum equity to auto-join. `> 0` is not enough: plenty of addresses (e.g.
// 0x…0001) hold a few cents of dust and would otherwise land on the board.
const LB_MIN_EQUITY = 10
const HL_INFO    = 'https://api.hyperliquid.xyz/info'
const LB_GENESIS = 1667260800000

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-lb-pin, Authorization',
}

// Operator super-user bypass: `Authorization: Bearer <ADMIN_TOKEN>` acts on any account.
// Ensures the server owner can never be locked out by the auth layer below.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''

const SCRIPTS = {
  insolvent: 'strategies/manager.js',
  dca:       'strategies/dca.js',
  grid:      'strategies/grid.js',
  ocgrid:    'strategies/ocgrid.js',
  twap:      'strategies/twap.js',
  trend:     'strategies/trend.js',
  accumulator: 'strategies/accumulator.js',
  volbreak:  'strategies/volbreak.js',
  // Per-position risk guards (share one script; mode comes from --mode in args)
  liqguard:  'strategies/guardian.js',
  levbrake:  'strategies/guardian.js',
}

// ─── RUNTIME STATE ────────────────────────────────────────────────────────────
// Keyed by "type:address:instance" — an address can run the SAME bot type on
// multiple tokens at once (instance = coin, e.g. grid:0xabc:HYPE + grid:0xabc:NEAR)
const procs  = {}   // "type:addr:inst" → { proc, buffer: string[], address, instance }
const subs   = {}   // "type:addr:inst" → Set<ServerResponse>  (SSE subscribers)

function procKey(type, addr, inst = '') {
  return `${type}:${(addr || '').toLowerCase()}:${(inst || '').toUpperCase()}`
}

// ─── FS HELPERS ───────────────────────────────────────────────────────────────
function stratDir(type, addr) {
  const d = join(LOGS_DIR, type, addr.toLowerCase())
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

function logPath(type, addr, inst = '') {
  const day = new Date().toISOString().slice(0, 10)
  return join(stratDir(type, addr), `${inst ? inst.toUpperCase() + '-' : ''}${day}.log`)
}

function winsPath(type, addr) {
  return join(stratDir(type, addr), 'wins.jsonl')
}

// ─── KEY STORE + ENCRYPTED BOT REGISTRY ──────────────────────────────────────
// Agent keys are encrypted (AES-256-GCM) with a server-held master key and the
// running-bot registry is persisted, so a restart/reboot auto-resumes every bot
// with no user interaction. The master key lives OUTSIDE the repo dir so it isn't
// swept into a git/repo backup. Tradeoff is convenience-grade (master key sits on
// the same box); the backstop is that agent keys can trade but cannot withdraw.
const MASTER_KEY_FILE = join(homedir(), '.hliq', 'master.key')
const REGISTRY_FILE   = join(__dirname, '.bots.enc.json')

function loadMasterKey() {
  try {
    if (existsSync(MASTER_KEY_FILE)) return Buffer.from(readFileSync(MASTER_KEY_FILE, 'utf8').trim(), 'hex')
  } catch (_) {}
  const key = randomBytes(32)
  try {
    mkdirSync(dirname(MASTER_KEY_FILE), { recursive: true })
    writeFileSync(MASTER_KEY_FILE, key.toString('hex'), { mode: 0o600 })
    chmodSync(MASTER_KEY_FILE, 0o600)
  } catch (e) { console.error('Could not persist master key:', e.message) }
  return key
}
const MASTER_KEY = loadMasterKey()

function encryptKey(plain) {
  const iv  = randomBytes(12)
  const c   = createCipheriv('aes-256-gcm', MASTER_KEY, iv)
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')
}
function decryptKey(blob) {
  const buf = Buffer.from(blob, 'base64')
  const iv  = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28)
  const d   = createDecipheriv('aes-256-gcm', MASTER_KEY, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8')
}

// Registry: { "type:addr:inst": { type, address, instance, extraArgs, key(enc) } }
function loadRegistry() {
  try { return existsSync(REGISTRY_FILE) ? JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) : {} }
  catch { return {} }
}
function saveRegistry(reg) {
  try { writeFileSync(REGISTRY_FILE, JSON.stringify(reg), { mode: 0o600 }) } catch (_) {}
}
function persistBot(type, address, instance, extraArgs, agentKey) {
  const reg = loadRegistry()
  reg[procKey(type, address, instance)] = { type, address, instance, extraArgs, key: encryptKey(agentKey) }
  saveRegistry(reg)
}
function unpersistBot(type, address, instance) {
  const reg = loadRegistry()
  delete reg[procKey(type, address, instance)]
  saveRegistry(reg)
}

// ─── AUTH ───────────────────────────────────────────────────────────────────────
// The bot-control API takes an `address` and acts on that account's bots. Unauthenticated,
// anyone could stop another user's bots or read their strategy logs. Model: the client
// proves possession of the account's AGENT KEY (the same credential it trades with) by
// signing a short-lived server nonce; the server binds each bot to the agent address that
// started it (`botOwner`) and gates mutations + log reads to that owner. Boolean run-state
// (/api/status) stays open so the dashboard's bot badges work for any viewer.
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000   // 12h session
const NONCE_TTL_MS = 5 * 60 * 1000
// Token-signing secret derived from the master key (already persisted outside the repo),
// so tokens survive restarts without a second key file.
const AUTH_SECRET  = createHmac('sha256', MASTER_KEY).update('insolvent-auth-token-v1').digest()

const nonces = new Map()   // nonce -> expiry
function issueNonce() { const n = randomBytes(16).toString('hex'); nonces.set(n, Date.now() + NONCE_TTL_MS); return n }
function consumeNonce(n) { const e = nonces.get(n); if (e == null) return false; nonces.delete(n); return e > Date.now() }
setInterval(() => { const now = Date.now(); for (const [n, e] of nonces) if (e < now) nonces.delete(n) }, 60_000).unref()

const authMsg = (address, nonce) =>
  `Insolvent Trade — bot control login\nAccount: ${String(address).toLowerCase()}\nNonce: ${nonce}`

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
function signToken(payload) {
  const p   = b64url(JSON.stringify(payload))
  const sig = b64url(createHmac('sha256', AUTH_SECRET).update(p).digest())
  return `${p}.${sig}`
}
function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null
  const [p, sig] = token.split('.')
  const expect   = b64url(createHmac('sha256', AUTH_SECRET).update(p).digest())
  const a = Buffer.from(sig), b = Buffer.from(expect)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let payload
  try { payload = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()) } catch { return null }
  if (!payload || (payload.e ?? 0) < Date.now()) return null
  return payload   // { s: signer(lower), e: exp }
}

function agentAddrFromKey(key) { try { return new ethers.Wallet(key).address.toLowerCase() } catch { return null } }

// master address (lower) -> agent address (lower) that controls its bots.
const botOwner = new Map()
function claimOwner(address, agentKey) {
  const a = agentAddrFromKey(agentKey)
  if (address && a) botOwner.set(String(address).toLowerCase(), a)
}

// { signer, admin } or null. `explicitToken` supports EventSource (SSE), which can't
// send an Authorization header, so the token arrives as a ?token= query param instead.
function getAuth(req, explicitToken) {
  let tok = explicitToken
  if (!tok) { const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || ''); if (m) tok = m[1].trim() }
  if (!tok) return null
  if (ADMIN_TOKEN && tok === ADMIN_TOKEN) return { signer: null, admin: true }
  const p = verifyToken(tok)
  return p ? { signer: p.s, admin: false } : null
}

// Hyperliquid is the authority on who may sign for a wallet — ask it.
//
// botOwner is in-memory and first-write-wins, so a claim made by a key that is no longer
// the account's agent (rotated since, or persisted from before a restart) locked the real
// owner out of their own bots with "account controlled by another key". Every route that
// could fix it is itself gated, so the only escape was restarting hliq-strat. An agent key
// is rotatable by design, so binding ownership to one agent address forever was wrong.
//
// If the caller's agent address is CURRENTLY approved for that master wallet on HL, it
// genuinely controls the account and may take the claim over. This only ever widens access
// to a key HL itself vouches for — an unapproved key still gets nothing.
const _agentOkCache = new Map()   // `${master}|${agent}` -> { ok, exp }
async function agentApprovedFor(address, agentAddr) {
  const master = String(address ?? '').toLowerCase()
  const agent  = String(agentAddr ?? '').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(master) || !/^0x[0-9a-f]{40}$/.test(agent)) return false
  const ck = `${master}|${agent}`
  const hit = _agentOkCache.get(ck)
  if (hit && hit.exp > Date.now()) return hit.ok
  let ok = false
  try {
    const r = await fetch(HL_INFO, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'extraAgents', user: master }),
      signal: AbortSignal.timeout(5000),
    })
    if (r.ok) {
      const list = await r.json()
      const now  = Date.now()
      ok = Array.isArray(list) && list.some(a =>
        String(a?.address ?? '').toLowerCase() === agent &&
        (!a?.validUntil || Number(a.validUntil) > now))
    }
  } catch { ok = false }
  // Cache a positive far longer than a negative: a rejection may just be a network blip,
  // and caching that would keep the real owner locked out for the whole window.
  _agentOkCache.set(ck, { ok, exp: Date.now() + (ok ? 300_000 : 15_000) })
  return ok
}

// Gate an operation on `address`'s bots. On failure, writes the response and returns false.
async function requireOwner(req, res, address, explicitToken) {
  const auth = getAuth(req, explicitToken)
  if (!auth) { json(res, 401, { error: 'authentication required' }); return false }
  if (auth.admin) return true
  const owner = botOwner.get(String(address).toLowerCase())
  if (owner && owner === auth.signer) return true
  if (await agentApprovedFor(address, auth.signer)) {
    botOwner.set(String(address).toLowerCase(), auth.signer)   // HL vouches for it — re-claim
    return true
  }
  json(res, 403, { error: owner ? 'not authorized for this account' : 'no bots claimed for this account' })
  return false
}

let shuttingDown = false

// ─── WIN DETECTION ────────────────────────────────────────────────────────────
const WIN_RE = /^\[(.+?)\] \[WIN\s*\] (.+)$/

function recordWin(type, addr, line) {
  const m = WIN_RE.exec(line)
  if (!m) return
  const entry = JSON.stringify({ ts: m[1], type, msg: m[2] }) + '\n'
  try { appendFileSync(winsPath(type, addr), entry) } catch (_) {}
}

// ─── LINE HANDLER (stdout/stderr) ─────────────────────────────────────────────
function handleLine(type, addr, line, inst = '') {
  try { appendFileSync(logPath(type, addr, inst), line + '\n') } catch (_) {}
  recordWin(type, addr, line)

  const key = procKey(type, addr, inst)
  const p = procs[key]
  if (p) {
    p.buffer.push(line)
    if (p.buffer.length > 500) p.buffer.shift()
  }

  const msg = `data: ${JSON.stringify({ line })}\n\n`
  for (const res of (subs[key] ?? [])) {
    try { res.write(msg) } catch (_) {}
  }
}

// ─── PROCESS MANAGEMENT ───────────────────────────────────────────────────────
function startStrategy(type, extraArgs = [], agentKey = '', address = '', instance = '', resume = false) {
  const key = procKey(type, address, instance)
  if (procs[key])    return { ok: false, error: `already running${instance ? ' on ' + instance : ''}` }
  if (!SCRIPTS[type]) return { ok: false, error: 'unknown strategy' }

  const envKey = agentKey || process.env.WALLET_KEY
  if (!envKey) return { ok: false, error: 'Agent key not provided — enter it in the Strategies tab' }

  // All bots accept --address: reads (positions, margin, orders) go to the
  // master wallet while the agent key only signs. Without it, bots querying
  // the agent address see an empty account and misbehave.
  const addressArgs = address ? ['--address', address] : []
  // Guards persist a cumulative-cap counter; on auto-resume (deploy/reboot) tell the
  // bot to restore it instead of resetting. Not added to the persisted args — a fresh
  // user arm has no --resume, which makes the bot start the cap over.
  const resumeArgs = (resume && (type === 'liqguard' || type === 'levbrake' || type === 'accumulator')) ? ['--resume'] : []
  // Key is passed via env (AGENT_KEY), NOT argv — so it never shows in `ps aux`.
  const argv = [SCRIPTS[type], ...addressArgs, ...extraArgs, ...resumeArgs]
  const proc = spawn('node', argv, { cwd: __dirname, env: { ...process.env, AGENT_KEY: envKey } })

  // Keep the spawn inputs so /api/restart can relaunch with the exact same
  // config (incl. agent key, which lives only in memory) without the UI re-sending.
  const entry = { proc, buffer: [], address, instance: (instance || '').toUpperCase(), lastError: '', agentKey: envKey, extraArgs, startedAt: Date.now() }
  procs[key] = entry

  // Persist (encrypted) so a restart/reboot auto-resumes this bot with no prompt.
  persistBot(type, address, instance, extraArgs, envKey)
  // Bind this account to the agent key controlling it, for the auth gate.
  claimOwner(address, envKey)

  let outBuf = ''
  let errBuf = ''

  proc.stdout.on('data', chunk => {
    outBuf += chunk.toString()
    const lines = outBuf.split('\n')
    outBuf = lines.pop()
    for (const l of lines) if (l) {
      if (/\[ERROR/.test(l)) entry.lastError = l
      handleLine(type, address, l, instance)
    }
  })

  proc.stderr.on('data', chunk => {
    errBuf += chunk.toString()
    const lines = errBuf.split('\n')
    errBuf = lines.pop()
    for (const l of lines) if (l) {
      entry.lastError = l
      handleLine(type, address, `[STDERR] ${l}`, instance)
    }
  })

  proc.on('exit', code => {
    const ts  = new Date().toISOString().replace('T', ' ').slice(0, 19)
    handleLine(type, address, `[${ts}] [EXIT    ] Process exited — code ${code ?? '?'}`, instance)
    const ranMs = Date.now() - (entry.startedAt || 0)
    delete procs[key]
    // A bot that exits on its own (boundary stop, crash) should NOT auto-resume.
    // But if hliq-strat is shutting down, keep the record so the next boot revives it.
    //
    // Exception: dying to a 429 within the startup window is not the bot deciding to
    // stop, it is HL's IP budget being exhausted — usually by the resume storm this very
    // restart caused. Unpersisting on that silently deleted grid bots that had been
    // running for days, and nothing ever brought them back. Keep the registry entry and
    // retry with a widening backoff instead. Bounded, so a genuinely broken config still
    // gives up rather than looping forever.
    const rateLimited = RATE_LIMIT_RE.test(entry.lastError || '')
    if (!shuttingDown && rateLimited && ranMs < STARTUP_WINDOW_MS && (resumeRetries.get(key) ?? 0) < MAX_RESUME_RETRIES) {
      const n     = (resumeRetries.get(key) ?? 0) + 1
      resumeRetries.set(key, n)
      const delay = RESUME_RETRY_BASE_MS * n
      handleLine(type, address, `[${ts}] [RETRY   ] Rate-limited during startup — retrying in ${Math.round(delay / 1000)}s (attempt ${n}/${MAX_RESUME_RETRIES})`, instance)
      setTimeout(() => {
        if (shuttingDown || procs[key]) return
        try { startStrategy(type, extraArgs, envKey, address, instance, true) }
        catch (e) { console.error(`  ✗ retry failed for ${type}:${instance} — ${e.message}`) }
      }, delay).unref?.()
    } else if (!shuttingDown) {
      unpersistBot(type, address, instance)
      resumeRetries.delete(key)
    }
    const exit = `data: ${JSON.stringify({ exit: code ?? -1 })}\n\n`
    for (const res of (subs[key] ?? [])) {
      try { res.write(exit) } catch (_) {}
    }
  })

  // Resume path skips the early-exit wait so N bots boot in parallel, fast.
  if (resume) return { ok: true }

  // Hold the response briefly — bots validate config (min sizes, balance) right
  // after spawn; an immediate exit should reach the UI, not a silent "started"
  return new Promise(resolve => {
    const onEarlyExit = code => {
      clearTimeout(t)
      const raw = entry.lastError || `process exited immediately (code ${code ?? '?'})`
      resolve({ ok: false, error: raw.replace(/^(\[[^\]]*\]\s*){1,2}/, '').trim() })
    }
    const t = setTimeout(() => {
      proc.removeListener('exit', onEarlyExit)
      resolve({ ok: true })
    }, 3500)
    proc.once('exit', onEarlyExit)
  })
}

function stopStrategy(type, address, instance = '') {
  const key = procKey(type, address, instance)
  const p = procs[key]
  if (!p) return { ok: false, error: 'not running' }
  unpersistBot(type, address, instance)   // explicit stop = don't auto-resume
  p.proc.kill('SIGTERM')
  return { ok: true }
}

// On boot, decrypt the persisted registry and relaunch every bot that was running
// (deploy / pm2 restart / server reboot) — fully automatic, no user interaction.
// Boot used to launch every persisted bot in one tight loop. Each bot's startup is
// request-heavy — a grid alone pulls meta, clearinghouse state and open orders, then
// cancels and places — and HL's 1200 weight/min budget is per IP, shared across all of
// them. With ~68 bots that blew the budget in seconds: two grids that had been running
// for days died to "Fatal: 429 Too Many Requests" moments after resuming, and the
// exit handler then unpersisted them, so they were gone until noticed by hand.
//
// Spacing the launches spreads the same work across several rate-limit windows. Boot
// takes longer, which is fine — a bot that starts a minute late still works, one that
// gets 429'd out of the registry does not.
const RESUME_STAGGER_MS   = 1500
const STARTUP_WINDOW_MS   = 120_000   // "died during startup" cutoff for the 429 retry
const RESUME_RETRY_BASE_MS = 30_000   // 30s, 60s, 90s
const MAX_RESUME_RETRIES  = 3
const RATE_LIMIT_RE = /\b429\b|too many requests|rate limit/i
const resumeRetries = new Map()   // procKey -> consecutive rate-limited startup deaths

async function resumeBots() {
  const reg = loadRegistry()
  const entries = Object.values(reg)
  if (!entries.length) return
  const eta = Math.round((entries.length * RESUME_STAGGER_MS) / 1000)
  console.log(`  Resuming ${entries.length} persisted bot(s), ${RESUME_STAGGER_MS}ms apart (~${eta}s)…`)
  // Claim ownership for ALL of them up front. This is local work, and doing it before
  // the staggered spawns means an owner-gated API call during the boot window is not
  // rejected just because that bot's turn to launch has not come round yet.
  const ready = []
  for (const r of entries) {
    let agentKey
    try { agentKey = decryptKey(r.key) } catch (e) { console.error(`  ✗ decrypt failed for ${r.type}:${r.instance} — ${e.message}`); continue }
    claimOwner(r.address, agentKey)
    ready.push({ r, agentKey })
  }
  for (let i = 0; i < ready.length; i++) {
    if (shuttingDown) { console.log('  … resume aborted (shutting down)'); return }
    const { r, agentKey } = ready[i]
    try {
      startStrategy(r.type, r.extraArgs ?? [], agentKey, r.address ?? '', r.instance ?? '', true)
      console.log(`  ✓ resumed ${r.type}${r.instance ? ':' + r.instance : ''} (${r.address})`)
    } catch (e) { console.error(`  ✗ resume failed for ${r.type}:${r.instance} — ${e.message}`) }
    if (i < ready.length - 1) await new Promise(res => setTimeout(res, RESUME_STAGGER_MS))
  }
  console.log('  Resume complete.')
}

// Shutdown: mark so child 'exit' handlers KEEP the registry (for auto-resume),
// then let the children die with the parent.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { shuttingDown = true; setTimeout(() => process.exit(0), 300) })
}

// Drop --lower/--upper (and their values) from grid args so a restart re-derives the
// AUTO range (position-anchored) instead of pinning to the bounds it last ran with.
function stripGridBounds(type, args = []) {
  if (type !== 'grid') return args
  const out = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lower' || args[i] === '--upper') { i++; continue }
    out.push(args[i])
  }
  return out
}

// Restart: kill the running process, wait for it to exit, then relaunch. Grid bounds
// are stripped so the restart always re-derives the auto range.
async function restartStrategy(type, address, instance = '') {
  const key = procKey(type, address, instance)
  const p = procs[key]
  if (!p) return { ok: false, error: 'not running' }
  const { agentKey } = p
  const extraArgs = stripGridBounds(type, p.extraArgs)
  await new Promise(resolve => {
    let done = false
    const fin = () => { if (!done) { done = true; resolve() } }
    p.proc.once('exit', fin)
    p.proc.kill('SIGTERM')
    setTimeout(fin, 6000)   // fallback if exit never fires
  })
  delete procs[key]         // ensure the slot is free before relaunch
  return await startStrategy(type, extraArgs, agentKey, address, instance)
}

// Pause/Resume: keep the process (and its in-memory key) alive — just signal the
// bot to cancel its orders and idle (SIGUSR1) or re-arm (SIGUSR2). No key loss.
function pauseStrategy(type, address, instance = '') {
  const p = procs[procKey(type, address, instance)]
  if (!p) return { ok: false, error: 'not running' }
  if (p.paused) return { ok: true }
  try { p.proc.kill('SIGUSR1'); p.paused = true; return { ok: true } } catch (e) { return { ok: false, error: e.message } }
}
function resumeStrategy(type, address, instance = '') {
  const p = procs[procKey(type, address, instance)]
  if (!p) return { ok: false, error: 'not running' }
  if (!p.paused) return { ok: true }
  try { p.proc.kill('SIGUSR2'); p.paused = false; return { ok: true } } catch (e) { return { ok: false, error: e.message } }
}

// Guardian persists cumulative cap state (totalAdded / fires) to .guardian-state.json,
// keyed `mode:addr:COIN`. Read it so the UI's Projected Plan can show the REAL remaining
// budget on an armed guard instead of a fresh-from-zero ladder.
const GUARDIAN_STATE_FILE = join(__dirname, '.guardian-state.json')
function readGuardianState() {
  try { return existsSync(GUARDIAN_STATE_FILE) ? JSON.parse(readFileSync(GUARDIAN_STATE_FILE, 'utf8')) : {} }
  catch { return {} }
}

function getStatus(address) {
  // { grid: true } = any instance running (back-compat) +
  // _instances: { 'grid:HYPE': true, 'grid:NEAR': true, 'dca:': true }
  const out = { _instances: {}, _paused: {}, _guards: {}, _configs: {} }
  const addrL = (address || '').toLowerCase()
  const gState = readGuardianState()
  for (const t of Object.keys(SCRIPTS)) out[t] = false
  for (const [key, p] of Object.entries(procs)) {
    const [t, a] = key.split(':')
    if (a !== addrL) continue
    out[t] = true
    out._instances[`${t}:${p.instance || ''}`] = true
    if (p.paused) out._paused[`${t}:${p.instance || ''}`] = true
    // Expose each running instance's launch args so the UI can pre-fill an Edit form and
    // re-launch that ONE instance with a changed config.
    out._configs[`${t}:${p.instance || ''}`] = { type: t, instance: p.instance || '', args: p.extraArgs || [] }
    // Expose guard config + cumulative cap state so the UI can pre-fill the modal and
    // show the true remaining budget when editing an armed guard.
    if (t === 'liqguard' || t === 'levbrake') {
      const st = gState[`${t}:${addrL}:${p.instance || ''}`]
      out._guards[`${t}:${p.instance || ''}`] = {
        type: t, instance: p.instance || '', args: p.extraArgs || [],
        added: parseFloat(st?.totalAdded) || 0, fires: parseInt(st?.fires) || 0,
      }
    }
  }
  // Profit Stack (accumulator) live buffer + lifetime, so the UI can show "buffer $X/$Y"
  // instead of the user guessing why no buy fired. Keyed by "addr:ASSET" in its state file.
  try {
    const accFile = join(__dirname, '.accumulator-state.json')
    if (existsSync(accFile)) {
      const all = JSON.parse(readFileSync(accFile, 'utf8'))
      for (const [k, v] of Object.entries(all)) {
        const i = k.lastIndexOf(':')
        if (i < 0) continue
        if (k.slice(0, i).toLowerCase() !== addrL) continue
        out._accum = out._accum || {}
        out._accum[k.slice(i + 1)] = {
          buffer:        parseFloat(v?.toBuyUsd) || 0,
          lifetimeQty:   parseFloat(v?.lifetimeQty) || 0,
          lifetimeSpent: parseFloat(v?.lifetimeSpent) || 0,
          daySkimmed:    parseFloat(v?.daySkimmed) || 0,
        }
      }
    }
  } catch {}
  return out
}

// ─── WIN READERS ──────────────────────────────────────────────────────────────
function readWins(type, addr) {
  const p = winsPath(type, addr)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
    .reverse()
}

function readAllWins(addr) {
  const out = {}
  for (const t of Object.keys(SCRIPTS)) out[t] = readWins(t, addr)
  return out
}

// ─── LOG FILE LIST ────────────────────────────────────────────────────────────
function logFiles(type, addr) {
  const d = join(LOGS_DIR, type, addr.toLowerCase())
  if (!existsSync(d)) return []
  return readdirSync(d)
    .filter(f => f.endsWith('.log'))
    .sort().reverse()
}

function readLogFile(type, addr, filename) {
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return null
  const p = join(LOGS_DIR, type, addr.toLowerCase(), filename)
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf8')
}

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────
function body(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end',  () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
    req.on('error', reject)
  })
}

function json(res, status, data) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

// ─── LEADERBOARD ──────────────────────────────────────────────────────────────
// The board used to be computed in every visitor's browser: ~7 Hyperliquid calls
// per address, serially. That is fine for a hand-curated list and hopeless once
// accounts auto-join. So the server now fetches once, caches, and hands browsers
// one pre-computed JSON.

const sleep = ms => new Promise(r => setTimeout(r, ms))
const isAddr = a => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)

// Cache for the proxied real liquidation-heatmap feed (HyperPerps). Their endpoint has
// no CORS header, so the browser can't call it directly — we proxy + cache here.
const _heatmapCache = {}

async function hlInfo(payload) {
  const r = await fetch(HL_INFO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (r.status === 429) throw Object.assign(new Error('HL 429'), { rateLimited: true })
  if (!r.ok) throw new Error('HL ' + r.status)
  return r.json()
}

function lbReadList() {
  if (!existsSync(LEADERBOARD_FILE)) return []
  try {
    const raw = JSON.parse(readFileSync(LEADERBOARD_FILE, 'utf8'))
    // legacy files stored bare strings
    return raw.map(x => (typeof x === 'string' ? { addr: x, label: '' } : x)).filter(e => isAddr(e.addr))
  } catch { return [] }
}
function lbWriteList(list) { writeFileSync(LEADERBOARD_FILE, JSON.stringify(list)) }

// Accounts that were explicitly removed. Auto-join (on wallet connect) skips these so
// a removed account can't silently re-enter; only an explicit re-add (join force:true)
// clears the flag. Lowercased addresses.
const LB_REMOVED_FILE = join(__dirname, 'leaderboard-removed.json')
function lbReadRemoved() {
  if (!existsSync(LB_REMOVED_FILE)) return []
  try { const a = JSON.parse(readFileSync(LB_REMOVED_FILE, 'utf8')); return Array.isArray(a) ? a.map(x => String(x).toLowerCase()) : [] }
  catch { return [] }
}
function lbWriteRemoved(list) { writeFileSync(LB_REMOVED_FILE, JSON.stringify([...new Set(list.map(x => String(x).toLowerCase()))])) }
function lbMarkRemoved(addr)  { const k = addr.toLowerCase(); const s = lbReadRemoved(); if (!s.includes(k)) { s.push(k); lbWriteRemoved(s) } }
function lbClearRemoved(addr) { const k = addr.toLowerCase(); const s = lbReadRemoved(); if (s.includes(k)) lbWriteRemoved(s.filter(x => x !== k)) }
function lbIsRemoved(addr)    { return lbReadRemoved().includes(addr.toLowerCase()) }

// ─── PAPER LEADERBOARD ────────────────────────────────────────────────────────
// Deliberately SEPARATE from the real board. Real entries are computed server-side
// from Hyperliquid, so they cannot be faked; paper entries are simulated on the
// user's device and SUBMITTED by the client, so the server has no way to verify
// them. Keeping the two files apart is what stops unverifiable numbers from
// contaminating a ranking that is otherwise trustworthy.
//
// Identity is a chosen name (no wallet). To stop one person overwriting another's
// entry, the first submit mints a secret that the client stores; later updates to
// that name must present it. That is anti-griefing, NOT proof of honesty — a
// determined user can still submit invented figures, which is why the board is
// labelled self-reported in the UI.
// HIDDEN is deliberately NOT the same as REMOVED. Removed drops the account from the
// tracked list entirely and blocks silent re-entry. Hidden keeps it tracked and keeps its
// stats fresh, but withholds it from the public board — for curating what the leaderboard
// shows without losing the account or its history. Only a PIN-holder can see or set it.
const LB_HIDDEN_FILE = join(__dirname, 'leaderboard-hidden.json')
function lbReadHidden() {
  if (!existsSync(LB_HIDDEN_FILE)) return []
  try { const a = JSON.parse(readFileSync(LB_HIDDEN_FILE, 'utf8')); return Array.isArray(a) ? a.map(x => String(x).toLowerCase()) : [] }
  catch { return [] }
}
function lbWriteHidden(list) { writeFileSync(LB_HIDDEN_FILE, JSON.stringify([...new Set(list.map(x => String(x).toLowerCase()))])) }
function lbSetHidden(addr, on) {
  const k = String(addr).toLowerCase()
  const cur = lbReadHidden()
  if (on && !cur.includes(k)) lbWriteHidden([...cur, k])
  if (!on && cur.includes(k)) lbWriteHidden(cur.filter(x => x !== k))
}

// ─── COMBINED ACCOUNT VALUE (All Accounts) ────────────────────────────────────
//
// Why this is server-side. The combined view used to rebuild its total on each device from
// that device's OWN cached snapshot+anchor per wallet, so two browsers showing the same
// eight wallets produced different equity — measured at $3,432.46 on desktop against
// $3,417.08 on mobile at the same instant, with "today" $85 apart. Every figure taken
// straight from live clearinghouse data (positions, maintenance margin, free margin, net
// PnL) matched; only the three derived from accountValue disagreed. There was no
// authoritative number to agree ON.
//
// So compute the snapshot ONCE, here, and let every client bridge from the same pair:
//     equity = accountValue + (liveTotalPerp − perpBase)
// accountValue and perpBase are read together for each wallet and returned together, so a
// client never mixes a snapshot from one moment with an anchor from another — the same
// pairing rule the single-account path follows. What remains device-dependent is only the
// live perp delta, which comes from HL and is identical on both within a tick.
const COMBINED_TTL_MS = 60_000
const _combinedCache = new Map()   // key(sorted addrs) -> { at, data }

// Value of an HL [ts, "value"] series at an instant, by linear interpolation. Clamped: a
// baseline has nothing to extrapolate from before the first sample.
function _hlSeriesAt(hist, ts) {
  if (!Array.isArray(hist) || !hist.length) return 0
  const v = i => parseFloat(hist[i][1]) || 0
  if (ts <= +hist[0][0]) return v(0)
  if (ts >= +hist[hist.length - 1][0]) return v(hist.length - 1)
  let lo = 0, hi = hist.length - 1
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (+hist[m][0] <= ts) lo = m; else hi = m }
  const t0 = +hist[lo][0], t1 = +hist[hi][0]
  return t1 === t0 ? v(lo) : v(lo) + (v(hi) - v(lo)) * ((ts - t0) / (t1 - t0))
}

async function computeCombined(addrs) {
  const now = Date.now()
  let accountValue = 0, perpBase = 0, dayAgo = 0
  const missing = []
  for (const addr of addrs) {
    try {
      // Portfolio FIRST, then the anchor — never the other way round. Reading the anchor
      // before the (slower) portfolio call would pair a snapshot with a perp value from
      // before it, and every later bridge would re-apply that gap.
      const port = await hlInfo({ type: 'portfolio', user: addr })
      const cs   = await hlInfo({ type: 'clearinghouseState', user: addr })
      const hist = (port ?? []).find(p => p[0] === 'allTime')?.[1]?.accountValueHistory ?? []
      if (!hist.length) { missing.push(addr); continue }
      accountValue += parseFloat(hist[hist.length - 1][1]) || 0
      dayAgo       += _hlSeriesAt(hist, now - 86_400_000)
      perpBase     += parseFloat(cs?.marginSummary?.accountValue ?? 0)
    } catch (e) {
      // A wallet that fails is reported, not silently dropped — dropping it would shrink
      // the total and read as a real loss.
      missing.push(addr)
      if (e.rateLimited) { console.warn('[combined] HL 429 — serving what we have'); break }
    }
  }
  return { updatedAt: now, accountValue, perpBase, dayAgo, wallets: addrs.length - missing.length, missing }
}

// ─── STRATEGY SUBSCRIPTIONS ───────────────────────────────────────────────────
//
// Strategies run HERE — /api/start spawns a process that trades with the user's agent key.
// So the paywall lives here too. Hiding the tab in the client would stop nobody: a POST to
// /api/start would still launch a bot. The client gate is cosmetic; THIS is the gate.
//
// Payment is a plain Hyperliquid USDC send to the treasury below — the same "Send" dialog
// people already use, no bridge, no gas, no second chain to explain. Nothing is asked of
// the user afterwards: a watcher polls the treasury's own ledger and credits the SENDER.
// That is the whole reason to pay on HyperCore rather than Arbitrum — the sender is in the
// ledger entry, so a transaction hash never has to be copied anywhere.
const SUBS_FILE      = join(__dirname, 'subscriptions.json')
const SUB_PAY_FILE   = join(__dirname, 'sub-payments.json')
const SUB_TREASURY   = '0x8fe3c39057b6348a27d912423a9770b242911c5d'   // lowercase for comparison
const SUB_PRICE_USDC  = 10        // per period
const SUB_PERIOD_DAYS = 30
const SUB_TRIAL_DAYS  = 7         // 0 disables the free trial
const SUB_POLL_MS     = 30_000
const SUB_POKE_MS     = 5_000     // floor between user-triggered "check now" polls

function subsRead() {
  if (!existsSync(SUBS_FILE)) return {}
  try { const o = JSON.parse(readFileSync(SUBS_FILE, 'utf8')); return (o && typeof o === 'object') ? o : {} }
  catch { return {} }
}
function subsWrite(o) { try { writeFileSync(SUBS_FILE, JSON.stringify(o, null, 2)) } catch (e) { console.error('[subs] save failed:', e.message) } }
function subGet(addr) { return subsRead()[String(addr).toLowerCase()] ?? null }
function subActive(addr) {
  const r = subGet(addr)
  return !!(r && Number(r.until) > Date.now())
}
// Extend from whatever is later — paying early tops up rather than throwing away the
// remainder of the current period.
function subExtend(addr, days, patch = {}) {
  const all = subsRead()
  const k = String(addr).toLowerCase()
  const cur = all[k] ?? { until: 0, trialUsed: false, credit: 0 }
  const from = Math.max(Date.now(), Number(cur.until) || 0)
  all[k] = { ...cur, ...patch, until: from + days * 86400_000 }
  subsWrite(all)
  return all[k]
}

// Watcher bookkeeping: how far we have read, and which ledger entries were already
// applied. Kept out of subscriptions.json so that file stays a clean wallet → entitlement
// map that a human can read and edit.
function subPayRead() {
  if (!existsSync(SUB_PAY_FILE)) return { floor: 0, since: 0, seen: [], binds: {} }
  try {
    const o = JSON.parse(readFileSync(SUB_PAY_FILE, 'utf8'))
    return {
      floor: Number(o.floor) || 0,
      since: Number(o.since) || 0,
      seen: Array.isArray(o.seen) ? o.seen : [],
      binds: o.binds ?? {},
    }
  } catch { return { floor: 0, since: 0, seen: [], binds: {} } }
}
function subPayWrite(o) {
  try { writeFileSync(SUB_PAY_FILE, JSON.stringify({ ...o, seen: o.seen.slice(-500) }, null, 2)) }
  catch (e) { console.error('[subs] payments save failed:', e.message) }
}

// A send can be identified by nonce alone, but hash+time+nonce costs nothing and survives
// a nonce reset. Never key on hash by itself: Hyperliquid returns 0x0…0 for some entries.
const subPayKey = (e) => `${e.time}:${e.hash}:${e.delta?.nonce ?? ''}`

let _subPollAt = 0
let _subPolling = false

// Reads the treasury's own ledger and credits whoever sent USDC to it. Runs on a timer and
// on demand from /api/sub/check. Never throws — a Hyperliquid hiccup must not take the
// process down, and skipping a poll costs nothing because the next one re-reads the window.
async function subPollPayments() {
  if (_subPolling) return
  _subPolling = true
  _subPollAt = Date.now()
  try {
    const st = subPayRead()
    // First ever run: start the clock now. Sends that predate the feature are not
    // subscriptions and must not retroactively grant anyone anything. `floor` is written
    // once and never moves; `since` is just how far we have read.
    if (!st.floor) { st.floor = st.since = Date.now(); subPayWrite(st); return }

    // Re-read a small overlap so an entry that lands out of order is still picked up. The
    // dedupe below makes re-reading free, and `floor` keeps the overlap from ever
    // reaching back past the install.
    const from = Math.max(st.floor, st.since - 10 * 60_000)
    const rows = await hlInfo({ type: 'userNonFundingLedgerUpdates', user: SUB_TREASURY, startTime: from })
    if (!Array.isArray(rows)) return

    const seen = new Set(st.seen)
    let newest = st.since
    let changed = false

    for (const e of rows) {
      const d = e?.delta ?? {}
      if (Number(e.time) > newest) newest = Number(e.time)
      // Deliberately NOT matched on delta.type. Hyperliquid reports a HyperCore transfer
      // as `send`, `internalTransfer` or `spotTransfer` depending on which pocket it left
      // and which API version answered — and the in-app button uses usdSend (perp) while a
      // manual send from the Hyperliquid UI is usually spot. Keying on the type would mean
      // one of those two silently never activating. What actually matters is: money, in
      // USDC, addressed to us. Deposits and withdrawals carry no `destination`, so they
      // fall out here on their own.
      if (String(d.destination ?? '').toLowerCase() !== SUB_TREASURY) continue
      if (d.token !== undefined && String(d.token) !== 'USDC') continue   // pricing another token is a mess we do not need
      if (Number(e.time) < st.floor) continue
      const key = subPayKey(e)
      if (seen.has(key)) continue

      const usdc = Number(d.usdcValue ?? d.usdc ?? d.amount ?? 0)
      const payer = String(d.user ?? '').toLowerCase()
      seen.add(key); changed = true
      if (!isAddr(payer) || !(usdc > 0)) continue

      // A wallet may nominate a different wallet to enable before paying, for people
      // running several accounts off one funded address.
      const target = isAddr(st.binds?.[payer]) ? String(st.binds[payer]).toLowerCase() : payer

      // Underpayment is banked rather than swallowed: two $5 sends buy a month. Anything
      // left over after whole periods stays on the account toward the next one.
      const cur = subGet(target)
      const pot = (Number(cur?.credit) || 0) + usdc
      const periods = Math.floor(pot / SUB_PRICE_USDC)
      const credit = +(pot - periods * SUB_PRICE_USDC).toFixed(6)

      if (periods > 0) {
        subExtend(target, periods * SUB_PERIOD_DAYS, { credit, lastPayment: e.time })
        console.log(`[subs] ${target} +${periods * SUB_PERIOD_DAYS}d from ${payer} ($${usdc})`)
      } else {
        const all = subsRead()
        all[target] = { ...(all[target] ?? { until: 0, trialUsed: false }), credit, lastPayment: e.time }
        subsWrite(all)
        console.log(`[subs] ${target} banked $${usdc} (credit $${credit}, needs $${SUB_PRICE_USDC})`)
      }
      if (st.binds?.[payer]) { delete st.binds[payer]; }
    }

    if (changed || newest > st.since) subPayWrite({ ...st, since: newest, seen: [...seen] })
  } catch (e) {
    console.warn('[subs] poll failed:', e.message)
  } finally {
    _subPolling = false
    _subPollAt = Date.now()
  }
}

const LB_PAPER_FILE = join(__dirname, 'leaderboard-paper.json')
const LB_PAPER_MAX  = 300

function lbPaperRead() {
  if (!existsSync(LB_PAPER_FILE)) return []
  try {
    const raw = JSON.parse(readFileSync(LB_PAPER_FILE, 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch { return [] }
}
function lbPaperWrite(list) {
  try { writeFileSync(LB_PAPER_FILE, JSON.stringify(list)) } catch (e) { console.error('paper lb write:', e.message) }
}

// Same character policy as the real board's display names.
function lbCleanName(s) {
  return String(s ?? '')
    .split('').filter(ch => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join('')
    .replace(/\s+/g, ' ').trim().slice(0, 24)
}

function lbReadStats() {
  if (!existsSync(LB_STATS_FILE)) return { updatedAt: 0, rows: {} }
  try { return JSON.parse(readFileSync(LB_STATS_FILE, 'utf8')) } catch { return { updatedAt: 0, rows: {} } }
}
function lbWriteStats(s) { writeFileSync(LB_STATS_FILE, JSON.stringify(s)) }

// Pull every fill newer than `since`, following HL's 2000-row page limit.
async function hlFillsSince(addr, since) {
  const out = []
  let start = since + 1
  for (let page = 0; page < 25; page++) {
    const batch = await hlInfo({ type: 'userFillsByTime', user: addr, startTime: start })
    if (!Array.isArray(batch) || !batch.length) break
    out.push(...batch)
    if (batch.length < 2000) break
    const maxT = Math.max(...batch.map(f => +f.time))
    if (maxT < start) break
    start = maxT + 1
  }
  return out
}

// Refresh one account. Fills/funding accumulate incrementally so we never re-pull
// an account's entire history after the first sync.
// HIP-3 dex names, cached for an hour — the list changes rarely and this is called
// once per account per refresh cycle.
let _dexNames = { at: 0, names: [] }
async function lbPerpDexNames() {
  if (Date.now() - _dexNames.at < 60 * 60 * 1000 && _dexNames.names.length) return _dexNames.names
  try {
    const d = await hlInfo({ type: 'perpDexs' })
    const names = (Array.isArray(d) ? d : []).filter(Boolean).map(x => x?.name).filter(Boolean)
    if (names.length) _dexNames = { at: Date.now(), names }
  } catch (_) { /* keep whatever we had */ }
  return _dexNames.names
}

async function lbRefreshOne(addr, label, prev) {
  const st = prev ?? {
    realizedPnl: 0, fees: 0, volume: 0, funding: 0,
    lastFillTs: LB_GENESIS - 1, lastFundingTs: LB_GENESIS - 1, windows: {},
  }

  const [cs, portfolio, spot, openOrders] = await Promise.all([
    hlInfo({ type: 'clearinghouseState', user: addr }),
    hlInfo({ type: 'portfolio', user: addr }).catch(() => []),
    hlInfo({ type: 'spotClearinghouseState', user: addr }).catch(() => ({ balances: [] })),
    hlInfo({ type: 'frontendOpenOrders', user: addr }).catch(() => []),
  ])

  // HIP-3 (builder-deployed) markets live on separate dexes and are INVISIBLE to the
  // plain clearinghouseState above. Without this the board under-reports anyone
  // holding one — an account with 5 positions showed 4, and its unrealized PnL was
  // short by that position's PnL, disagreeing with every other view in the app.
  //
  // Fanning all 9 dexes for all accounts every cycle would be ~4,500 extra calls and
  // would rate-limit us, so: normally query only the dexes this account is KNOWN to
  // use (almost always none), and re-discover the full set about once an hour.
  const dexAll     = await lbPerpDexNames()
  const lastSweep  = st.dexSweepAt ?? 0
  const doSweep    = Date.now() - lastSweep > 55 * 60 * 1000
  const dexToCheck = doSweep ? dexAll : (st.dexes ?? []).filter(d => dexAll.includes(d))

  const hip3Pos = []
  const dexesWithPos = []
  for (const dex of dexToCheck) {
    try {
      const dcs = await hlInfo({ type: 'clearinghouseState', user: addr, dex })
      const ps  = (dcs?.assetPositions ?? []).filter(ap => parseFloat(ap.position?.szi ?? 0) !== 0)
      if (ps.length) { hip3Pos.push(...ps); dexesWithPos.push(dex) }
    } catch (e) {
      if (e.rateLimited) throw e          // let the caller back off
      // otherwise treat this dex as empty for now
    }
    if (doSweep) await sleep(120)         // pace the hourly sweep
  }

  // Win-rate buckets: closing fills grouped per coin per hour, carried across
  // refreshes so a window that gains fills later still resolves correctly.
  const windows = { ...(st.windows ?? {}) }
  const fills = await hlFillsSince(addr, st.lastFillTs)
  let { realizedPnl, fees, volume, lastFillTs } = st
  for (const f of fills) {
    const pnl = parseFloat(f.closedPnl ?? 0)
    const fee = parseFloat(f.fee ?? 0)
    realizedPnl += pnl
    fees        += fee
    volume      += parseFloat(f.sz ?? 0) * parseFloat(f.px ?? 0)
    if (pnl !== 0) {
      const k = `${f.coin}_${Math.floor(+f.time / 3600000)}`
      windows[k] = (windows[k] ?? 0) + pnl - fee
    }
    if (+f.time > lastFillTs) lastFillTs = +f.time
  }

  let { funding, lastFundingTs } = st
  const fund = await hlInfo({ type: 'userFunding', user: addr, startTime: lastFundingTs + 1 }).catch(() => [])
  for (const f of (Array.isArray(fund) ? fund : [])) {
    funding += parseFloat(f.delta?.usdc ?? 0)
    if (+f.time > lastFundingTs) lastFundingTs = +f.time
  }

  // Main-dex positions plus any HIP-3 ones found above, so the count and the
  // unrealized total both cover the whole account.
  const rawPos = [
    ...(cs.assetPositions ?? []).filter(ap => parseFloat(ap.position?.szi ?? 0) !== 0),
    ...hip3Pos,
  ]
  const unrealizedPnl = rawPos.reduce((s, ap) => s + parseFloat(ap.position.unrealizedPnl ?? 0), 0)
  // Keep HL's `{ position: {...} }` wrapper — the client's _lbPosHtml reads p.position.
  const positions = rawPos.map(ap => ({
    position: {
      coin: ap.position.coin,
      szi: ap.position.szi,
      entryPx: ap.position.entryPx,
      positionValue: ap.position.positionValue,
      unrealizedPnl: ap.position.unrealizedPnl,
      liquidationPx: ap.position.liquidationPx,
      leverage: ap.position.leverage,
      returnOnEquity: ap.position.returnOnEquity,
    },
  }))

  const perpAcctVal   = parseFloat(cs.marginSummary?.accountValue ?? 0)
  const spotUSDCTotal = parseFloat((spot?.balances ?? []).find(b => b.coin === 'USDC')?.total ?? 0)
  const avHist        = (portfolio ?? []).find(p => p[0] === 'allTime')?.[1]?.accountValueHistory ?? []
  const accountValue  = avHist.length ? parseFloat(avHist.at(-1)[1]) : perpAcctVal + spotUSDCTotal

  // Health = 100 − HL's Unified Account Ratio (maint margin / unified USDC balance)
  const maintMargin = parseFloat(cs.crossMaintenanceMarginUsed ?? 0)
  const marginBase  = spotUSDCTotal > 0 ? spotUSDCTotal : perpAcctVal
  const healthPct   = marginBase > 0 ? Math.max(0, (1 - maintMargin / marginBase) * 100) : 0
  const healthCls   = healthPct > 60 ? 'pos' : healthPct > 30 ? 'warn' : 'neg'

  const allW = Object.values(windows)

  return {
    addr, label,
    accountValue,
    unrealizedPnl,
    realizedPnl,
    // fees are summed in the token they were charged in; HYPE-denominated fees are
    // a small approximation here rather than converted at the mid.
    netPnl: realizedPnl + unrealizedPnl + funding - fees,
    positions,
    openOrders: Array.isArray(openOrders) ? openOrders : [],
    outcomes: [],                 // prediction-market marks aren't computed server-side yet
    maintMargin, healthPct, healthCls,
    totalVolume: volume,
    winCount: allW.filter(n => n > 0).length,
    totalWindows: allW.length,
    totalFees: fees,
    allTimeFunding: funding,
    // internal accumulators (stripped before the row is served)
    fees, volume, funding, lastFillTs, lastFundingTs, windows,
    // which HIP-3 dexes this account uses, so later refreshes skip the other 8
    dexes: dexesWithPos,
    dexSweepAt: doSweep ? Date.now() : (st.dexSweepAt ?? 0),
    updatedAt: Date.now(),
    error: null,
  }
}

let _lbRefreshing = false
async function lbRefreshAll() {
  if (_lbRefreshing) return
  _lbRefreshing = true
  try {
    const list  = lbReadList()
    const stats = lbReadStats()

    // Drop cached rows for accounts that are no longer on the board, otherwise a
    // removed address keeps showing up (its row is never overwritten again).
    const listed = new Set(list.map(e => e.addr.toLowerCase()))
    for (const key of Object.keys(stats.rows ?? {})) {
      if (!listed.has(key)) delete stats.rows[key]
    }

    for (const { addr, label } of list) {
      const key = addr.toLowerCase()
      try {
        stats.rows[key] = await lbRefreshOne(addr, label ?? '', stats.rows[key])
      } catch (e) {
        if (e.rateLimited) { console.warn('[lb] HL 429 — backing off 60s'); await sleep(60_000) }
        else console.warn('[lb] refresh failed', addr, e.message)
        // keep the previous row rather than dropping the account from the board
      }
      await sleep(300)
    }
    stats.updatedAt = Date.now()
    lbWriteStats(stats)
  } finally { _lbRefreshing = false }
}

// Cheap spam gate for the public join endpoint.
const _lbJoinHits = new Map()   // ip -> [timestamps]
// Paper submissions are re-sent whenever a score changes, so they need a looser
// budget than the once-ever real-board join.
const _lbPaperHits = new Map()
function lbPaperAllowed(ip) {
  const now = Date.now(), win = 3600_000
  const hits = (_lbPaperHits.get(ip) ?? []).filter(t => now - t < win)
  if (hits.length >= 30) { _lbPaperHits.set(ip, hits); return false }
  hits.push(now); _lbPaperHits.set(ip, hits)
  return true
}

function lbJoinAllowed(ip) {
  const now = Date.now(), win = 3600_000
  const hits = (_lbJoinHits.get(ip) ?? []).filter(t => now - t < win)
  if (hits.length >= 5) { _lbJoinHits.set(ip, hits); return false }
  hits.push(now); _lbJoinHits.set(ip, hits)
  return true
}

// Early-beta bug-report inbox (see POST /api/bug-report). Rate-limited so a bad actor
// can't flood the file; 10 reports/hour/IP is plenty for genuine feedback.
const BUG_FILE = join(__dirname, 'bug-reports.json')
const _bugHits = new Map()
function bugReportAllowed(ip) {
  const now = Date.now(), win = 3600_000
  const hits = (_bugHits.get(ip) ?? []).filter(t => now - t < win)
  if (hits.length >= 10) { _bugHits.set(ip, hits); return false }
  hits.push(now); _bugHits.set(ip, hits)
  return true
}

// Uncaught-error telemetry (see POST /api/error). Deduped by message so the file stays small
// even under a crash loop; per-IP rate-limited so it can't be used to flood the disk.
const ERR_FILE = join(__dirname, 'client-errors.json')
const _errHits = new Map()
function errAllowed(ip) {
  const now = Date.now(), win = 60_000
  const hits = (_errHits.get(ip) ?? []).filter(t => now - t < win)
  if (hits.length >= 30) { _errHits.set(ip, hits); return false }
  hits.push(now); _errHits.set(ip, hits)
  return true
}
function recordError(entry) {
  let map = {}
  try { if (existsSync(ERR_FILE)) map = JSON.parse(readFileSync(ERR_FILE, 'utf8')) } catch {}
  if (!map || typeof map !== 'object') map = {}
  const key = (entry.message || '').slice(0, 140)
  const prev = map[key] || { count: 0, first: entry.at }
  map[key] = { ...entry, count: prev.count + 1, first: prev.first, last: entry.at }
  // Keep the 500 most-recently-seen distinct errors.
  const keys = Object.keys(map)
  if (keys.length > 500) {
    const trimmed = {}
    for (const k of keys.sort((a, b) => (map[b].last || 0) - (map[a].last || 0)).slice(0, 500)) trimmed[k] = map[k]
    map = trimmed
  }
  try { writeFileSync(ERR_FILE, JSON.stringify(map, null, 2)) } catch (e) { console.error('[err] save failed:', e.message) }
}

// ── Global chat (POST/GET /api/chat) ─────────────────────────────────────────
// Simple file-backed global chatroom. Poll-based (no WS) — fine at this scale. Rate-limited
// per IP and length-capped so it can't flood the disk; last 300 messages retained.
const CHAT_FILE = join(__dirname, 'chat.json')
const _chatHits = new Map()
function chatAllowed(ip) {
  const now = Date.now(), win = 60_000
  const hits = (_chatHits.get(ip) ?? []).filter(t => now - t < win)
  if (hits.length >= 15) { _chatHits.set(ip, hits); return false }   // 15 msgs/min/IP
  hits.push(now); _chatHits.set(ip, hits)
  return true
}
function loadChat() { try { const a = JSON.parse(readFileSync(CHAT_FILE, 'utf8')); return Array.isArray(a) ? a : [] } catch { return [] } }
function saveChat(a) { try { writeFileSync(CHAT_FILE, JSON.stringify(a)) } catch (e) { console.error('[chat] save failed:', e.message) } }
const _chatClean = s => String(s ?? '').split('').filter(c => { const n = c.charCodeAt(0); return n >= 32 && n !== 127 }).join('').replace(/\s+/g, ' ').trim()

// Referral attribution: { code → { addrs: [...] } }. Recorded when a referred wallet joins the
// leaderboard (deduped by addr). No addresses in the URL — only opaque per-device codes.
const REF_FILE = join(__dirname, 'referrals.json')
const REF_CODE_RE = /^[a-z0-9]{4,16}$/i
function loadRefs()  { try { const d = JSON.parse(readFileSync(REF_FILE, 'utf8')); return (d && typeof d === 'object') ? d : {} } catch { return {} } }
function saveRefs(d) { try { writeFileSync(REF_FILE, JSON.stringify(d, null, 2)) } catch (e) { console.error('[ref] save failed:', e.message) } }
function recordReferral(code, addr) {
  if (!REF_CODE_RE.test(String(code || '')) || !isAddr(addr)) return
  const refs = loadRefs()
  const key  = String(code)
  const a    = String(addr).toLowerCase()
  const list = Array.isArray(refs[key]?.addrs) ? refs[key].addrs : []
  if (list.includes(a)) return                  // one credit per referred wallet
  list.push(a)
  refs[key] = { addrs: list, updatedAt: new Date().toISOString() }
  saveRefs(refs)
  console.log(`[ref] ${a.slice(0, 8)}… credited to code ${key} (total ${list.length})`)
}

// ─── PAPER-TRADING CHALLENGE ──────────────────────────────────────────────────
// Time-boxed contest: everyone starts with $1000 paper (deposits disabled, enforced client
// side), highest net PnL at the deadline wins the prize. Anyone can play; a wallet is only
// needed to CLAIM. Paper scores are self-reported (client-computed) and unverifiable — the
// board is for fun/competition; the owner pays the winner manually after sanity-checking.
//
// >>> EDIT THESE to run / extend / end a round: <<<
const CHALLENGE = {
  start:  1000,
  target: 500,                                   // headline goal (progress bar); winner = highest at deadline
  prize:  '$100 USDC',
  end:    Date.parse('2026-08-31T23:59:59Z'),    // deadline (UTC). Change to open a new round.
}
const CHAL_FILE = join(__dirname, 'challenge.json')
const CHAL_NAME_RE = /^.{1,24}$/
const _chalHits = new Map()
function chalAllowed(ip) {
  const now = Date.now(), win = 60_000
  const hits = (_chalHits.get(ip) ?? []).filter(t => now - t < win)
  if (hits.length >= 20) { _chalHits.set(ip, hits); return false }
  hits.push(now); _chalHits.set(ip, hits)
  return true
}
function loadChal()  { try { const d = JSON.parse(readFileSync(CHAL_FILE, 'utf8')); return (d && typeof d === 'object') ? d : {} } catch { return {} } }
function saveChal(d) { try { writeFileSync(CHAL_FILE, JSON.stringify(d, null, 2)) } catch (e) { console.error('[chal] save failed:', e.message) } }
function chalBoard(store) {
  return Object.entries(store)
    .map(([id, e]) => {
      const s = e.snap || {}
      return {
        id, name: e.name, netPnl: Number(e.netPnl) || 0, claimed: !!e.addr,
        // Live snapshot for the expandable row (watch positions / PnL breakdown).
        equity:        Number(s.equity),
        unrealizedPnl: Number(s.unrealizedPnl) || 0,
        realizedPnl:   Number(s.realizedPnl)   || 0,
        volume:        Number(s.volume)        || 0,
        healthPct:     Number(s.healthPct)     || 0,
        trades:        Number(s.trades)        || 0,
        wins:          Number(s.wins)          || 0,
        positions:     Array.isArray(s.positions) ? s.positions : [],
      }
    })
    .sort((a, b) => b.netPnl - a.netPnl)
}

// ── Challenge audit trail (winner verification) ───────────────────────────────
// Players submit their full paper fill log; it's stored privately (never served on the
// public board) so a winning run can be reviewed: the claimed PnL is reconciled against
// the fills, and each fill's price is cross-checked against real Hyperliquid candles.
const CHAL_AUDIT_FILE = join(__dirname, 'challenge-audit.json')
function loadChalAudit()  { try { const d = JSON.parse(readFileSync(CHAL_AUDIT_FILE, 'utf8')); return (d && typeof d === 'object') ? d : {} } catch { return {} } }
function saveChalAudit(d) { try { writeFileSync(CHAL_AUDIT_FILE, JSON.stringify(d)) } catch (e) { console.error('[chal] audit save failed:', e.message) } }
const _cNum = (v, lo, hi) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0 }
function chalSanitizeFills(arr) {
  if (!Array.isArray(arr)) return []
  return arr.slice(0, 400).map(f => {
    const coin = String(f.coin ?? '').slice(0, 24)
    if (!/^[A-Za-z0-9:#+._-]{1,24}$/.test(coin)) return null
    return {
      coin,
      px:        _cNum(f.px, 0, 1e12),
      sz:        _cNum(f.sz, 0, 1e12),
      side:      f.side === 'B' ? 'B' : 'A',
      time:      Math.round(_cNum(f.time, 0, 1e15)),
      closedPnl: _cNum(f.closedPnl, -1e12, 1e12),
      dir:       String(f.dir ?? '').slice(0, 24),
      fee:       _cNum(f.fee, 0, 1e9),
    }
  }).filter(Boolean)
}
const _IVL_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 }
// Pick the finest interval that keeps a coin's whole fill span under ~800 candles per request.
function _chalInterval(spanMs) {
  for (const k of ['1m', '5m', '15m', '1h', '4h', '1d']) if (spanMs / _IVL_MS[k] <= 800) return k
  return '1d'
}
// Cross-check each fill's price against the real HL candle covering its timestamp. Best-effort:
// coins we can't fetch (HIP-3 dex coins, prediction outcomes, API errors) are marked 'unverified'
// rather than failed. A fill whose price sits outside the real [low,high] (±1% for slippage) is
// flagged — that's the tell of a fabricated "bought the exact bottom at a price that never traded".
async function chalPriceCheck(fills) {
  const TOL = 0.01
  const byCoin = new Map()
  for (const f of fills) { if (!byCoin.has(f.coin)) byCoin.set(f.coin, []); byCoin.get(f.coin).push(f) }
  const out = new Map()   // fill -> { ok, market }
  let checked = 0, flagged = 0, unverified = 0
  for (const [coin, cfills] of byCoin) {
    // Skip coins HL candles can't answer for: HIP-3 dex-qualified ("dex:SYM") and outcomes ("#..").
    if (coin.includes(':') || coin.startsWith('#') || byCoin.size > 20) {
      for (const f of cfills) { out.set(f, { ok: null, reason: 'unverifiable market' }); unverified++ }
      continue
    }
    const times = cfills.map(f => f.time)
    const lo = Math.min(...times), hi = Math.max(...times)
    const ivl = _chalInterval(Math.max(_IVL_MS['1m'], hi - lo))
    try {
      const candles = await hlInfo({ type: 'candleSnapshot', req: { coin, interval: ivl, startTime: lo - _IVL_MS[ivl], endTime: hi + _IVL_MS[ivl] } })
      const cs = (Array.isArray(candles) ? candles : []).map(c => ({ t: +c.t, T: +c.T, l: parseFloat(c.l), h: parseFloat(c.h) })).sort((a, b) => a.t - b.t)
      if (!cs.length) { for (const f of cfills) { out.set(f, { ok: null, reason: 'no candles' }); unverified++ }; continue }
      for (const f of cfills) {
        const c = cs.find(c => f.time >= c.t && f.time <= (c.T || c.t + _IVL_MS[ivl]))
              || cs.reduce((best, c) => Math.abs(c.t - f.time) < Math.abs(best.t - f.time) ? c : best, cs[0])
        const ok = f.px >= c.l * (1 - TOL) && f.px <= c.h * (1 + TOL)
        out.set(f, { ok, market: [c.l, c.h] })
        if (ok) checked++; else flagged++
      }
    } catch { for (const f of cfills) { out.set(f, { ok: null, reason: 'candle fetch failed' }); unverified++ } }
  }
  return { out, checked, flagged, unverified }
}

function text(res, status, data) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'text/plain' })
  res.end(data)
}

// ─── ROUTER ───────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url    = new URL(req.url, `http://localhost:${PORT}`)
  const path   = url.pathname
  const method = req.method

  if (method === 'OPTIONS') { res.writeHead(204, CORS); return res.end() }

  // ── GET /api/auth/nonce → { nonce } to be signed by the account's agent key ──
  if (method === 'GET' && path === '/api/auth/nonce') {
    return json(res, 200, { nonce: issueNonce(), ttl: NONCE_TTL_MS })
  }

  // ── POST /api/auth/login { address, nonce, signature } → { token, exp } ──────
  // The client signs authMsg(address, nonce) with the account's agent key. The
  // recovered signer becomes the session identity; ownership is checked per-route.
  if (method === 'POST' && path === '/api/auth/login') {
    const b = await body(req)
    if (!isAddr(b.address) || !b.nonce || !b.signature) return json(res, 400, { error: 'bad request' })
    if (!consumeNonce(b.nonce)) return json(res, 400, { error: 'nonce expired or unknown' })
    let signer
    try { signer = ethers.verifyMessage(authMsg(b.address, b.nonce), b.signature).toLowerCase() }
    catch { return json(res, 400, { error: 'bad signature' }) }
    const exp = Date.now() + TOKEN_TTL_MS
    return json(res, 200, { token: signToken({ s: signer, e: exp }), exp })
  }

  // ── POST /api/start ───────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/start') {
    const b = await body(req)
    // Must present a token whose signer == the agent key being submitted (proves you
    // hold the key), and the account must be unclaimed or already yours. Admin bypasses.
    const auth = getAuth(req)
    if (!auth) return json(res, 401, { error: 'authentication required' })
    if (!auth.admin) {
      const agentAddr = agentAddrFromKey(b.agentKey ?? '')
      if (!agentAddr || agentAddr !== auth.signer) return json(res, 403, { error: 'start with your own agent key' })
      // A stale claim must not lock the real owner out — see agentApprovedFor.
      const owner = botOwner.get(String(b.address ?? '').toLowerCase())
      if (owner && owner !== auth.signer && !(await agentApprovedFor(b.address ?? '', auth.signer)))
        return json(res, 403, { error: 'account controlled by another key' })
    }
    // The paywall. Enforced here because this is where a strategy actually starts —
    // the client-side gate only hides the UI. A resume (deploy/reboot) does not come
    // through this route, so an expiring subscription never kills a bot mid-flight, it
    // just stops new ones being armed.
    //
    // Dev mode used to bypass the gate in the CLIENT only — the server had never heard of
    // it — so the owner got an unlocked Run button and a 402 the moment they pressed it.
    // Dev mode is already earned by verifying LB_PIN against this server, so the same PIN
    // is what proves it here. Deliberately scoped to the paywall alone: it is an
    // entitlement, not a key, and the agent-key ownership checks above still apply in full.
    const _operator = auth.admin || (!!LB_PIN && (req.headers['x-lb-pin'] ?? '') === LB_PIN)
    if (!_operator && !subActive(b.address ?? '')) {
      return json(res, 402, { error: 'subscription required', subscribe: true })
    }
    const result = await startStrategy(b.type, b.args ?? [], b.agentKey ?? '', b.address ?? '', b.instance ?? '')
    return json(res, result.ok ? 200 : 400, result)
  }

  // ── POST /api/stop ────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/stop') {
    const b = await body(req)
    if (!await requireOwner(req, res, b.address ?? '')) return
    const result = stopStrategy(b.type, b.address ?? '', b.instance ?? '')
    return json(res, result.ok ? 200 : 400, result)
  }

  // ── POST /api/restart ─────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/restart') {
    const b = await body(req)
    if (!await requireOwner(req, res, b.address ?? '')) return
    const result = await restartStrategy(b.type, b.address ?? '', b.instance ?? '')
    return json(res, result.ok ? 200 : 400, result)
  }

  if (method === 'POST' && path === '/api/pause') {
    const b = await body(req)
    if (!await requireOwner(req, res, b.address ?? '')) return
    const r = pauseStrategy(b.type, b.address ?? '', b.instance ?? '')
    return json(res, r.ok ? 200 : 400, r)
  }

  if (method === 'POST' && path === '/api/resume') {
    const b = await body(req)
    if (!await requireOwner(req, res, b.address ?? '')) return
    const r = resumeStrategy(b.type, b.address ?? '', b.instance ?? '')
    return json(res, r.ok ? 200 : 400, r)
  }

  // ── GET /api/status?address=0x... ─────────────────────────────────────────
  if (method === 'GET' && path === '/api/status') {
    const addr = url.searchParams.get('address') || ''
    return json(res, 200, getStatus(addr))
  }

  // ── GET /api/status/all  → { "0xaddr": ["grid","dca",...] } ───────────────
  if (method === 'GET' && path === '/api/status/all') {
    const out = {}
    for (const [key, p] of Object.entries(procs)) {
      const [type, addr] = key.split(':')
      if (!out[addr]) out[addr] = []
      out[addr].push(p.instance ? `${type}:${p.instance}` : type)
    }
    return json(res, 200, out)
  }

  // ── GET /api/wins?address=0x...          → all strategies ─────────────────
  // ── GET /api/wins/:type?address=0x...    → one strategy ───────────────────
  if (method === 'GET' && path.startsWith('/api/wins')) {
    const addr  = url.searchParams.get('address') || ''
    if (!await requireOwner(req, res, addr)) return
    const parts = path.split('/').filter(Boolean)   // ['api','wins','type'?]
    if (parts.length >= 3) return json(res, 200, readWins(parts[2], addr))
    return json(res, 200, readAllWins(addr))
  }

  // ── GET /api/history/:type?address=0x...                  → list log files ─
  // ── GET /api/history/:type/:filename?address=0x...         → read one file ──
  if (method === 'GET' && path.startsWith('/api/history/')) {
    const addr  = url.searchParams.get('address') || ''
    if (!await requireOwner(req, res, addr)) return
    const parts = path.split('/').filter(Boolean)   // ['api','history','type','file'?]
    const type  = parts[2]
    if (!type) return json(res, 400, { error: 'missing type' })
    if (parts[3]) {
      const content = readLogFile(type, addr, parts[3])
      if (!content) return json(res, 404, { error: 'not found' })
      return text(res, 200, content)
    }
    return json(res, 200, logFiles(type, addr))
  }

  // ── GET /api/logs/:type?address=0x...  → SSE live stream ─────────────────
  if (method === 'GET' && path.startsWith('/api/logs/')) {
    const type = path.split('/')[3]
    const addr = url.searchParams.get('address') || ''
    const inst = url.searchParams.get('instance') || ''
    if (!type) return json(res, 400, { error: 'missing type' })
    if (!await requireOwner(req, res, addr, url.searchParams.get('token'))) return

    res.writeHead(200, {
      ...CORS,
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    })

    const key = procKey(type, addr, inst)

    // Replay buffer to late subscriber
    for (const line of (procs[key]?.buffer ?? [])) {
      res.write(`data: ${JSON.stringify({ line })}\n\n`)
    }

    if (!subs[key]) subs[key] = new Set()
    subs[key].add(res)

    req.on('close', () => { subs[key]?.delete(res) })
    return
  }

  // ── GET /api/leaderboard  → return saved extra addresses ─────────────────
  // ── GET /api/leaderboard/paper → the simulated board ─────────────────────
  if (method === 'GET' && path === '/api/leaderboard/paper') {
    const rows = lbPaperRead()
      .map(({ secret, ...pub }) => pub)          // never leak the update secrets
      .sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0))
    return json(res, 200, { rows, simulated: true, updatedAt: Date.now() })
  }

  // ── POST /api/leaderboard/paper { name, secret?, equity, pnl, trades, wins } ──
  // Self-reported simulated results. Clamped to sane ranges so a bad payload
  // can't wreck the board's rendering, but the figures are NOT verifiable.
  if (method === 'POST' && path === '/api/leaderboard/paper') {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?'
    if (!lbPaperAllowed(ip)) return json(res, 429, { error: 'too many submissions, try later' })

    const b    = await body(req)
    const name = lbCleanName(b.name)
    if (name.length < 2) return json(res, 400, { error: 'name must be at least 2 characters' })
    if (/^0x[0-9a-fA-F]{6,}/.test(name)) return json(res, 400, { error: 'name cannot look like an address' })

    const num = (v, lo, hi) => {
      const n = parseFloat(v)
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0
    }
    // Sanitize the open-position list so the board's expandable detail can render
    // the same way the real one does. Everything is clamped and re-stringified —
    // nothing the client sends is echoed back raw.
    const positions = Array.isArray(b.positions) ? b.positions.slice(0, 20).map(ap => {
      const p = ap?.position ?? {}
      const coin = String(p.coin ?? '').slice(0, 24)
      if (!/^[A-Za-z0-9:#+._-]{1,24}$/.test(coin)) return null
      return { position: {
        coin,
        szi:            String(num(p.szi, -1e12, 1e12)),
        entryPx:        String(num(p.entryPx, 0, 1e12)),
        positionValue:  String(num(p.positionValue, 0, 1e12)),
        unrealizedPnl:  String(num(p.unrealizedPnl, -1e12, 1e12)),
        liquidationPx:  p.liquidationPx == null ? null : String(num(p.liquidationPx, 0, 1e12)),
        returnOnEquity: String(num(p.returnOnEquity, -1e6, 1e6)),
        leverage: { type: p.leverage?.type === 'isolated' ? 'isolated' : 'cross',
                    value: Math.round(num(p.leverage?.value, 1, 100)) || 1 },
      } }
    }).filter(Boolean) : []

    const row = {
      name,
      equity:  num(b.equity, 0, 1e12),
      pnl:     num(b.pnl,   -1e12, 1e12),
      trades:  Math.round(num(b.trades, 0, 1e6)),
      wins:    Math.round(num(b.wins,   0, 1e6)),
      unrealizedPnl: num(b.unrealizedPnl, -1e12, 1e12),
      realizedPnl:   num(b.realizedPnl,   -1e12, 1e12),
      volume:        num(b.volume, 0, 1e12),
      healthPct:     num(b.healthPct, 0, 100),
      positions,
      updated: Date.now(),
    }
    if (row.wins > row.trades) row.wins = row.trades

    const list = lbPaperRead()
    const i    = list.findIndex(e => e.name.toLowerCase() === name.toLowerCase())

    if (i >= 0) {
      // Existing name — only the holder of the original secret may update it.
      const given = String(b.secret ?? '')
      const want  = String(list[i].secret ?? '')
      const ok = given.length === want.length && given.length > 0 &&
        timingSafeEqual(Buffer.from(given), Buffer.from(want))
      if (!ok) return json(res, 403, { error: 'that name is taken — pick another' })
      list[i] = { ...list[i], ...row }
      lbPaperWrite(list)
      return json(res, 200, { ok: true, updated: true })
    }

    if (list.length >= LB_PAPER_MAX) return json(res, 507, { error: 'paper board full' })
    const secret = randomBytes(16).toString('hex')
    list.push({ ...row, secret, created: Date.now() })
    lbPaperWrite(list)
    return json(res, 200, { ok: true, added: true, secret })
  }

  if (method === 'GET' && path === '/api/leaderboard') {
    const addrs = existsSync(LEADERBOARD_FILE)
      ? JSON.parse(readFileSync(LEADERBOARD_FILE, 'utf8'))
      : []
    // Hidden accounts are withheld from everyone EXCEPT a PIN-holder, who gets them
    // flagged so the dev UI can show and un-hide them. Filtering client-side instead
    // would leave the addresses sitting in a public response, which is not hidden.
    const hidden = new Set(lbReadHidden())
    if (!hidden.size) return json(res, 200, addrs)
    const isAdmin = LB_PIN && (req.headers['x-lb-pin'] ?? '') === LB_PIN
    if (isAdmin) return json(res, 200, addrs.map(e => hidden.has(String(e.addr).toLowerCase()) ? { ...e, hidden: true } : e))
    return json(res, 200, addrs.filter(e => !hidden.has(String(e.addr).toLowerCase())))
  }

  // ── GET /api/leaderboard/stats → pre-computed rows (no client fan-out) ────
  if (method === 'GET' && path === '/api/leaderboard/stats') {
    const s = lbReadStats()
    const listed = new Set(lbReadList().map(e => e.addr.toLowerCase()))
    const hidden  = new Set(lbReadHidden())
    const isAdmin = LB_PIN && (req.headers['x-lb-pin'] ?? '') === LB_PIN
    const rows = Object.values(s.rows ?? {})
      .filter(r => listed.has(r.addr.toLowerCase()))   // never serve a de-listed account
      // Hidden rows are withheld unless the caller holds the PIN, in which case they come
      // back flagged so the dev board can render them as hidden rather than omit them.
      .filter(r => isAdmin || !hidden.has(r.addr.toLowerCase()))
      .map(r => hidden.has(r.addr.toLowerCase()) ? { ...r, hidden: true } : r)
      // drop internal accumulators/cursors — `windows` in particular is large
      .map(({ lastFillTs, lastFundingTs, windows, fees, volume, funding, dexes, dexSweepAt, ...row }) => row)
      .sort((a, b) => b.accountValue - a.accountValue)
    return json(res, 200, { updatedAt: s.updatedAt ?? 0, rows })
  }

  // ── POST /api/bug-report { message, diag } → append to bug-reports.json ────
  // Public (no auth): early-beta feedback channel from the in-app "Report a Bug"
  // sheet. Rate-limited per IP, size-capped, and it stores no keys/addresses —
  // only the lightweight diagnostics the client chose to attach.
  // ── POST /api/error → record an uncaught client error (telemetry) ────────────
  if (method === 'POST' && path === '/api/error') {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?'
    if (!errAllowed(ip)) return json(res, 200, { ok: true })   // silently drop floods
    const b = await body(req)
    const message = String(b.message ?? '').trim().slice(0, 500)
    if (!message) return json(res, 400, { error: 'empty' })
    recordError({
      message,
      kind:   String(b.kind ?? 'error').slice(0, 20),
      stack:  String(b.stack ?? '').slice(0, 2000),
      url:    String(b.url ?? '').slice(0, 200),
      ua:     String(b.ua ?? '').slice(0, 300),
      screen: String(b.screen ?? '').slice(0, 20),
      lang:   String(b.lang ?? '').slice(0, 8),
      at:     Date.now(),
    })
    return json(res, 200, { ok: true })
  }

  // ── GET /api/errors → read back what POST /api/error collects (OWNER-ONLY) ───
  // Same gate as /api/challenge/audit: ADMIN_TOKEN bearer, or LB_PIN by header or
  // ?pin= query. The query form is the point — it opens in a phone browser, which
  // is where a rate-limit episode actually gets noticed. Newest-seen first.
  //   /api/errors?pin=…&kind=ratelimit
  if (method === 'GET' && path === '/api/errors') {
    const tok    = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')
    const pin    = req.headers['x-lb-pin'] || url.searchParams.get('pin') || ''
    const authed = (ADMIN_TOKEN && tok === ADMIN_TOKEN) || (LB_PIN && pin === LB_PIN)
    if (!authed) return json(res, 403, { error: 'forbidden' })
    let map = {}
    try { if (existsSync(ERR_FILE)) map = JSON.parse(readFileSync(ERR_FILE, 'utf8')) } catch {}
    if (!map || typeof map !== 'object') map = {}
    const kind  = String(url.searchParams.get('kind') || '')
    const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 100, 500)
    const entries = Object.entries(map)
      .map(([message, v]) => ({ message, ...v }))
      .filter(e => !kind || e.kind === kind)
      .sort((a, b) => (b.last || 0) - (a.last || 0))
    return json(res, 200, { total: entries.length, entries: entries.slice(0, limit) })
  }

  if (method === 'POST' && path === '/api/bug-report') {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?'
    if (!bugReportAllowed(ip)) return json(res, 429, { error: 'too many reports, try later' })
    const b = await body(req)
    const message = String(b.message ?? '').trim().slice(0, 4000)
    if (!message) return json(res, 400, { error: 'empty message' })
    const diag = (b && typeof b.diag === 'object' && b.diag) ? b.diag : {}
    const entry = { message, diag, ip, receivedAt: new Date().toISOString() }
    try {
      let list = []
      try { if (existsSync(BUG_FILE)) list = JSON.parse(readFileSync(BUG_FILE, 'utf8')) } catch {}
      if (!Array.isArray(list)) list = []
      list.push(entry)
      if (list.length > 2000) list = list.slice(-2000)
      writeFileSync(BUG_FILE, JSON.stringify(list, null, 2))
      console.log(`[bug] report received (${message.length} chars) tab=${diag.tab || '?'} lang=${diag.lang || '?'}`)
      return json(res, 200, { ok: true })
    } catch (e) {
      console.error('[bug] save failed:', e.message)
      return json(res, 500, { error: 'save failed' })
    }
  }

  // ── GET /api/chat?since=<ts> → recent global-chat messages (or new ones since ts) ──
  if (method === 'GET' && path === '/api/chat') {
    const since = parseInt(url.searchParams.get('since') || '0') || 0
    const all   = loadChat()
    const messages = since ? all.filter(m => m.ts > since) : all.slice(-80)
    return json(res, 200, { messages, now: Date.now() })
  }
  // ── POST /api/chat { name, text, addr? } → append a global-chat message ──
  if (method === 'POST' && path === '/api/chat') {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?'
    if (!chatAllowed(ip)) return json(res, 429, { error: 'slow down — too many messages' })
    const b    = await body(req)
    const text = _chatClean(b.text).slice(0, 280)
    if (!text) return json(res, 400, { error: 'empty message' })
    const name = _chatClean(b.name).slice(0, 24) || 'anon'
    const addr = isAddr(b.addr) ? String(b.addr).toLowerCase() : null
    const msg  = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, addr, text, ts: Date.now() }
    let list = loadChat()
    list.push(msg)
    if (list.length > 300) list = list.slice(-300)
    saveChat(list)
    return json(res, 200, { ok: true, message: msg })
  }

  // ── GET /api/referral/count?code=XXXX → how many wallets joined via this code ──
  if (method === 'GET' && path === '/api/referral/count') {
    const code = url.searchParams.get('code') || ''
    if (!REF_CODE_RE.test(code)) return json(res, 200, { count: 0 })
    const refs = loadRefs()
    const n = Array.isArray(refs[code]?.addrs) ? refs[code].addrs.length : 0
    return json(res, 200, { count: n })
  }

  // ── GET /api/challenge → config + board (+ winner once the deadline passes) ──
  if (method === 'GET' && path === '/api/challenge') {
    const now   = Date.now()
    const board = chalBoard(loadChal())
    const ended = now > CHALLENGE.end
    const winner = ended && board.length ? board[0] : null
    return json(res, 200, { config: CHALLENGE, now, ended, board: board.slice(0, 100), winner })
  }
  // ── POST /api/challenge/submit { id, name, netPnl } → keep this player's score ──
  if (method === 'POST' && path === '/api/challenge/submit') {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?'
    if (!chalAllowed(ip)) return json(res, 429, { error: 'slow down' })
    if (Date.now() > CHALLENGE.end) return json(res, 200, { ok: true, ended: true })
    const b = await body(req)
    const id = String(b.id || '')
    if (!REF_CODE_RE.test(id)) return json(res, 400, { error: 'bad id' })
    const name   = CHAL_NAME_RE.test(String(b.name || '')) ? String(b.name) : ('Player-' + id.slice(0, 4))
    const netPnl = Number(b.netPnl)
    // Scores are client-reported (paper is simulated) — keep them in a sane band so the board
    // can't be trivially blown up. Real anti-fraud is manual review before paying the winner.
    if (!Number.isFinite(netPnl) || netPnl > 1_000_000 || netPnl < -CHALLENGE.start) return json(res, 400, { error: 'implausible score' })
    // Live snapshot so the standings can show each player's positions + PnL breakdown when a
    // row is expanded — sanitized/clamped exactly like the paper leaderboard (nothing echoed raw).
    const num = (v, lo, hi) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0 }
    const positions = Array.isArray(b.positions) ? b.positions.slice(0, 20).map(ap => {
      const p = ap?.position ?? {}
      const coin = String(p.coin ?? '').slice(0, 24)
      if (!/^[A-Za-z0-9:#+._-]{1,24}$/.test(coin)) return null
      return { position: {
        coin,
        szi:            String(num(p.szi, -1e12, 1e12)),
        entryPx:        String(num(p.entryPx, 0, 1e12)),
        positionValue:  String(num(p.positionValue, 0, 1e12)),
        unrealizedPnl:  String(num(p.unrealizedPnl, -1e12, 1e12)),
        liquidationPx:  p.liquidationPx == null ? null : String(num(p.liquidationPx, 0, 1e12)),
        returnOnEquity: String(num(p.returnOnEquity, -1e6, 1e6)),
        leverage: { type: p.leverage?.type === 'isolated' ? 'isolated' : 'cross',
                    value: Math.round(num(p.leverage?.value, 1, 100)) || 1 },
      } }
    }).filter(Boolean) : []
    const snap = {
      equity:        num(b.equity, 0, 1e12),
      unrealizedPnl: num(b.unrealizedPnl, -1e12, 1e12),
      realizedPnl:   num(b.realizedPnl,   -1e12, 1e12),
      volume:        num(b.volume, 0, 1e12),
      healthPct:     num(b.healthPct, 0, 100),
      trades:        Math.round(num(b.trades, 0, 1e6)),
      wins:          Math.round(num(b.wins,   0, 1e6)),
      positions,
    }
    if (snap.wins > snap.trades) snap.wins = snap.trades
    const store = loadChal()
    const prev  = store[id] || {}
    // Store the player's CURRENT net PnL (live board) — ranking and the row must match what the
    // player sees in their own card, so this is the latest value, not a best-ever peak.
    store[id] = { ...prev, name, netPnl, snap, updatedAt: new Date().toISOString() }
    saveChal(store)
    // Private audit trail: the full fill log (sent only when it changed) + total funding, kept
    // out of the public board and used to verify a winning run. See GET /api/challenge/audit.
    if (Array.isArray(b.fills)) {
      const audit = loadChalAudit()
      audit[id] = { name, funding: _cNum(b.funding, -1e12, 1e12), fills: chalSanitizeFills(b.fills), updatedAt: new Date().toISOString() }
      saveChalAudit(audit)
    }
    return json(res, 200, { ok: true })
  }
  // ── POST /api/challenge/claim { id, addr } → record a wallet to be paid ──────
  if (method === 'POST' && path === '/api/challenge/claim') {
    const b = await body(req)
    const id = String(b.id || '')
    if (!REF_CODE_RE.test(id)) return json(res, 400, { error: 'bad id' })
    if (!isAddr(b.addr))       return json(res, 400, { error: 'invalid address' })
    const store = loadChal()
    if (!store[id]) return json(res, 404, { error: 'no entry for this player' })
    store[id] = { ...store[id], addr: String(b.addr).toLowerCase(), claimedAt: new Date().toISOString() }
    saveChal(store)
    console.log(`[chal] claim: ${id} → ${String(b.addr).slice(0, 8)}… (netPnl ${store[id].netPnl})`)
    return json(res, 200, { ok: true })
  }

  // ── GET /api/challenge/audit?id=..&pin=..[&prices=0] → verify a player's run ──
  // OWNER-ONLY (LB_PIN header/query, or ADMIN_TOKEN bearer). Returns the player's full fill
  // log, a PnL reconciliation (does the claimed net PnL follow from the fills + funding +
  // unrealized?), and a per-fill price cross-check against real Hyperliquid candles. This is
  // the tool for reviewing a winner before paying — it can't PROVE simulated results, but it
  // catches fabricated numbers and impossible fill prices.
  if (method === 'GET' && path === '/api/challenge/audit') {
    const tok    = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')
    const pin    = req.headers['x-lb-pin'] || url.searchParams.get('pin') || ''
    const authed = (ADMIN_TOKEN && tok === ADMIN_TOKEN) || (LB_PIN && pin === LB_PIN)
    if (!authed) return json(res, 403, { error: 'forbidden' })
    const id = String(url.searchParams.get('id') || '')
    if (!REF_CODE_RE.test(id)) return json(res, 400, { error: 'bad id' })
    const store = loadChal(), audit = loadChalAudit()
    const entry = store[id]
    if (!entry) return json(res, 404, { error: 'no entry for this player' })
    const a = audit[id] || {}
    const fills = Array.isArray(a.fills) ? a.fills : []
    const snap  = entry.snap || {}

    // Reconcile: net PnL should equal realized(Σ closedPnl) − fees(Σ fee) + funding + unrealized.
    const realized = fills.reduce((s, f) => s + (Number(f.closedPnl) || 0), 0)
    const fees     = fills.reduce((s, f) => s + (Number(f.fee) || 0), 0)
    const funding  = Number(a.funding) || 0
    const unreal   = Number(snap.unrealizedPnl) || 0
    const reconciled = realized - fees + funding + unreal
    const claimed    = Number(entry.netPnl) || 0
    const gap        = claimed - reconciled
    const reconcileOk = Math.abs(gap) <= Math.max(1, Math.abs(claimed) * 0.02)   // ±$1 or 2%

    // Per-fill price cross-check (skip with ?prices=0 to avoid the HL calls).
    let priceSummary = { checked: 0, flagged: 0, unverified: 0, skipped: true }
    let fillsOut = fills
    if (url.searchParams.get('prices') !== '0' && fills.length) {
      try {
        const { out, checked, flagged, unverified } = await chalPriceCheck(fills)
        priceSummary = { checked, flagged, unverified, skipped: false }
        fillsOut = fills.map(f => ({ ...f, price: out.get(f) || { ok: null } }))
      } catch (e) { priceSummary = { checked: 0, flagged: 0, unverified: fills.length, skipped: false, error: e.message } }
    }

    return json(res, 200, {
      id, name: entry.name, claimed, wallet: entry.addr || null, updatedAt: entry.updatedAt,
      reconcile: { claimed, reconciled, realized, fees, funding, unrealized: unreal, gap, ok: reconcileOk },
      prices: priceSummary,
      fillCount: fills.length,
      fills: fillsOut,
    })
  }

  // ── POST /api/leaderboard/join { addr } → self-serve add ──────────────────
  // Called by the client only after a wallet connect. The server can't verify
  // ownership without a signed message, so it also rate-limits per IP, caps the
  // list, and rejects addresses with no Hyperliquid account.
  if (method === 'POST' && path === '/api/leaderboard/join') {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?'
    if (!lbJoinAllowed(ip)) return json(res, 429, { error: 'too many joins, try later' })

    const b = await body(req)
    if (!isAddr(b.addr)) return json(res, 400, { error: 'invalid address' })
    if (b.refBy) recordReferral(b.refBy, b.addr)   // attribute the invite that brought this wallet

    const list  = lbReadList()
    const key   = b.addr.toLowerCase()
    const force = !!b.force   // explicit "add me back" (user-prompted) — overrides removal
    if (list.some(e => e.addr.toLowerCase() === key)) { if (force) lbClearRemoved(key); return json(res, 200, { ok: true, already: true }) }
    // A previously-removed account does NOT silently re-enter on the next connect.
    if (!force && lbIsRemoved(key)) return json(res, 200, { ok: true, blocked: true })
    if (list.length >= LB_MAX) return json(res, 507, { error: 'leaderboard full' })
    if (force) lbClearRemoved(key)

    // Must be a funded HL account — blocks junk, burner and dusted addresses.
    try {
      const cs = await hlInfo({ type: 'clearinghouseState', user: b.addr })
      const equity = parseFloat(cs?.marginSummary?.accountValue ?? 0)
      if (!(equity >= LB_MIN_EQUITY)) return json(res, 400, { error: `needs at least $${LB_MIN_EQUITY} on Hyperliquid` })
    } catch { return json(res, 503, { error: 'could not verify account' }) }

    list.push({ addr: b.addr, label: (b.label ?? '').toString().slice(0, 24) })
    lbWriteList(list)
    lbRefreshAll().catch(() => {})   // pick the newcomer up right away
    return json(res, 200, { ok: true, added: true })
  }

  // ── Subscription: status / trial / check-now / pay-from ──────────────────────
  if (method === 'GET' && path === '/api/sub/status') {
    const addr = url.searchParams.get('address') ?? ''
    const r = isAddr(addr) ? subGet(addr) : null
    return json(res, 200, {
      active: !!(r && Number(r.until) > Date.now()),
      until: r?.until ?? 0,
      credit: Number(r?.credit) || 0,          // banked from an underpayment
      lastPayment: r?.lastPayment ?? 0,
      trialAvailable: SUB_TRIAL_DAYS > 0 && !(r?.trialUsed),
      trialDays: SUB_TRIAL_DAYS,
      priceUsdc: SUB_PRICE_USDC,
      periodDays: SUB_PERIOD_DAYS,
      treasury: SUB_TREASURY,
      chain: 'Hyperliquid',
      token: 'USDC',
    })
  }

  if (method === 'POST' && path === '/api/sub/trial') {
    const b = await body(req)
    if (!isAddr(b.address)) return json(res, 400, { error: 'invalid address' })
    if (!SUB_TRIAL_DAYS)    return json(res, 400, { error: 'no trial available' })
    const cur = subGet(b.address)
    // One trial per wallet, ever — otherwise it is not a trial, it is a free product.
    if (cur?.trialUsed) return json(res, 400, { error: 'trial already used for this wallet' })
    const r = subExtend(b.address, SUB_TRIAL_DAYS, { trialUsed: true })
    return json(res, 200, { ok: true, until: r.until, trial: true })
  }

  // "I sent it" — poll the treasury ledger right now instead of waiting for the timer.
  // Throttled globally so a page full of impatient taps cannot hammer Hyperliquid.
  if (method === 'POST' && path === '/api/sub/check') {
    const b = await body(req)
    if (Date.now() - _subPollAt >= SUB_POKE_MS) await subPollPayments()
    const r = isAddr(b.address) ? subGet(b.address) : null
    return json(res, 200, {
      active: !!(r && Number(r.until) > Date.now()),
      until: r?.until ?? 0,
      credit: Number(r?.credit) || 0,
    })
  }

  // Optional: nominate a different wallet to enable before sending. Without this the
  // sender is credited, which is what almost everyone wants; this covers the person
  // funding several accounts from one address.
  if (method === 'POST' && path === '/api/sub/payfrom') {
    const b = await body(req)
    if (!isAddr(b.address) || !isAddr(b.payer)) return json(res, 400, { error: 'invalid address' })
    const st = subPayRead()
    st.binds = st.binds ?? {}
    st.binds[String(b.payer).toLowerCase()] = String(b.address).toLowerCase()
    subPayWrite(st)
    return json(res, 200, { ok: true })
  }
  // ── POST /api/combined { addrs } → one authoritative combined snapshot ───────
  // Public and read-only: it returns aggregate figures for addresses the caller already
  // knows, and every input is a public Hyperliquid address whose data anyone can query
  // directly. Cached per address-set so N devices polling cost one upstream refresh.
  if (method === 'POST' && path === '/api/combined') {
    const b = await body(req)
    const addrs = [...new Set((Array.isArray(b.addrs) ? b.addrs : [])
      .filter(a => isAddr(a)).map(a => String(a).toLowerCase()))].sort()
    if (!addrs.length) return json(res, 400, { error: 'no valid addresses' })
    if (addrs.length > 50) return json(res, 400, { error: 'too many addresses' })

    const key = addrs.join(',')
    const hit = _combinedCache.get(key)
    if (hit && (Date.now() - hit.at) < COMBINED_TTL_MS) return json(res, 200, { ...hit.data, cached: true })

    try {
      const data = await computeCombined(addrs)
      // Never cache a fully-failed refresh: that would pin an empty total for the TTL.
      if (data.wallets > 0) _combinedCache.set(key, { at: Date.now(), data })
      else if (hit) return json(res, 200, { ...hit.data, stale: true })
      return json(res, 200, data)
    } catch (e) {
      if (hit) return json(res, 200, { ...hit.data, stale: true })
      return json(res, 503, { error: 'could not compute' })
    }
  }

  // ── POST /api/leaderboard/hide { addr, hidden } → dev-only visibility toggle ──
  // PIN-gated and fails closed when LB_PIN is unset, matching the admin-overwrite route:
  // an unset PIN must never mean "anyone may curate the public board".
  if (method === 'POST' && path === '/api/leaderboard/hide') {
    if (!LB_PIN) return json(res, 503, { error: 'admin PIN not configured' })
    if ((req.headers['x-lb-pin'] ?? '') !== LB_PIN) return json(res, 403, { error: 'forbidden' })
    const b = await body(req)
    if (!isAddr(b.addr)) return json(res, 400, { error: 'invalid address' })
    lbSetHidden(b.addr, !!b.hidden)
    return json(res, 200, { ok: true, addr: String(b.addr).toLowerCase(), hidden: !!b.hidden })
  }

  // ── POST /api/leaderboard/name { addr, name, ts, signature } ──────────────
  // Set the public display name shown on the board instead of the address. Ownership is
  // proven by a personal_sign from that address, so only the owner can rename their entry
  // (the address itself is public, so a signature is the only real proof).
  if (method === 'POST' && path === '/api/leaderboard/name') {
    const b = await body(req)
    if (!isAddr(b.addr)) return json(res, 400, { error: 'invalid address' })

    // Strip control chars, collapse whitespace, cap length. Reject names that could be
    // mistaken for an address.
    const name = (b.name ?? '').toString()
      .split('').filter(ch => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join('')
      .replace(/\s+/g, ' ').trim().slice(0, 24)
    if (/^0x[0-9a-fA-F]{6,}/.test(name)) return json(res, 400, { error: 'name cannot look like an address' })

    const ts = Number(b.ts ?? 0)
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 10 * 60 * 1000)
      return json(res, 400, { error: 'stale request — try again' })

    const msg = `Insolvent Trade — set leaderboard name\naddress: ${b.addr.toLowerCase()}\nname: ${name}\nts: ${ts}`
    let signer
    try { signer = ethers.verifyMessage(msg, b.signature ?? '') }
    catch { return json(res, 400, { error: 'bad signature' }) }
    if (signer.toLowerCase() !== b.addr.toLowerCase())
      return json(res, 403, { error: 'signature does not match that address' })

    const list = lbReadList()
    const i = list.findIndex(e => e.addr.toLowerCase() === b.addr.toLowerCase())
    if (i < 0) return json(res, 404, { error: 'address is not on the leaderboard' })
    list[i].label = name
    lbWriteList(list)
    // Reflect it in the pre-computed rows straight away, so the board shows the new name
    // without waiting for the next refresh cycle.
    try {
      const s = lbReadStats()
      const row = s.rows?.[b.addr.toLowerCase()]
      if (row) { row.label = name; lbWriteStats(s) }
    } catch {}
    return json(res, 200, { ok: true, label: name })
  }

  // ── GET /api/heatmap/:coin → proxied REAL on-chain liquidation clusters ───
  // Source: HyperPerps free market-wide feed (real positions, not a model). Cached 60s;
  // serves stale on upstream failure so the tab never hard-fails.
  if (method === 'GET' && path.startsWith('/api/heatmap/')) {
    const coin = (path.split('/')[3] || '').toUpperCase().replace(/[^A-Z0-9.]/g, '')
    if (!coin) return json(res, 400, { error: 'missing coin' })
    const cached = _heatmapCache[coin]
    if (cached && Date.now() - cached.ts < 60_000) return json(res, 200, cached.data)
    try {
      const r = await fetch(`https://trade.hyperperps.app/api/public/heatmap/${coin}`, { signal: AbortSignal.timeout(8000) })
      const data = await r.json()
      _heatmapCache[coin] = { ts: Date.now(), data }
      return json(res, 200, data)
    } catch (e) {
      if (_heatmapCache[coin]) return json(res, 200, _heatmapCache[coin].data)
      return json(res, 502, { error: 'heatmap upstream unavailable' })
    }
  }

  // ── POST /api/leaderboard/verify-pin → non-destructive dev-PIN check ───────
  // Dev mode used to "test" the PIN by overwriting the whole board, which was
  // destructive and left the client in a half-activated state. This just checks it.
  if (method === 'POST' && path === '/api/leaderboard/verify-pin') {
    if (!LB_PIN) return json(res, 503, { error: 'LB_PIN not configured on server' })
    if ((req.headers['x-lb-pin'] ?? '') !== LB_PIN) return json(res, 403, { error: 'forbidden' })
    return json(res, 200, { ok: true })
  }

  // ── POST /api/leaderboard → replace the whole list (admin) ────────────────
  if (method === 'POST' && path === '/api/leaderboard') {
    // This endpoint overwrites the public board. It previously accepted any
    // request — the x-lb-pin header the client sent was never checked.
    if (!LB_PIN) return json(res, 503, { error: 'LB_PIN not configured on server' })
    if ((req.headers['x-lb-pin'] ?? '') !== LB_PIN) return json(res, 403, { error: 'forbidden' })

    const b = await body(req)
    if (!Array.isArray(b.addrs)) return json(res, 400, { error: 'addrs must be array' })
    writeFileSync(LEADERBOARD_FILE, JSON.stringify(b.addrs))
    return json(res, 200, { ok: true })
  }

  // ── POST /api/leaderboard/remove { addr, ts, signature } — self-serve remove ──
  // Owner proves control with a personal_sign (same as /name); a dev/operator may
  // override with the LB_PIN header to remove ANY account.
  if (method === 'POST' && path === '/api/leaderboard/remove') {
    const b = await body(req)
    if (!isAddr(b.addr)) return json(res, 400, { error: 'invalid address' })
    const key = b.addr.toLowerCase()

    const pinOk = !!LB_PIN && (req.headers['x-lb-pin'] ?? '') === LB_PIN
    if (!pinOk) {
      const ts = Number(b.ts ?? 0)
      if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 10 * 60 * 1000)
        return json(res, 400, { error: 'stale request — try again' })
      const msg = `Insolvent Trade — remove from leaderboard\naddress: ${key}\nts: ${ts}`
      let signer
      try { signer = ethers.verifyMessage(msg, b.signature ?? '') }
      catch { return json(res, 400, { error: 'bad signature' }) }
      if (signer.toLowerCase() !== key)
        return json(res, 403, { error: 'signature does not match that address' })
    }

    const list = lbReadList()
    const next = list.filter(e => e.addr.toLowerCase() !== key)
    if (next.length === list.length) return json(res, 404, { error: 'address is not on the leaderboard' })
    lbWriteList(next)
    lbMarkRemoved(key)   // block silent auto-rejoin on the next wallet connect
    try { const s = lbReadStats(); if (s.rows?.[key]) { delete s.rows[key]; lbWriteStats(s) } } catch {}
    return json(res, 200, { ok: true, removed: true })
  }

  // ── POST /api/leaderboard/paper/remove { name, secret } — self-serve remove ──
  // Owner proves control with the row's secret; a dev/operator may override with
  // the LB_PIN header to remove ANY paper entry.
  if (method === 'POST' && path === '/api/leaderboard/paper/remove') {
    const b = await body(req)
    const name = lbCleanName(b.name)
    if (!name) return json(res, 400, { error: 'name required' })
    const list = lbPaperRead()
    const i = list.findIndex(e => (e.name ?? '').toLowerCase() === name.toLowerCase())
    if (i < 0) return json(res, 404, { error: 'not on the paper board' })

    const pinOk = !!LB_PIN && (req.headers['x-lb-pin'] ?? '') === LB_PIN
    if (!pinOk) {
      const given = String(b.secret ?? ''), want = String(list[i].secret ?? '')
      const ok = given.length === want.length && given.length > 0 &&
        timingSafeEqual(Buffer.from(given), Buffer.from(want))
      if (!ok) return json(res, 403, { error: 'wrong secret for that name' })
    }
    list.splice(i, 1)
    lbPaperWrite(list)
    return json(res, 200, { ok: true, removed: true })
  }

  json(res, 404, { error: 'not found' })
})

server.listen(PORT, () => {
  console.log(`\n  Insolvent Trade — Strategy Server`)
  console.log(`  Listening on http://localhost:${PORT}`)
  console.log(`  WALLET_KEY: ${process.env.WALLET_KEY ? '✓ set' : '✗ not set (bots use per-account keys)'}`)
  console.log(`  LB_PIN:     ${LB_PIN ? '✓ set' : '✗ not set (leaderboard overwrite disabled)'}`)
  console.log(`  ADMIN_TOKEN: ${ADMIN_TOKEN ? '✓ set (operator bypass enabled)' : '✗ not set (owner-only auth)'}`)
  resumeBots()
  // Watch the treasury for subscription payments. First tick seeds the watermark, so
  // sends that predate this deploy are never credited to anyone.
  setTimeout(() => subPollPayments(), 3000)
  setInterval(() => subPollPayments(), SUB_POLL_MS)
  // Keep the cached leaderboard warm so browsers never fan out to HL themselves.
  setTimeout(() => lbRefreshAll().catch(e => console.warn('[lb]', e.message)), 5000)
  setInterval(() => lbRefreshAll().catch(e => console.warn('[lb]', e.message)), 5 * 60 * 1000)
  console.log('')
})
