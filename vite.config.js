import { defineConfig }    from 'vite'
import { spawn }           from 'node:child_process'
import {
  existsSync, mkdirSync,
  appendFileSync, readFileSync, readdirSync,
} from 'node:fs'
import { join, dirname }   from 'node:path'
import { fileURLToPath }   from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOGS_DIR  = join(__dirname, 'logs')

const SCRIPTS = {
  insolvent: 'strategies/manager.js',
  dca:       'strategies/dca.js',
  grid:      'strategies/grid.js',
  twap:      'strategies/twap.js',
  trend:     'strategies/trend.js',
  shorter:   'strategies/shorter.js',
  custom:    null,   // script path provided at start time
}

// ─── RUNTIME STATE ────────────────────────────────────────────────────────────
const procs = {}   // type → { proc, buffer: string[] }
const subs  = {}   // type → Set<ServerResponse>

// ─── FS HELPERS ───────────────────────────────────────────────────────────────
function stratDir(type) {
  const d = join(LOGS_DIR, type)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}
function logPath(type) {
  return join(stratDir(type), `${new Date().toISOString().slice(0, 10)}.log`)
}
function winsPath(type) {
  return join(stratDir(type), 'wins.jsonl')
}

// ─── WIN DETECTION ────────────────────────────────────────────────────────────
const WIN_RE = /^\[(.+?)\] \[WIN\s*\] (.+)$/

function recordWin(type, line) {
  const m = WIN_RE.exec(line)
  if (!m) return
  try { appendFileSync(winsPath(type), JSON.stringify({ ts: m[1], type, msg: m[2] }) + '\n') } catch (_) {}
}

// ─── LINE HANDLER ─────────────────────────────────────────────────────────────
function handleLine(type, line) {
  try { appendFileSync(logPath(type), line + '\n') } catch (_) {}
  recordWin(type, line)
  const p = procs[type]
  if (p) { p.buffer.push(line); if (p.buffer.length > 500) p.buffer.shift() }
  const msg = `data: ${JSON.stringify({ line })}\n\n`
  for (const res of (subs[type] ?? [])) { try { res.write(msg) } catch (_) {} }
}

// ─── PROCESS MANAGEMENT ───────────────────────────────────────────────────────
function startStrategy(type, agentKey, extraArgs = [], scriptOverride = null) {
  if (procs[type])               return { ok: false, error: 'already running' }
  if (!(type in SCRIPTS))        return { ok: false, error: 'unknown strategy' }
  if (!agentKey)                 return { ok: false, error: 'Agent key not set — enter it in the Strategies tab' }

  const script = scriptOverride ?? SCRIPTS[type]
  if (!script) return { ok: false, error: 'No script path — fill in the Script Path field' }

  const argv = [script, ...extraArgs]
  const proc = spawn('node', argv, {
    cwd: __dirname,
    env: { ...process.env, AGENT_KEY: agentKey },
  })
  procs[type] = { proc, buffer: [] }

  let outBuf = '', errBuf = ''

  proc.stdout.on('data', chunk => {
    outBuf += chunk.toString()
    const lines = outBuf.split('\n'); outBuf = lines.pop()
    for (const l of lines) if (l) handleLine(type, l)
  })
  proc.stderr.on('data', chunk => {
    errBuf += chunk.toString()
    const lines = errBuf.split('\n'); errBuf = lines.pop()
    for (const l of lines) if (l) handleLine(type, `[STDERR] ${l}`)
  })
  proc.on('exit', code => {
    const ts = new Date().toISOString().replace('T',' ').slice(0,19)
    handleLine(type, `[${ts}] [EXIT    ] Process exited — code ${code ?? '?'}`)
    delete procs[type]
    const exit = `data: ${JSON.stringify({ exit: code ?? -1 })}\n\n`
    for (const res of (subs[type] ?? [])) { try { res.write(exit) } catch (_) {} }
  })

  return { ok: true }
}

function stopStrategy(type) {
  const p = procs[type]
  if (!p) return { ok: false, error: 'not running' }
  p.proc.kill('SIGTERM')
  return { ok: true }
}

function getStatus() {
  const out = {}
  for (const t of Object.keys(SCRIPTS)) out[t] = !!procs[t]
  return out
}

function readWins(type) {
  const p = winsPath(type)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean).reverse()
}

function readAllWins() {
  const out = {}
  for (const t of Object.keys(SCRIPTS)) out[t] = readWins(t)
  return out
}

function logFiles(type) {
  const d = join(LOGS_DIR, type)
  if (!existsSync(d)) return []
  return readdirSync(d).filter(f => f.endsWith('.log')).sort().reverse()
}

// ─── BODY READER ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end',  () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
    req.on('error', reject)
  })
}

function sendJson(res, status, data) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

// ─── VITE PLUGIN ──────────────────────────────────────────────────────────────
function strategyPlugin() {
  return {
    name: 'insolvent-strategy-server',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path   = req.url?.split('?')[0] ?? ''
        const method = req.method

        if (!path.startsWith('/api/')) return next()

        // POST /api/start
        if (method === 'POST' && path === '/api/start') {
          const b      = await readBody(req)
          const result = startStrategy(b.type, b.agentKey, b.args ?? [], b.script ?? null)
          return sendJson(res, result.ok ? 200 : 400, result)
        }

        // POST /api/stop
        if (method === 'POST' && path === '/api/stop') {
          const b      = await readBody(req)
          const result = stopStrategy(b.type)
          return sendJson(res, result.ok ? 200 : 400, result)
        }

        // GET /api/status
        if (method === 'GET' && path === '/api/status') {
          return sendJson(res, 200, getStatus())
        }

        // GET /api/wins  or  /api/wins/:type
        if (method === 'GET' && path.startsWith('/api/wins')) {
          const parts = path.split('/').filter(Boolean)
          return sendJson(res, 200, parts.length >= 3 ? readWins(parts[2]) : readAllWins())
        }

        // GET /api/history/:type  or  /api/history/:type/:file
        if (method === 'GET' && path.startsWith('/api/history/')) {
          const parts = path.split('/').filter(Boolean)
          const type  = parts[2]
          if (!type) return sendJson(res, 400, { error: 'missing type' })
          if (parts[3]) {
            const fname = parts[3]
            if (fname.includes('..')) return sendJson(res, 400, { error: 'invalid' })
            const p = join(LOGS_DIR, type, fname)
            if (!existsSync(p)) return sendJson(res, 404, { error: 'not found' })
            res.statusCode = 200
            res.setHeader('Content-Type', 'text/plain')
            return res.end(readFileSync(p, 'utf8'))
          }
          return sendJson(res, 200, logFiles(type))
        }

        // GET /api/logs/:type  — SSE
        if (method === 'GET' && path.startsWith('/api/logs/')) {
          const type = path.split('/')[3]
          if (!type) return sendJson(res, 400, { error: 'missing type' })

          res.statusCode = 200
          res.setHeader('Content-Type',  'text/event-stream')
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Connection',    'keep-alive')
          res.setHeader('X-Accel-Buffering', 'no')
          res.flushHeaders()

          for (const line of (procs[type]?.buffer ?? [])) {
            res.write(`data: ${JSON.stringify({ line })}\n\n`)
          }

          if (!subs[type]) subs[type] = new Set()
          subs[type].add(res)
          req.on('close', () => { subs[type]?.delete(res) })
          return
        }

        next()
      })
    },
  }
}

// ─── VITE CONFIG ──────────────────────────────────────────────────────────────
export default defineConfig({
  plugins: [strategyPlugin()],
  server: {
    port: 5175,
    allowedHosts: true,
    hmr: false,
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@walletconnect') || id.includes('@web3modal') || id.includes('w3m')) {
            return 'walletconnect'
          }
          if (id.includes('chart.js')) {
            return 'charts'
          }
        },
      },
    },
  },
  optimizeDeps: {
    include: ['@nktkas/hyperliquid', 'ethers', 'chart.js'],
    esbuildOptions: {
      target: 'esnext',
    },
  },
})
