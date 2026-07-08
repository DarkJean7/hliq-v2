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
import { randomBytes, createCipheriv, createDecipheriv }      from 'node:crypto'

const __dirname  = dirname(fileURLToPath(import.meta.url))
const PORT       = 3002
const LOGS_DIR        = join(__dirname, 'logs')
const LEADERBOARD_FILE = join(__dirname, 'leaderboard.json')

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const SCRIPTS = {
  insolvent: 'strategies/manager.js',
  dca:       'strategies/dca.js',
  grid:      'strategies/grid.js',
  ocgrid:    'strategies/ocgrid.js',
  twap:      'strategies/twap.js',
  trend:     'strategies/trend.js',
  accumulator: 'strategies/accumulator.js',
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
  const entry = { proc, buffer: [], address, instance: (instance || '').toUpperCase(), lastError: '', agentKey: envKey, extraArgs }
  procs[key] = entry

  // Persist (encrypted) so a restart/reboot auto-resumes this bot with no prompt.
  persistBot(type, address, instance, extraArgs, envKey)

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
    delete procs[key]
    // A bot that exits on its own (boundary stop, crash) should NOT auto-resume.
    // But if hliq-strat is shutting down, keep the record so the next boot revives it.
    if (!shuttingDown) unpersistBot(type, address, instance)
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
function resumeBots() {
  const reg = loadRegistry()
  const entries = Object.values(reg)
  if (!entries.length) return
  console.log(`  Resuming ${entries.length} persisted bot(s)…`)
  for (const r of entries) {
    let agentKey
    try { agentKey = decryptKey(r.key) } catch (e) { console.error(`  ✗ decrypt failed for ${r.type}:${r.instance} — ${e.message}`); continue }
    try {
      startStrategy(r.type, r.extraArgs ?? [], agentKey, r.address ?? '', r.instance ?? '', true)
      console.log(`  ✓ resumed ${r.type}${r.instance ? ':' + r.instance : ''} (${r.address})`)
    } catch (e) { console.error(`  ✗ resume failed for ${r.type}:${r.instance} — ${e.message}`) }
  }
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

  // ── POST /api/start ───────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/start') {
    const b      = await body(req)
    const result = await startStrategy(b.type, b.args ?? [], b.agentKey ?? '', b.address ?? '', b.instance ?? '')
    return json(res, result.ok ? 200 : 400, result)
  }

  // ── POST /api/stop ────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/stop') {
    const b      = await body(req)
    const result = stopStrategy(b.type, b.address ?? '', b.instance ?? '')
    return json(res, result.ok ? 200 : 400, result)
  }

  // ── POST /api/restart ─────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/restart') {
    const b      = await body(req)
    const result = await restartStrategy(b.type, b.address ?? '', b.instance ?? '')
    return json(res, result.ok ? 200 : 400, result)
  }

  if (method === 'POST' && path === '/api/pause') {
    const b = await body(req)
    const r = pauseStrategy(b.type, b.address ?? '', b.instance ?? '')
    return json(res, r.ok ? 200 : 400, r)
  }

  if (method === 'POST' && path === '/api/resume') {
    const b = await body(req)
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
    const parts = path.split('/').filter(Boolean)   // ['api','wins','type'?]
    if (parts.length >= 3) return json(res, 200, readWins(parts[2], addr))
    return json(res, 200, readAllWins(addr))
  }

  // ── GET /api/history/:type?address=0x...                  → list log files ─
  // ── GET /api/history/:type/:filename?address=0x...         → read one file ──
  if (method === 'GET' && path.startsWith('/api/history/')) {
    const addr  = url.searchParams.get('address') || ''
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
  if (method === 'GET' && path === '/api/leaderboard') {
    const addrs = existsSync(LEADERBOARD_FILE)
      ? JSON.parse(readFileSync(LEADERBOARD_FILE, 'utf8'))
      : []
    return json(res, 200, addrs)
  }

  // ── POST /api/leaderboard → save extra addresses { addrs: string[] } ──────
  if (method === 'POST' && path === '/api/leaderboard') {
    const b = await body(req)
    if (!Array.isArray(b.addrs)) return json(res, 400, { error: 'addrs must be array' })
    writeFileSync(LEADERBOARD_FILE, JSON.stringify(b.addrs))
    return json(res, 200, { ok: true })
  }

  json(res, 404, { error: 'not found' })
})

server.listen(PORT, () => {
  console.log(`\n  Insolvent Terminal — Strategy Server`)
  console.log(`  Listening on http://localhost:${PORT}`)
  console.log(`  WALLET_KEY: ${process.env.WALLET_KEY ? '✓ set' : '✗ not set (bots use per-account keys)'}`)
  resumeBots()
  console.log('')
})
