#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — Strategy Server
 *
 * Manages strategy processes, streams live logs via SSE,
 * persists logs to disk, and records wins per strategy.
 *
 * Run:
 *   WALLET_KEY=0xYOUR_KEY node server.js
 *
 * Port: 3001
 */

import { createServer }                                       from 'node:http'
import { spawn }                                              from 'node:child_process'
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname }                                      from 'node:path'
import { fileURLToPath }                                      from 'node:url'

const __dirname  = dirname(fileURLToPath(import.meta.url))
const PORT       = 3001
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
  twap:      'strategies/twap.js',
  trend:     'strategies/trend.js',
}

// ─── RUNTIME STATE ────────────────────────────────────────────────────────────
const procs  = {}        // type → { proc, buffer: string[] }
const subs   = {}        // type → Set<ServerResponse>  (SSE subscribers)

// ─── FS HELPERS ───────────────────────────────────────────────────────────────
function stratDir(type) {
  const d = join(LOGS_DIR, type)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

function logPath(type) {
  const day = new Date().toISOString().slice(0, 10)
  return join(stratDir(type), `${day}.log`)
}

function winsPath(type) {
  return join(stratDir(type), 'wins.jsonl')
}

// ─── WIN DETECTION ────────────────────────────────────────────────────────────
// Matches: [2026-04-06 12:00:00] [WIN     ] some message
const WIN_RE = /^\[(.+?)\] \[WIN\s*\] (.+)$/

function recordWin(type, line) {
  const m = WIN_RE.exec(line)
  if (!m) return
  const entry = JSON.stringify({ ts: m[1], type, msg: m[2] }) + '\n'
  try { appendFileSync(winsPath(type), entry) } catch (_) {}
}

// ─── LINE HANDLER (stdout/stderr) ─────────────────────────────────────────────
function handleLine(type, line) {
  // Persist to log file
  try { appendFileSync(logPath(type), line + '\n') } catch (_) {}

  // Check for win
  recordWin(type, line)

  // Buffer last 500 lines for late SSE subscribers
  const p = procs[type]
  if (p) {
    p.buffer.push(line)
    if (p.buffer.length > 500) p.buffer.shift()
  }

  // Push to live SSE subscribers
  const msg = `data: ${JSON.stringify({ line })}\n\n`
  for (const res of (subs[type] ?? [])) {
    try { res.write(msg) } catch (_) {}
  }
}

// ─── PROCESS MANAGEMENT ───────────────────────────────────────────────────────
function startStrategy(type, extraArgs = []) {
  if (procs[type])         return { ok: false, error: 'already running' }
  if (!SCRIPTS[type])      return { ok: false, error: 'unknown strategy' }

  const key = process.env.WALLET_KEY
  if (!key) return { ok: false, error: 'WALLET_KEY environment variable not set' }

  const argv = [SCRIPTS[type], '--wallet', key, ...extraArgs]
  const proc = spawn('node', argv, { cwd: __dirname, env: process.env })

  procs[type] = { proc, buffer: [] }

  let outBuf = ''
  let errBuf = ''

  proc.stdout.on('data', chunk => {
    outBuf += chunk.toString()
    const lines = outBuf.split('\n')
    outBuf = lines.pop()
    for (const l of lines) if (l) handleLine(type, l)
  })

  proc.stderr.on('data', chunk => {
    errBuf += chunk.toString()
    const lines = errBuf.split('\n')
    errBuf = lines.pop()
    for (const l of lines) if (l) handleLine(type, `[STDERR] ${l}`)
  })

  proc.on('exit', code => {
    const ts  = new Date().toISOString().replace('T', ' ').slice(0, 19)
    handleLine(type, `[${ts}] [EXIT    ] Process exited — code ${code ?? '?'}`)
    delete procs[type]
    // Notify subscribers the process ended
    const exit = `data: ${JSON.stringify({ exit: code ?? -1 })}\n\n`
    for (const res of (subs[type] ?? [])) {
      try { res.write(exit) } catch (_) {}
    }
  })

  return { ok: true }
}

function stopStrategy(type) {
  const p = procs[type]
  if (!p) return { ok: false, error: 'not running' }
  p.proc.kill('SIGTERM')
  // exit event will clean up procs[type]
  return { ok: true }
}

function getStatus() {
  const out = {}
  for (const t of Object.keys(SCRIPTS)) out[t] = !!procs[t]
  return out
}

// ─── WIN READERS ──────────────────────────────────────────────────────────────
function readWins(type) {
  const p = winsPath(type)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
    .reverse()   // newest first
}

function readAllWins() {
  const out = {}
  for (const t of Object.keys(SCRIPTS)) out[t] = readWins(t)
  return out
}

// ─── LOG FILE LIST ────────────────────────────────────────────────────────────
function logFiles(type) {
  const d = join(LOGS_DIR, type)
  if (!existsSync(d)) return []
  return readdirSync(d)
    .filter(f => f.endsWith('.log'))
    .sort().reverse()
}

function readLogFile(type, filename) {
  // Basic path sanity — no directory traversal
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return null
  const p = join(LOGS_DIR, type, filename)
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
    const result = startStrategy(b.type, b.args ?? [])
    return json(res, result.ok ? 200 : 400, result)
  }

  // ── POST /api/stop ────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/stop') {
    const b      = await body(req)
    const result = stopStrategy(b.type)
    return json(res, result.ok ? 200 : 400, result)
  }

  // ── GET /api/status ───────────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/status') {
    return json(res, 200, getStatus())
  }

  // ── GET /api/wins        → all strategies ────────────────────────────────
  // ── GET /api/wins/:type  → one strategy ──────────────────────────────────
  if (method === 'GET' && path.startsWith('/api/wins')) {
    const parts = path.split('/').filter(Boolean)   // ['api','wins','type'?]
    if (parts.length >= 3) return json(res, 200, readWins(parts[2]))
    return json(res, 200, readAllWins())
  }

  // ── GET /api/history/:type           → list of log files ─────────────────
  // ── GET /api/history/:type/:filename → read one log file ─────────────────
  if (method === 'GET' && path.startsWith('/api/history/')) {
    const parts = path.split('/').filter(Boolean)   // ['api','history','type','file'?]
    const type  = parts[2]
    if (!type) return json(res, 400, { error: 'missing type' })
    if (parts[3]) {
      const content = readLogFile(type, parts[3])
      if (!content) return json(res, 404, { error: 'not found' })
      return text(res, 200, content)
    }
    return json(res, 200, logFiles(type))
  }

  // ── GET /api/logs/:type  → SSE live stream ────────────────────────────────
  if (method === 'GET' && path.startsWith('/api/logs/')) {
    const type = path.split('/')[3]
    if (!type) return json(res, 400, { error: 'missing type' })

    res.writeHead(200, {
      ...CORS,
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    })

    // Replay buffer to late subscriber
    for (const line of (procs[type]?.buffer ?? [])) {
      res.write(`data: ${JSON.stringify({ line })}\n\n`)
    }

    if (!subs[type]) subs[type] = new Set()
    subs[type].add(res)

    req.on('close', () => { subs[type]?.delete(res) })
    return
  }

  // ── GET /api/leaderboard  → return saved extra addresses ────────────────
  if (method === 'GET' && path === '/api/leaderboard') {
    const addrs = existsSync(LEADERBOARD_FILE)
      ? JSON.parse(readFileSync(LEADERBOARD_FILE, 'utf8'))
      : []
    return json(res, 200, addrs)
  }

  // ── POST /api/leaderboard → save extra addresses { addrs: string[] } ────
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
  console.log(`  WALLET_KEY: ${process.env.WALLET_KEY ? '✓ set' : '✗ NOT SET — strategies cannot start'}\n`)
})
